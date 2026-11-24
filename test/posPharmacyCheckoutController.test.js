'use strict';

jest.mock('../controllers/salesLegacyController', () => ({
  getPosProducts: jest.fn(),
  createDirectSale: jest.fn(),
}));
jest.mock('../models/Warehouse', () => ({ find: jest.fn() }));
jest.mock('../models/StockBatch', () => ({ find: jest.fn() }));
jest.mock('../models/Client', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../controllers/posController', () => ({ getReceipt: jest.fn() }));
jest.mock('../lib/prisma', () => ({ dbClient: jest.fn() }));

const Warehouse = require('../models/Warehouse');
const StockBatch = require('../models/StockBatch');
const Client = require('../models/Client');
const posController = require('../controllers/posController');
const { dbClient } = require('../lib/prisma');
const controller = require('../controllers/posPharmacyCheckoutController');

const authContext = {
  user: { id: 'cashier-1' },
  company: { id: 'company-1' },
  register: { id: 'register-1', code: 'PH-01' },
};

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

describe('Pharmacy checkout lookup endpoints', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lists only active stock locations for the signed-in company', async () => {
    Warehouse.find.mockReturnValue({
      sort: jest.fn().mockResolvedValue([
        { _id: 'warehouse-1', name: 'Pharmacy', code: 'PH' },
      ]),
    });
    const res = response();

    await controller.listWarehouses({ posAuthContext: authContext, query: {}, body: {} }, res, (error) => { throw error; });

    expect(Warehouse.find).toHaveBeenCalledWith({
      company: 'company-1',
      isActive: { $ne: false },
    });
    expect(res.body).toEqual({
      success: true,
      data: [{ id: 'warehouse-1', name: 'Pharmacy', code: 'PH' }],
    });
  });

  it('searches only active named customers within the signed-in company', async () => {
    Client.find.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        { _id: 'customer-1', name: 'Kigali Clinic', code: 'CL-01', contact: { phone: '0780000000' } },
      ]),
    });
    const res = response();

    await controller.searchCustomers({
      posAuthContext: authContext,
      query: { q: 'clinic' },
      body: {},
    }, res, (error) => { throw error; });

    expect(Client.find).toHaveBeenCalledWith(expect.objectContaining({
      company: 'company-1',
      isActive: true,
      isWalkIn: { $ne: true },
    }));
    expect(res.body.data).toEqual([
      { id: 'customer-1', name: 'Kigali Clinic', code: 'CL-01', phone: '0780000000' },
    ]);
  });

  it('does not query customer records for searches shorter than two characters', async () => {
    const res = response();

    await controller.searchCustomers({
      posAuthContext: authContext,
      query: { q: 'a' },
      body: {},
    }, res, (error) => { throw error; });

    expect(res.body).toEqual({ success: true, data: [] });
    expect(Client.find).not.toHaveBeenCalled();
  });

  it('loads a recalled customer only from the signed-in company', async () => {
    Client.findOne.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue({
        _id: 'customer-1',
        name: 'Kigali Clinic',
        code: 'CL-01',
        contact: { phone: '0780000000' },
      }),
    });
    const res = response();

    await controller.getCustomer({
      posAuthContext: authContext,
      params: { customerId: 'customer-1' },
      query: {},
      body: {},
    }, res, (error) => { throw error; });

    expect(Client.findOne).toHaveBeenCalledWith({
      _id: 'customer-1',
      company: 'company-1',
      isActive: true,
      isWalkIn: { $ne: true },
    });
    expect(res.body.data).toEqual({
      id: 'customer-1',
      name: 'Kigali Clinic',
      code: 'CL-01',
      phone: '0780000000',
    });
  });

  it('returns only fiscal receipt details for a sale on the current register', async () => {
    const queryRaw = jest.fn().mockResolvedValue([{ registerId: 'register-1', cashierId: 'cashier-1' }]);
    dbClient.mockReturnValue({ $queryRawUnsafe: queryRaw });
    posController.getReceipt.mockImplementation((_req, res) => res.json({
      success: true,
      data: {
        fiscalMode: 'production',
        ebm: {
          ebmStatus: 'submitted',
          rcptNo: 'RRA-01',
          rcptDtDisplay: '2026-01-02',
          qrCodeDataUrl: 'data:image/png;base64,qr',
        },
        client: { name: 'Private customer data' },
      },
    }));
    const res = response();

    await controller.getFiscalReceipt({
      posAuthContext: authContext,
      params: { invoiceId: '507f1f77bcf86cd799439011' },
      query: {},
      body: {},
    }, res, (error) => { throw error; });

    expect(queryRaw).toHaveBeenCalledWith(
      expect.stringContaining('company_id = $2'),
      '507f1f77bcf86cd799439011',
      'company-1',
    );
    expect(posController.getReceipt).toHaveBeenCalled();
    expect(res.body.data).toEqual({
      fiscalMode: 'production',
      fiscalStatus: 'submitted',
      fiscalReceiptNumber: 'RRA-01',
      fiscalReceiptDate: '2026-01-02',
      fiscalQrCodeDataUrl: 'data:image/png;base64,qr',
      fiscalError: null,
    });
    expect(JSON.stringify(res.body)).not.toContain('Private customer data');
  });

  it('rejects invalid batch filters before querying inventory', async () => {
    const res = response();

    await controller.listBatches({
      posAuthContext: authContext,
      query: { productId: 'invalid', warehouseId: 'warehouse-1' },
      body: {},
    }, res, (error) => { throw error; });

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('PHARMACY_BATCH_QUERY_INVALID');
    expect(StockBatch.find).not.toHaveBeenCalled();
  });

  it('returns only available, non-expired batches for the selected location', async () => {
    StockBatch.find.mockReturnValue({
      sort: jest.fn().mockResolvedValue([
        { _id: 'batch-1', batchNo: 'LOT-A', qtyOnHand: 8, reservedQuantity: 2, expiryDate: new Date(Date.now() + 86_400_000) },
        { _id: 'batch-2', batchNo: 'LOT-B', qtyOnHand: 1, reservedQuantity: 1, expiryDate: null },
        { _id: 'batch-3', batchNo: 'LOT-C', qtyOnHand: 4, reservedQuantity: 0, expiryDate: new Date(Date.now() - 86_400_000) },
      ]),
    });
    const res = response();

    await controller.listBatches({
      posAuthContext: authContext,
      query: { productId: '507f1f77bcf86cd799439011', warehouseId: '507f1f77bcf86cd799439012' },
      body: {},
    }, res, (error) => { throw error; });

    expect(StockBatch.find).toHaveBeenCalledWith(expect.objectContaining({
      company: 'company-1',
      product: '507f1f77bcf86cd799439011',
      warehouse: '507f1f77bcf86cd799439012',
    }));
    expect(res.body.data).toEqual([
      expect.objectContaining({ id: 'batch-1', batchNo: 'LOT-A', availableQuantity: 6 }),
    ]);
  });
});
