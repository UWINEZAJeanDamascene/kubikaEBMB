jest.mock('../lib/prisma', () => ({ prisma: {} }));

const { prisma } = require('../lib/prisma');

const {
  GENESIS_HASH,
  hashAuditRow,
  hashCheckpoint,
  verifyPosAuditIntegrity,
  createDailyPosAuditCheckpoints,
} = require('../services/posAuditIntegrityService');

function auditRow(sequence, previousHash, overrides = {}) {
  const row = {
    id: `audit-${sequence}`,
    companyId: 'company-a',
    registerId: 'register-a',
    userId: 'cashier-a',
    event: 'SESSION_ENDED',
    metadata: { sequence },
    ip: null,
    streamId: 'company-a:register:register-a',
    streamSequence: BigInt(sequence),
    prevHash: previousHash,
    createdAt: new Date(`2026-11-11T10:0${sequence}:00.000Z`),
  };
  return { ...row, hash: hashAuditRow(row), ...overrides };
}

function checkpointFor(row, date = '2026-11-11') {
  const checkpoint = {
    id: `checkpoint-${date}`,
    companyId: row.companyId,
    streamId: row.streamId,
    checkpointDate: new Date(`${date}T00:00:00.000Z`),
    streamSequence: row.streamSequence,
    auditLogId: row.id,
    auditHash: row.hash,
  };
  return { ...checkpoint, checkpointHash: hashCheckpoint(checkpoint) };
}

describe('POS audit hash-chain verification and checkpoints', () => {
  const streamId = 'company-a:register:register-a';

  test('verifies an intact chain and its checkpoint', async () => {
    const first = auditRow(1, GENESIS_HASH);
    const second = auditRow(2, first.hash);
    const client = {
      posAuditLog: {
        findMany: jest.fn().mockResolvedValueOnce([first, second]).mockResolvedValueOnce([]),
        count: jest.fn().mockResolvedValue(0),
      },
      posAuditCheckpoint: { findMany: jest.fn().mockResolvedValue([checkpointFor(second)]) },
    };

    const result = await verifyPosAuditIntegrity({ companyId: 'company-a', streamId, client });
    expect(result).toMatchObject({ valid: true, checkedRows: 2, verifiedCheckpoints: 1, legacyUnverifiedRows: 0 });
    expect(result.streams[0].lastVerifiedSequence).toBe('2');
  });

  test('reports tampered rows and broken sequence links', async () => {
    const first = auditRow(1, GENESIS_HASH);
    const tampered = auditRow(2, first.hash, { metadata: { sequence: 'changed' } });
    const client = {
      posAuditLog: {
        findMany: jest.fn().mockResolvedValueOnce([first, tampered]),
        count: jest.fn().mockResolvedValue(0),
      },
      posAuditCheckpoint: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const result = await verifyPosAuditIntegrity({ companyId: 'company-a', streamId, client });
    expect(result.valid).toBe(false);
    expect(result.streams[0].firstBreak.reason).toBe('ROW_HASH_MISMATCH');
  });

  test('hashes structured action context and keeps legacy hash representation verifiable', () => {
    const versionTwo = auditRow(1, GENESIS_HASH);
    Object.assign(versionTwo, {
      hashVersion: 2,
      actionId: 'action-1',
      correlationId: 'correlation-1',
      outcome: 'COMMITTED',
      entityType: 'CUSTOMER',
      entityId: 'customer-1',
    });
    versionTwo.hash = hashAuditRow(versionTwo);
    const changed = { ...versionTwo, outcome: 'FAILED' };
    expect(hashAuditRow(versionTwo)).toBe(versionTwo.hash);
    expect(hashAuditRow(changed)).not.toBe(versionTwo.hash);

    const legacy = auditRow(2, versionTwo.hash);
    expect(hashAuditRow(legacy)).toBe(legacy.hash);
  });

  test('reports legacy rows as unverified without treating them as valid chained evidence', async () => {
    const client = {
      posAuditLog: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(3),
      },
      posAuditCheckpoint: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const result = await verifyPosAuditIntegrity({ companyId: 'company-a', streamId, client });
    expect(result).toMatchObject({ valid: true, legacyUnverifiedRows: 3 });
    expect(result.legacyCoverageNote).toMatch(/before the hash-chain cutover/);
  });

  test('rejects a checkpoint whose digest or row reference was altered', async () => {
    const row = auditRow(1, GENESIS_HASH);
    const checkpoint = { ...checkpointFor(row), auditHash: 'f'.repeat(64) };
    const client = {
      posAuditLog: {
        findMany: jest.fn().mockResolvedValueOnce([row]),
        count: jest.fn().mockResolvedValue(0),
      },
      posAuditCheckpoint: { findMany: jest.fn().mockResolvedValue([checkpoint]) },
    };
    const result = await verifyPosAuditIntegrity({ companyId: 'company-a', streamId, client });
    expect(result.valid).toBe(false);
    expect(result.streams[0].firstBreak.reason).toBe('CHECKPOINT_HASH_MISMATCH');
  });

  test('creates one checkpoint per active stream and skips an existing date on rerun', async () => {
    const row = auditRow(4, 'a'.repeat(64));
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      posAuditLog: {
        findMany: jest.fn().mockResolvedValue([{ streamId }]),
        findFirst: jest.fn().mockResolvedValue(row),
      },
      posAuditCheckpoint: {
        findUnique: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'exists' }),
        create: jest.fn().mockImplementation(async ({ data }) => data),
      },
    };
    prisma.$transaction = jest.fn((callback) => callback(tx));
    const date = new Date('2026-11-11T00:00:00.000Z');

    const created = await createDailyPosAuditCheckpoints({ companyId: 'company-a', checkpointDate: date });
    const rerun = await createDailyPosAuditCheckpoints({ companyId: 'company-a', checkpointDate: date });

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(created.created).toHaveLength(1);
    expect(created.created[0].checkpointHash).toBe(hashCheckpoint(created.created[0]));
    expect(rerun.created).toHaveLength(0);
    expect(rerun.skipped).toEqual([streamId]);
    expect(tx.$queryRaw.mock.calls.every(([query]) => query.join('').includes('::text AS "locked"'))).toBe(true);
  });
});
