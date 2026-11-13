'use strict';

const {
  RECEIPT_BLOCK_SIZE,
  allocateOfflineReceiptBlock,
  isReceiptNumberCollision,
  retireUnusedReceiptNumbersForShift,
  retireUnusedReceiptNumbersForSnapshots,
} = require('../services/posOfflineReceiptNumberService');

const ids = () => {
  let index = 0;
  return () => `id${String(++index).padStart(22, '0')}`;
};

describe('offline receipt number lifecycle', () => {
  test('refills an exhausted block to the fixed size without duplicating its used prefix', async () => {
    const queryRaw = jest.fn().mockResolvedValue([]);
    const executeRaw = jest.fn().mockResolvedValue(1);
    let next = 1;
    const result = await allocateOfflineReceiptBlock({
      queryRaw,
      executeRaw,
      companyId: 'company',
      deviceId: 'device',
      registerId: 'register',
      blockId: 'snapshot',
      expiresAt: new Date(Date.now() + 60_000),
      nextReferenceNo: async () => `INV-2026-${String(next++).padStart(5, '0')}`,
      generateId: ids(),
    });

    expect(result).toHaveLength(RECEIPT_BLOCK_SIZE);
    expect(new Set(result).size).toBe(RECEIPT_BLOCK_SIZE);
    expect(executeRaw).toHaveBeenCalledTimes(RECEIPT_BLOCK_SIZE);
    expect(queryRaw.mock.calls[0][0]).toMatch(/snapshot\.expires_at <= CURRENT_TIMESTAMP/);
  });

  test('refills an expired block using only expired snapshot reservations and moves them to the new block', async () => {
    const queryRaw = jest.fn().mockResolvedValue([
      { receiptNumber: 'INV-2026-00001' },
      { receiptNumber: 'INV-2026-00002' },
    ]);
    const executeRaw = jest.fn().mockResolvedValue(1);
    let next = 3;
    const result = await allocateOfflineReceiptBlock({
      queryRaw,
      executeRaw,
      companyId: 'company',
      deviceId: 'device',
      registerId: 'register',
      blockId: 'new-snapshot',
      expiresAt: new Date(Date.now() + 60_000),
      nextReferenceNo: async () => `INV-2026-${String(next++).padStart(5, '0')}`,
      generateId: ids(),
      size: 4,
    });

    expect(result).toEqual([
      'INV-2026-00001', 'INV-2026-00002', 'INV-2026-00003', 'INV-2026-00004',
    ]);
    expect(queryRaw.mock.calls[0][0]).toMatch(/FOR UPDATE OF allocation SKIP LOCKED/);
    expect(queryRaw.mock.calls[0].slice(1)).toEqual([
      'company', 'device', 'register', expect.any(Date), 4, 'new-snapshot',
    ]);
    expect(executeRaw).toHaveBeenCalledTimes(2);
    expect(executeRaw.mock.calls[0][0]).toContain('block_index');
    expect(executeRaw.mock.calls[0][6]).toBe(2);
  });

  test('retries number collisions without claiming another document\'s number', async () => {
    const queryRaw = jest.fn().mockResolvedValue([]);
    const claimed = new Set();
    const executeRaw = jest.fn(async (_sql, _id, _company, _device, _register, _block, _index, number) => {
      if (claimed.has(number)) {
        const error = new Error('unique collision');
        error.code = 'P2002';
        throw error;
      }
      if (number.endsWith('00001')) {
        claimed.add(number);
        const error = new Error('invoice already owns number');
        error.meta = { code: '23505' };
        throw error;
      }
      claimed.add(number);
      return 1;
    });
    let next = 1;
    const result = await allocateOfflineReceiptBlock({
      queryRaw,
      executeRaw,
      companyId: 'company',
      deviceId: 'device',
      registerId: 'register',
      blockId: 'snapshot',
      expiresAt: new Date(Date.now() + 60_000),
      nextReferenceNo: async () => `INV-2026-${String(next++).padStart(5, '0')}`,
      generateId: ids(),
      size: 2,
    });

    expect(result).toEqual(['INV-2026-00002', 'INV-2026-00003']);
    expect(new Set(result).size).toBe(2);
    expect(executeRaw).toHaveBeenCalledTimes(3);
    expect(isReceiptNumberCollision({ meta: { code: '23505' } })).toBe(true);
  });

  test('rejects allocations outside the supported block capacity', async () => {
    await expect(allocateOfflineReceiptBlock({ size: RECEIPT_BLOCK_SIZE + 1 }))
      .rejects.toThrow(/between 1 and 50/);
  });

  test('retires every unused number in the closing shift and returns an auditable count', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: 'unused-1' }, { id: 'unused-2' }]),
    };
    const at = new Date('2026-11-11T12:00:00.000Z');
    const retired = await retireUnusedReceiptNumbersForShift(tx, {
      companyId: 'company',
      tillSessionId: 'till-session',
      at,
    });

    expect(retired).toBe(2);
    const [sql, companyId, tillSessionId, timestamp] = tx.$queryRawUnsafe.mock.calls[0];
    expect(sql).toContain("retirement_reason = 'SHIFT_CLOSED'");
    expect(sql).toContain('allocation.operation_id IS NULL');
    expect(sql).toContain('allocation.used_at IS NULL');
    expect(sql).toContain('snapshot.till_session_id = $2');
    expect([companyId, tillSessionId, timestamp]).toEqual(['company', 'till-session', at]);
  });

  test('retires unused allocations only after the final sync batch is confirmed drained', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: 'unused-a' }, { id: 'unused-b' }]),
    };
    const at = new Date('2026-11-11T12:30:00.000Z');
    const retired = await retireUnusedReceiptNumbersForSnapshots(tx, {
      companyId: 'company', deviceId: 'device', snapshotIds: ['snapshot-a', 'snapshot-b', 'snapshot-a'], at,
    });

    expect(retired).toBe(2);
    const [sql, companyId, deviceId, snapshotIds, timestamp] = tx.$queryRawUnsafe.mock.calls[0];
    expect(sql).toContain("retirement_reason = 'SYNC_COMPLETED'");
    expect(sql).toContain('allocation.operation_id IS NULL');
    expect(sql).toContain('allocation.used_at IS NULL');
    expect(sql).toContain('allocation.retired_at IS NULL');
    expect([companyId, deviceId, snapshotIds, timestamp]).toEqual([
      'company', 'device', ['snapshot-a', 'snapshot-b'], at,
    ]);
  });

  test('does not query when no completed snapshot IDs are supplied', async () => {
    const tx = { $queryRawUnsafe: jest.fn() };
    await expect(retireUnusedReceiptNumbersForSnapshots(tx, {
      companyId: 'company', deviceId: 'device', snapshotIds: [],
    })).resolves.toBe(0);
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});
