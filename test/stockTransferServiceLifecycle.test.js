const mockProduct = {
  _id: 'product-1',
  isActive: true,
  isStockable: true,
  costingMethod: 'wac',
  averageCost: 5,
  currentStock: 10,
  trackBatch: false,
  trackSerialNumbers: false,
};
const mockLine = {
  _id: 'line-1',
  product: 'product-1',
  qty: 4,
  unitCost: null,
  inventoryIdentity: {},
  save: jest.fn(async function save() {
    Object.assign(mockLine, this);
    return this;
  }),
};
const mockTransfer = {
  _id: 'transfer-1',
  company: 'company-1',
  fromWarehouse: 'warehouse-1',
  toWarehouse: 'warehouse-2',
  status: 'draft',
  signatures: [],
  save: jest.fn(async function save() { return this; }),
};
const mockTransitLayers = [];
const mockDb = {
  inventoryBatch: {
    groupBy: jest.fn(async () => [{ productId: 'product-1', _sum: { reservedQuantity: 0, quantity: 10 } }]),
    findMany: jest.fn(async () => []),
    findFirst: jest.fn(async () => null),
  },
  stockBatch: {
    groupBy: jest.fn(async () => []),
    findMany: jest.fn(async () => []),
  },
  warehouseInventoryCost: {
    findMany: jest.fn(async () => [{ productId: 'product-1', totalQty: 10, totalValue: 50 }]),
    findUnique: jest.fn(async ({ where }) => where.companyId_warehouseId_productId.warehouseId === 'warehouse-1'
      ? { id: 'source-cost', totalQty: 10, totalValue: 50 }
      : null),
    update: jest.fn(async () => ({})),
    create: jest.fn(async ({ data }) => data),
  },
  inventoryLayer: {
    create: jest.fn(async ({ data }) => {
      mockTransitLayers.push({ ...data });
      return data;
    }),
    findMany: jest.fn(async () => mockTransitLayers.filter((layer) => Number(layer.qtyRemaining) > 0)),
    update: jest.fn(async ({ where, data }) => {
      const layer = mockTransitLayers.find((item) => item.id === where.id);
      layer.qtyRemaining -= data.qtyRemaining.decrement;
      return layer;
    }),
  },
  stockLevel: {
    findUnique: jest.fn(async ({ where }) => where.companyId_productId_warehouseId.warehouseId === 'warehouse-1'
      ? { id: 'source-stock', qtyOnHand: 10, totalValue: 50, avgCost: 5 }
      : null),
    update: jest.fn(async () => ({})),
    create: jest.fn(async ({ data }) => data),
  },
  product: { update: jest.fn(async () => ({})) },
  stockSerialNumber: { findMany: jest.fn(async () => []), updateMany: jest.fn(async () => ({ count: 0 })) },
  stockTransferDiscrepancy: { create: jest.fn(async ({ data }) => data) },
};

jest.mock('../models/StockTransfer', () => ({
  findById: jest.fn(() => ({ session: async () => mockTransfer })),
}));
jest.mock('../models/StockTransferLine', () => ({
  find: jest.fn(() => ({ session: async () => [mockLine] })),
}));
jest.mock('../models/InventoryLayer', () => ({
  find: jest.fn(() => ({
    sort: () => ({
      limit: () => ({ session: async () => [] }),
    }),
  })),
}));
jest.mock('../models/Product', () => ({}));
jest.mock('../models/StockMovement', () => ({
  create: jest.fn(async () => ({})),
}));
jest.mock('../lib/prisma', () => ({ dbClient: () => mockDb }));
jest.mock('../services/transactionService', () => ({
  runInTransaction: async (operation) => operation(null),
}));
jest.mock('../services/journalService', () => ({}));
jest.mock('../services/inventoryService', () => ({}));
jest.mock('../utils/lineProducts', () => ({
  loadLineProducts: async () => new Map([['product-1', mockProduct]]),
  getLineProduct: (products, line) => products.get(String(line.product?._id || line.product)),
}));

const StockMovement = require('../models/StockMovement');
const stockTransferService = require('../services/stockTransferService');

describe('stock transfer dispatch and receipt persistence', () => {
  beforeEach(() => {
    mockTransfer.status = 'draft';
    mockTransfer.signatures = [];
    mockTransfer.inTransitValue = 0;
    mockTransfer.confirmedBy = null;
    mockTransfer.confirmedAt = null;
    mockTransfer.receivedBy = null;
    mockTransfer.receivedDate = null;
    mockTransfer.discrepancyBy = null;
    mockTransfer.discrepancyAt = null;
    mockLine.qtyReceived = 0;
    mockLine.inTransitQty = 0;
    mockLine.inTransitValue = 0;
    mockLine.unitCost = null;
    mockLine.inventoryIdentity = {};
    mockTransitLayers.length = 0;
    jest.clearAllMocks();
  });

  test('keeps dispatched stock in transit until receipt and records a manager discrepancy', async () => {
    const dispatched = await stockTransferService.dispatchTransfer('transfer-1', {
      actorId: 'dispatcher-1',
    });

    expect(dispatched.status).toBe('in_transit');
    expect(dispatched.confirmedBy).toBe('dispatcher-1');
    expect(dispatched.confirmedAt).toBeInstanceOf(Date);
    expect(dispatched.inTransitValue).toBe(20);
    expect(mockLine.inTransitQty).toBe(4);
    expect(StockMovement.create).toHaveBeenCalledTimes(1);
    expect(StockMovement.create.mock.calls[0][0][0].type).toBe('out');

    const received = await stockTransferService.receiveTransfer('transfer-1', {
      actorId: 'warehouse-manager-1',
      notes: 'Short by one',
      lines: [{ lineId: 'line-1', qtyReceived: 3 }],
    });

    expect(received.status).toBe('completed');
    expect(received.receivedBy).toBe('warehouse-manager-1');
    expect(received.receivedDate).toBeInstanceOf(Date);
    expect(received.discrepancyBy).toBe('warehouse-manager-1');
    expect(received.discrepancyAt).toBeInstanceOf(Date);
    expect(received.inTransitValue).toBe(5);
    expect(mockLine.qtyReceived).toBe(3);
    expect(mockLine.inTransitQty).toBe(1);
    expect(mockTransitLayers[0].qtyRemaining).toBe(1);
    expect(mockDb.stockLevel.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'source-stock' },
      data: expect.objectContaining({ qtyOnHand: 6, totalValue: 30 }),
    }));
    expect(mockDb.stockLevel.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        companyId: 'company-1',
        productId: 'product-1',
        warehouseId: 'warehouse-2',
        qtyOnHand: 3,
        totalValue: 15,
      }),
    }));
    expect(mockDb.stockTransferDiscrepancy.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        expectedQty: 4,
        receivedQty: 3,
        varianceQty: -1,
        recordedById: 'warehouse-manager-1',
      }),
    }));
    expect(StockMovement.create).toHaveBeenCalledTimes(2);
    expect(StockMovement.create.mock.calls[1][0][0].type).toBe('in');
  });

  test('does not permit cancellation after dispatch', async () => {
    mockTransfer.status = 'in_transit';
    await expect(stockTransferService.cancelTransfer('transfer-1', { actorId: 'manager-1' }))
      .rejects.toMatchObject({ code: 'POST_DISPATCH_CANCELLATION_FORBIDDEN' });
  });
});
