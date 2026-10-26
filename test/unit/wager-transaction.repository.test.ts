import { describe, expect, test } from 'bun:test';
import { DeadlockException, UniqueConstraintViolationException } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { TransientPersistenceError } from '../../src/application/wager-transaction-repository';
import {
  isTransientPersistenceFailure,
  MikroOrmWagerTransactionRepository,
} from '../../src/database/repositories/wager-transaction.repository';

const withCode = (code: string) => Object.assign(new Error(`falha ${code}`), { code });
const keys = { idempotencyKey: 'k', providerId: 'p', externalTransactionId: 'e' };

/** ORM falso cujo `fork()` lança o erro informado, como uma falha ao obter conexão. */
function failingOrm(error: unknown) {
  return {
    em: {
      fork() {
        throw error;
      },
    },
  } as unknown as MikroORM;
}

describe('isTransientPersistenceFailure', () => {
  test.each([
    ['DeadlockException do MikroORM', new DeadlockException(withCode('40P01'))],
    ['serialização (40001)', withCode('40001')],
    ['conexão encerrada (08006)', withCode('08006')],
    ['conexão recusada pelo servidor (08001)', withCode('08001')],
    ['servidor encerrando (57P01)', withCode('57P01')],
    ['servidor iniciando (57P03)', withCode('57P03')],
    ['conexões esgotadas (53300)', withCode('53300')],
    ['lock indisponível (55P03)', withCode('55P03')],
    ['socket recusado', withCode('ECONNREFUSED')],
    ['socket reiniciado', withCode('ECONNRESET')],
  ])('transitória: %s', (_case, error) => {
    expect(isTransientPersistenceFailure(error)).toBe(true);
  });

  test.each([
    ['violação de unicidade', new UniqueConstraintViolationException(withCode('23505'))],
    ['violação de CHECK', withCode('23514')],
    ['sintaxe SQL', withCode('42601')],
    ['erro sem código', new Error('bug')],
    ['valor que não é erro', 'falha'],
    ['null', null],
  ])('não transitória: %s', (_case, error) => {
    expect(isTransientPersistenceFailure(error)).toBe(false);
  });
});

describe('MikroOrmWagerTransactionRepository: classificação de falhas', () => {
  test('falha transitória vira TransientPersistenceError, com a causa preservada', async () => {
    const cause = withCode('08006');
    const repository = new MikroOrmWagerTransactionRepository(failingOrm(cause));

    for (const attempt of [
      repository.findExisting(keys),
      repository.applyToLockedWallet(
        'w',
        keys,
        { correlationId: 'c', decidedAt: new Date() },
        () => {
          throw new Error('não deveria decidir');
        },
      ),
    ]) {
      const error = await attempt.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TransientPersistenceError);
      expect((error as Error).cause).toBe(cause);
    }
  });

  test('falha não transitória segue inalterada', async () => {
    const cause = withCode('42601');
    const repository = new MikroOrmWagerTransactionRepository(failingOrm(cause));

    await expect(repository.findExisting(keys)).rejects.toBe(cause);
  });
});
