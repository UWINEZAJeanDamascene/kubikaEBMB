'use strict';

jest.mock('../services/posTrackedStockService', () => ({
  consumeLegacyBatchQuantity: jest.fn().mockResolvedValue(undefined),
}));

const {
  reservePharmacyPendingSale,
  consumeReservedPharmacyBatches,
  releasePharmacyPendingSaleReservation,
} = require('../services/posPharmacyPendingStockReservationService');
const { consumeLegacyBatchQuantity } = require('../services/posTrackedStockService');

function stockUpdate(quantity = 4) {
  return {
    product: { _id: '507f1f77bcf86cd799439001', name: 'Medicine', trackingType: 'batch' },
    quantity,
    trackingType: 'batch',
    warehouseId: '507f1f77bcf86cd799439002',
    lineData: { lineOrder: 0, batchAllocations: [] },
  };
}

function transaction({ batchQuantity = 8, batchReserved = 3 } = {}) {
  return {
    $queryRawUnsafe: jest.fn(async (query) => {
      if (query.includes('SELECT qty_on_hand AS "qtyOnHand"')) {
        return [{ qtyOnHand: 20, qtyReserved: 2 }];
      }
      if (query.includes('COALESCE(SUM(qty_on_hand)')) return [{ quantity: '0' }];
      if (query.includes('SELECT id, batch_no AS "batchNo"')) {
        return [{
          id: '507f1f77bcf86cd799439003',
          batchNo: 'BATCH-1',
          qtyOnHand: batchQuantity,
          reservedQuantity: batchReserved,
          unitCost: 2.5,
        }];
      }
      throw new Error(`Unexpected SQL query: ${query}`);
    }),
    $executeRawUnsafe: jest.fn().mockResolvedValue(1),
  };
}

describe('Pharmacy pending stock reservations', () => {
  beforeEach(() => jest.clearAllMocks());

  test('locks stock and reserves eligible FEFO batch quantity in the pending-sale transaction', async () => {
    const tx = transaction();

    const result = await reservePharmacyPendingSale(tx, {
      companyId: '507f1f77bcf86cd799439010',
      invoiceId: '507f1f77bcf86cd799439011',
      registerId: '507f1f77bcf86cd799439012',
      stockUpdates: [stockUpdate()],
    });

    expect(result).toMatchObject({
      status: 'reserved',
      lines: [{
        productId: '507f1f77bcf86cd799439001',
        quantity: 4,
        allocations: [{
          batchId: '507f1f77bcf86cd799439003',
          batchNo: 'BATCH-1',
          quantity: 4,
        }],
      }],
    });
    expect(tx.$queryRawUnsafe.mock.calls[0][0]).toContain('FOR UPDATE');
    expect(tx.$queryRawUnsafe.mock.calls[2][0]).toContain('FOR UPDATE');
    expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(3);
    expect(tx.$executeRawUnsafe.mock.calls[0][0]).toContain('reserved_quantity = reserved_quantity +');
    expect(tx.$executeRawUnsafe.mock.calls[1][0]).toContain('qty_reserved = qty_reserved +');
    expect(tx.$executeRawUnsafe.mock.calls[2][0]).toContain('INSERT INTO pos_pharmacy_pending_stock_reservations');
  });

  test('does not persist partial reservation when unexpired batch stock is insufficient', async () => {
    const tx = transaction({ batchQuantity: 4, batchReserved: 2 });

    await expect(reservePharmacyPendingSale(tx, {
      companyId: '507f1f77bcf86cd799439010',
      invoiceId: '507f1f77bcf86cd799439011',
      registerId: '507f1f77bcf86cd799439012',
      stockUpdates: [stockUpdate()],
    })).rejects.toMatchObject({ code: 'WAREHOUSE_STOCK_CHANGED' });

    expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  test('consumes only the exact reserved batch quantity and decrements its legacy batch once', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{
        batchNo: 'BATCH-1',
        unitCost: 2.5,
        qtyOnHand: 8,
        reservedQuantity: 4,
        recallStatus: 'active',
        isQuarantined: false,
        expiryDate: null,
      }]),
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
    };

    const result = await consumeReservedPharmacyBatches(tx, {
      companyId: '507f1f77bcf86cd799439010',
      productId: '507f1f77bcf86cd799439001',
      warehouseId: '507f1f77bcf86cd799439002',
      reservationLine: {
        quantity: 4,
        allocations: [{ batchId: '507f1f77bcf86cd799439003', batchNo: 'BATCH-1', quantity: 4 }],
      },
      session: {},
    });

    expect(result).toMatchObject({ quantity: 4, totalCost: 10 });
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('reserved_quantity = reserved_quantity -'),
      4,
      '507f1f77bcf86cd799439003',
    );
    expect(consumeLegacyBatchQuantity).toHaveBeenCalledTimes(1);
    expect(consumeLegacyBatchQuantity).toHaveBeenCalledWith(
      '507f1f77bcf86cd799439010',
      '507f1f77bcf86cd799439001',
      '507f1f77bcf86cd799439002',
      'BATCH-1',
      4,
      {},
    );
  });

  test('releases product and batch reservations once when an unpaid sale is cancelled', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{
        id: 'reservation-1',
        status: 'reserved',
        lines: [{
          productId: '507f1f77bcf86cd799439001',
          warehouseId: '507f1f77bcf86cd799439002',
          quantity: 4,
          allocations: [{
            batchId: '507f1f77bcf86cd799439003',
            quantity: 4,
          }],
        }],
      }]),
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
    };

    const result = await releasePharmacyPendingSaleReservation(
      tx,
      '507f1f77bcf86cd799439010',
      '507f1f77bcf86cd799439011',
    );

    expect(result).toEqual({ released: true, replayed: false });
    expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(3);
    expect(tx.$executeRawUnsafe.mock.calls[0][0]).toContain('qty_reserved = qty_reserved -');
    expect(tx.$executeRawUnsafe.mock.calls[1][0]).toContain('reserved_quantity = reserved_quantity -');
    expect(tx.$executeRawUnsafe.mock.calls[2][0]).toContain("SET status = 'released'");
  });
});
