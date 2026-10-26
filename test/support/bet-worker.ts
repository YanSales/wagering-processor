import { MikroORM } from '@mikro-orm/postgresql';
import {
  SubmitWagerTransaction,
  type SubmitWagerTransactionCommand,
} from '../../src/application/submit-wager-transaction';
import { createOrmConfig } from '../../src/database/orm.config';
import { MikroOrmWagerTransactionRepository } from '../../src/database/repositories/wager-transaction.repository';
import { Money, type MoneyProps } from '../../src/domain/money';
import { assertTestDatabaseEnv } from './test-database';

/** Comando serializável: `money` como `MoneyProps`, o resto como em `SubmitWagerTransactionCommand`. */
export type WorkerCommand = Omit<SubmitWagerTransactionCommand, 'money'> & { money: MoneyProps };

export type WorkerResult =
  | {
      ok: true;
      transactionId: string;
      status: string;
      failureCode: string | null;
      balance: MoneyProps;
      idempotentReplay: boolean;
    }
  | { ok: false; error: string; message: string };

/**
 * Processo independente que submete transações pelo mesmo caso de uso e repositório da aplicação,
 * com seu próprio MikroORM e pool de conexões: simula outra instância do serviço.
 *
 * Protocolo (stdout/stdin, uma linha por mensagem): conecta e imprime `READY`; espera `GO` no stdin;
 * executa todos os comandos em paralelo; imprime `RESULT <json>` e encerra.
 * Uso: `bun --no-env-file test/support/bet-worker.ts '<json de WorkerCommand[]>'`.
 */
if (import.meta.main) {
  // Herda o ambiente do teste: recusa qualquer banco que não seja *_test.
  assertTestDatabaseEnv();
  const commands = JSON.parse(process.argv[2] ?? '[]') as WorkerCommand[];
  const orm = await MikroORM.init(createOrmConfig());
  try {
    // Como o `DatabaseConnector` da aplicação: no MikroORM 7, `connect()` antes de `checkConnection()`.
    await orm.connect();
    const check = await orm.checkConnection();
    if (!check.ok) throw new Error(`Sem conexão com o banco de teste: ${check.reason}`);
    const useCase = new SubmitWagerTransaction(new MikroOrmWagerTransactionRepository(orm));
    console.log('READY');
    for await (const line of console) {
      if (line.trim() === 'GO') break;
    }
    const settled = await Promise.allSettled(
      commands.map((command) =>
        useCase.execute({ ...command, money: Money.fromProps(command.money) }),
      ),
    );
    const results: WorkerResult[] = settled.map((outcome) =>
      outcome.status === 'fulfilled'
        ? {
            ok: true,
            transactionId: outcome.value.transactionId,
            status: outcome.value.status,
            failureCode: outcome.value.failureCode ?? null,
            balance: outcome.value.balance.toProps(),
            idempotentReplay: outcome.value.idempotentReplay,
          }
        : {
            ok: false,
            error: (outcome.reason as Error).name,
            message: (outcome.reason as Error).message,
          },
    );
    console.log(`RESULT ${JSON.stringify(results)}`);
  } finally {
    await orm.close(true);
  }
}
