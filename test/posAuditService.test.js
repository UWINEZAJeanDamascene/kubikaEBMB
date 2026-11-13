jest.mock('../lib/prisma', () => ({
  prisma: {
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
    posAuditLog: { create: jest.fn(), findFirst: jest.fn() },
  },
}));
jest.mock('../config/redis', () => ({ redisClient: {}, isRedisConfigured: () => false }));

const { prisma } = require('../lib/prisma');
const { GENESIS_HASH, hashAuditRow } = require('../services/posAuditIntegrityService');
const {
  POS_AUDIT_EVENTS,
  sanitizeMetadata,
  withPosAuditCorrelation,
  writePosAuditLog,
  writePosDenialAudit,
  shouldSampleDenial,
} = require('../services/posAuditService');

describe('POS audit logging', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation((callback) => callback(prisma));
    prisma.$queryRaw.mockResolvedValue([]);
    prisma.posAuditLog.findFirst.mockResolvedValue(null);
  });

  test('writes only allowlisted event fields and redacts sensitive metadata values', async () => {
    prisma.posAuditLog.create.mockResolvedValue({ id: 'audit-id' });
    await writePosAuditLog({
      companyId: '507f1f77bcf86cd799439011',
      registerId: '507f1f77bcf86cd799439012',
      userId: '507f1f77bcf86cd799439013',
      event: 'APPROVAL_GRANTED',
      metadata: {
        action: 'VOID_SALE',
        approvalToken: 'do-not-store',
        nested: { pin: '2580', sessionId: 'session-id' },
      },
      ip: '127.0.0.1',
    });

    expect(prisma.posAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        companyId: '507f1f77bcf86cd799439011',
        registerId: '507f1f77bcf86cd799439012',
        userId: '507f1f77bcf86cd799439013',
        event: 'APPROVAL_GRANTED',
        actionId: expect.any(String),
        correlationId: null,
        outcome: 'COMMITTED',
        entityType: null,
        entityId: null,
        hashVersion: 2,
        metadata: {
          action: 'VOID_SALE',
          approvalToken: '[REDACTED]',
          nested: { pin: '[REDACTED]', sessionId: 'session-id' },
        },
        ip: '127.0.0.1',
      }),
    });
    const serialized = JSON.stringify(prisma.posAuditLog.create.mock.calls[0][0], (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
    expect(serialized).not.toContain('2580');
    expect(serialized).not.toContain('do-not-store');
    const saved = prisma.posAuditLog.create.mock.calls[0][0].data;
    expect(saved.streamSequence).toBe(1n);
    expect(saved.prevHash).toBe(GENESIS_HASH);
    expect(saved.hash).toBe(hashAuditRow(saved));
  });

  test('samples repeated denials while retaining exact rolling-window counts in emitted events', async () => {
    prisma.posAuditLog.create.mockImplementation(async ({ data }) => data);
    expect([1, 2, 3, 4, 5, 6, 7, 8].filter(shouldSampleDenial)).toEqual([1, 2, 3, 4, 5, 8]);
    const companyId = 'denial-sampling-company';
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      await writePosDenialAudit({
        companyId, registerId: 'register-a', userId: 'cashier-a', event: 'PIN_LOGIN_FAILED',
        metadata: { flow: 'cashier_pin' },
      });
    }
    const rows = prisma.posAuditLog.create.mock.calls.map(([{ data }]) => data);
    expect(rows).toHaveLength(6);
    expect(rows.map((row) => row.metadata.attemptCountInWindow)).toEqual([1, 2, 3, 4, 5, 8]);
    expect(rows.every((row) => row.metadata.counterScope === 'instance' || row.metadata.counterScope === 'shared')).toBe(true);
  });

  test('serializes a stream and links each entry to the prior hash', async () => {
    const previous = {
      id: 'prior-audit', companyId: 'company', registerId: 'register', userId: 'cashier',
      event: 'SESSION_LOCKED', metadata: null, ip: null,
      streamId: 'company:register:register', streamSequence: 8n,
      prevHash: 'a'.repeat(64), hash: 'b'.repeat(64), createdAt: new Date('2026-11-11T10:00:00.000Z'),
    };
    prisma.posAuditLog.findFirst.mockResolvedValue(previous);
    prisma.posAuditLog.create.mockResolvedValue({ id: 'new-audit' });

    await writePosAuditLog({ companyId: 'company', registerId: 'register', event: 'SESSION_ENDED' });

    const { data } = prisma.posAuditLog.create.mock.calls[0][0];
    expect(data.streamSequence).toBe(9n);
    expect(data.prevHash).toBe('b'.repeat(64));
    expect(data.hash).toBe(hashAuditRow(data));
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw.mock.calls[0][0].join('')).toContain('pg_advisory_xact_lock(hashtext(');
    expect(prisma.$queryRaw.mock.calls[0][0].join('')).toContain('::text AS "locked"');
  });

  test('uses a caller transaction so the audit entry shares the business transaction', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      posAuditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'audit-id' }),
      },
    };
    await writePosAuditLog({ companyId: 'company', event: 'SESSION_ENDED' }, tx);
    expect(tx.posAuditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  test('carries approval correlation into the resulting business-action audit event', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      posAuditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'audit-action' }),
      },
    };

    await withPosAuditCorrelation('approval-correlation-1', () => writePosAuditLog({
      companyId: 'company',
      registerId: 'register',
      userId: 'cashier',
      event: 'POS_ACTION_FAILED',
      metadata: { action: 'REFUND', saleId: 'sale-1' },
    }, tx));

    expect(tx.posAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        correlationId: 'approval-correlation-1',
        outcome: 'FAILED',
        entityType: 'SALE',
        entityId: 'sale-1',
        metadata: {
          action: 'REFUND',
          saleId: 'sale-1',
          correlationId: 'approval-correlation-1',
        },
      }),
    }));
  });

  test('fails the caller transaction when required audit evidence cannot be written', async () => {
    let committedBusinessRows = [];
    prisma.$transaction.mockImplementation(async (callback) => {
      const stagedBusinessRows = [];
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([]),
        posAuditLog: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockRejectedValue(new Error('audit storage unavailable')),
        },
        businessWrite: jest.fn(async (row) => stagedBusinessRows.push(row)),
      };
      try {
        const value = await callback(tx);
        committedBusinessRows = stagedBusinessRows;
        return value;
      } catch (error) {
        stagedBusinessRows.length = 0;
        throw error;
      }
    });

    await expect(prisma.$transaction(async (tx) => {
      await tx.businessWrite({ id: 'sale-effect' });
      await writePosAuditLog({ companyId: 'company', event: 'SESSION_ENDED' }, tx);
    })).rejects.toThrow('audit storage unavailable');
    expect(committedBusinessRows).toEqual([]);
  });

  test('rejects unknown events and missing tenant identity', async () => {
    expect(POS_AUDIT_EVENTS.has('PIN_RESET')).toBe(true);
    expect(POS_AUDIT_EVENTS.has('SHIFT_HISTORY_VIEWED')).toBe(true);
    expect(POS_AUDIT_EVENTS.has('PAYMENT_SETTINGS_UPDATED')).toBe(true);
    expect(POS_AUDIT_EVENTS.has('POS_OFFLINE_ACTION_USAGE_IDEMPOTENCY_CONFLICT')).toBe(true);
    expect(POS_AUDIT_EVENTS.has('DISCOUNT_SETTINGS_UPDATED')).toBe(true);
    expect(POS_AUDIT_EVENTS.has('REGISTER_DISCOUNT_SETTINGS_UPDATED')).toBe(true);
    expect(POS_AUDIT_EVENTS.has('APPROVAL_POLICY_UPDATED')).toBe(true);
    expect(POS_AUDIT_EVENTS.has('PAYMENT_REMOVED')).toBe(true);
    expect(POS_AUDIT_EVENTS.has('PAYMENT_PROVIDER_REQUESTED')).toBe(true);
    expect(POS_AUDIT_EVENTS.has('PAYMENT_PROVIDER_REQUEST_UNCERTAIN')).toBe(true);
    expect(POS_AUDIT_EVENTS.has('PAYMENT_PROVIDER_REQUEST_FAILED')).toBe(true);
    expect(POS_AUDIT_EVENTS.has('PAYMENT_PROVIDER_STATUS_UPDATED')).toBe(true);
    expect(POS_AUDIT_EVENTS.has('GIFT_CARD_ISSUED')).toBe(true);
    expect(POS_AUDIT_EVENTS.has('GIFT_CARD_LOADED')).toBe(true);
    expect(POS_AUDIT_EVENTS.has('GIFT_CARD_REDEEMED')).toBe(true);
    expect(POS_AUDIT_EVENTS.has('GIFT_CARD_REFUNDED')).toBe(true);
    await expect(writePosAuditLog({ companyId: 'company', event: 'UNKNOWN' })).rejects.toThrow('Unsupported POS audit event');
    await expect(writePosAuditLog({ event: 'SESSION_ENDED' })).rejects.toThrow('A company is required');
    expect(prisma.posAuditLog.create).not.toHaveBeenCalled();
  });

  test('accepts and records remote device wipe requests', async () => {
    prisma.posAuditLog.create.mockResolvedValue({ id: 'audit-id' });

    await writePosAuditLog({
      companyId: 'company',
      registerId: 'register',
      userId: 'manager',
      event: 'REGISTER_DEVICE_WIPE_REQUESTED',
      metadata: { deviceId: 'device' },
    });

    expect(prisma.posAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        companyId: 'company',
        registerId: 'register',
        userId: 'manager',
        event: 'REGISTER_DEVICE_WIPE_REQUESTED',
        metadata: { deviceId: 'device' },
      }),
    });
  });

  test('records an offline action usage idempotency conflict', async () => {
    prisma.posAuditLog.create.mockResolvedValue({ id: 'audit-id' });

    await writePosAuditLog({
      companyId: 'company',
      registerId: 'register',
      userId: 'cashier',
      event: 'POS_OFFLINE_ACTION_USAGE_IDEMPOTENCY_CONFLICT',
      metadata: { operationId: 'operation', action: 'card', conflictFields: ['amount'] },
    });

    expect(prisma.posAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        companyId: 'company',
        registerId: 'register',
        userId: 'cashier',
        event: 'POS_OFFLINE_ACTION_USAGE_IDEMPOTENCY_CONFLICT',
        metadata: { operationId: 'operation', action: 'card', conflictFields: ['amount'] },
      }),
    });
  });

  test('sanitizes token, hash, and credential fields recursively', () => {
    expect(sanitizeMetadata({
      approvalId: 'approval-1',
      tokenHash: 'secret-hash',
      credentials: [{ password: 'secret', safe: true }],
    })).toEqual({
      approvalId: 'approval-1',
      tokenHash: '[REDACTED]',
      credentials: '[REDACTED]',
    });
  });

  test('masks personal and payment identifiers without losing useful audit facts', () => {
    expect(sanitizeMetadata({
      action: 'CUSTOMER_UPDATED',
      errorCode: 'VALIDATION_FAILED',
      customerPhone: '+250788123456',
      buyer_tin: '123456789',
      cardNumber: '4111111111111111',
      voucher_code: 'SAVE-1234',
      note: 'Call +250788123456; buyer TIN: 123456789; Authorization Bearer abcdefghijklmnopqrstuvwxyz123456.',
      registerId: 'register-reference',
    })).toEqual({
      action: 'CUSTOMER_UPDATED',
      errorCode: 'VALIDATION_FAILED',
      customerPhone: '[MASKED]',
      buyer_tin: '[MASKED]',
      cardNumber: '[REDACTED]',
      voucher_code: '[REDACTED]',
      note: 'Call [MASKED PHONE]; buyer TIN: [MASKED TIN]; Authorization Bearer [REDACTED].',
      registerId: 'register-reference',
    });
  });

  test('bounds and safely serializes unusual metadata values', () => {
    const circular = { createdAt: new Date('2026-01-02T03:04:05.000Z'), large: 2n };
    circular.self = circular;
    expect(sanitizeMetadata(circular)).toEqual({
      createdAt: '2026-01-02T03:04:05.000Z',
      large: '2',
      self: '[CIRCULAR]',
    });
    expect(sanitizeMetadata({ details: 'x'.repeat(5000) }).details).toHaveLength(4011);
  });
});
