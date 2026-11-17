'use strict';

const mockTx = { warehouse: {}, client: {}, posShift: {}, product: {}, $queryRawUnsafe: jest.fn(), $executeRawUnsafe: jest.fn() };
const mockDb = { $transaction: jest.fn() };
const mockAudit = jest.fn();

jest.mock('../lib/prisma', () => ({ dbClient: () => mockDb }));
jest.mock('../services/posAuditService', () => ({ writePosAuditLog: (...args) => mockAudit(...args) }));

const controller = require('../controllers/posStockReservationController');

const makeResponse = () => ({
  status: jest.fn(function status(code) { this.statusCode = code; return this; }),
  json: jest.fn(function json(body) { this.body = body; return this; }),
});

const request = {
  posAuthContext: {
    session: { companyId: 'aaaaaaaaaaaaaaaaaaaaaaaa', registerId: 'bbbbbbbbbbbbbbbbbbbbbbbb', userId: 'cccccccccccccccccccccccc' },
    register: { id: 'bbbbbbbbbbbbbbbbbbbbbbbb' },
  },
  body: {
    warehouseId: 'dddddddddddddddddddddddd',
    clientId: 'eeeeeeeeeeeeeeeeeeeeeeee',
    items: [{ productId: 'ffffffffffffffffffffffff', quantity: 2, salesUnitCode: 'carton' }],
  },
};

describe('POS wholesale stock reservations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.$transaction.mockImplementation((callback) => callback(mockTx));
    mockTx.warehouse.findFirst = jest.fn().mockResolvedValue({ id: request.body.warehouseId, name: 'Main Store' });
    mockTx.client.findFirst = jest.fn().mockResolvedValue({ id: request.body.clientId, name: 'Wholesale Customer', code: 'C-1', phoneNormalized: '+250700000000' });
    mockTx.posShift.findFirst = jest.fn().mockResolvedValue({ id: '111111111111111111111111' });
    mockTx.product.findMany = jest.fn().mockResolvedValue([{
      id: request.body.items[0].productId, name: 'Beans', sku: 'BEANS', unit: 'pcs', sellingPrice: 1000, isStockable: true, trackingType: 'none',
      customFields: { posWholesale: { priceTiers: [{ minBaseQuantity: 12, unitPrice: 900 }], saleUnits: [{ code: 'carton', label: 'Carton', baseQuantity: 12 }] } },
    }]);
    mockTx.$queryRawUnsafe.mockImplementation((sql) => sql.includes('INSERT INTO pos_stock_reservations')
      ? [{ id: '222222222222222222222222', referenceNo: 'RSV-1', status: 'partial', createdAt: new Date() }]
      : [{ reservedNow: 12 }]);
    mockTx.$executeRawUnsafe.mockResolvedValue(1);
    mockAudit.mockResolvedValue(undefined);
  });

  test('atomically reserves available base units and returns the shortage as a backorder', async () => {
    const res = makeResponse();
    await controller.create(request, res, (error) => { throw error; });

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.body.data).toMatchObject({
      status: 'partial',
      clientName: 'Wholesale Customer',
      lines: [{ quantity: 2, salesUnitLabel: 'Carton', baseUnitsPerSale: 12, baseQuantity: 24, reservedQuantity: 12, remainingBaseQuantity: 12 }],
      backorderLines: [{ productName: 'Beans', remainingBaseQuantity: 12 }],
    });
    expect(mockTx.$queryRawUnsafe).toHaveBeenCalledWith(expect.stringContaining('qty_reserved = sl.qty_reserved + LEAST'), expect.any(String), request.body.items[0].productId, request.body.warehouseId, 24);
  });

  test('requires a named wholesale customer before reserving', async () => {
    mockTx.client.findFirst.mockResolvedValue(null);
    const res = makeResponse();
    await controller.create(request, res, (error) => { throw error; });
    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.body.code).toBe('POS_RESERVATION_CUSTOMER_REQUIRED');
    expect(mockTx.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});
