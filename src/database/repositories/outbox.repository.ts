import type { MikroORM } from '@mikro-orm/postgresql';
import type {
  ClaimedOutboxMessage,
  ClaimRequest,
  OutboxStore,
} from '../../application/outbox/publish-outbox';

/**
 * Reserva e marcação dos eventos de `outbox_messages` para o publisher (contrato §11). Cada operação
 * é um único comando SQL; datas usam o relógio do banco, o mesmo de `next_attempt_at`, para que
 * instâncias com relógios diferentes concordem sobre vencimentos e reservas.
 *
 * Exclusividade por wallet: uma wallet só é reservada pelo seu evento mais antigo ainda não publicado
 * (a "cabeça"), quando ele está vencido e sem reserva válida. A cabeça é travada com
 * `FOR UPDATE SKIP LOCKED`: dois publishers simultâneos nunca reservam a mesma wallet, e quem chega
 * depois do commit da reserva vê a cabeça reservada. Os eventos seguintes da wallet recebem a mesma
 * reserva, então só o detentor os envia, em ordem. Uma reserva expirada (publisher caído ou lento)
 * pode ser assumida; a marcação exige o token atual, e o antigo detentor não a sobrescreve.
 *
 * A ordem por wallet também depende das premissas de `seq` documentadas em `ARCHITECTURE.md`.
 */
export class MikroOrmOutboxRepository implements OutboxStore {
  constructor(private readonly orm: MikroORM) {}

  async claim(request: ClaimRequest): Promise<ClaimedOutboxMessage[]> {
    const rows = (await this.#execute(
      `with heads as (
         select o.message_group_id
           from outbox_messages o
          where o.published_at is null
            and o.next_attempt_at <= now()
            and (o.claimed_until is null or o.claimed_until <= now())
            and not exists (
              select 1 from outbox_messages p
               where p.message_group_id = o.message_group_id
                 and p.published_at is null
                 and p.seq < o.seq)
          order by o.seq
          limit ?
          for update of o skip locked
       ), batch as (
         select r.id
           from (select m.id,
                        row_number() over (partition by m.message_group_id order by m.seq) as position
                   from outbox_messages m
                  where m.published_at is null
                    and m.message_group_id in (select message_group_id from heads)) r
          where r.position <= ?
       )
       update outbox_messages o
          set claimed_until = now() + ? * interval '1 millisecond', claim_token = ?
         from batch
        where o.id = batch.id
       returning o.id, o.seq::text as seq, o.message_group_id, o.event_type, o.payload, o.attempts`,
      [request.maxGroups, request.maxPerGroup, request.leaseMs, request.claimToken],
    )) as {
      id: string;
      seq: string;
      message_group_id: string;
      event_type: string;
      payload: Record<string, unknown>;
      attempts: number;
    }[];

    // `RETURNING` não tem ordem garantida; `seq` volta como texto para não passar por number.
    return rows
      .sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : 1))
      .map((row) => ({
        id: row.id,
        messageGroupId: row.message_group_id,
        eventType: row.event_type,
        payload: row.payload,
        attempts: row.attempts,
      }));
  }

  async markPublished(id: string, claimToken: string): Promise<boolean> {
    const rows = await this.#execute(
      `update outbox_messages
          set published_at = now(), claimed_until = null, claim_token = null
        where id = ? and claim_token = ? and published_at is null
       returning id`,
      [id, claimToken],
    );
    return rows.length === 1;
  }

  async scheduleRetry(
    id: string,
    claimToken: string,
    delayMs: number,
    errorCode: string,
  ): Promise<boolean> {
    const rows = await this.#execute(
      `update outbox_messages
          set attempts = attempts + 1,
              next_attempt_at = now() + ? * interval '1 millisecond',
              last_error_code = ?,
              claimed_until = null,
              claim_token = null
        where id = ? and claim_token = ? and published_at is null
       returning id`,
      [delayMs, errorCode, id, claimToken],
    );
    return rows.length === 1;
  }

  async release(claimToken: string): Promise<void> {
    await this.#execute(
      `update outbox_messages set claimed_until = null, claim_token = null
        where claim_token = ? and published_at is null`,
      [claimToken],
    );
  }

  #execute(sql: string, params: unknown[]): Promise<unknown[]> {
    return this.orm.em.getConnection().execute(sql, params, 'all') as Promise<unknown[]>;
  }
}
