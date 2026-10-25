import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';
import {
  type CreateWagerTransactionProps,
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  WagerTransaction,
  WagerTransactionKind,
  type WagerTransactionState,
  WagerTransactionStatus,
} from '../../src/domain/wager-transaction';
import { LedgerDirection } from '../../src/domain/wallet-ledger-entry';

const brl = (cents: bigint) => Money.fromCents(cents, 'BRL');
const T0 = new Date('2026-10-25T12:00:00.000Z');
const T1 = new Date('2026-10-25T12:00:05.000Z');

type Kind = WagerTransactionKind;
const { Bet, Win, Loss, Refund, Rollback, Opening } = WagerTransactionKind;
const { Pending, PendingReference, Processed, Rejected, Failed } = WagerTransactionStatus;

function props(kind: Kind = Bet, overrides: Partial<CreateWagerTransactionProps> = {}) {
  const needsReference = kind === Refund || kind === Rollback;
  return {
    id: `tx-${kind.toLowerCase()}`,
    providerId: 'provider-a',
    externalTransactionId: `ext-${kind.toLowerCase()}`,
    idempotencyKey: `provider-a:ext-${kind.toLowerCase()}`,
    payloadHash: 'hash-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: brl(2_500n),
    ...(needsReference ? { referenceExternalTransactionId: 'ext-bet' } : {}),
    createdAt: T0,
    ...overrides,
  } satisfies CreateWagerTransactionProps;
}

const create = (kind: Kind = Bet, overrides: Partial<CreateWagerTransactionProps> = {}) =>
  WagerTransaction.create(props(kind, overrides));

function snapshot(tx: WagerTransaction) {
  return {
    status: tx.status,
    failureCode: tx.failureCode,
    referenceTransactionId: tx.referenceTransactionId,
    processedAt: tx.processedAt?.getTime(),
  };
}

describe('WagerTransaction.create', () => {
  test('nasce em PENDING, sem resultado, com os campos informados', () => {
    const tx = create(Bet);

    expect(tx.status).toBe(Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.failureCode).toBeUndefined();
    expect(tx.referenceTransactionId).toBeUndefined();
    expect(tx.processedAt).toBeUndefined();
    expect(tx.kind).toBe(Bet);
    expect(tx.money.equals(brl(2_500n))).toBe(true);
    expect(tx.providerId).toBe('provider-a');
    expect(tx.idempotencyKey).toBe('provider-a:ext-bet');
    expect(tx.createdAt.getTime()).toBe(T0.getTime());
  });

  test.each([Bet, Win, Loss, Refund, Rollback])('aceita o tipo submetível %s', (kind) => {
    expect(create(kind).status).toBe(Pending);
  });

  test('rejeita OPENING, que é interno e não pode ser submetido', () => {
    expect(() => create(Opening)).toThrow('OPENING é interno');
  });

  test('rejeita tipo desconhecido', () => {
    expect(() => create('DEPOSIT' as Kind)).toThrow(InvalidWagerTransactionError);
  });

  test.each([Refund, Rollback])('%s exige referenceExternalTransactionId', (kind) => {
    expect(() => create(kind, { referenceExternalTransactionId: undefined })).toThrow(
      'exige referenceExternalTransactionId',
    );
  });

  test('WIN aceita referência opcional', () => {
    expect(create(Win).referenceExternalTransactionId).toBeUndefined();
    expect(
      create(Win, { referenceExternalTransactionId: 'ext-bet' }).referenceExternalTransactionId,
    ).toBe('ext-bet');
  });

  test('rejeita valor negativo (contrato §6.1)', () => {
    expect(() => create(Bet, { money: brl(-1n) })).toThrow('não pode ser negativo');
  });

  test('aceita valor zero sem classificá-lo: continua PENDING', () => {
    const tx = create(Bet, { money: brl(0n) });

    expect(tx.status).toBe(Pending);
    expect(tx.money.isZero()).toBe(true);
  });

  test.each([
    'id',
    'providerId',
    'externalTransactionId',
    'idempotencyKey',
    'payloadHash',
    'walletId',
    'playerId',
    'roundId',
    'gameId',
  ] as const)('rejeita %s vazio ou ausente', (field) => {
    expect(() => create(Bet, { [field]: '' })).toThrow(`${field} deve ser`);
    expect(() => create(Bet, { [field]: '   ' })).toThrow(InvalidWagerTransactionError);
    expect(() => create(Bet, { [field]: undefined as unknown as string })).toThrow(
      InvalidWagerTransactionError,
    );
  });

  test.each([
    ['referência em branco', { referenceExternalTransactionId: ' ' }],
    ['money que não é Money', { money: { cents: 1n } as unknown as Money }],
    ['data inválida', { createdAt: new Date('invalid') }],
    ['data que não é Date', { createdAt: '2026-10-25' as unknown as Date }],
  ])('rejeita %s', (_case, overrides) => {
    expect(() => create(Win, overrides)).toThrow(InvalidWagerTransactionError);
  });
});

describe('WagerTransaction: transições a partir de PENDING', () => {
  test('markProcessed → PROCESSED (terminal), com processedAt', () => {
    const tx = create(Bet);

    tx.markProcessed(undefined, T1);

    expect(tx.status).toBe(Processed);
    expect(tx.isTerminal()).toBe(true);
    expect(tx.processedAt?.getTime()).toBe(T1.getTime());
    expect(tx.referenceTransactionId).toBeUndefined();
    expect(tx.failureCode).toBeUndefined();
  });

  test.each([Refund, Rollback])('%s processada registra o id interno da referência', (kind) => {
    const tx = create(kind);

    tx.markProcessed('tx-internal-bet', T1);

    expect(tx.status).toBe(Processed);
    expect(tx.referenceTransactionId).toBe('tx-internal-bet');
  });

  test.each([Refund, Rollback])(
    '%s não pode ser processada sem o id interno da referência',
    (kind) => {
      const tx = create(kind);
      const before = snapshot(tx);

      expect(() => tx.markProcessed(undefined, T1)).toThrow(InvalidTransactionStateError);
      expect(snapshot(tx)).toEqual(before);
    },
  );

  test('WIN com referência externa pode ser processada com ou sem o id interno (pendente de contrato)', () => {
    const resolved = create(Win, { referenceExternalTransactionId: 'ext-bet' });
    const unresolved = create(Win, { referenceExternalTransactionId: 'ext-bet' });

    resolved.markProcessed('tx-internal-bet', T1);
    unresolved.markProcessed(undefined, T1);

    expect(resolved.referenceTransactionId).toBe('tx-internal-bet');
    expect(unresolved.referenceTransactionId).toBeUndefined();
  });

  test('transação sem referência externa não aceita id interno de referência', () => {
    const tx = create(Bet);
    const before = snapshot(tx);

    expect(() => tx.markProcessed('tx-x', T1)).toThrow('não há referência externa');
    expect(snapshot(tx)).toEqual(before);
  });

  test.each([
    ['data inválida', 'tx-x', new Date('invalid')],
    ['referência interna em branco', ' ', T1],
  ])('markProcessed com %s falha sem alterar o estado', (_case, reference, at) => {
    const tx = create(Refund);
    const before = snapshot(tx);

    expect(() => tx.markProcessed(reference, at)).toThrow(InvalidWagerTransactionError);
    expect(snapshot(tx)).toEqual(before);
  });

  test('markPendingReference → PENDING_REFERENCE (não terminal)', () => {
    const tx = create(Refund);

    tx.markPendingReference();

    expect(tx.status).toBe(PendingReference);
    expect(tx.isTerminal()).toBe(false);
  });

  test('markPendingReference exige referência externa', () => {
    const tx = create(Bet);

    expect(() => tx.markPendingReference()).toThrow('não referencia outra transação');
    expect(tx.status).toBe(Pending);
  });

  test('reject → REJECTED (terminal), com failureCode', () => {
    const tx = create(Bet);

    tx.reject('EXAMPLE_RULE_CODE');

    expect(tx.status).toBe(Rejected);
    expect(tx.isTerminal()).toBe(true);
    expect(tx.failureCode).toBe('EXAMPLE_RULE_CODE');
    expect(tx.processedAt).toBeUndefined();
  });

  test('fail → FAILED (terminal), com failureCode', () => {
    const tx = create(Bet);

    tx.fail('EXAMPLE_INFRA_CODE');

    expect(tx.status).toBe(Failed);
    expect(tx.isTerminal()).toBe(true);
    expect(tx.failureCode).toBe('EXAMPLE_INFRA_CODE');
  });

  test.each([
    ['vazio', ''],
    ['minúsculas', 'insufficient_funds'],
    ['com espaço', 'NO FUNDS'],
    ['começando por dígito', '1_ERROR'],
    ['com hífen', 'NO-FUNDS'],
    ['não string', 42 as unknown as string],
  ])('failureCode %s é rejeitado sem alterar o estado', (_case, code) => {
    const tx = create(Bet);

    expect(() => tx.reject(code)).toThrow(InvalidWagerTransactionError);
    expect(() => tx.fail(code)).toThrow(InvalidWagerTransactionError);
    expect(snapshot(tx)).toEqual({
      status: Pending,
      failureCode: undefined,
      referenceTransactionId: undefined,
      processedAt: undefined,
    });
  });
});

describe('WagerTransaction: transições a partir de PENDING_REFERENCE (contrato §7.1)', () => {
  const pendingReference = () => {
    const tx = create(Rollback);
    tx.markPendingReference();
    return tx;
  };

  test('pode continuar aguardando (markPendingReference repetido)', () => {
    const tx = pendingReference();

    tx.markPendingReference();

    expect(tx.status).toBe(PendingReference);
  });

  test('referência encontrada → PROCESSED', () => {
    const tx = pendingReference();

    tx.markProcessed('tx-internal-bet', T1);

    expect(tx.status).toBe(Processed);
    expect(tx.referenceTransactionId).toBe('tx-internal-bet');
  });

  test('limite esgotado → REJECTED com failureCode', () => {
    const tx = pendingReference();

    tx.reject('EXAMPLE_REFERENCE_CODE');

    expect(tx.status).toBe(Rejected);
    expect(tx.failureCode).toBe('EXAMPLE_REFERENCE_CODE');
  });

  test('erro permanente → FAILED', () => {
    const tx = pendingReference();

    tx.fail('EXAMPLE_INFRA_CODE');

    expect(tx.status).toBe(Failed);
  });
});

describe('WagerTransaction: estados terminais não mudam mais', () => {
  const terminal: Array<[string, () => WagerTransaction]> = [
    [
      'PROCESSED',
      () => {
        const tx = create(Refund);
        tx.markProcessed('tx-internal-bet', T1);
        return tx;
      },
    ],
    [
      'REJECTED',
      () => {
        const tx = create(Refund);
        tx.reject('EXAMPLE_RULE_CODE');
        return tx;
      },
    ],
    [
      'FAILED',
      () => {
        const tx = create(Refund);
        tx.fail('EXAMPLE_INFRA_CODE');
        return tx;
      },
    ],
  ];
  const transitions: Array<[string, (tx: WagerTransaction) => void]> = [
    ['markProcessed', (tx) => tx.markProcessed('tx-other', T1)],
    ['markPendingReference', (tx) => tx.markPendingReference()],
    ['reject', (tx) => tx.reject('EXAMPLE_RULE_CODE')],
    ['fail', (tx) => tx.fail('EXAMPLE_INFRA_CODE')],
  ];

  for (const [state, make] of terminal) {
    test.each(transitions)(
      `${state}: %s lança InvalidTransactionStateError sem alterar o estado`,
      (_n, transition) => {
        const tx = make();
        const before = snapshot(tx);

        expect(() => transition(tx)).toThrow(InvalidTransactionStateError);
        expect(snapshot(tx)).toEqual(before);
        expect(tx.isTerminal()).toBe(true);
      },
    );
  }

  test('o erro informa transação, estado atual e transição tentada', () => {
    const tx = create(Bet);
    tx.reject('EXAMPLE_RULE_CODE');
    let caught: unknown;

    try {
      tx.markProcessed(undefined, T1);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(InvalidTransactionStateError);
    const error = caught as InvalidTransactionStateError;
    expect(error.transactionId).toBe(tx.id);
    expect(error.status).toBe(Rejected);
    expect(error.transition).toBe('markProcessed');
  });
});

describe('WagerTransaction: consultas de domínio', () => {
  test.each([
    [Bet, true],
    [Win, true],
    [Refund, true],
    [Rollback, true],
    [Loss, false],
  ])('affectsBalance(%s) = %p', (kind, expected) => {
    expect(create(kind).affectsBalance()).toBe(expected);
  });

  test.each([
    [Bet, false],
    [Win, false],
    [Loss, false],
    [Refund, true],
    [Rollback, true],
  ])('requiresReference(%s) = %p', (kind, expected) => {
    expect(create(kind).requiresReference()).toBe(expected);
  });

  test('matchesPayload compara o hash do payload', () => {
    const tx = create(Bet, { payloadHash: 'abc' });

    expect(tx.matchesPayload('abc')).toBe(true);
    expect(tx.matchesPayload('abd')).toBe(false);
  });

  test.each([
    [Bet, LedgerDirection.Debit],
    [Win, LedgerDirection.Credit],
    [Refund, LedgerDirection.Credit],
  ])('ledgerDirectionFor(%s) = %s', (kind, direction) => {
    expect(create(kind).ledgerDirectionFor()).toBe(direction);
  });

  test.each([
    [Bet, LedgerDirection.Credit],
    [Win, LedgerDirection.Debit],
    [Refund, LedgerDirection.Debit],
  ])('ROLLBACK de %s inverte a direção: %s', (referenceKind, direction) => {
    expect(create(Rollback).ledgerDirectionFor(create(referenceKind))).toBe(direction);
  });

  test.each([
    ['sem referência', undefined],
    ['referência LOSS', () => create(Loss)],
    ['referência ROLLBACK', () => create(Rollback)],
  ])('ROLLBACK %s não tem direção definida', (_case, reference) => {
    const ref = typeof reference === 'function' ? reference() : reference;

    expect(() => create(Rollback).ledgerDirectionFor(ref)).toThrow('BET, WIN ou REFUND');
  });

  test('LOSS não gera lançamento', () => {
    expect(() => create(Loss).ledgerDirectionFor()).toThrow('LOSS não gera lançamento');
  });
});

describe('WagerTransaction.rehydrate e encapsulamento', () => {
  const persisted = (overrides: Partial<WagerTransactionState> = {}): WagerTransactionState => ({
    ...props(Refund),
    status: Processed,
    referenceTransactionId: 'tx-internal-bet',
    processedAt: T1,
    ...overrides,
  });

  test('reconstrói o estado persistido sem revalidar', () => {
    const tx = WagerTransaction.rehydrate(persisted());

    expect(tx.status).toBe(Processed);
    expect(tx.referenceTransactionId).toBe('tx-internal-bet');
    expect(tx.processedAt?.getTime()).toBe(T1.getTime());
    expect(tx.isTerminal()).toBe(true);
  });

  test('estado reidratado terminal continua bloqueando transições', () => {
    const tx = WagerTransaction.rehydrate(persisted());

    expect(() => tx.reject('EXAMPLE_RULE_CODE')).toThrow(InvalidTransactionStateError);
  });

  test('estado reidratado não terminal segue a máquina de estados', () => {
    const tx = WagerTransaction.rehydrate(
      persisted({
        status: PendingReference,
        referenceTransactionId: undefined,
        processedAt: undefined,
      }),
    );

    tx.markProcessed('tx-internal-bet', T1);

    expect(tx.status).toBe(Processed);
  });

  test('OPENING persistido pode ser reidratado e credita', () => {
    const tx = WagerTransaction.rehydrate(
      persisted({ kind: Opening, referenceExternalTransactionId: undefined }),
    );

    expect(tx.kind).toBe(Opening);
    expect(tx.ledgerDirectionFor()).toBe('CREDIT');
  });

  test('campos públicos protegidos e datas copiadas na entrada e na saída', () => {
    const createdAt = new Date(T0.getTime());
    const at = new Date(T1.getTime());
    const tx = create(Bet, { createdAt });
    tx.markProcessed(undefined, at);

    expect(Object.isFrozen(tx)).toBe(true);
    expect(() => {
      (tx as unknown as { kind: string }).kind = 'WIN';
    }).toThrow(TypeError);
    expect(() => {
      (tx as unknown as { status: string }).status = Pending;
    }).toThrow(TypeError);
    createdAt.setUTCFullYear(2000);
    at.setUTCFullYear(2000);
    tx.createdAt.setUTCFullYear(1999);
    tx.processedAt?.setUTCFullYear(1999);

    expect(tx.kind).toBe(Bet);
    expect(tx.status).toBe(Processed);
    expect(tx.createdAt.getTime()).toBe(T0.getTime());
    expect(tx.processedAt?.getTime()).toBe(T1.getTime());
  });
});

describe('WagerTransaction: PENDING_REFERENCE só é processada com a referência resolvida', () => {
  // Estado observável completo, para provar que uma tentativa inválida não altera nada.
  const observable = (tx: WagerTransaction) => ({
    ...snapshot(tx),
    kind: tx.kind,
    referenceExternalTransactionId: tx.referenceExternalTransactionId,
    cents: tx.money.cents,
    isTerminal: tx.isTerminal(),
  });

  const awaiting = (kind: Kind) => {
    const tx = create(kind, { referenceExternalTransactionId: 'ext-bet' });
    tx.markPendingReference();
    return tx;
  };

  test.each([Win, Bet, Refund, Rollback])(
    '%s em PENDING_REFERENCE sem o id interno da referência é rejeitada sem alterar o estado',
    (kind) => {
      const tx = awaiting(kind);
      const before = observable(tx);

      expect(before).toMatchObject({
        status: PendingReference,
        referenceTransactionId: undefined,
        failureCode: undefined,
        processedAt: undefined,
      });
      expect(() => tx.markProcessed(undefined, T1)).toThrow(InvalidTransactionStateError);
      expect(observable(tx)).toEqual(before);
    },
  );

  test.each([Win, Bet, Refund, Rollback])(
    '%s em PENDING_REFERENCE com o id interno da referência chega a PROCESSED',
    (kind) => {
      const tx = awaiting(kind);

      tx.markProcessed('tx-internal-bet', T1);

      expect(tx.status).toBe(Processed);
      expect(tx.referenceTransactionId).toBe('tx-internal-bet');
      expect(tx.processedAt?.getTime()).toBe(T1.getTime());
      expect(tx.failureCode).toBeUndefined();
    },
  );

  test('após a tentativa inválida, a transação continua utilizável e resolve a referência', () => {
    const tx = awaiting(Win);

    expect(() => tx.markProcessed(undefined, T1)).toThrow('aguarda a referência');
    tx.markProcessed('tx-internal-bet', T1);

    expect(tx.status).toBe(Processed);
    expect(tx.referenceTransactionId).toBe('tx-internal-bet');
  });

  test('WIN em PENDING continua podendo ser processada sem o id interno (regra anterior)', () => {
    const tx = create(Win, { referenceExternalTransactionId: 'ext-bet' });

    tx.markProcessed(undefined, T1);

    expect(tx.status).toBe(Processed);
    expect(tx.referenceTransactionId).toBeUndefined();
  });
});
