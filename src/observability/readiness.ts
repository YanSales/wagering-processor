import { GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { SqsSender } from '../messaging/wager-events.queues';

/** Uma dependência verificada pelo readiness. Resolve `true` se alcançável; nunca expõe o motivo. */
export interface DependencyCheck {
  name: string;
  check(): Promise<boolean>;
}

export type DependencyState = 'up' | 'down' | 'disabled';

export interface ReadinessReport {
  ready: boolean;
  checks: Record<string, DependencyState>;
}

export const READINESS_TIMEOUT_MS = 2_000;

/**
 * Executa as verificações em paralelo, cada uma com timeout. Uma exceção ou timeout conta como
 * `down`; o motivo não entra no relatório (pode conter host, usuário ou SQL), só o estado.
 */
export async function checkReadiness(
  checks: readonly DependencyCheck[],
  disabled: readonly string[] = [],
  timeoutMs = READINESS_TIMEOUT_MS,
): Promise<ReadinessReport> {
  const results = await Promise.all(
    checks.map(async (dependency) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      });
      try {
        const ok = await Promise.race([dependency.check().catch(() => false), timeout]);
        return [dependency.name, ok ? 'up' : 'down'] as const;
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  const states: Record<string, DependencyState> = Object.fromEntries(results);
  for (const name of disabled) states[name] = 'disabled';
  return { ready: results.every(([, state]) => state === 'up'), checks: states };
}

/** PostgreSQL alcançável: `select 1` pelo pool da aplicação. */
export function postgresCheck(orm: Pick<MikroORM, 'checkConnection'>): DependencyCheck {
  return {
    name: 'postgres',
    check: async () => (await orm.checkConnection()).ok,
  };
}

/** SQS alcançável e as filas usadas pelos recursos habilitados existentes. */
export function sqsQueuesCheck(client: SqsSender, queueNames: readonly string[]): DependencyCheck {
  return {
    name: 'sqs',
    check: async () => {
      for (const QueueName of queueNames) {
        await client.send(new GetQueueUrlCommand({ QueueName }), {
          abortSignal: AbortSignal.timeout(READINESS_TIMEOUT_MS),
        });
      }
      return true;
    },
  };
}
