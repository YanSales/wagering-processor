import { randomUUID } from 'node:crypto';
import { DEFAULT_OUTBOX_RETRY, OutboxRetryPolicy } from './outbox-retry-policy';

/** Evento da outbox reservado para publicação nesta rodada. */
export interface ClaimedOutboxMessage {
  /** `eventId` do envelope. */
  id: string;
  /** Wallet do evento: o grupo FIFO (§8). */
  messageGroupId: string;
  eventType: string;
  /** Envelope gravado, enviado como está em toda (re)publicação. */
  payload: Readonly<Record<string, unknown>>;
  /** Falhas de publicação já registradas. */
  attempts: number;
}

export interface ClaimRequest {
  /** Identifica a reserva; só quem a detém marca ou reagenda os eventos reservados. */
  claimToken: string;
  /** Máximo de wallets reservadas por rodada. */
  maxGroups: number;
  /** Máximo de eventos reservados por wallet. */
  maxPerGroup: number;
  leaseMs: number;
}

/**
 * Persistência da publicação. A implementação garante que uma wallet só é reservada a partir do seu
 * evento mais antigo ainda não publicado (vencido e sem reserva válida) e por um publisher de cada vez.
 */
export interface OutboxStore {
  /** Reserva eventos de wallets disponíveis; devolve-os em ordem de gravação (`seq`). */
  claim(request: ClaimRequest): Promise<ClaimedOutboxMessage[]>;
  /** Marca como publicado se a reserva ainda for de `claimToken`; `false` se ela se perdeu. */
  markPublished(id: string, claimToken: string): Promise<boolean>;
  /** Registra a falha (tentativa + 1, próxima em `delayMs`) e libera a reserva do evento. */
  scheduleRetry(
    id: string,
    claimToken: string,
    delayMs: number,
    errorCode: string,
  ): Promise<boolean>;
  /** Libera as reservas restantes de `claimToken` (eventos não processados nesta rodada). */
  release(claimToken: string): Promise<void>;
}

/** Envio de um evento ao broker. Resolve somente depois de o broker aceitá-lo. */
export interface EventPublisher {
  publish(message: ClaimedOutboxMessage): Promise<void>;
}

export interface PublishOutboxOptions {
  maxGroups: number;
  maxPerGroup: number;
  leaseMs: number;
  policy?: OutboxRetryPolicy;
  newToken?: () => string;
  /** Relógio monotônico (ms) usado só para não começar envios perto do fim da reserva. */
  elapsed?: () => number;
  /** Recebe cada falha de envio; a rodada continua com as outras wallets. */
  onError?: (message: ClaimedOutboxMessage, error: unknown) => void;
}

/** Contagem de uma rodada do publisher, para log e métricas. */
export interface PublishOutboxSummary {
  claimed: number;
  published: number;
  /** Envios recusados ou com erro: reagendados com backoff; a wallet espera por eles. */
  failed: number;
  /** Reservas perdidas antes da marcação (expiradas e assumidas por outro publisher). */
  leaseLost: number;
  /** Reservados mas não enviados (falha anterior na wallet ou fim do tempo da reserva). */
  released: number;
}

/**
 * Uma rodada do publisher da Transactional Outbox (contrato §11): reserva eventos confirmados, envia
 * cada um ao broker e só então o marca como publicado.
 *
 * - **At-least-once**: se o processo cair entre o envio e a marcação, a reserva expira e outro
 *   publisher reenvia o mesmo envelope, com o mesmo `eventId`; o consumidor deduplica por ele.
 * - **Ordem por wallet**: os eventos de uma wallet saem em ordem de `seq`, um de cada vez. Uma falha
 *   interrompe a wallet na rodada: os eventos seguintes não são enviados antes do que falhou.
 * - **Concorrência**: a reserva é exclusiva por wallet (no banco); a marcação exige a mesma reserva,
 *   então um publisher atrasado não sobrescreve o trabalho de outro.
 * - Nenhum envio começa depois de metade da reserva: o restante fica de margem para o envio em curso
 *   e a marcação, antes que outro publisher possa assumir a wallet.
 */
export class PublishOutbox {
  readonly #policy: OutboxRetryPolicy;
  readonly #newToken: () => string;
  readonly #elapsed: () => number;

  constructor(
    private readonly store: OutboxStore,
    private readonly publisher: EventPublisher,
    private readonly options: PublishOutboxOptions,
  ) {
    for (const name of ['maxGroups', 'maxPerGroup', 'leaseMs'] as const) {
      const value = options[name];
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`${name} deve ser um inteiro positivo; recebido ${String(value)}.`);
      }
    }
    this.#policy = options.policy ?? OutboxRetryPolicy.from(DEFAULT_OUTBOX_RETRY);
    this.#newToken = options.newToken ?? randomUUID;
    this.#elapsed = options.elapsed ?? (() => performance.now());
  }

  async runOnce(): Promise<PublishOutboxSummary> {
    const claimToken = this.#newToken();
    const claimed = await this.store.claim({
      claimToken,
      maxGroups: this.options.maxGroups,
      maxPerGroup: this.options.maxPerGroup,
      leaseMs: this.options.leaseMs,
    });
    const startedAt = this.#elapsed();
    const summary: PublishOutboxSummary = {
      claimed: claimed.length,
      published: 0,
      failed: 0,
      leaseLost: 0,
      released: 0,
    };
    if (claimed.length === 0) return summary;

    let handled = 0;
    try {
      rounds: for (const group of byGroup(claimed)) {
        for (const [index, message] of group.entries()) {
          if (this.#elapsed() - startedAt >= this.options.leaseMs / 2) break rounds;
          handled += 1;
          if (!(await this.#publish(message, claimToken, summary))) {
            // Os seguintes desta wallet não saem antes deste: ficam para a próxima reserva.
            const skipped = group.length - index - 1;
            handled += skipped;
            summary.released += skipped;
            break;
          }
        }
      }
      summary.released += claimed.length - handled;
    } finally {
      await this.store.release(claimToken);
    }
    return summary;
  }

  /** `true` se o evento foi enviado e marcado; `false` se a wallet deve parar nesta rodada. */
  async #publish(
    message: ClaimedOutboxMessage,
    claimToken: string,
    summary: PublishOutboxSummary,
  ): Promise<boolean> {
    try {
      await this.publisher.publish(message);
    } catch (error) {
      summary.failed += 1;
      this.options.onError?.(message, error);
      await this.store.scheduleRetry(
        message.id,
        claimToken,
        this.#policy.delayAfterFailure(message.attempts),
        errorCode(error),
      );
      return false;
    }
    // Uma falha aqui sobe: o evento já foi aceito e será reenviado depois da reserva (at-least-once).
    if (await this.store.markPublished(message.id, claimToken)) {
      summary.published += 1;
      return true;
    }
    summary.leaseLost += 1;
    return false;
  }
}

/** Agrupa por wallet mantendo a ordem de `seq` dentro de cada uma. */
function byGroup(messages: ClaimedOutboxMessage[]): ClaimedOutboxMessage[][] {
  const groups = new Map<string, ClaimedOutboxMessage[]>();
  for (const message of messages) {
    const group = groups.get(message.messageGroupId);
    if (group === undefined) groups.set(message.messageGroupId, [message]);
    else group.push(message);
  }
  return [...groups.values()];
}

/** Código curto e sem dados do evento, gravado em `last_error_code`. */
function errorCode(error: unknown): string {
  const name = error instanceof Error ? error.name : 'UnknownError';
  return name.slice(0, 100);
}
