'use strict';

const {
  batchStatus,
  allocateFefo,
  reconcileBatchQuantity,
} = require('../services/pharmacyBatchSafetyService');

describe('Pharmacy Stage 3 batch and FEFO safety', () => {
  test('blocks expired, quarantined and recalled batches', () => {
    const at = new Date('2026-11-23T00:00:00Z');
    expect(batchStatus({ expiryDate: '2026-11-22T00:00:00Z' }, at)).toBe('expired');
    expect(batchStatus({ isQuarantined: true }, at)).toBe('quarantined');
    expect(batchStatus({ recallStatus: 'recalled' }, at)).toBe('recalled');
  });

  test('allocates FEFO across saleable batches only', () => {
    const allocations = allocateFefo([
      { id: 'late', batchNo: 'LATE', qtyOnHand: 5, expiryDate: '2027-01-01T00:00:00Z' },
      { id: 'recalled', batchNo: 'RECALLED', qtyOnHand: 5, recallStatus: 'recalled', expiryDate: '2026-12-01T00:00:00Z' },
      { id: 'early', batchNo: 'EARLY', qtyOnHand: 3, expiryDate: '2026-12-15T00:00:00Z' },
    ], 6, new Date('2026-11-23T00:00:00Z'));
    expect(allocations).toEqual([
      { batchId: 'early', batchNo: 'EARLY', quantity: 3 },
      { batchId: 'late', batchNo: 'LATE', quantity: 3 },
    ]);
  });

  test('returns exact available and reserved reconciliation', () => {
    expect(reconcileBatchQuantity(
      { qtyReceived: 100, qtyOnHand: 60, reservedQuantity: 5 },
      [{ type: 'in', quantity: 100 }, { type: 'out', quantity: 40 }],
    )).toMatchObject({
      received: 100,
      onHand: 60,
      reserved: 5,
      available: 55,
      movementDelta: 60,
      reconciled: true,
    });
  });
});
