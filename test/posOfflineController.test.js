'use strict';

jest.mock('../models/Product', () => ({ find: jest.fn() }));
jest.mock('../models/StockLevel', () => ({ find: jest.fn() }));
jest.mock('../models/StockSerialNumber', () => ({ find: jest.fn(), updateMany: jest.fn() }));
jest.mock('../models/StockMovement', () => ({ findOne: jest.fn(), updateMany: jest.fn() }));
jest.mock('../models/TillSession', () => ({ findOne: jest.fn() }));
jest.mock('../models/Warehouse', () => ({ findOne: jest.fn() }));
jest.mock('../services/systemSettingsService', () => ({ get: jest.fn() }));
jest.mock('../services/moduleEntitlementService', () => ({
  getEntitlement: jest.fn().mockResolvedValue({ status: 'on', version: 1 }),
}));
jest.mock('../services/posPaymentService', () => ({
  getPaymentSettings: jest.fn(),
  resolvePaymentFlow: jest.fn(),
}));
jest.mock('../services/AuditLogService', () => ({ log: jest.fn() }));
jest.mock('../services/posRegisterService', () => ({
  findClaimedRegister: jest.fn(),
}));
jest.mock('../services/transactionService', () => ({
  runInTransaction: jest.fn(async (operation) => operation(null)),
}));
jest.mock('../lib/prisma', () => ({ dbClient: jest.fn() }));
let mockReceiptNumber = 0;
jest.mock('../utils/referenceNumbers', () => ({
  nextReferenceNo: jest.fn(async (_companyId, prefix) => (
    `${prefix}-2026-${String(++mockReceiptNumber).padStart(5, '0')}`
  )),
}));

const Product = require('../models/Product');
const StockLevel = require('../models/StockLevel');
const StockSerialNumber = require('../models/StockSerialNumber');
const StockMovement = require('../models/StockMovement');
const TillSession = require('../models/TillSession');
const Warehouse = require('../models/Warehouse');
const SystemSettingsService = require('../services/systemSettingsService');
const moduleEntitlementService = require('../services/moduleEntitlementService');
const posPaymentService = require('../services/posPaymentService');
const AuditLogService = require('../services/AuditLogService');
const { findClaimedRegister } = require('../services/posRegisterService');
const { dbClient } = require('../lib/prisma');
const { verifyCapability } = require('../services/posOfflineCapabilityService');
const { issueSnapshot, listConflicts, resolveConflict } = require('../controllers/posOfflineController');

const IDS = {
  company: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  user: 'bbbbbbbbbbbbbbbbbbbbbbbb',
  cashier: '999999999999999999999999',
  register: 'cccccccccccccccccccccccc',
  registerCode: 'REG-01',
  warehouse: 'dddddddddddddddddddddddd',
  till: 'eeeeeeeeeeeeeeeeeeeeeeee',
  product: 'ffffffffffffffffffffffff',
  conflict: '111111111111111111111111',
  invoice: '222222222222222222222222',
};

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

function query(value) {
  const options = { skip: 0, limit: undefined };
  const chain = {
    select: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn((offset) => { options.skip = offset; return chain; }),
    limit: jest.fn((limit) => { options.limit = limit; return chain; }),
    lean: jest.fn(async () => (typeof value === 'function' ? value(options) : value)),
  };
  return chain;
}

describe('POS offline controller', () => {
  const previousSecret = process.env.JWT_SECRET;
  beforeEach(() => {
    jest.clearAllMocks();
    mockReceiptNumber = 0;
    process.env.JWT_SECRET = 'unit-test-secret-that-is-at-least-32-characters';
    posPaymentService.getPaymentSettings.mockResolvedValue({});
    posPaymentService.resolvePaymentFlow.mockReturnValue('LEGACY');
    moduleEntitlementService.getEntitlement.mockResolvedValue({ status: 'on', version: 1 });
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
    };
    dbClient.mockReturnValue({
      ...tx,
      $transaction: jest.fn(async (callback) => callback(tx)),
    });
  });
  afterAll(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });

  function snapshotRequest({ cashierId = IDS.cashier, deviceId = '77777777-7777-4777-8777-777777777777', registerCode = IDS.registerCode } = {}) {
    return {
      user: { id: IDS.user, company: { _id: IDS.company } },
      posAuthContext: {
        session: { userId: cashierId },
        company: { id: IDS.company },
        register: { code: IDS.registerCode, claimedDeviceId: '77777777-7777-4777-8777-777777777777' },
      },
      body: { deviceId, registerId: registerCode, warehouseId: IDS.warehouse },
    };
  }

  test('issues a signed capability bound to an enabled cashier/device/register/warehouse/till', async () => {
    const paymentSettings = { paymentFlow: 'PAYMENTS_V2', registerPaymentFlowOverrides: {} };
    SystemSettingsService.get.mockResolvedValue({
      pos_offline_enabled: true,
      pos_offline_max_hours: 12,
      pos_offline_queue_limit: 100000,
      pos_negative_stock_escalation_days: 5,
      allow_negative_stock: false,
      pos_offline_action_caps: {
        companyDefaults: {
          card: { maxPerTransaction: 1000, maxTotalPerPeriod: 3000, maxCountPerPeriod: 3 },
        },
        offlineManagerApproval: {
          enabled: true,
          caps: {
            card: { maxPerTransaction: 3000, maxTotalPerPeriod: 6000, maxCountPerPeriod: 2 },
          },
        },
      },
    });
    posPaymentService.getPaymentSettings.mockResolvedValue(paymentSettings);
    posPaymentService.resolvePaymentFlow.mockReturnValue('PAYMENTS_V2');
    findClaimedRegister.mockResolvedValue({ id: IDS.register, code: IDS.registerCode });
    Warehouse.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue({ _id: IDS.warehouse }) });
    TillSession.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue({ _id: IDS.till }) });
    Product.find.mockReturnValue(query([{
      _id: IDS.product,
      name: 'Widget',
      sellingPrice: 100,
      taxRate: 18,
      isStockable: true,
      trackingType: 'none',
      averageCost: 40,
    }]));
    StockLevel.find.mockReturnValue(query([{
      product_id: IDS.product,
      qty_on_hand: 5,
      qty_reserved: 1,
    }]));
    StockSerialNumber.find.mockReturnValue(query([]));
    const database = dbClient();
    database.$queryRawUnsafe.mockImplementation(async (sql) => (
      String(sql).includes('FROM warehouses w')
        ? [{ priceListId: '888888888888888888888888', productId: IDS.product, price: '75' }]
        : []
    ));

    const res = response();
    const req = snapshotRequest();
    await issueSnapshot(req, res, (error) => { throw error; });

    expect(res.statusCode).toBe(200);
    expect(SystemSettingsService.get).toHaveBeenCalledWith(IDS.company);
    expect(TillSession.findOne).toHaveBeenCalledWith({
      company: IDS.company,
      openedBy: IDS.cashier,
      registerId: IDS.registerCode,
      status: 'open',
    });
    expect(res.body.data.productCount).toBe(1);
    expect(res.body.data.paymentFlow).toBe('PAYMENTS_V2');
    expect(res.body.data.offlineManagerApproval).toEqual(expect.objectContaining({
      enabled: true,
      caps: expect.objectContaining({
        card: { maxPerTransaction: 3000, maxTotalPerPeriod: 6000, maxCountPerPeriod: 2 },
      }),
    }));
    expect(res.body.data.receiptNumbers).toHaveLength(50);
    expect(new Set(res.body.data.receiptNumbers).size).toBe(50);
    expect(posPaymentService.resolvePaymentFlow).toHaveBeenCalledWith(paymentSettings, IDS.register);
    const claims = verifyCapability(res.body.data.capability);
    expect(claims).toMatchObject({
      companyId: IDS.company,
      userId: IDS.cashier,
      registerId: IDS.registerCode,
      warehouseId: IDS.warehouse,
      tillSessionId: IDS.till,
      paymentFlow: 'PAYMENTS_V2',
      fiscalMode: 'ebm',
      entitlementVersion: 1,
      requiresFiscalSubmission: true,
      provisionalFiscalReceiptsAllowed: false,
    });
    const snapshotInsert = database.$executeRawUnsafe.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO pos_offline_snapshots'));
    const snapshotData = JSON.parse(snapshotInsert[8]);
    expect(snapshotData.escalationDays).toBe(5);
    expect(snapshotData.maxHours).toBe(12);
    expect(snapshotData.offlinePolicy).toMatchObject({
      maxHours: 12,
      maxSales: 200,
      maxSingleSaleRwf: 100000,
      maxTotalValueRwf: 100000,
      requiresFiscalSubmission: true,
      provisionalFiscalReceiptsAllowed: false,
      actions: expect.objectContaining({ cash_sales: true, refunds: false, shift_close: false }),
    });
    expect(snapshotData.paymentFlow).toBe('PAYMENTS_V2');
    expect(snapshotData.fiscalMode).toBe('ebm');
    expect(snapshotData.entitlementVersion).toBe(1);
    expect(snapshotData.receiptNumbers).toEqual(res.body.data.receiptNumbers);
    expect(snapshotData.products[IDS.product]).toMatchObject({ price: 75, standardPrice: 100 });
    expect(snapshotData.products[IDS.product]).toMatchObject({ taxRate: 18, taxCode: 'B' });
    expect(snapshotData.priceListId).toBe('888888888888888888888888');
    expect(database.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO pos_offline_snapshots'),
      expect.any(String),
      IDS.company,
      IDS.cashier,
      expect.any(String),
      IDS.registerCode,
      IDS.warehouse,
      IDS.till,
      expect.stringContaining('"taxRate":18'),
      'ebm',
      1,
      100000,
      expect.any(Date),
      expect.any(Date),
    );
  });

  test('reads snapshot products, stock, and serials in HTTP-safe batches', async () => {
    SystemSettingsService.get.mockResolvedValue({
      pos_offline_enabled: true,
      pos_offline_max_hours: 12,
      pos_offline_queue_limit: 100000,
      pos_negative_stock_escalation_days: 5,
      allow_negative_stock: false,
    });

    findClaimedRegister.mockResolvedValue({ id: IDS.register, code: IDS.registerCode });
    Warehouse.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue({ _id: IDS.warehouse }) });
    TillSession.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue({ _id: IDS.till }) });

    const makeRows = (count, createRow) => ({ skip, limit }) => (
      Array.from({ length: Math.max(0, Math.min(limit, count - skip)) }, (_, index) => createRow(skip + index))
    );
    Product.find.mockImplementation(() => query(makeRows(501, (index) => ({
      _id: `${String(index).padStart(24, '0')}`,
      name: `Product ${index}`,
      sellingPrice: 10,
    }))));
    StockLevel.find.mockImplementation(() => query(makeRows(501, (index) => ({
      product_id: `${String(index).padStart(24, '0')}`,
      qty_on_hand: 1,
      qty_reserved: 0,
    }))));
    StockSerialNumber.find.mockImplementation(() => query(makeRows(501, (index) => ({
      product: IDS.product,
      serialNo: `SERIAL-${index}`,
    }))));

    const res = response();
    await issueSnapshot(snapshotRequest(), res, (error) => { throw error; });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.productCount).toBe(501);
    for (const model of [Product, StockLevel, StockSerialNumber]) {
      expect(model.find).toHaveBeenCalledTimes(2);
      for (const { value: queryBuilder } of model.find.mock.results) {
        expect(queryBuilder.limit).toHaveBeenCalledWith(expect.any(Number));
        expect(queryBuilder.limit.mock.calls[0][0]).toBeLessThanOrEqual(500);
      }
    }
  });

  test('includes only unreserved, unexpired batch stock in the signed offline snapshot', async () => {
    SystemSettingsService.get.mockResolvedValue({
      pos_offline_enabled: true,
      pos_offline_max_hours: 12,
      pos_offline_queue_limit: 100000,
      allow_negative_stock: false,
    });
    findClaimedRegister.mockResolvedValue({ id: IDS.register, code: IDS.registerCode });
    Warehouse.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue({ _id: IDS.warehouse }) });
    TillSession.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue({ _id: IDS.till }) });
    Product.find.mockReturnValue(query([{
      _id: IDS.product,
      name: 'Batch Widget',
      sellingPrice: 100,
      taxRate: 0,
      taxCode: 'A',
      isStockable: true,
      trackingType: 'batch',
      averageCost: 40,
    }]));
    StockLevel.find.mockReturnValue(query([]));
    StockSerialNumber.find.mockReturnValue(query([]));
    const database = dbClient();
    database.stockBatch = {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
          productId: IDS.product,
          batchNo: 'FRESH-1',
          qtyOnHand: 8,
          reservedQuantity: 3,
          unitCost: 40,
          expiryDate: new Date(Date.now() + 60 * 86400000),
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        {
          id: 'bbbbbbbbbbbbbbbbbbbbbbbb',
          productId: IDS.product,
          batchNo: 'EXPIRED',
          qtyOnHand: 10,
          reservedQuantity: 0,
          unitCost: 35,
          expiryDate: new Date(Date.now() - 86400000),
          createdAt: new Date('2025-01-01T00:00:00.000Z'),
        },
        {
          id: 'cccccccccccccccccccccccc',
          productId: IDS.product,
          batchNo: 'RESERVED',
          qtyOnHand: 2,
          reservedQuantity: 2,
          unitCost: 30,
          expiryDate: null,
          createdAt: new Date('2025-02-01T00:00:00.000Z'),
        },
      ]),
    };

    const res = response();
    await issueSnapshot(snapshotRequest(), res, (error) => { throw error; });

    expect(res.statusCode).toBe(200);
    expect(database.stockBatch.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        companyId: IDS.company,
        warehouseId: IDS.warehouse,
        productId: { in: [IDS.product] },
        isQuarantined: false,
      }),
      take: 500,
    }));
    expect(res.body.data.batchesByProduct[IDS.product]).toEqual([
      expect.objectContaining({
        id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
        batchNo: 'FRESH-1',
        availableQuantity: 5,
      }),
    ]);
    const snapshotInsert = database.$executeRawUnsafe.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO pos_offline_snapshots'));
    const snapshotData = JSON.parse(snapshotInsert[8]);
    expect(snapshotData.products[IDS.product].batches).toEqual([
      expect.objectContaining({
        id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
        batchNo: 'FRESH-1',
        availableQuantity: 5,
        unitCost: 40,
      }),
    ]);
  });

  test('rejects serial catalogs above 20,000 after bounded reads', async () => {
    SystemSettingsService.get.mockResolvedValue({ pos_offline_enabled: true });
    findClaimedRegister.mockResolvedValue({ id: IDS.register, code: IDS.registerCode });
    Warehouse.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue({ _id: IDS.warehouse }) });
    TillSession.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue({ _id: IDS.till }) });
    Product.find.mockReturnValue(query([]));
    StockLevel.find.mockReturnValue(query([]));
    StockSerialNumber.find.mockImplementation(() => query(({ skip, limit }) => (
      Array.from({ length: Math.max(0, Math.min(limit, 20001 - skip)) }, (_, index) => ({
        product: IDS.product,
        serialNo: `SERIAL-${skip + index}`,
      }))
    )));

    const res = response();
    await issueSnapshot(snapshotRequest(), res, (error) => { throw error; });

    expect(res.statusCode).toBe(413);
    expect(res.body.code).toBe('POS_OFFLINE_SERIAL_CATALOG_TOO_LARGE');
    expect(StockSerialNumber.find).toHaveBeenCalledTimes(41);
    for (const { value: queryBuilder } of StockSerialNumber.find.mock.results) {
      expect(queryBuilder.limit.mock.calls[0][0]).toBeLessThanOrEqual(500);
    }
  });

  test('does not issue capabilities when company offline POS is disabled', async () => {
    SystemSettingsService.get.mockResolvedValue({ pos_offline_enabled: false });
    const res = response();
    await issueSnapshot(snapshotRequest(), res, (error) => { throw error; });
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('POS_OFFLINE_DISABLED');
    expect(Product.find).not.toHaveBeenCalled();
  });

  test('does not issue a snapshot for a register or device outside the active POS session', async () => {
    const req = snapshotRequest({ registerCode: 'OTHER-REGISTER' });
    const res = response();
    await issueSnapshot(req, res, (error) => { throw error; });
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('POS_OFFLINE_SNAPSHOT_BINDING_INVALID');
    expect(SystemSettingsService.get).not.toHaveBeenCalled();
  });

  test('requires an open till owned by the active POS cashier, not just an open register till', async () => {
    SystemSettingsService.get.mockResolvedValue({ pos_offline_enabled: true });
    findClaimedRegister.mockResolvedValue({ id: IDS.register, code: IDS.registerCode });
    Warehouse.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue({ _id: IDS.warehouse }) });
    TillSession.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
    const res = response();
    await issueSnapshot(snapshotRequest(), res, (error) => { throw error; });
    expect(res.statusCode).toBe(409);
    expect(TillSession.findOne).toHaveBeenCalledWith(expect.objectContaining({ openedBy: IDS.cashier }));
    expect(Product.find).not.toHaveBeenCalled();
  });

  test('lists conflicts after updating overdue open conflicts to escalated', async () => {
    const database = dbClient();
    database.$queryRawUnsafe.mockResolvedValue([{ id: IDS.conflict, status: 'escalated' }]);
    const res = response();
    await listConflicts({ user: { company: { _id: IDS.company } } }, res, (error) => { throw error; });
    expect(database.$executeRawUnsafe).toHaveBeenCalledWith(expect.stringContaining("status = 'escalated'"), IDS.company);
    expect(res.body.data).toEqual([{ id: IDS.conflict, status: 'escalated' }]);
  });

  test('requires exact unique available serial assignment and audits manager resolution', async () => {
    const database = dbClient();
    database.$queryRawUnsafe.mockResolvedValue([{
      id: IDS.conflict,
      offlineSaleId: 'offline-sale-id-123',
      invoiceId: IDS.invoice,
      productId: IDS.product,
      warehouseId: IDS.warehouse,
      conflictType: 'serial',
      details: { quantity: 2 },
      status: 'open',
      createdAt: new Date(),
    }]);
    StockSerialNumber.find.mockReturnValue(query([{ serialNo: 'SERIAL-1' }, { serialNo: 'SERIAL-2' }]));
    StockSerialNumber.updateMany.mockResolvedValue({ modifiedCount: 2 });
    StockMovement.updateMany.mockResolvedValue({ modifiedCount: 1 });
    AuditLogService.log.mockResolvedValue(undefined);
    const req = {
      user: { id: IDS.user, company: { _id: IDS.company } },
      params: { conflictId: IDS.conflict },
      body: { resolution: 'assign_serials', serialNumbers: ['serial-1', 'serial-2'], reason: 'Verified alternate stock serials.' },
      ip: '127.0.0.1',
      get: () => 'test-agent',
    };
    const res = response();
    await resolveConflict(req, res, (error) => { throw error; });

    expect(res.statusCode).toBe(200);
    expect(StockSerialNumber.updateMany).toHaveBeenCalled();
    expect(StockMovement.updateMany).toHaveBeenCalled();
    expect(AuditLogService.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'pos_offline_conflict.resolve',
      userId: IDS.user,
      entityId: IDS.conflict,
    }));
  });

  test('does not silently resolve a serial conflict without exact serials', async () => {
    dbClient().$queryRawUnsafe.mockResolvedValue([{
      id: IDS.conflict,
      productId: IDS.product,
      warehouseId: IDS.warehouse,
      conflictType: 'serial',
      details: { quantity: 2 },
      status: 'open',
    }]);
    const res = response();
    await resolveConflict({
      user: { id: IDS.user, company: { _id: IDS.company } },
      params: { conflictId: IDS.conflict },
      body: { resolution: 'assign_serials', serialNumbers: ['SERIAL-1'], reason: 'Only one provided.' },
    }, res, (error) => {
      res.status(error.status).json({ success: false, code: error.code, message: error.message });
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('POS_OFFLINE_SERIAL_ASSIGNMENT_INVALID');
    expect(StockSerialNumber.updateMany).not.toHaveBeenCalled();
  });
});
