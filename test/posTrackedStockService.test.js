jest.mock('../models/StockBatch', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/InventoryBatch', () => ({ find: jest.fn() }));
jest.mock('../models/StockSerialNumber', () => ({ find: jest.fn() }));

const StockBatch = require('../models/StockBatch');
const InventoryBatch = require('../models/InventoryBatch');
const StockSerialNumber = require('../models/StockSerialNumber');
const {
  consumeTrackedBatches,
  consumeOfflineTrackedBatches,
  findAvailableSerialsOutsideQuarantine,
} = require('../services/posTrackedStockService');

function query(rows) {
  const q = {
    sort: jest.fn(),
    session: jest.fn(),
    select: jest.fn(),
    limit: jest.fn(),
    lean: jest.fn(),
  };
  q.sort.mockReturnValue(q);
  q.session.mockResolvedValue(rows);
  q.select.mockReturnValue(q);
  q.limit.mockReturnValue(q);
  q.lean.mockResolvedValue(rows);
  return q;
}

describe('shared POS tracked-stock service', () => {
  beforeEach(() => jest.clearAllMocks());

  test('consumes eligible batches in FEFO order and mirrors quantity to legacy batch records', async () => {
    const session = { id: 'transaction-session' };
    const first = { batchNo: 'EARLY', qtyOnHand: 3, unitCost: 10, expiryDate: new Date('2030-01-01'), save: jest.fn() };
    const second = { batchNo: 'LATE', qtyOnHand: 5, unitCost: 20, expiryDate: new Date('2031-01-01'), save: jest.fn() };
    const legacy = { availableQuantity: 4, quantity: 4, unitCost: 10, save: jest.fn(), updateStatus: jest.fn() };
    StockBatch.find.mockReturnValue(query([first, second]));
    InventoryBatch.find.mockImplementation((filter) => query(filter.batchNumber === 'EARLY' ? [legacy] : []));

    const result = await consumeTrackedBatches('co', 'product', 'warehouse', 4, session);

    expect(result).toEqual({
      allocations: [
        { batchNo: 'EARLY', quantity: 3, unitCost: 10 },
        { batchNo: 'LATE', quantity: 1, unitCost: 20 },
      ],
      totalCost: 50,
      quantity: 4,
    });
    expect(first.qtyOnHand).toBe(0);
    expect(second.qtyOnHand).toBe(4);
    expect(first.save).toHaveBeenCalledWith({ session });
    expect(legacy.availableQuantity).toBe(1);
    expect(legacy.save).toHaveBeenCalledWith({ session });
  });

  test('rejects insufficient eligible batch stock', async () => {
    const batch = { batchNo: 'ONLY', qtyOnHand: 1, unitCost: 2, save: jest.fn() };
    StockBatch.find.mockReturnValue(query([batch]));
    await expect(consumeTrackedBatches('co', 'p', 'w', 2, {})).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    expect(batch.save).not.toHaveBeenCalled();
  });

  test('honors snapshot batch IDs and records shortages using signed batch costs', async () => {
    const savedBatch = {
      _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      batchNo: 'LOT-A',
      qtyOnHand: 2,
      reservedQuantity: 1,
      unitCost: 999,
      expiryDate: new Date('2027-01-01T00:00:00.000Z'),
      isQuarantined: false,
      save: jest.fn().mockResolvedValue(undefined),
    };
    StockBatch.findOne.mockImplementation(({ _id }) => ({
      session: jest.fn().mockResolvedValue(_id === savedBatch._id ? savedBatch : null),
    }));
    InventoryBatch.find.mockImplementation((filter) => query(
      filter.batchNumber === 'LOT-A' ? [] : [],
    ));

    const result = await consumeOfflineTrackedBatches(
      'company-1',
      'product-1',
      'warehouse-1',
      [
        { batchId: savedBatch._id, quantity: 3 },
        { batchId: 'bbbbbbbbbbbbbbbbbbbbbbbb', quantity: 1 },
      ],
      [
        { id: savedBatch._id, batchNo: 'LOT-A', availableQuantity: 3, expiryDate: null, unitCost: 7 },
        { id: 'bbbbbbbbbbbbbbbbbbbbbbbb', batchNo: 'LOT-B', availableQuantity: 2, expiryDate: null, unitCost: 4 },
      ],
      new Date('2026-06-03T08:00:00.000Z'),
      null,
    );

    expect(savedBatch.qtyOnHand).toBe(1);
    expect(savedBatch.save).toHaveBeenCalledWith({ session: null });
    expect(result).toMatchObject({
      quantity: 4,
      totalCost: 25,
      shortfall: 3,
      unavailableBatches: [
        {
          batchId: savedBatch._id,
          batchNo: 'LOT-A',
          quantity: 3,
          consumedQuantity: 1,
          reason: 'batch_quantity_changed',
        },
        {
          batchId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
          batchNo: 'LOT-B',
          quantity: 1,
          consumedQuantity: 0,
          reason: 'batch_missing',
        },
      ],
    });
    expect(InventoryBatch.find).toHaveBeenCalledWith(expect.objectContaining({
      batchNumber: 'LOT-A',
      availableQuantity: { $gt: 0 },
    }));
  });

  test('filters requested serials attached to active quarantined batches', async () => {
    const serialQuery = query([
      { serialNo: 'GOOD', batch: 'batch-good' },
      { serialNo: 'HELD', batch: 'batch-held' },
      { serialNo: 'LOOSE', batch: null },
    ]);
    const batchQuery = query([{ _id: 'batch-held' }]);
    StockSerialNumber.find.mockReturnValue(serialQuery);
    StockBatch.find.mockReturnValue(batchQuery);

    const result = await findAvailableSerialsOutsideQuarantine({
      companyId: 'co', productId: 'p', warehouseId: 'w', serialNumbers: ['GOOD', 'HELD', 'LOOSE'],
    });

    expect(result.map((serial) => serial.serialNo)).toEqual(['GOOD', 'LOOSE']);
    expect(StockBatch.find).toHaveBeenCalledWith({
      company: 'co', _id: { $in: ['batch-good', 'batch-held'] }, isQuarantined: true, qtyOnHand: { $gt: 0 },
    });
  });
});
