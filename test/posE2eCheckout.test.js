/**
 * POS E2E pack — checkout contracts for the canonical sales-legacy path.
 * Controllers are exercised with boundary mocks (no live DB required).
 */

jest.mock('../models/Invoice', () => ({ findOne: jest.fn(), create: jest.fn() }));
jest.mock('../models/Client', () => ({ findOne: jest.fn(), create: jest.fn() }));
jest.mock('../models/Product', () => ({ find: jest.fn(), bulkWrite: jest.fn() }));
jest.mock('../models/StockMovement', () => ({ insertMany: jest.fn() }));
jest.mock('../models/Warehouse', () => ({ findOne: jest.fn() }));
jest.mock('../models/Company', () => ({ findById: jest.fn() }));
jest.mock('../models/BankAccount', () => ({ BankAccount: { findOne: jest.fn(), invalidateCacheForLedgerAccount: jest.fn() } }));
jest.mock('../models/TillSession', () => ({ findOne: jest.fn() }));
jest.mock('../models/StockLevel', () => ({ find: jest.fn(), updateMany: jest.fn() }));
jest.mock('../models/StockSerialNumber', () => ({ find: jest.fn(), updateMany: jest.fn() }));
jest.mock('../models/StockBatch', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/InventoryBatch', () => ({ find: jest.fn() }));
jest.mock('../services/transactionService', () => ({ runInTransaction: jest.fn() }));
jest.mock('../services/posRegisterService', () => ({
  findClaimedRegister: jest.fn(async (_companyId, registerId) => ({
    id: '888888888888888888888888',
    _id: registerId,
    code: registerId,
  })),
  registerClaimRequiredError: () => Object.assign(new Error('Register claim required'), { statusCode: 403, code: 'POS_REGISTER_CLAIM_REQUIRED' }),
}));
jest.mock('../services/inventoryService', () => ({
  consume: jest.fn(),
  consumeAvailable: jest.fn(),
  reduceLayers: jest.fn(),
}));
jest.mock('../services/journalService', () => ({
  getMappedAccountCode: jest.fn(),
  createDebitLine: jest.fn((account, amount, desc) => ({ accountCode: account, debit: amount, credit: 0, description: desc })),
  createCreditLine: jest.fn((account, amount, desc) => ({ accountCode: account, debit: 0, credit: amount, description: desc })),
  createEntriesAtomic: jest.fn(),
}));
jest.mock('../services/posAccountingProfileService', () => ({
  getProfile: jest.fn().mockResolvedValue({
    companyDefaults: {},
    tillTypeOverrides: {},
    registerOverrides: {},
  }),
  resolveAccount: jest.fn(() => null),
  assertTenderMappings: jest.fn(),
}));
jest.mock('../services/CurrencyService', () => ({ getCompanyBase: jest.fn() }));
jest.mock('../services/cacheService', () => ({ bumpCompanyFinancialCaches: jest.fn() }));
jest.mock('../services/emailService', () => ({ sendInvoiceEmail: jest.fn() }));
jest.mock('../services/ebmService', () => ({
  getConfig: jest.fn(() => ({ mode: 'mock' })),
  VSDC_ENDPOINTS: { SAVE_SALES: '/saveSales' },
}));
jest.mock('../services/moduleEntitlementService', () => ({
  hasModule: jest.fn().mockResolvedValue(true),
  getEntitlement: jest.fn().mockResolvedValue({ status: 'on', version: 1 }),
}));
jest.mock('../services/ebmSalesService', () => ({
  submitInvoiceAsync: jest.fn(),
  prepareV2SaleSubmission: jest.fn(),
}));
jest.mock('../services/posPaymentService', () => ({
  getPaymentSettings: jest.fn().mockResolvedValue({ paymentFlow: 'LEGACY', registerPaymentFlowOverrides: {} }),
  resolvePaymentFlow: jest.fn(() => 'LEGACY'),
  resolveEnabledMethods: jest.fn(() => ['CASH', 'MTN_MOMO', 'AIRTEL_MONEY']),
  getEffectiveMethodRegistry: jest.fn(() => ({ methods: [] })),
  assertPaymentMethodEnabled: jest.fn().mockResolvedValue(undefined),
  validateTenderConfiguration: jest.fn((_settings, tender) => {
    if (tender.method === 'CARD' && !tender.reference) {
      throw Object.assign(new Error('Enter the card slip reference for Card.'), {
        code: 'POS_PAYMENT_REFERENCE_REQUIRED',
      });
    }
    if (tender.method === 'MTN_MOMO' && !tender.reference && !tender.allowOptionalReference) {
      throw Object.assign(new Error('Enter the transaction id for Mobile money.'), {
        code: 'POS_PAYMENT_REFERENCE_REQUIRED',
      });
    }
  }),
}));
jest.mock('../services/posAuditService', () => ({
  writePosAuditLog: jest.fn().mockResolvedValue(undefined),
  requestIp: jest.fn(() => '127.0.0.1'),
}));
jest.mock('../controllers/posManagerApprovalController', () => ({
  consumeApproval: jest.fn(),
  hashPayload: jest.fn((payload) => JSON.stringify(payload || {})),
}));
jest.mock('../controllers/posController', () => ({ getReceipt: jest.fn() }));
jest.mock('../lib/prisma', () => ({
  dbClient: jest.fn(),
  prisma: {},
}));

const Invoice = require('../models/Invoice');
const Client = require('../models/Client');
const Product = require('../models/Product');
const StockMovement = require('../models/StockMovement');
const Warehouse = require('../models/Warehouse');
const { BankAccount } = require('../models/BankAccount');
const TillSession = require('../models/TillSession');
const StockLevel = require('../models/StockLevel');
const StockBatch = require('../models/StockBatch');
const InventoryBatch = require('../models/InventoryBatch');
const { runInTransaction } = require('../services/transactionService');
const inventoryService = require('../services/inventoryService');
const JournalService = require('../services/journalService');
const posAccountingProfileService = require('../services/posAccountingProfileService');
const CurrencyService = require('../services/CurrencyService');
const cacheService = require('../services/cacheService');
const { consumeApproval } = require('../controllers/posManagerApprovalController');
const { findClaimedRegister } = require('../services/posRegisterService');
const { writePosAuditLog } = require('../services/posAuditService');
const moduleEntitlementService = require('../services/moduleEntitlementService');
const posPaymentService = require('../services/posPaymentService');
const { dbClient } = require('../lib/prisma');
const { createDirectSale, getCheckoutPaymentFlow } = require('../controllers/salesLegacyController');
const posPaymentsV2Controller = require('../controllers/posPaymentsV2Controller');
const ebmService = require('../services/ebmService');
const EBMSalesService = require('../services/ebmSalesService');
const { issueCapability } = require('../services/posOfflineCapabilityService');
const {
  IDS,
  mockRes,
  catalogProduct,
  checkoutBody,
  makeReq,
  saleLine,
} = require('./helpers/posE2eFixtures');

function leanFind(value) {
  return { select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(value) }) };
}

function stockLevelRows(qtyOnHand = 50, qtyReserved = 0) {
  return [{
    product_id: IDS.product,
    qty_on_hand: qtyOnHand,
    qty_reserved: qtyReserved,
  }];
}

function emptyCheckoutDb() {
  return {
    stockBatch: { groupBy: jest.fn().mockResolvedValue([]) },
    systemSettings: { findUnique: jest.fn().mockResolvedValue(null) },
    user: { findFirst: jest.fn().mockResolvedValue({ id: IDS.cashier, name: 'Cashier' }) },
    userRole: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRawUnsafe: checkoutQueryMock(),
    $executeRawUnsafe: jest.fn().mockResolvedValue(1),
  };
}

const discountTestSettings = {
  defaultLimits: { maxLineDiscountPercent: 0, maxCartDiscountPercent: null, maxSaleDiscountRwf: null },
  rules: [],
  discountReasons: ['Test discount'],
  systemTillTypes: ['retail'],
  registerLabels: [],
};

function checkoutQueryMock(initialImplementation = async () => []) {
  const query = jest.fn();
  const setImplementation = query.mockImplementation.bind(query);
  query.mockImplementation = (implementation) => setImplementation(async (sql, ...params) => {
    const result = await implementation(sql, ...params);
    if (!result?.length && String(sql).includes('UPDATE pos_receipt_number_allocations')) {
      return [{ id: 'receipt-allocation-1' }];
    }
    if (!result?.length && String(sql).includes('FROM pos_effective_prices')) {
      return [{ priceListId: null, productId: IDS.product, price: 1000 }];
    }
    if (!result?.length && String(sql).includes('FROM "pos_shifts"')) {
      return [{ id: '777777777777777777777778', openedById: IDS.cashier }];
    }
    return result;
  });
  query.mockImplementation(initialImplementation);
  return query;
}

function buildInvoiceDoc(overrides = {}) {
  const invoice = {
    _id: IDS.invoice,
    referenceNo: 'INV-POS-1',
    grandTotal: 1180,
    totalAmount: 1180,
    payments: [],
    save: jest.fn().mockResolvedValue(undefined),
    populate: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  invoice.populate.mockResolvedValue(invoice);
  return invoice;
}

function stubHappyPathDeps({ stockMatchedCount = 1, momoBank = null } = {}) {
  CurrencyService.getCompanyBase.mockResolvedValue('RWF');
  TillSession.findOne.mockResolvedValue({ _id: IDS.till, status: 'open', openedBy: IDS.cashier });
  Warehouse.findOne.mockResolvedValue({ _id: IDS.warehouse });
  Product.find.mockReturnValue(leanFind([catalogProduct()]));
  StockLevel.find.mockReturnValue({ lean: jest.fn().mockResolvedValue(stockLevelRows()) });
  StockLevel.updateMany.mockResolvedValue({ matchedCount: stockMatchedCount });
  Client.findOne.mockResolvedValue(null);
  Client.create.mockResolvedValue({
    _id: IDS.client,
    name: 'Walk-in Customer',
    totalPurchases: 0,
    outstandingBalance: 0,
    save: jest.fn().mockResolvedValue(undefined),
  });
  const invoice = buildInvoiceDoc();
  Invoice.create.mockResolvedValue([invoice]);
  inventoryService.consume.mockResolvedValue({
    allocations: [{ qty: 1, unitCost: 400, amount: 400 }],
    totalCost: 400,
  });
  Product.bulkWrite.mockResolvedValue({});
  StockMovement.insertMany.mockResolvedValue([]);
  JournalService.getMappedAccountCode.mockImplementation(async (_c, _m, _k, fallback) => fallback);
  JournalService.createEntriesAtomic.mockResolvedValue([{ _id: 'je-rev' }, { _id: 'je-cogs' }]);
  BankAccount.findOne.mockReturnValue({
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(momoBank),
    }),
  });
  BankAccount.invalidateCacheForLedgerAccount.mockResolvedValue(undefined);
  cacheService.bumpCompanyFinancialCaches.mockResolvedValue(undefined);
  consumeApproval.mockResolvedValue(IDS.approval);

  const db = {
    stockBatch: { groupBy: jest.fn().mockResolvedValue([]) },
    category: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findFirst: jest.fn().mockResolvedValue({ id: IDS.cashier, name: 'Cashier' }) },
    userRole: { findMany: jest.fn().mockResolvedValue([]) },
    invoiceLine: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    restaurantStockCommitment: { findMany: jest.fn().mockResolvedValue([]) },
    posCustomerCreditLedger: { create: jest.fn().mockResolvedValue({ id: 'credit-ledger-1' }) },
    systemSettings: { findUnique: jest.fn().mockResolvedValue({ posDiscountSettings: discountTestSettings }) },
    // SELECT replay → empty; INSERT reservation → claimed row.
    $queryRawUnsafe: checkoutQueryMock(async (sql) => {
      if (String(sql).includes('INSERT INTO pos_sale_requests')) {
        return [{ requestKey: 'claimed' }];
      }
      if (String(sql).includes('INSERT INTO pos_stored_value_accounts')) {
        return [{ id: 'loyalty-wallet-id', balance: 1 }];
      }
      return [];
    }),
    $executeRawUnsafe: jest.fn().mockResolvedValue(1),
  };
  dbClient.mockReturnValue(db);
  runInTransaction.mockImplementation(async (fn) => fn(null));
  return { invoice, db };
}

describe('POS E2E — checkout (sales-legacy)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    moduleEntitlementService.hasModule.mockResolvedValue(true);
    moduleEntitlementService.getEntitlement.mockResolvedValue({ status: 'on', version: 1 });
    dbClient.mockReturnValue({
      systemSettings: { findUnique: jest.fn().mockResolvedValue(null) },
      user: { findFirst: jest.fn().mockResolvedValue({ id: IDS.cashier, name: 'Cashier' }) },
      userRole: { findMany: jest.fn().mockResolvedValue([]) },
    });
    posAccountingProfileService.getProfile.mockResolvedValue({
      companyDefaults: {},
      tillTypeOverrides: {},
      registerOverrides: {},
    });
    posAccountingProfileService.resolveAccount.mockImplementation(() => null);
    const paymentService = require('../services/posPaymentService');
    paymentService.getPaymentSettings.mockResolvedValue({
      paymentFlow: 'LEGACY',
      registerPaymentFlowOverrides: {},
    });
    paymentService.resolvePaymentFlow.mockReturnValue('LEGACY');
  });

  test('rejects checkout when no open till exists for the register', async () => {
    CurrencyService.getCompanyBase.mockResolvedValue('RWF');
    TillSession.findOne.mockResolvedValue(null);
    dbClient.mockReturnValue(emptyCheckoutDb());
    const res = mockRes();
    await createDirectSale(makeReq({ body: checkoutBody() }), res, jest.fn());
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('POS_SHIFT_REQUIRED');
    expect(res.body.message).toMatch(/Open this register shift/i);
  });

  test('rejects checkout from an unpaired device before reading or creating a sale', async () => {
    findClaimedRegister.mockResolvedValueOnce(null);
    const next = jest.fn();
    const res = mockRes();
    await createDirectSale(makeReq({ body: checkoutBody() }), res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403, code: 'POS_REGISTER_CLAIM_REQUIRED' }));
    expect(TillSession.findOne).not.toHaveBeenCalled();
    expect(Invoice.create).not.toHaveBeenCalled();
    expect(runInTransaction).not.toHaveBeenCalled();
  });

  test('requires a card slip reference for a manual card tender', async () => {
    CurrencyService.getCompanyBase.mockResolvedValue('RWF');
    TillSession.findOne.mockResolvedValue({ _id: IDS.till, status: 'open', openedBy: IDS.cashier });
    Warehouse.findOne.mockResolvedValue({ _id: IDS.warehouse });
    Product.find.mockReturnValue(leanFind([catalogProduct()]));
    StockLevel.find.mockReturnValue({ lean: jest.fn().mockResolvedValue(stockLevelRows()) });
    dbClient.mockReturnValue(emptyCheckoutDb());

    const res = mockRes();
    await createDirectSale(makeReq({
      body: checkoutBody({ paymentMethod: 'card', paymentAmount: 1180 }),
    }), res, jest.fn());

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('POS_PAYMENT_REFERENCE_REQUIRED');
    expect(runInTransaction).not.toHaveBeenCalled();
  });

  test('requires a manager approval for discounts / price overrides', async () => {
    CurrencyService.getCompanyBase.mockResolvedValue('RWF');
    TillSession.findOne.mockResolvedValue({ _id: IDS.till, status: 'open', openedBy: IDS.cashier });
    Warehouse.findOne.mockResolvedValue({ _id: IDS.warehouse });
    Product.find.mockReturnValue(leanFind([catalogProduct()]));
    StockLevel.find.mockReturnValue({ lean: jest.fn().mockResolvedValue(stockLevelRows()) });
    const { db } = stubHappyPathDeps();
    db.systemSettings.findUnique.mockResolvedValue({ posDiscountSettings: discountTestSettings });

    const res = mockRes();
    await createDirectSale(makeReq({
      body: checkoutBody({
        items: [saleLine({ discountPct: 10, unitPrice: 1000 })],
        paymentAmount: 1062,
      }),
    }), res, jest.fn());

    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('POS_MANAGER_APPROVAL_REQUIRED');
  });

  test('denies open-price checkout without the dedicated POS permission', async () => {
    const openPriceProductId = IDS.product;
    const { db } = stubHappyPathDeps();
    Product.find.mockReturnValue(leanFind([catalogProduct({ isStockable: false })]));
    StockLevel.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
    db.systemSettings.findUnique.mockResolvedValue({
      posDiscountSettings: discountTestSettings,
      posScannerSettings: { openPriceProductId },
    });
    const req = makeReq({
      body: checkoutBody({
        items: [saleLine({ openPrice: true, description: 'Emergency service', unitPrice: 1500 })],
        paymentAmount: 1770,
      }),
    });
    req.posAuthContext = {
      user: { id: IDS.cashier, role: { id: 'cashier-role', name: 'cashier', permissions: [] } },
      session: { companyId: IDS.company, registerId: '888888888888888888888888' },
      settings: { posRolePermissions: {} },
    };

    const res = mockRes();
    await createDirectSale(req, res, jest.fn());

    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('POS_PERMISSION_DENIED');
    expect(Invoice.create).not.toHaveBeenCalled();
  });

  test('posts an authorized open-price line with the configured product tax and no stock movement', async () => {
    const { db } = stubHappyPathDeps();
    Product.find.mockReturnValue(leanFind([catalogProduct({ isStockable: false })]));
    StockLevel.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
    db.systemSettings.findUnique.mockResolvedValue({
      posDiscountSettings: discountTestSettings,
      posScannerSettings: { openPriceProductId: IDS.product },
    });
    const req = makeReq({
      body: checkoutBody({
        items: [saleLine({
          openPrice: true,
          description: 'Emergency service',
          unitPrice: 1500,
        })],
        paymentAmount: 1770,
      }),
    });
    req.posAuthContext = {
      user: { id: IDS.cashier, role: { id: 'supervisor-role', name: 'supervisor', permissions: [] } },
      session: { companyId: IDS.company, registerId: '888888888888888888888888' },
      settings: { posRolePermissions: {} },
    };

    const res = mockRes();
    await createDirectSale(req, res, (error) => { throw error; });

    expect(res.statusCode).toBe(201);
    expect(Invoice.create.mock.calls[0][0][0].lines[0]).toMatchObject({
      description: 'Emergency service',
      unitPrice: 1500,
      taxRate: 18,
      taxCode: 'B',
    });
    expect(StockMovement.insertMany).not.toHaveBeenCalled();
    expect(inventoryService.consume).not.toHaveBeenCalled();
  });

  test('rejects cart discounts on open-price items', async () => {
    const { db } = stubHappyPathDeps();
    Product.find.mockReturnValue(leanFind([catalogProduct({ isStockable: false })]));
    StockLevel.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
    db.systemSettings.findUnique.mockResolvedValue({
      posDiscountSettings: discountTestSettings,
      posScannerSettings: { openPriceProductId: IDS.product },
    });
    const req = makeReq({
      body: checkoutBody({
        items: [saleLine({ openPrice: true, description: 'Emergency service', unitPrice: 1500 })],
        cartDiscountPct: 10,
        cartDiscountReason: 'Test discount',
        paymentAmount: 1593,
      }),
    });
    req.posAuthContext = {
      user: { id: IDS.cashier, role: { id: 'supervisor-role', name: 'supervisor', permissions: [] } },
      session: { companyId: IDS.company, registerId: '888888888888888888888888' },
      settings: { posRolePermissions: {} },
    };

    const res = mockRes();
    await createDirectSale(req, res, jest.fn());

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('POS_OPEN_PRICE_DISCOUNT_UNSUPPORTED');
    expect(Invoice.create).not.toHaveBeenCalled();
  });

  test('cash checkout posts stock, journals, and till cash activity', async () => {
    const { invoice, db } = stubHappyPathDeps();
    const scopedProfile = {
      companyDefaults: { salesRevenue: '4000' },
      tillTypeOverrides: { retail: { salesRevenue: '4010' } },
      registerOverrides: { '888888888888888888888888': { posRegisterCash: '1005' } },
    };
    posAccountingProfileService.getProfile.mockResolvedValueOnce(scopedProfile);
    posAccountingProfileService.resolveAccount.mockImplementation((profile, key, scope) => (
      profile.registerOverrides[scope.registerId]?.[key]
      || profile.tillTypeOverrides[scope.tillType]?.[key]
      || profile.companyDefaults[key]
      || null
    ));
    const shiftId = '777777777777777777777778';
    db.$queryRawUnsafe.mockImplementation(async (sql) => {
      if (String(sql).includes('FROM "pos_shifts"')) return [{ id: shiftId, openedById: IDS.cashier }];
      if (String(sql).includes('INSERT INTO pos_sale_requests')) return [{ requestKey: 'claimed' }];
      return [];
    });

    const res = mockRes();

    await createDirectSale(makeReq({
      body: checkoutBody(),
      headers: { 'Idempotency-Key': 'idem-key-abcdefghij' },
    }), res, (err) => { throw err; });

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBe(invoice);
    expect(res.body.changeDue).toBe(0);
    expect(Invoice.create.mock.calls[0][0][0].posCheckoutPayload).toEqual({
      items: [{ unitPrice: 1000, catalogUnitPrice: 1000 }],
      salespersonId: IDS.cashier,
      salespersonName: 'Cashier',
    });
    expect(db.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('"opened_by" AS "openedById"'),
      IDS.company,
      '888888888888888888888888',
    );
    expect(StockLevel.updateMany).toHaveBeenCalled();
    expect(inventoryService.consume).toHaveBeenCalled();
    expect(db.invoiceLine.updateMany).toHaveBeenCalledWith({
      where: {
        invoiceId: IDS.invoice,
        companyId: IDS.company,
        lineOrder: 0,
        productId: IDS.product,
      },
      data: { unitCost: 400, cogsAmount: 400 },
    });
    expect(JournalService.createEntriesAtomic).toHaveBeenCalled();
    const [, , journalEntries, journalOptions] = JournalService.createEntriesAtomic.mock.calls[0];
    expect(journalOptions).toEqual(expect.objectContaining({
      session: expect.objectContaining({
        $executeRawUnsafe: expect.any(Function),
        $queryRawUnsafe: expect.any(Function),
      }),
      allowDuplicate: false,
    }));
    expect(journalEntries[0].lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountCode: '1005', debit: 1180 }),
      expect.objectContaining({ accountCode: '4010', credit: 1000 }),
    ]));
    expect(posAccountingProfileService.resolveAccount).toHaveBeenCalledWith(
      scopedProfile,
      'posRegisterCash',
      { tillType: 'retail', registerId: '888888888888888888888888' },
    );
    expect(posAccountingProfileService.resolveAccount).toHaveBeenCalledWith(
      scopedProfile,
      'loyaltyRewardsExpense',
      { tillType: 'retail', registerId: '888888888888888888888888' },
    );
    expect(findClaimedRegister).toHaveBeenCalledWith(IDS.company, IDS.registerId, IDS.deviceId);
    expect(db.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('shift_id = $5, cashier_id = $6'),
      IDS.till,
      '',
      IDS.invoice,
      IDS.company,
      shiftId,
      IDS.cashier,
    );
    expect(db.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE till_sessions SET expected_cash'),
      1180,
      expect.any(String),
      IDS.company,
      IDS.till,
      IDS.cashier,
    );
  });

  test('Restaurant recipe checkout uses committed ingredient cost without deducting the menu product twice', async () => {
    const { db } = stubHappyPathDeps();
    const orderItemId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    const shiftId = '777777777777777777777778';
    db.restaurantStockCommitment.findMany.mockResolvedValue([
      { orderItemId, totalCost: 30 },
      { orderItemId, totalCost: 5.25 },
    ]);
    db.$queryRawUnsafe.mockImplementation(async (sql) => {
      if (String(sql).includes('FROM "pos_shifts"')) return [{ id: shiftId, openedById: IDS.cashier }];
      if (String(sql).includes('INSERT INTO pos_sale_requests')) return [{ requestKey: 'claimed' }];
      return [];
    });
    const request = makeReq({
      body: checkoutBody({ items: [saleLine({ taxCode: 'B', taxRate: 18 })] }),
      headers: { 'Idempotency-Key': 'restaurant-recipe-cogs-0001' },
    });
    request.posRestaurantCheckout = {
      lines: [{
        itemId: orderItemId,
        productId: IDS.product,
        quantity: 1,
        unitPrice: 1000,
        taxCode: 'B',
        taxRate: 18,
        description: 'POS Widget',
        discountPct: 0,
        stockMode: 'recipe',
        barStockProductId: null,
      }],
    };

    const res = mockRes();
    await createDirectSale(request, res, (err) => { throw err; });

    expect(res.statusCode).toBe(201);
    expect(inventoryService.consume).not.toHaveBeenCalled();
    expect(StockLevel.updateMany).not.toHaveBeenCalled();
    expect(Product.bulkWrite).not.toHaveBeenCalled();
    expect(StockMovement.insertMany).not.toHaveBeenCalled();
    expect(db.restaurantStockCommitment.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        companyId: IDS.company,
        orderItemId: { in: [orderItemId] },
        status: 'committed',
      }),
    }));
    expect(db.invoiceLine.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ invoiceId: IDS.invoice, lineOrder: 0, productId: IDS.product }),
      data: { unitCost: 35.25, cogsAmount: 35.25 },
    }));
    const journalLines = JournalService.createEntriesAtomic.mock.calls[0][2].flatMap((entry) => entry.lines);
    expect(journalLines).toEqual(expect.arrayContaining([expect.objectContaining({ debit: 35.25 })]));
  });

  test('applies a saved Restaurant promotion discount without requiring manual discount approval', async () => {
    stubHappyPathDeps();
    Invoice.create.mockResolvedValue([buildInvoiceDoc({ grandTotal: 800, totalAmount: 800 })]);
    const orderItemId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    const request = makeReq({
      body: checkoutBody({
        items: [saleLine({
          unitPrice: 1000,
          discountPct: 20,
          discountReason: '',
          taxCode: 'A',
          taxRate: 0,
        })],
        paymentAmount: 800,
      }),
    });
    request.posRestaurantCheckout = {
      lines: [{
        itemId: orderItemId,
        productId: IDS.product,
        quantity: 1,
        unitPrice: 1000,
        taxCode: 'A',
        taxRate: 0,
        description: 'POS Widget',
        discountPct: 20,
        promotionSnapshot: { unitPrice: 800 },
      }],
    };

    const res = mockRes();
    await createDirectSale(request, res, (error) => { throw error; });

    expect(res.statusCode).toBe(201);
    expect(Invoice.create.mock.calls[0][0][0].lines[0]).toMatchObject({
      unitPrice: 1000,
      discountPct: 20,
      lineSubtotal: 1000,
      taxRate: 0,
      taxAmount: 0,
      lineTotal: 800,
    });
  });

  test('completes an approved discounted sale without updating the protected walk-in customer', async () => {
    const { db } = stubHappyPathDeps();
    const walkInCustomer = {
      _id: IDS.client,
      isWalkIn: true,
      totalPurchases: 0,
      save: jest.fn().mockResolvedValue(undefined),
    };
    Client.findOne.mockResolvedValue(walkInCustomer);
    db.$queryRawUnsafe.mockImplementation(async (sql) => {
      if (String(sql).includes('FROM "pos_shifts"')) {
        return [{ id: '777777777777777777777778', openedById: IDS.cashier }];
      }
      if (String(sql).includes('INSERT INTO pos_sale_requests')) return [{ requestKey: 'claimed' }];
      return [];
    });

    const res = mockRes();
    await createDirectSale(makeReq({
      body: checkoutBody({
        clientId: IDS.client,
        items: [saleLine({ discountPct: 10 })],
        paymentAmount: 1062,
        managerApprovalId: IDS.approval,
      }),
      headers: { 'Idempotency-Key': 'approved-walkin-sale-1' },
    }), res, (err) => { throw err; });

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(consumeApproval).toHaveBeenCalled();
    expect(walkInCustomer.save).not.toHaveBeenCalled();
    expect(JournalService.createEntriesAtomic).toHaveBeenCalled();
  });

  test('V2 checkout stores a pending invoice without stock, journal, or till-cash side effects', async () => {
    const { db } = stubHappyPathDeps();
    const shiftId = '777777777777777777777778';
    const paymentSettings = require('../services/posPaymentService');
    paymentSettings.resolvePaymentFlow.mockReturnValueOnce('PAYMENTS_V2');
    db.$queryRawUnsafe.mockImplementation(async (sql) => {
      if (String(sql).includes('FROM "pos_shifts"')) return [{ id: shiftId, openedById: IDS.cashier }];
      if (String(sql).includes('INSERT INTO pos_sale_requests')) return [{ requestKey: 'claimed' }];
      return [];
    });

    const req = makeReq({
      body: checkoutBody({ paymentAmount: 0 }),
      headers: { 'Idempotency-Key': 'idem-key-abcdefghij' },
    });
    req.posPaymentFlow = 'PAYMENTS_V2';
    const res = mockRes();

    await createDirectSale(req, res, (err) => { throw err; });

    expect(res.statusCode).toBe(201);
    expect(res.body.paymentRequired).toBe(true);
    expect(Invoice.create).toHaveBeenCalledWith([expect.objectContaining({
      status: 'PENDING_PAYMENT',
      amountPaid: 0,
      amountOutstanding: 1180,
      stockDeducted: false,
      autoConfirm: false,
      registerId: '888888888888888888888888',
      shiftId,
      cashierId: IDS.cashier,
      posCheckoutPayload: expect.objectContaining({ items: expect.any(Array) }),
    })], expect.objectContaining({ session: null }));
    expect(StockLevel.updateMany).not.toHaveBeenCalled();
    expect(inventoryService.consume).not.toHaveBeenCalled();
    expect(JournalService.createEntriesAtomic).not.toHaveBeenCalled();
    expect(db.$executeRawUnsafe).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE till_sessions SET expected_cash'),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  test('V2 offline cash creates a pending sale with the original operation metadata', async () => {
    moduleEntitlementService.hasModule.mockResolvedValue(false);
    moduleEntitlementService.getEntitlement.mockResolvedValue({ status: 'off', version: 1 });
    const { db } = stubHappyPathDeps();
    process.env.JWT_SECRET = 'unit-test-secret-that-is-at-least-32-characters';
    const paymentService = require('../services/posPaymentService');
    paymentService.resolvePaymentFlow.mockReturnValueOnce('PAYMENTS_V2');
    const issuedAt = Date.now() - 1000;
    const expiresAt = issuedAt + 24 * 60 * 60 * 1000;
    const snapshotId = '333333333333333333333333';
    const snapshotData = {
      fiscalMode: 'none',
      entitlementVersion: 1,
      products: {
        [IDS.product]: {
          name: 'Widget at snapshot',
          sku: 'WID-SNAP',
          unit: 'pcs',
          price: 1000,
          taxRate: 18,
          taxCode: 'B',
          isStockable: true,
          trackingType: 'none',
          averageCost: 400,
          availableStock: 3,
          serialNumbers: [],
        },
      },
      promotions: [],
      negativeStockAllowed: false,
      escalationDays: 3,
      paymentFlow: 'PAYMENTS_V2',
      offlinePolicy: { requiresFiscalSubmission: false },
    };
    db.$queryRawUnsafe.mockImplementation(async (sql) => {
      const statement = String(sql);
      if (statement.includes('SELECT request_key AS')) return [];
      if (statement.includes('FROM companies c LEFT JOIN system_settings s')) {
        return [{ ebmEnabled: false, offlinePolicy: { provisionalFiscalReceiptsAllowed: false } }];
      }
      if (statement.includes('FROM pos_offline_snapshots WHERE id = $1 AND company_id = $2 FOR UPDATE')) {
        return [{ queueLimit: 10000, usedValue: 0 }];
      }
      if (statement.includes('FROM pos_offline_snapshots WHERE id =')) {
        return [{
          id: snapshotId,
          warehouseId: IDS.warehouse,
          tillSessionId: IDS.till,
          snapshotData,
          fiscalMode: 'none',
          entitlementVersion: 1,
          queueLimit: 10000,
          expiresAt: new Date(expiresAt),
        }];
      }
      if (statement.includes('INSERT INTO pos_sale_requests')) return [{ requestKey: 'claimed' }];
      return [];
    });
    const operationId = 'offline-v2-operation-0001';
    const body = checkoutBody({
      paymentAmount: 0,
      deviceId: IDS.deviceId,
      items: [saleLine({ taxRate: 18, taxCode: 'B' })],
      offlineSnapshotCapability: issueCapability({
        id: snapshotId,
        companyId: IDS.company,
        userId: IDS.cashier,
        deviceId: IDS.deviceId,
        registerId: IDS.registerId,
        warehouseId: IDS.warehouse,
        tillSessionId: IDS.till,
        fiscalMode: 'none',
        entitlementVersion: 1,
        paymentFlow: 'PAYMENTS_V2',
        issuedAt,
        expiresAt,
      }),
      offlineReceiptNumber: 'INV-2026-00001',
      offlineSaleId: operationId,
      offlineOperationId: operationId,
      offlinePaymentFlow: 'PAYMENTS_V2',
      offlineCreatedAt: new Date(issuedAt + 500).toISOString(),
    });
    const req = makeReq({
      body,
      headers: { 'Idempotency-Key': `${operationId}-v2-create` },
    });
    req.posPaymentFlow = 'PAYMENTS_V2';
    const res = mockRes();

    await createDirectSale(req, res, (error) => { throw error; });

    expect(res.body).toMatchObject({ success: true });
    expect(res.statusCode).toBe(201);
    expect(res.body.paymentRequired).toBe(true);
    expect(Invoice.create.mock.calls[0][0][0].posCheckoutPayload).toMatchObject({
      paymentMethod: 'cash',
      offlineSnapshotCapability: body.offlineSnapshotCapability,
      offlineSaleId: operationId,
      offlineOperationId: operationId,
      offlinePaymentFlow: 'PAYMENTS_V2',
    });
    expect(db.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE pos_offline_snapshots SET used_value'),
      1180,
      snapshotId,
      IDS.company,
    );
    expect(StockLevel.updateMany).not.toHaveBeenCalled();
    expect(JournalService.createEntriesAtomic).not.toHaveBeenCalled();
  });

  test('holds an offline sale for review when the fiscal entitlement changed after snapshot issue', async () => {
    moduleEntitlementService.hasModule.mockResolvedValue(false);
    moduleEntitlementService.getEntitlement.mockResolvedValue({ status: 'on', version: 2 });
    const { db } = stubHappyPathDeps();
    process.env.JWT_SECRET = 'unit-test-secret-that-is-at-least-32-characters';
    const issuedAt = Date.now() - 1000;
    const expiresAt = issuedAt + 24 * 60 * 60 * 1000;
    const snapshotId = '333333333333333333333333';
    const snapshotData = {
      fiscalMode: 'none',
      entitlementVersion: 1,
      products: {},
    };
    db.$transaction = jest.fn(async (callback) => callback(db));
    db.posSyncException = {
      upsert: jest.fn().mockResolvedValue({ id: 'sync-exception-1', status: 'open' }),
    };
    db.$queryRawUnsafe.mockImplementation(async (sql) => {
      if (String(sql).includes('SELECT request_key AS')) return [];
      if (String(sql).includes('FROM pos_offline_snapshots WHERE id =')) {
        return [{
          id: snapshotId,
          warehouseId: IDS.warehouse,
          tillSessionId: IDS.till,
          snapshotData,
          fiscalMode: 'none',
          entitlementVersion: 1,
          queueLimit: 10000,
          expiresAt: new Date(expiresAt),
        }];
      }
      return [];
    });
    const operationId = 'offline-operation-changed-01';
    const body = checkoutBody({
      offlineSnapshotCapability: issueCapability({
        id: snapshotId,
        companyId: IDS.company,
        userId: IDS.cashier,
        deviceId: IDS.deviceId,
        registerId: IDS.registerId,
        warehouseId: IDS.warehouse,
        tillSessionId: IDS.till,
        fiscalMode: 'none',
        entitlementVersion: 1,
        issuedAt,
        expiresAt,
      }),
      offlineSaleId: operationId,
      offlineOperationId: operationId,
      offlineCreatedAt: new Date(issuedAt + 500).toISOString(),
    });
    const res = mockRes();

    await createDirectSale(makeReq({ body }), res, (error) => { throw error; });

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({
      code: 'POS_OFFLINE_FISCAL_ENTITLEMENT_CHANGED',
      syncExceptionId: 'sync-exception-1',
    });
    expect(db.posSyncException.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        companyId: IDS.company,
        deviceId: IDS.deviceId,
        operationId,
        errorCode: 'POS_OFFLINE_FISCAL_ENTITLEMENT_CHANGED',
        status: 'open',
      }),
    }));
    expect(Invoice.create).not.toHaveBeenCalled();
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'POS_OFFLINE_FISCAL_ENTITLEMENT_CHANGED',
    }), db);
  });

  test('V2 completion reuses the pending invoice and posts revenue plus COGS in one journal entry', async () => {
    const { invoice, db } = stubHappyPathDeps();
    const shiftId = '777777777777777777777778';
    require('../services/posPaymentService').resolvePaymentFlow.mockReturnValueOnce('PAYMENTS_V2');
    const client = {
      _id: IDS.client,
      name: 'Existing customer',
      totalPurchases: 0,
      outstandingBalance: 0,
      save: jest.fn().mockResolvedValue(undefined),
    };
    invoice.status = 'PENDING_PAYMENT';
    invoice.amountPaid = 0;
    invoice.amountOutstanding = 1180;
    invoice.registerId = '888888888888888888888888';
    invoice.shiftId = shiftId;
    invoice.cashierId = IDS.cashier;
    invoice.ebm = { paymentFlow: 'PAYMENTS_V2' };
    Client.findOne.mockResolvedValue(client);
    Invoice.findOne.mockReturnValue({
      session: jest.fn().mockResolvedValue(invoice),
    });
    db.invoiceLine.findMany.mockResolvedValue([{
      productId: IDS.product,
      qty: 1,
      unitPrice: 1000,
      discountPct: 0,
      taxRate: 18,
      lineSubtotal: 1000,
      lineTax: 180,
      lineTotal: 1180,
      warehouseId: IDS.warehouse,
      serialNumbers: [],
    }]);
    db.$queryRawUnsafe.mockImplementation(async (sql) => {
      if (String(sql).includes('INSERT INTO pos_sale_requests')) return [{ requestKey: 'claimed' }];
      if (String(sql).includes('pos_completion_key')) return [{ status: 'PENDING_PAYMENT', completionKey: null }];
      if (String(sql).includes('FROM "pos_shifts"')) return [{ id: shiftId, openedById: IDS.cashier }];
      if (String(sql).includes('INSERT INTO pos_stored_value_accounts')) {
        return [{ id: 'loyalty-wallet-id', balance: 10 }];
      }
      return [];
    });
    JournalService.createEntriesAtomic.mockResolvedValue([{ _id: 'je-v2-combined' }]);
    const req = makeReq({
      body: checkoutBody({
        clientId: IDS.client,
        payments: [{
          paymentMethod: 'mobile_money',
          provider: 'airtel',
          amount: 1180,
          reference: '',
          manualMobileMoneyPaymentId: 'manual-mobile-money-payment',
        }],
        paymentAmount: 0,
      }),
    });
    req.posPaymentFlow = 'PAYMENTS_V2';
    req.posV2Completion = {
      invoiceId: IDS.invoice,
      completionKey: 'complete-key-0001',
      manualMobileMoneyPaymentIds: ['manual-mobile-money-payment'],
    };
    const res = mockRes();

    await createDirectSale(req, res, (err) => { throw err; });

    expect(res.statusCode).toBe(201);
    expect(require('../services/posPaymentService').validateTenderConfiguration).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        method: 'AIRTEL_MONEY',
        reference: '',
        allowOptionalReference: true,
      }),
    );
    expect(Invoice.create).not.toHaveBeenCalled();
    expect(JournalService.createEntriesAtomic).toHaveBeenCalledTimes(1);
    const entries = JournalService.createEntriesAtomic.mock.calls[0][2];
    expect(entries).toHaveLength(1);
    expect(entries[0].sourceType).toBe('invoice');
    expect(entries[0].lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountCode: '4000', credit: 1000 }),
      expect.objectContaining({ accountCode: '5000', debit: 400 }),
      expect.objectContaining({ accountCode: '1400', credit: 400 }),
    ]));
    expect(invoice.revenueJournalEntry).toBe('je-v2-combined');
    expect(invoice.cogsJournalEntry).toBeNull();
    expect(db.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('SET pos_completion_key = $1, pos_checkout_payload = NULL'),
      'complete-key-0001',
      IDS.invoice,
      IDS.company,
    );
  });

  test('V2 credit completion updates the customer balance and posts to the existing AR ledger', async () => {
    const { invoice, db } = stubHappyPathDeps();
    const shiftId = '777777777777777777777778';
    const paymentSettings = require('../services/posPaymentService');
    paymentSettings.resolvePaymentFlow.mockReturnValueOnce('PAYMENTS_V2');
    const client = {
      _id: IDS.client,
      name: 'Account Customer',
      totalPurchases: 0,
      outstandingBalance: 0,
      save: jest.fn().mockResolvedValue(undefined),
    };
    db.arTransactionLedger = { create: jest.fn().mockResolvedValue({ id: 'ar-ledger-row' }) };
    invoice.status = 'PENDING_PAYMENT';
    invoice.amountPaid = 0;
    invoice.amountOutstanding = 1180;
    invoice.registerId = '888888888888888888888888';
    invoice.shiftId = shiftId;
    invoice.cashierId = IDS.cashier;
    invoice.ebm = { paymentFlow: 'PAYMENTS_V2' };
    Client.findOne.mockResolvedValue(client);
    Invoice.findOne.mockReturnValue({
      session: jest.fn().mockResolvedValue(invoice),
    });
    db.invoiceLine.findMany.mockResolvedValue([{
      productId: IDS.product,
      qty: 1,
      unitPrice: 1000,
      discountPct: 0,
      taxRate: 18,
      lineSubtotal: 1000,
      lineTax: 180,
      lineTotal: 1180,
      warehouseId: IDS.warehouse,
      serialNumbers: [],
    }]);
    db.$queryRawUnsafe.mockImplementation(async (sql) => {
      if (String(sql).includes('SELECT credit_limit')) {
        return [{ credit_limit: '500', outstanding_balance: '100', code: 'ACCOUNT-1' }];
      }
      if (String(sql).includes('COALESCE(SUM(amount_outstanding)')) return [{ overdueAmount: '0' }];
      if (String(sql).includes('INSERT INTO pos_sale_requests')) return [{ requestKey: 'claimed' }];
      if (String(sql).includes('pos_completion_key')) return [{ status: 'PENDING_PAYMENT', completionKey: null }];
      if (String(sql).includes('FROM "pos_shifts"')) return [{ id: shiftId, openedById: IDS.cashier }];
      if (String(sql).includes('INSERT INTO pos_stored_value_accounts')) {
        return [{ id: 'loyalty-wallet-id', balance: 10 }];
      }
      return [];
    });
    JournalService.createEntriesAtomic.mockResolvedValue([{ _id: 'je-v2-credit' }]);
    const req = makeReq({
      body: checkoutBody({
        clientId: IDS.client,
        payments: [{ paymentMethod: 'cash', amount: 780 }],
        paymentAmount: 0,
      }),
    });
    req.posPaymentFlow = 'PAYMENTS_V2';
    req.posV2Completion = {
      invoiceId: IDS.invoice,
      completionKey: 'complete-credit-0001',
      creditAmount: 400,
      creditPaymentIds: ['credit-payment-id'],
    };
    const res = mockRes();

    await createDirectSale(req, res, (err) => { throw err; });

    expect(res.statusCode).toBe(201);
    expect(client.outstandingBalance).toBe(500);
    expect(db.arTransactionLedger.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        clientId: IDS.client,
        invoiceId: IDS.invoice,
        transactionType: 'invoice_created',
        amount: 400,
        direction: 'increase',
        clientBalanceAfter: 500,
        journalEntryId: 'je-v2-credit',
        metadata: { paymentFlow: 'PAYMENTS_V2', paymentIds: ['credit-payment-id'] },
      }),
    });
    expect(db.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining("'partially_paid'"),
      'complete-credit-0001',
      IDS.invoice,
      IDS.company,
    );
  });

  test('V2 credit completion requires manager approval when credit exceeds the limit', async () => {
    const { invoice, db } = stubHappyPathDeps();
    const paymentSettings = require('../services/posPaymentService');
    paymentSettings.resolvePaymentFlow.mockReturnValueOnce('PAYMENTS_V2');
    paymentSettings.getPaymentSettings
      .mockResolvedValueOnce({
        paymentFlow: 'PAYMENTS_V2',
        allowOverCreditLimit: true,
      })
      .mockResolvedValueOnce({
        paymentFlow: 'PAYMENTS_V2',
        allowOverCreditLimit: true,
      });
    const client = {
      _id: IDS.client,
      name: 'Account Customer',
      totalPurchases: 0,
      outstandingBalance: 0,
      save: jest.fn().mockResolvedValue(undefined),
    };
    db.arTransactionLedger = { create: jest.fn().mockResolvedValue({ id: 'ar-ledger-row' }) };
    invoice.status = 'PENDING_PAYMENT';
    invoice.amountPaid = 0;
    invoice.amountOutstanding = 1180;
    invoice.registerId = '888888888888888888888888';
    invoice.shiftId = '777777777777777777777778';
    invoice.cashierId = IDS.cashier;
    invoice.ebm = { paymentFlow: 'PAYMENTS_V2' };
    Client.findOne.mockResolvedValue(client);
    Invoice.findOne.mockReturnValue({ session: jest.fn().mockResolvedValue(invoice) });
    db.invoiceLine.findMany.mockResolvedValue([{
      productId: IDS.product,
      qty: 1,
      unitPrice: 1000,
      discountPct: 0,
      taxRate: 18,
      lineSubtotal: 1000,
      lineTax: 180,
      lineTotal: 1180,
      warehouseId: IDS.warehouse,
      serialNumbers: [],
    }]);
    db.posApproval = {
      findFirst: jest.fn().mockResolvedValue({
        id: 'approval-1',
        approvedBy: 'manager-1',
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    db.$queryRawUnsafe.mockImplementation(async (sql) => {
      if (String(sql).includes('SELECT credit_limit')) {
        return [{ credit_limit: '300', outstanding_balance: '100', code: 'ACCOUNT-1' }];
      }
      if (String(sql).includes('COALESCE(SUM(amount_outstanding)')) return [{ overdueAmount: '0' }];
      if (String(sql).includes('INSERT INTO pos_sale_requests')) return [{ requestKey: 'claimed' }];
      if (String(sql).includes('pos_completion_key')) return [{ status: 'PENDING_PAYMENT', completionKey: null }];
      if (String(sql).includes('FROM "pos_shifts"')) return [{ id: '777777777777777777777778', openedById: IDS.cashier }];
      if (String(sql).includes('INSERT INTO pos_stored_value_accounts')) {
        return [{ id: 'loyalty-wallet-id', balance: 10 }];
      }
      return [];
    });
    JournalService.createEntriesAtomic.mockResolvedValue([{ _id: 'je-v2-credit' }]);
    const req = makeReq({
      body: checkoutBody({
        clientId: IDS.client,
        payments: [{ paymentMethod: 'cash', amount: 780 }],
        paymentAmount: 0,
      }),
      headers: { 'x-pos-approval-token': 'one-use-credit-approval' },
    });
    req.posPaymentFlow = 'PAYMENTS_V2';
    req.posV2Completion = {
      invoiceId: IDS.invoice,
      completionKey: 'complete-credit-0002',
      creditAmount: 400,
      creditPaymentIds: ['credit-payment-id'],
      creditApprovalToken: 'one-use-credit-approval',
      creditOverrideReason: 'Manager-approved credit exception',
    };
    const res = mockRes();

    await createDirectSale(req, res, (err) => { throw err; });

    expect(res.statusCode).toBe(201);
    expect(db.posCustomerCreditLedger.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ entryType: 'CHARGE', direction: 'increase', invoiceId: IDS.invoice }),
    }));
    expect(db.posApproval.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        action: 'CREDIT_OVER_LIMIT',
        context: { equals: {
          saleId: IDS.invoice,
          clientId: IDS.client,
          creditAmount: 400,
          creditLimit: 300,
          outstandingBalance: 100,
          reason: 'Manager-approved credit exception',
        } },
      }),
    }));
    expect(db.posApproval.updateMany).toHaveBeenCalled();
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'APPROVAL_USED',
      metadata: expect.objectContaining({ action: 'CREDIT_OVER_LIMIT', approvedBy: 'manager-1' }),
    }), db);
  });

  test('V2 gift card completion posts the liability tender without debiting the card a second time', async () => {
    const { invoice, db } = stubHappyPathDeps();
    const shiftId = '777777777777777777777778';
    require('../services/posPaymentService').resolvePaymentFlow.mockReturnValueOnce('PAYMENTS_V2');
    const client = {
      _id: IDS.client,
      name: 'Gift card customer',
      totalPurchases: 0,
      outstandingBalance: 0,
      save: jest.fn().mockResolvedValue(undefined),
    };
    invoice.status = 'PENDING_PAYMENT';
    invoice.amountPaid = 0;
    invoice.amountOutstanding = 1180;
    invoice.currencyCode = 'RWF';
    invoice.registerId = '888888888888888888888888';
    invoice.shiftId = shiftId;
    invoice.cashierId = IDS.cashier;
    invoice.ebm = { paymentFlow: 'PAYMENTS_V2' };
    Client.findOne.mockResolvedValue(client);
    Invoice.findOne.mockReturnValue({ session: jest.fn().mockResolvedValue(invoice) });
    db.invoiceLine.findMany.mockResolvedValue([{
      productId: IDS.product,
      qty: 1,
      unitPrice: 1000,
      discountPct: 0,
      taxRate: 18,
      lineSubtotal: 1000,
      lineTax: 180,
      lineTotal: 1180,
      warehouseId: IDS.warehouse,
      serialNumbers: [],
    }]);
    db.$queryRawUnsafe.mockImplementation(async (sql) => {
      if (String(sql).includes('INSERT INTO pos_sale_requests')) return [{ requestKey: 'claimed' }];
      if (String(sql).includes('FROM pos_stored_value_ledger l')) {
        return [{ id: 'redemption-ledger', accountId: 'gift-card-account', amount: '1180', reference: 'EF01' }];
      }
      if (String(sql).includes('pos_completion_key')) return [{ status: 'PENDING_PAYMENT', completionKey: null }];
      if (String(sql).includes('FROM "pos_shifts"')) return [{ id: shiftId, openedById: IDS.cashier }];
      if (String(sql).includes('INSERT INTO pos_stored_value_accounts')) {
        return [{ id: 'loyalty-wallet-id', balance: 10 }];
      }
      return [];
    });
    JournalService.createEntriesAtomic.mockResolvedValue([{ _id: 'je-v2-gift-card' }]);
    const req = makeReq({
      body: checkoutBody({
        clientId: IDS.client,
        payments: [{
          paymentMethod: 'gift_card',
          amount: 1180,
          reference: 'EF01',
          storedValueAccountId: 'gift-card-account',
          posPaymentId: 'gift-card-payment',
        }],
        paymentAmount: 0,
      }),
    });
    req.posPaymentFlow = 'PAYMENTS_V2';
    req.posV2Completion = {
      invoiceId: IDS.invoice,
      completionKey: 'complete-gift-0001',
      storedValuePaymentIds: ['gift-card-payment'],
    };
    const res = mockRes();

    await createDirectSale(req, res, (err) => { throw err; });

    expect(res.statusCode).toBe(201);
    expect(JournalService.createEntriesAtomic).toHaveBeenCalledTimes(1);
    const entries = JournalService.createEntriesAtomic.mock.calls[0][2];
    expect(entries).toHaveLength(1);
    expect(entries[0].lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountCode: '2850', debit: 1180, credit: 0 }),
      expect.objectContaining({ accountCode: '4000', credit: 1000 }),
      expect.objectContaining({ accountCode: '5000', debit: 400 }),
      expect.objectContaining({ accountCode: '1400', credit: 400 }),
    ]));
    expect(db.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('pos_payment_id = $3'),
      IDS.company,
      'gift-card-account',
      'gift-card-payment',
      IDS.invoice,
    );
    const redemptionValidationQuery = db.$queryRawUnsafe.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes('pos_payment_id = $3'));
    expect(redemptionValidationQuery).toContain('JOIN pos_payments');
    expect(redemptionValidationQuery).toContain('p.company_id = l.company_id');
    expect(redemptionValidationQuery).toContain('AND NOT EXISTS');
    expect(db.$queryRawUnsafe).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE pos_stored_value_accounts SET balance = balance -'),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  test('V2 gift-card completion keeps the sale after journal failure and replays without repeating business work', async () => {
    const { db } = stubHappyPathDeps();
    const completionKey = 'complete-retry-giftcard-0001';
    const shiftId = '777777777777777777777778';
    const registerId = '888888888888888888888888';
    db.posRegister = { findFirst: jest.fn().mockResolvedValue({ id: registerId, companyId: IDS.company }) };
    db.posShift = { findFirst: jest.fn().mockResolvedValue({ id: shiftId, companyId: IDS.company, registerId }) };
    db.ebmSubmissionQueue = {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }) => data),
    };
    db.ebmAlert = { create: jest.fn().mockResolvedValue({ id: 'ebm-alert-retry' }) };
    const cashierId = IDS.cashier;
    const posPayment = {
      id: 'gift-card-payment-retry',
      companyId: IDS.company,
      saleId: IDS.invoice,
      method: 'GIFT_CARD',
      amount: 1180,
      reference: 'EF01',
      status: 'SUCCESS',
    };
    const pendingInvoice = {
      id: IDS.invoice,
      status: 'PENDING_PAYMENT',
      totalAmount: 1180,
      shiftId,
      registerId,
      cashierId,
      tillSessionId: IDS.till,
      clientId: IDS.client,
      posCheckoutPayload: {
        warehouseId: IDS.warehouse,
        items: [saleLine()],
      },
      posCompletionKey: null,
    };
    const completionState = { status: 'PENDING_PAYMENT', completionKey: null };
    db.invoice = { findFirst: jest.fn().mockResolvedValue(pendingInvoice) };
    db.posPayment = {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([posPayment]),
    };
    db.posShift = { findFirst: jest.fn().mockResolvedValue({ id: shiftId, companyId: IDS.company, registerId }) };
    const saleRequestReservations = [];
    const saleRequestFinalizations = [];
    let durableSaleRequest = null;
    db.$queryRawUnsafe.mockImplementation(async (sql, ...args) => {
      const query = String(sql);
      if (query.includes('SELECT request_key AS')) return durableSaleRequest ? [durableSaleRequest] : [];
      if (query.includes('INSERT INTO pos_sale_requests')) {
        saleRequestReservations.push(args);
        if (durableSaleRequest) return [];
        durableSaleRequest = {
          requestKey: args[1], createdById: args[2], payloadHash: args[3], invoiceId: null, status: 'processing',
        };
        return [{ requestKey: args[1] }];
      }
      if (query.includes('SELECT l.account_id AS "accountId"')) {
        return [{ accountId: 'gift-card-account', reference: 'EF01', codeSuffix: 'EF01', amount: '1180' }];
      }
      if (query.includes('SELECT l.id, l.amount::text AS amount')) {
        return [{ id: 'redemption-ledger', accountId: 'gift-card-account', amount: '1180', reference: 'EF01' }];
      }
      if (query.includes('pos_completion_key')) return [completionState];
      if (query.includes('FROM "pos_shifts"')) return [{ id: shiftId, openedById: IDS.cashier }];
      if (query.includes('INSERT INTO pos_stored_value_accounts')) {
        return [{ id: 'loyalty-wallet-id', balance: 10 }];
      }
      return [];
    });
    db.$executeRawUnsafe.mockImplementation(async (sql, ...args) => {
      if (String(sql).includes('UPDATE invoices SET pos_completion_key')) {
        completionState.status = 'fully_paid';
        completionState.completionKey = args[0];
      }
      if (String(sql).includes('UPDATE pos_sale_requests')) {
        saleRequestFinalizations.push(args);
        durableSaleRequest = {
          ...durableSaleRequest,
          invoiceId: args[2],
          status: 'completed',
        };
      }
      return 1;
    });
    const paymentService = require('../services/posPaymentService');
    paymentService.getPaymentSettings.mockResolvedValue({
      paymentFlow: 'PAYMENTS_V2',
      registerPaymentFlowOverrides: {},
    });
    paymentService.resolvePaymentFlow.mockReturnValue('PAYMENTS_V2');
    ebmService.getConfig.mockReturnValue({ mode: 'sandbox' });
    EBMSalesService.prepareV2SaleSubmission.mockResolvedValue({ payload: { invoiceNo: 'INV-GIFT-RETRY' } });
    const stockState = { warehouseQuantity: 50, productQuantity: 50, committedJournals: 0 };
    StockLevel.updateMany.mockImplementation(async (_filter, update) => {
      stockState.warehouseQuantity += update.$inc.qty_on_hand;
      return { matchedCount: 1 };
    });
    Product.bulkWrite.mockImplementation(async (operations) => {
      stockState.productQuantity += operations.reduce(
        (sum, operation) => sum + operation.updateOne.update.$inc.currentStock,
        0,
      );
    });
    JournalService.createEntriesAtomic
      .mockRejectedValueOnce(new Error('forced journal failure'))
      .mockImplementation(async () => {
        stockState.committedJournals += 1;
        return [{ _id: 'je-v2-gift-card-retry' }];
      });
    const initialStock = { ...stockState };
    let transactionTail = Promise.resolve();
    runInTransaction.mockImplementation(async (operation) => {
      const previousTransaction = transactionTail;
      let releaseTransaction;
      transactionTail = new Promise((resolve) => { releaseTransaction = resolve; });
      await previousTransaction;
      const transactionSnapshot = { ...stockState };
      const completionSnapshot = { ...completionState };
      try {
        return await operation({});
      } catch (error) {
        Object.assign(stockState, transactionSnapshot);
        Object.assign(completionState, completionSnapshot);
        throw error;
      } finally {
        releaseTransaction();
      }
    });
    const invoiceDoc = buildInvoiceDoc({
      _id: IDS.invoice,
      referenceNo: 'INV-GIFT-RETRY',
      grandTotal: 1180,
      totalAmount: 1180,
      amountPaid: 0,
      amountOutstanding: 1180,
      currencyCode: 'RWF',
      registerId,
      shiftId,
      cashierId,
      tillSessionId: IDS.till,
      client: IDS.client,
      status: 'PENDING_PAYMENT',
      ebm: { paymentFlow: 'PAYMENTS_V2' },
    });
    invoiceDoc.save.mockImplementation(async () => {
      completionState.status = invoiceDoc.status;
    });
    Invoice.findOne.mockImplementation(() => ({
      session: jest.fn().mockResolvedValue(invoiceDoc),
      populate: jest.fn().mockResolvedValue(invoiceDoc),
    }));
    Client.findOne.mockResolvedValue({
      _id: IDS.client,
      name: 'Gift card customer',
      totalPurchases: 0,
      outstandingBalance: 0,
      save: jest.fn().mockResolvedValue(undefined),
    });
    db.invoiceLine.findMany.mockResolvedValue([{
      productId: IDS.product,
      qty: 1,
      unitPrice: 1000,
      discountPct: 0,
      taxRate: 18,
      lineSubtotal: 1000,
      lineTax: 180,
      lineTotal: 1180,
      warehouseId: IDS.warehouse,
      serialNumbers: [],
    }]);
    const req = makeReq({
      headers: { 'Idempotency-Key': completionKey },
      params: { saleId: IDS.invoice },
    });
    req.posAuthContext = {
      company: { id: IDS.company },
      register: { id: registerId, code: IDS.registerId, claimedDeviceId: IDS.deviceId },
      user: { id: cashierId, name: 'Cashier' },
      session: { id: 'pos-session-retry', companyId: IDS.company, registerId },
    };
    req.posPermissions = ['pos.payment.take', 'pos.credit.sell', 'pos.giftcard.redeem'];
    const failed = mockRes();
    const next = (error) => { if (error) throw error; };

    await posPaymentsV2Controller.completeSale(req, failed, next);
    const retried = [mockRes(), mockRes()];
    await Promise.all(retried.map((res) => posPaymentsV2Controller.completeSale(req, res, next)));

    expect(failed.statusCode).toBe(201);
    expect(failed.body.success).toBe(true);
    expect(failed.body.data.posPostingStatus).toBe('pending');
    expect(retried.map((res) => res.statusCode)).toEqual([200, 200]);
    expect(retried.every((res) => res.body.success)).toBe(true);
    expect(retried.every((res) => res.body.replayed === true)).toBe(true);
    expect(retried.map((res) => res.body.data._id)).toEqual([IDS.invoice, IDS.invoice]);
    expect(retried[0].body.data).toBe(retried[1].body.data);
    expect(req.posV2Completion.completionKey).toBe(completionKey);
    expect(saleRequestReservations).toHaveLength(1);
    expect(saleRequestReservations[0][1]).toBe(completionKey);
    expect(saleRequestFinalizations).toHaveLength(1);
    expect(saleRequestFinalizations[0][1]).toBe(completionKey);
    expect(JournalService.createEntriesAtomic).toHaveBeenCalledTimes(1);
    expect(stockState).toEqual({
      warehouseQuantity: initialStock.warehouseQuantity - 1,
      productQuantity: initialStock.productQuantity - 1,
      committedJournals: 0,
    });
    expect(EBMSalesService.submitInvoiceAsync).toHaveBeenCalledTimes(1);
  });

  test('rejects client prices that do not match the warehouse-assigned price list', async () => {
    const { db } = stubHappyPathDeps();
    db.$queryRawUnsafe.mockImplementation(async (sql) => (
      String(sql).includes('FROM warehouses w')
        ? [{ priceListId: '888888888888888888888888', productId: IDS.product, price: '1200' }]
        : []
    ));
    const res = mockRes();

    await createDirectSale(makeReq({
      body: checkoutBody({ items: [saleLine({ unitPrice: 1000, catalogUnitPrice: 1000 })] }),
    }), res, jest.fn());

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('POS_PRICE_CHANGED');
    expect(Invoice.create).not.toHaveBeenCalled();
  });

  test('uses the warehouse-assigned product price as the sale-time invoice snapshot', async () => {
    const { db } = stubHappyPathDeps();
    db.$queryRawUnsafe.mockImplementation(async (sql) => (
      String(sql).includes('FROM warehouses w')
        ? [{ priceListId: '888888888888888888888888', productId: IDS.product, price: '1200' }]
        : []
    ));
    const res = mockRes();

    await createDirectSale(makeReq({
      body: checkoutBody({
        items: [saleLine({ unitPrice: 1200, catalogUnitPrice: 1200 })],
        paymentAmount: 1416,
      }),
    }), res, (error) => { throw error; });

    expect(res.statusCode).toBe(201);
    expect(Invoice.create.mock.calls[0][0][0].lines[0].unitPrice).toBe(1200);
  });

  test('rejects unpaid walk-in sales before creating a customer or invoice', async () => {
    stubHappyPathDeps();
    const res = mockRes();

    await createDirectSale(makeReq({ body: checkoutBody({ paymentAmount: 500 }) }), res, jest.fn());

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('POS_WALKIN_CREDIT_NOT_ALLOWED');
    expect(Client.create).not.toHaveBeenCalled();
    expect(Invoice.create).not.toHaveBeenCalled();
  });

  test('blocks a registered customer sale that exceeds available credit', async () => {
    const { db } = stubHappyPathDeps();
    Client.findOne.mockResolvedValue({ _id: IDS.client, name: 'Account Customer' });
    db.$queryRawUnsafe.mockImplementation(async (sql) => {
      if (String(sql).includes('SELECT credit_limit')) return [{ credit_limit: '1000', outstanding_balance: '400' }];
      if (String(sql).includes('INSERT INTO pos_sale_requests')) return [{ requestKey: 'claimed' }];
      return [];
    });
    const res = mockRes();

    await createDirectSale(makeReq({
      body: checkoutBody({ clientId: IDS.client, paymentAmount: 500 }),
    }), res, jest.fn());

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('POS_CREDIT_LIMIT_EXCEEDED');
    expect(Invoice.create).not.toHaveBeenCalled();
  });

  test('allows partial payment within available customer credit and saves the locked balance', async () => {
    const { db } = stubHappyPathDeps();
    const client = {
      _id: IDS.client,
      name: 'Account Customer',
      totalPurchases: 0,
      outstandingBalance: 0,
      save: jest.fn().mockResolvedValue(undefined),
    };
    Client.findOne.mockResolvedValue(client);
    db.$queryRawUnsafe.mockImplementation(async (sql, ...params) => {
      if (String(sql).includes('SELECT credit_limit')) return [{ credit_limit: '1000', outstanding_balance: '100' }];
      if (String(sql).includes('INSERT INTO pos_sale_requests')) return [{ requestKey: 'claimed' }];
      if (String(sql).includes('INSERT INTO pos_stored_value_accounts')) {
        return [{ id: 'loyalty-wallet-id', balance: params[4] }];
      }
      return [];
    });
    const res = mockRes();

    await createDirectSale(makeReq({
      body: checkoutBody({ clientId: IDS.client, paymentAmount: 500 }),
    }), res, (err) => { throw err; });

    expect(res.statusCode).toBe(201);
    expect(client.outstandingBalance).toBe(780);
    expect(client.save).toHaveBeenCalled();
  });

  test('mobile money checkout requires a payment reference and bank account', async () => {
    CurrencyService.getCompanyBase.mockResolvedValue('RWF');
    TillSession.findOne.mockResolvedValue({ _id: IDS.till, status: 'open', openedBy: IDS.cashier });
    Warehouse.findOne.mockResolvedValue({ _id: IDS.warehouse });
    Product.find.mockReturnValue(leanFind([catalogProduct()]));
    StockLevel.find.mockReturnValue({ lean: jest.fn().mockResolvedValue(stockLevelRows()) });
    dbClient.mockReturnValue(emptyCheckoutDb());

    const missingRef = mockRes();
    await createDirectSale(makeReq({
      body: checkoutBody({
        paymentMethod: 'mobile_money',
        paymentAmount: 1180,
        paymentReference: '',
        bankAccountId: IDS.bank,
      }),
    }), missingRef, jest.fn());
    expect(missingRef.statusCode).toBe(400);
    expect(missingRef.body.code).toBe('POS_PAYMENT_REFERENCE_REQUIRED');

    stubHappyPathDeps({
      momoBank: { _id: IDS.bank, ledgerAccountId: '1200', name: 'MoMo', isActive: true },
    });
    const ok = mockRes();
    await createDirectSale(makeReq({
      body: checkoutBody({
        paymentMethod: 'mobile_money',
        paymentProvider: 'momo',
        paymentAmount: 1180,
        paymentReference: 'MOMO-TX-99',
        bankAccountId: IDS.bank,
      }),
      headers: { 'Idempotency-Key': 'momo-key-abcdefghij' },
    }), ok, (err) => { throw err; });

    expect(ok.statusCode).toBe(201);
    expect(BankAccount.findOne).toHaveBeenCalledWith(expect.objectContaining({
      _id: IDS.bank,
      company: IDS.company,
      isActive: true,
    }));
  });

  test('legacy tills retain the current direct-sale checkout behavior', async () => {
    const { db } = stubHappyPathDeps();
    posPaymentService.resolvePaymentFlow.mockReturnValue('LEGACY');
    const res = mockRes();

    await createDirectSale(makeReq({
      body: checkoutBody({ paymentMethod: 'cash', paymentAmount: 1180 }),
      headers: { 'Idempotency-Key': 'legacy-flow-key-1234' },
    }), res, (err) => { throw err; });

    expect(res.statusCode).toBe(201);
    expect(Invoice.create).toHaveBeenCalledTimes(1);
    expect(posPaymentService.getPaymentSettings).toHaveBeenCalledWith(IDS.company);
    const completionAudits = writePosAuditLog.mock.calls.filter(([entry]) => entry.event === 'POS_SALE_COMPLETED');
    expect(completionAudits).toHaveLength(1);
    expect(completionAudits[0][1]).toBe(db);
    expect(completionAudits[0][0]).toEqual(expect.objectContaining({
      companyId: IDS.company,
      registerId: expect.any(String),
      userId: IDS.cashier,
      event: 'POS_SALE_COMPLETED',
      metadata: expect.objectContaining({ invoiceId: expect.any(String), paymentFlow: 'LEGACY' }),
    }));
  });

  test('rejects legacy direct-sale requests for V2 tills before creating a sale', async () => {
    stubHappyPathDeps();
    posPaymentService.resolvePaymentFlow.mockReturnValue('PAYMENTS_V2');
    const res = mockRes();

    await createDirectSale(makeReq({
      body: checkoutBody({ paymentMethod: 'cash', paymentAmount: 1180 }),
      headers: { 'Idempotency-Key': 'v2-legacy-key-1234' },
    }), res, jest.fn());

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      success: false,
      code: 'POS_PAYMENT_V2_REQUIRED',
      message: 'This till uses the new payment flow. Please use the payment screen.',
    });
    expect(Invoice.create).not.toHaveBeenCalled();
    expect(runInTransaction).not.toHaveBeenCalled();
  });

  test('switching a register setting back to LEGACY restores direct-sale checkout', async () => {
    stubHappyPathDeps();
    posPaymentService.resolvePaymentFlow
      .mockReturnValueOnce('PAYMENTS_V2')
      .mockReturnValueOnce('LEGACY');
    const blocked = mockRes();
    await createDirectSale(makeReq({
      body: checkoutBody({ paymentMethod: 'cash', paymentAmount: 1180 }),
      headers: { 'Idempotency-Key': 'switch-v2-key-1234' },
    }), blocked, jest.fn());
    expect(blocked.statusCode).toBe(409);

    stubHappyPathDeps();
    const restored = mockRes();
    await createDirectSale(makeReq({
      body: checkoutBody({ paymentMethod: 'cash', paymentAmount: 1180 }),
      headers: { 'Idempotency-Key': 'switch-legacy-key-1234' },
    }), restored, (err) => { throw err; });

    expect(restored.statusCode).toBe(201);
    expect(Invoice.create).toHaveBeenCalledTimes(1);
  });

  test('checkout payment-flow lookup is scoped to the claimed company register', async () => {
    const otherCompanyId = 'cccccccccccccccccccccccc';
    posPaymentService.getPaymentSettings.mockResolvedValue({
      paymentFlow: 'LEGACY',
      manualMobileMoneyMode: 'VERIFY',
      manualMobileMoneyReceivers: { MTN_MOMO: '*182*8#' },
    });
    posPaymentService.resolvePaymentFlow.mockReturnValue('PAYMENTS_V2');
    const res = mockRes();
    const next = jest.fn();

    const req = makeReq({
      query: { registerId: 'REG-1', deviceId: 'device-1' },
      user: { id: IDS.cashier, company: { _id: otherCompanyId } },
    });
    req.posAuthContext = {
      company: { id: IDS.company },
      session: { userId: IDS.cashier },
      register: { id: '888888888888888888888888', code: 'REG-1' },
    };
    await getCheckoutPaymentFlow(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(posPaymentService.getPaymentSettings).toHaveBeenCalledWith(IDS.company);
    expect(findClaimedRegister).not.toHaveBeenCalled();
    expect(res.body.data).toMatchObject({
      paymentFlow: 'PAYMENTS_V2',
      methods: ['CASH', 'MTN_MOMO', 'AIRTEL_MONEY'],
      manualMobileMoneyMode: 'VERIFY',
      manualMobileMoneyReceivers: { MTN_MOMO: '*182*8#' },
    });
  });

  test('checkout payment flow applies the configured feature policy for the assigned till type', async () => {
    const db = dbClient();
    db.systemSettings.findUnique.mockResolvedValue({
      posDiscountSettings: {
        systemTillTypes: ['retail', 'restaurant'],
        tillTypeFeatures: {
          retail: { manualDiscounts: true, promotions: true, vouchers: true, customerCredit: true },
          restaurant: { manualDiscounts: false, promotions: true, vouchers: false, customerCredit: false },
        },
      },
    });
    findClaimedRegister.mockResolvedValueOnce({
      id: '888888888888888888888888',
      systemTillType: 'restaurant',
    });
    const paymentService = require('../services/posPaymentService');
    paymentService.resolveEnabledMethods.mockReturnValue(['CASH', 'CREDIT']);
    const res = mockRes();

    const req = makeReq({
      query: { registerId: 'REG-1', deviceId: 'device-1' },
    });
    req.posAuthContext = {
      company: { id: IDS.company },
      session: { userId: IDS.cashier },
      register: {
        id: '888888888888888888888888',
        systemTillType: 'restaurant',
      },
    };
    await getCheckoutPaymentFlow(req, res, (error) => { throw error; });

    expect(res.body.data.methods).toEqual(['CASH']);
    expect(res.body.data.features).toEqual({
      manualDiscounts: false,
      promotions: true,
      vouchers: false,
      customerCredit: false,
    });
  });

  test('checkout rejects a manual discount disabled for the assigned till type', async () => {
    const { db } = stubHappyPathDeps();
    db.systemSettings.findUnique.mockResolvedValue({
      posDiscountSettings: {
        ...discountTestSettings,
        systemTillTypes: ['retail', 'restaurant'],
        tillTypeFeatures: {
          retail: { manualDiscounts: true, promotions: true, vouchers: true, customerCredit: true },
          restaurant: { manualDiscounts: false, promotions: true, vouchers: true, customerCredit: true },
        },
      },
    });
    findClaimedRegister.mockResolvedValueOnce({
      id: '888888888888888888888888',
      _id: IDS.registerId,
      code: IDS.registerId,
      systemTillType: 'restaurant',
    });
    const res = mockRes();

    await createDirectSale(makeReq({
      body: checkoutBody({
        items: [saleLine({ discountPct: 5, discountReason: 'Test discount' })],
        paymentAmount: 1121,
      }),
    }), res, (error) => { throw error; });

    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('POS_TILL_FEATURE_DISABLED');
    expect(Invoice.create).not.toHaveBeenCalled();
  });

  test('discounted checkout consumes the one-use manager approval', async () => {
    stubHappyPathDeps();
    const res = mockRes();
    await createDirectSale(makeReq({
      body: checkoutBody({
        items: [saleLine({ discountPct: 5 })],
        paymentAmount: 1121,
        managerApprovalId: IDS.approval,
      }),
      headers: { 'Idempotency-Key': 'disc-key-abcdefghij' },
    }), res, (err) => { throw err; });

    expect(res.statusCode).toBe(201);
    expect(consumeApproval).toHaveBeenCalledWith(expect.objectContaining({
      approvalId: IDS.approval,
      companyId: IDS.company,
      cashierId: IDS.cashier,
      action: 'discount',
    }));
  });

  test('allows discounts within configured caps without manager approval', async () => {
    const { db } = stubHappyPathDeps();
    db.systemSettings.findUnique.mockResolvedValue({
      posDiscountSettings: {
        ...discountTestSettings,
        defaultLimits: { maxLineDiscountPercent: 10, maxCartDiscountPercent: null, maxSaleDiscountRwf: null },
      },
    });
    const res = mockRes();
    await createDirectSale(makeReq({
      body: checkoutBody({
        items: [saleLine({ discountPct: 5 })],
        paymentAmount: 1121,
      }),
      headers: { 'Idempotency-Key': 'within-cap-key-12345' },
    }), res, (err) => { throw err; });

    expect(res.statusCode).toBe(201);
    expect(consumeApproval).not.toHaveBeenCalled();
  });

  test('applies cart discounts within configured caps without manager approval', async () => {
    const { db } = stubHappyPathDeps();
    db.systemSettings.findUnique.mockResolvedValue({
      posDiscountSettings: {
        ...discountTestSettings,
        defaultLimits: { maxLineDiscountPercent: null, maxCartDiscountPercent: 5, maxSaleDiscountRwf: null },
      },
    });
    const res = mockRes();
    await createDirectSale(makeReq({
      body: checkoutBody({
        items: [saleLine({ discountPct: 0, discountReason: '' })],
        cartDiscountPct: 5,
        cartDiscountReason: 'Test discount',
        paymentAmount: 1121,
      }),
      headers: { 'Idempotency-Key': 'cart-within-cap-12345' },
    }), res, (err) => { throw err; });

    expect(res.statusCode).toBe(201);
    expect(consumeApproval).not.toHaveBeenCalled();
  });

  test('consumes approval against the exact reasoned cart discount context', async () => {
    const { db } = stubHappyPathDeps();
    db.systemSettings.findUnique.mockResolvedValue({
      posDiscountSettings: {
        ...discountTestSettings,
        defaultLimits: { maxLineDiscountPercent: null, maxCartDiscountPercent: 5, maxSaleDiscountRwf: null },
      },
    });
    const res = mockRes();
    await createDirectSale(makeReq({
      body: checkoutBody({
        items: [saleLine({ discountPct: 0, discountReason: '' })],
        cartDiscountPct: 10,
        cartDiscountReason: 'Test discount',
        paymentAmount: 1062,
        managerApprovalId: IDS.approval,
        discountApprovalScope: 'DISCOUNT_APPLICATION',
      }),
      headers: { 'Idempotency-Key': 'approved-cart-discount-123' },
    }), res, (err) => { throw err; });

    expect(res.statusCode).toBe(201);
    expect(consumeApproval).toHaveBeenCalledWith(expect.objectContaining({
      approvalId: IDS.approval,
      action: 'discount',
      payload: expect.objectContaining({
        cartDiscountPct: 10,
        cartDiscountReason: 'Test discount',
        items: [expect.objectContaining({ productId: IDS.product, discountPct: 0 })],
      }),
    }));
  });

  test.each([
    ['percent', 10],
    ['fixed', 100],
  ])('requires manager approval when a %s promotion exceeds the whole-cart cap', async (discountType, value) => {
    const { db } = stubHappyPathDeps();
    db.systemSettings.findUnique.mockResolvedValue({
      posDiscountSettings: {
        ...discountTestSettings,
        defaultLimits: { maxLineDiscountPercent: null, maxCartDiscountPercent: 5, maxSaleDiscountRwf: null },
      },
    });
    db.$queryRawUnsafe.mockImplementation(async (sql) => {
      if (String(sql).includes('FROM pos_promotions')) {
        return [{ id: 'promotion-1', name: 'Promotion', discountType, value }];
      }
      if (String(sql).includes('INSERT INTO pos_sale_requests')) return [{ requestKey: 'claimed' }];
      return [];
    });

    const res = mockRes();
    await createDirectSale(makeReq({
      body: checkoutBody({
        items: [saleLine()],
        promotionId: 'promotion-1',
        paymentAmount: 1062,
      }),
      headers: { 'Idempotency-Key': `${discountType}-promotion-cap-key` },
    }), res, (err) => { throw err; });

    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('POS_MANAGER_APPROVAL_REQUIRED');
    expect(consumeApproval).not.toHaveBeenCalled();
  });

  test('blocks no-discount products even when a manager approval is supplied', async () => {
    const { db } = stubHappyPathDeps();
    db.systemSettings.findUnique.mockResolvedValue({
      posDiscountSettings: {
        ...discountTestSettings,
        defaultLimits: { maxLineDiscountPercent: 10, maxCartDiscountPercent: 10, maxSaleDiscountRwf: 10000 },
      },
    });
    Product.find.mockReturnValue(leanFind([catalogProduct({ isNoDiscount: true })]));
    const res = mockRes();
    await createDirectSale(makeReq({
      body: checkoutBody({
        items: [saleLine({ discountPct: 2 })],
        paymentAmount: 1121,
        managerApprovalId: IDS.approval,
      }),
    }), res, jest.fn());

    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('POS_ITEM_DISCOUNT_NOT_ALLOWED');
    expect(consumeApproval).not.toHaveBeenCalled();
  });

  test('blocks category-restricted products even when a manager approval is supplied', async () => {
    const categoryId = '555555555555555555555555';
    const { db } = stubHappyPathDeps();
    db.systemSettings.findUnique.mockResolvedValue({
      posDiscountSettings: {
        ...discountTestSettings,
        defaultLimits: { maxLineDiscountPercent: 10, maxCartDiscountPercent: 10, maxSaleDiscountRwf: 10000 },
      },
    });
    Product.find.mockReturnValue(leanFind([catalogProduct({ category: categoryId })]));
    db.category.findMany.mockResolvedValue([{ id: categoryId, isNoDiscount: true }]);
    const res = mockRes();
    await createDirectSale(makeReq({
      body: checkoutBody({
        items: [saleLine({ discountPct: 2 })],
        paymentAmount: 1121,
        managerApprovalId: IDS.approval,
      }),
    }), res, jest.fn());

    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('POS_ITEM_DISCOUNT_NOT_ALLOWED');
    expect(consumeApproval).not.toHaveBeenCalled();
  });

  test('stock race returns conflict when warehouse qty changes mid-checkout', async () => {
    stubHappyPathDeps({ stockMatchedCount: 0 });
    const res = mockRes();
    await createDirectSale(makeReq({
      body: checkoutBody(),
      headers: { 'Idempotency-Key': 'race-key-abcdefghij' },
    }), res, jest.fn());

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('ERR_INSUFFICIENT_STOCK');
    expect(res.body.message).toMatch(/Stock at the selected warehouse changed/i);
    expect(StockLevel.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        company_id: IDS.company,
        product_id: IDS.product,
        warehouse_id: IDS.warehouse,
        qty_reserved: 0,
        qty_on_hand: { $gte: expect.any(Number) },
      }),
      expect.objectContaining({ $inc: { qty_on_hand: expect.any(Number) } }),
    );
  });

  test('idempotent retry replays the completed invoice instead of double-selling', async () => {
    CurrencyService.getCompanyBase.mockResolvedValue('RWF');
    const body = checkoutBody();
    const hashPayload = { ...body };
    delete hashPayload.deviceId;
    const payloadHash = require('crypto').createHash('sha256').update(JSON.stringify(hashPayload)).digest('hex');
    const priorInvoice = buildInvoiceDoc({
      grandTotal: 1180,
      client: IDS.client,
    });
    dbClient.mockReturnValue({
      user: { findFirst: jest.fn().mockResolvedValue({ id: IDS.cashier, name: 'Cashier' }) },
      $queryRawUnsafe: jest.fn().mockResolvedValue([{
        requestKey: 'retry-key-abcdefghij',
        createdById: IDS.cashier,
        payloadHash,
        invoiceId: IDS.invoice,
        status: 'completed',
      }]),
    });
    Invoice.findOne.mockReturnValue({
      populate: jest.fn().mockResolvedValue(priorInvoice),
    });

    const res = mockRes();
    await createDirectSale(makeReq({
      body,
      headers: { 'Idempotency-Key': 'retry-key-abcdefghij' },
    }), res, jest.fn());

    expect(res.statusCode).toBe(200);
    expect(res.body.replayed).toBe(true);
    expect(res.body.data).toBe(priorInvoice);
    expect(runInTransaction).not.toHaveBeenCalled();
    expect(writePosAuditLog.mock.calls.filter(([entry]) => entry.event === 'POS_SALE_COMPLETED')).toHaveLength(0);
  });

  test('concurrent requests with the same idempotency key reserve only one sale', async () => {
    const { invoice, db } = stubHappyPathDeps();
    let finishInitialReads;
    const bothInitialReads = new Promise((resolve) => { finishInitialReads = resolve; });
    let initialReadCount = 0;
    let reserved = false;
    let reservation;
    db.$queryRawUnsafe.mockImplementation(async (sql, ...values) => {
      if (String(sql).includes('SELECT request_key AS')) {
        initialReadCount += 1;
        if (initialReadCount === 2) finishInitialReads();
        await bothInitialReads;
        return reserved ? [{ ...reservation, status: 'processing' }] : [];
      }
      if (String(sql).includes('INSERT INTO pos_sale_requests')) {
        if (reserved) return [];
        reserved = true;
        reservation = { requestKey: values[1], createdById: values[2], payloadHash: values[3] };
        return [{ requestKey: values[1] }];
      }
      return [];
    });

    const request = () => makeReq({
      body: checkoutBody(),
      headers: { 'Idempotency-Key': 'concurrent-key-12345' },
    });
    const firstResponse = mockRes();
    const secondResponse = mockRes();
    const next = (error) => { if (error) throw error; };

    await Promise.all([
      createDirectSale(request(), firstResponse, next),
      createDirectSale(request(), secondResponse, next),
    ]);

    expect([firstResponse.statusCode, secondResponse.statusCode].sort()).toEqual([201, 409]);
    expect([firstResponse, secondResponse].find((response) => response.statusCode === 409).body.code)
      .toBe('POS_SALE_STILL_PROCESSING');
    expect(Invoice.create).toHaveBeenCalledTimes(1);
    expect(inventoryService.consume).toHaveBeenCalledTimes(1);
    expect(Product.bulkWrite).toHaveBeenCalledTimes(1);
    expect(firstResponse.body.data === invoice || secondResponse.body.data === invoice).toBe(true);
  });

  test('idempotency key conflict rejects a different payload on the same key', async () => {
    CurrencyService.getCompanyBase.mockResolvedValue('RWF');
    dbClient.mockReturnValue({
      user: { findFirst: jest.fn().mockResolvedValue({ id: IDS.cashier, name: 'Cashier' }) },
      $queryRawUnsafe: jest.fn().mockResolvedValue([{
        requestKey: 'conflict-key-abcdef',
        createdById: IDS.cashier,
        payloadHash: 'different-hash',
        invoiceId: IDS.invoice,
        status: 'completed',
      }]),
    });

    const res = mockRes();
    await createDirectSale(makeReq({
      body: checkoutBody(),
      headers: { 'Idempotency-Key': 'conflict-key-abcdef' },
    }), res, jest.fn());

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('POS_IDEMPOTENCY_KEY_CONFLICT');
  });

  test('preflight rejects when available warehouse stock is insufficient', async () => {
    CurrencyService.getCompanyBase.mockResolvedValue('RWF');
    TillSession.findOne.mockResolvedValue({ _id: IDS.till, status: 'open', openedBy: IDS.cashier });
    Warehouse.findOne.mockResolvedValue({ _id: IDS.warehouse });
    Product.find.mockReturnValue(leanFind([catalogProduct()]));
    StockLevel.find.mockReturnValue({ lean: jest.fn().mockResolvedValue(stockLevelRows(0, 0)) });
    dbClient.mockReturnValue(emptyCheckoutDb());

    const res = mockRes();
    await createDirectSale(makeReq({ body: checkoutBody() }), res, jest.fn());
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('ERR_INSUFFICIENT_STOCK');
  });

  test('posts signed offline checkout against snapshot prices and records a stock conflict', async () => {
    moduleEntitlementService.hasModule.mockResolvedValue(false);
    moduleEntitlementService.getEntitlement.mockResolvedValue({ status: 'off', version: 1 });
    const { db } = stubHappyPathDeps();
    process.env.JWT_SECRET = 'unit-test-secret-that-is-at-least-32-characters';
    const issuedAt = Date.now() - 1000;
    const expiresAt = issuedAt + 24 * 60 * 60 * 1000;
    const snapshotId = '333333333333333333333333';
    const snapshotData = {
      fiscalMode: 'none',
      entitlementVersion: 1,
      products: {
        [IDS.product]: {
          name: 'Widget at snapshot',
          sku: 'WID-SNAP',
          unit: 'pcs',
          price: 1000,
          taxRate: 18,
          taxCode: 'B',
          isStockable: true,
          trackingType: 'none',
          averageCost: 400,
          availableStock: 3,
          serialNumbers: [],
        },
      },
      promotions: [],
      negativeStockAllowed: false,
      escalationDays: 3,
      paymentFlow: 'LEGACY',
      offlinePolicy: { requiresFiscalSubmission: false },
    };
    db.$queryRawUnsafe.mockImplementation(async (sql) => {
      const statement = String(sql);
      if (statement.includes('SELECT request_key AS')) return [];
      if (statement.includes('FROM companies c LEFT JOIN system_settings s')) {
        return [{ ebmEnabled: false, offlinePolicy: { provisionalFiscalReceiptsAllowed: false } }];
      }
      if (statement.includes('SELECT receipt_number AS "receiptNumber"')) {
        return [{ receiptNumber: 'INV-2026-00002' }];
      }
      if (statement.includes('FROM pos_offline_snapshots WHERE id = $1 AND company_id = $2 FOR UPDATE')) {
        return [{ queueLimit: 10000, usedValue: 0 }];
      }
      if (statement.includes('FROM pos_offline_snapshots WHERE id =')) {
        return [{
          id: snapshotId,
          warehouseId: IDS.warehouse,
          tillSessionId: IDS.till,
          snapshotData,
          fiscalMode: 'none',
          entitlementVersion: 1,
          queueLimit: 10000,
          expiresAt: new Date(expiresAt),
        }];
      }
      if (statement.includes('INSERT INTO pos_sale_requests')) return [{ requestKey: 'claimed' }];
      if (statement.includes('INSERT INTO stock_levels')) return [{ previousStock: 0, newStock: -1, reservedStock: 0 }];
      return [];
    });
    inventoryService.consumeAvailable.mockResolvedValue({ allocations: [], consumed: 0, shortfall: 1, totalCost: 0 });
    Product.find.mockReturnValue(leanFind([catalogProduct({ sellingPrice: 1400 })]));
    StockLevel.find.mockReturnValue({ lean: jest.fn().mockResolvedValue(stockLevelRows(0, 0)) });
    const offlineSaleId = 'offline-sale-00000001';
    const requestData = checkoutBody({
      displayTotal: 1180,
      deviceId: IDS.deviceId,
      offlineSnapshotCapability: issueCapability({
        id: snapshotId,
        companyId: IDS.company,
        userId: IDS.cashier,
        deviceId: IDS.deviceId,
        registerId: IDS.registerId,
        warehouseId: IDS.warehouse,
        tillSessionId: IDS.till,
        fiscalMode: 'none',
        receiptNumbers: ['INV-2026-00002'],
        entitlementVersion: 1,
        issuedAt,
        expiresAt,
      }),
      offlineReceiptNumber: 'INV-2026-00002',
      offlineSaleId,
      offlineOperationId: 'offline-operation-00000001',
      offlinePaymentFlow: 'LEGACY',
      offlineCreatedAt: new Date(issuedAt + 500).toISOString(),
      items: [saleLine({
        taxRate: 0,
        taxCode: 'A',
        unit: 'pcs',
        catalogUnitPrice: 1000,
        unitPrice: 1000,
      })],
    });
    const changedFlowRes = mockRes();
    await createDirectSale(makeReq({
      body: { ...requestData, offlinePaymentFlow: 'PAYMENTS_V2' },
      headers: { 'Idempotency-Key': 'offline-idempotency-key-0002' },
    }), changedFlowRes, (error) => { throw error; });

    expect(changedFlowRes.statusCode).toBe(409);
    expect(changedFlowRes.body.code).toBe('POS_OFFLINE_PAYMENT_FLOW_CHANGED');

    const changedTotalRes = mockRes();
    await createDirectSale(makeReq({
      body: { ...requestData, displayTotal: 1000 },
      headers: { 'Idempotency-Key': 'offline-idempotency-key-0010' },
    }), changedTotalRes, (error) => { throw error; });
    expect(changedTotalRes.statusCode).toBe(409);
    expect(changedTotalRes.body.code).toBe('POS_OFFLINE_TOTAL_SNAPSHOT_MISMATCH');

    const res = mockRes();
    await createDirectSale(makeReq({
      body: { ...requestData, offlineReceiptNumber: 'offline-operation-00000001' },
      headers: { 'Idempotency-Key': 'offline-idempotency-key-0001' },
    }), res, (error) => { throw error; });

    expect(res.statusCode).toBe(201);
    expect(res.body.offlineConflictCount).toBe(1);
    expect(Invoice.create.mock.calls[0][0][0].referenceNo).toBe('INV-2026-00002');
    expect(db.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('AND operation_id = $4'),
      IDS.company,
      IDS.deviceId,
      '888888888888888888888888',
      'offline-operation-00000001',
    );
    expect(db.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('AND receipt_number = $4 AND (operation_id IS NULL OR operation_id = $6)'),
      IDS.company,
      IDS.deviceId,
      '888888888888888888888888',
      'INV-2026-00002',
      expect.any(Date),
      'offline-operation-00000001',
    );
    expect(Invoice.create.mock.calls[0][0][0].lines[0].unitPrice).toBe(1000);
    expect(Invoice.create.mock.calls[0][0][0].lines[0].taxCode).toBe('B');
    expect(Invoice.create.mock.calls[0][0][0].lines[0].taxRate).toBe(18);
    expect(db.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO pos_offline_conflicts'),
      expect.any(String),
      IDS.company,
      offlineSaleId,
      IDS.invoice,
      IDS.product,
      IDS.warehouse,
      'stock',
      expect.stringContaining('"shortage":1'),
      expect.any(Date),
    );
    expect(inventoryService.consumeAvailable).toHaveBeenCalled();
    expect(StockMovement.insertMany).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ totalCost: 400 })]),
      expect.objectContaining({ session: null }),
    );
  });

  test('posts an offline batch sale against the exact signed FEFO allocation', async () => {
    moduleEntitlementService.hasModule.mockResolvedValue(false);
    moduleEntitlementService.getEntitlement.mockResolvedValue({ status: 'off', version: 1 });
    const { db } = stubHappyPathDeps();
    process.env.JWT_SECRET = 'unit-test-secret-that-is-at-least-32-characters';
    const issuedAt = Date.now() - 1000;
    const expiresAt = issuedAt + 24 * 60 * 60 * 1000;
    const snapshotId = '333333333333333333333333';
    const batchId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    const snapshotData = {
      fiscalMode: 'none',
      entitlementVersion: 1,
      products: {
        [IDS.product]: {
          name: 'Widget at snapshot',
          sku: 'WID-SNAP',
          unit: 'pcs',
          price: 1000,
          taxRate: 18,
          taxCode: 'B',
          isStockable: true,
          trackingType: 'batch',
          averageCost: 400,
          availableStock: 5,
          batches: [{
            id: batchId,
            batchNo: 'LOT-A',
            availableQuantity: 5,
            expiryDate: '2027-01-01T00:00:00.000Z',
            unitCost: 400,
          }],
          serialNumbers: [],
        },
      },
      promotions: [],
      negativeStockAllowed: false,
      escalationDays: 3,
      paymentFlow: 'LEGACY',
      offlinePolicy: { requiresFiscalSubmission: false },
    };
    db.$queryRawUnsafe.mockImplementation(async (sql) => {
      const statement = String(sql);
      if (statement.includes('SELECT request_key AS')) return [];
      if (statement.includes('FROM companies c LEFT JOIN system_settings s')) {
        return [{ ebmEnabled: false, offlinePolicy: { provisionalFiscalReceiptsAllowed: false } }];
      }
      if (statement.includes('FROM pos_offline_snapshots WHERE id = $1 AND company_id = $2 FOR UPDATE')) {
        return [{ queueLimit: 10000, usedValue: 0 }];
      }
      if (statement.includes('FROM pos_offline_snapshots WHERE id =')) {
        return [{
          id: snapshotId,
          warehouseId: IDS.warehouse,
          tillSessionId: IDS.till,
          snapshotData,
          fiscalMode: 'none',
          entitlementVersion: 1,
          queueLimit: 10000,
          expiresAt: new Date(expiresAt),
        }];
      }
      if (statement.includes('INSERT INTO pos_sale_requests')) return [{ requestKey: 'claimed' }];
      if (statement.includes('INSERT INTO stock_levels')) {
        return [{ previousStock: 5, newStock: 4, reservedStock: 0 }];
      }
      return [];
    });
    Product.find.mockReturnValue(leanFind([catalogProduct({
      sellingPrice: 1400,
      trackingType: 'batch',
      trackBatch: true,
    })]));
    StockLevel.find.mockReturnValue({ lean: jest.fn().mockResolvedValue(stockLevelRows(5, 0)) });
    const batch = {
      _id: batchId,
      batchNo: 'LOT-A',
      qtyOnHand: 5,
      reservedQuantity: 0,
      unitCost: 400,
      expiryDate: new Date('2027-01-01T00:00:00.000Z'),
      isQuarantined: false,
      save: jest.fn().mockResolvedValue(undefined),
    };
    StockBatch.findOne.mockReturnValue({ session: jest.fn().mockResolvedValue(batch) });
    InventoryBatch.find.mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      session: jest.fn().mockResolvedValue([]),
    });
    const offlineSaleId = 'offline-sale-batch-0001';
    const body = checkoutBody({
      deviceId: IDS.deviceId,
      offlineSnapshotCapability: issueCapability({
        id: snapshotId,
        companyId: IDS.company,
        userId: IDS.cashier,
        deviceId: IDS.deviceId,
        registerId: IDS.registerId,
        warehouseId: IDS.warehouse,
        tillSessionId: IDS.till,
        fiscalMode: 'none',
        entitlementVersion: 1,
        issuedAt,
        expiresAt,
      }),
      offlineReceiptNumber: 'INV-2026-00003',
      offlineSaleId,
      offlineOperationId: 'offline-operation-batch-0001',
      offlinePaymentFlow: 'LEGACY',
      offlineCreatedAt: new Date(issuedAt + 500).toISOString(),
      items: [saleLine({
        taxRate: 18,
        taxCode: 'B',
        unit: 'pcs',
        catalogUnitPrice: 1000,
        unitPrice: 1000,
        batchAllocations: [{ batchId, quantity: 1 }],
      })],
    });

    const invalidAllocationRes = mockRes();
    await createDirectSale(makeReq({
      body: {
        ...body,
        items: [{
          ...body.items[0],
          batchAllocations: [{ batchId, quantity: 6 }],
        }],
      },
      headers: { 'Idempotency-Key': 'offline-idempotency-key-0004' },
    }), invalidAllocationRes, (error) => { throw error; });
    expect(invalidAllocationRes.statusCode).toBe(403);
    expect(invalidAllocationRes.body.code).toBe('POS_OFFLINE_BATCH_SNAPSHOT_STOCK_EXCEEDED');

    const res = mockRes();
    await createDirectSale(makeReq({
      body,
      headers: { 'Idempotency-Key': 'offline-idempotency-key-0003' },
    }), res, (error) => { throw error; });

    expect(res.statusCode).toBe(201);
    expect(res.body.offlineConflictCount).toBe(0);
    expect(StockBatch.findOne).toHaveBeenCalledWith({
      _id: batchId,
      company: IDS.company,
      product: IDS.product,
      warehouse: IDS.warehouse,
    });
    expect(batch.qtyOnHand).toBe(4);
    expect(StockMovement.insertMany).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ batchNumber: 'LOT-A:1', totalCost: 400 })]),
      expect.objectContaining({ session: null }),
    );
  });

  test('reconstructs FEFO batches for a legacy offline snapshot and audits the allocation', async () => {
    moduleEntitlementService.hasModule.mockResolvedValue(false);
    moduleEntitlementService.getEntitlement.mockResolvedValue({ status: 'off', version: 1 });
    const { db } = stubHappyPathDeps();
    process.env.JWT_SECRET = 'unit-test-secret-that-is-at-least-32-characters';
    const issuedAt = Date.now() - 1000;
    const expiresAt = issuedAt + 24 * 60 * 60 * 1000;
    const snapshotId = '333333333333333333333333';
    const batchId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    const expiryDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    const snapshotData = {
      fiscalMode: 'none',
      entitlementVersion: 1,
      products: {
        [IDS.product]: {
          name: 'Widget at snapshot',
          sku: 'WID-SNAP',
          unit: 'pcs',
          price: 1000,
          taxRate: 18,
          taxCode: 'B',
          isStockable: true,
          trackingType: 'batch',
          averageCost: 400,
          availableStock: 5,
          serialNumbers: [],
        },
      },
      promotions: [],
      negativeStockAllowed: false,
      escalationDays: 3,
      paymentFlow: 'LEGACY',
      offlinePolicy: { requiresFiscalSubmission: false },
    };
    db.stockBatch.findMany = jest.fn().mockResolvedValue([{
      id: batchId,
      batchNo: 'LOT-LEGACY',
      qtyOnHand: 5,
      reservedQuantity: 0,
      unitCost: 400,
      expiryDate,
      createdAt: new Date(issuedAt - 1000),
    }]);
    db.$queryRawUnsafe.mockImplementation(async (sql) => {
      const statement = String(sql);
      if (statement.includes('SELECT request_key AS')) return [];
      if (statement.includes('FROM companies c LEFT JOIN system_settings s')) {
        return [{ ebmEnabled: false, offlinePolicy: { provisionalFiscalReceiptsAllowed: false } }];
      }
      if (statement.includes('FROM pos_offline_snapshots WHERE id = $1 AND company_id = $2 FOR UPDATE')) {
        return [{ queueLimit: 10000, usedValue: 0 }];
      }
      if (statement.includes('FROM pos_offline_snapshots WHERE id =')) {
        return [{
          id: snapshotId,
          warehouseId: IDS.warehouse,
          tillSessionId: IDS.till,
          snapshotData,
          fiscalMode: 'none',
          entitlementVersion: 1,
          queueLimit: 10000,
          expiresAt: new Date(expiresAt),
        }];
      }
      if (statement.includes('INSERT INTO pos_sale_requests')) return [{ requestKey: 'claimed' }];
      if (statement.includes('INSERT INTO stock_levels')) {
        return [{ previousStock: 5, newStock: 4, reservedStock: 0 }];
      }
      return [];
    });
    Product.find.mockReturnValue(leanFind([catalogProduct({
      sellingPrice: 1400,
      trackingType: 'batch',
      trackBatch: true,
    })]));
    StockLevel.find.mockReturnValue({ lean: jest.fn().mockResolvedValue(stockLevelRows(5, 0)) });
    const batch = {
      _id: batchId,
      batchNo: 'LOT-LEGACY',
      qtyOnHand: 5,
      reservedQuantity: 0,
      unitCost: 400,
      expiryDate,
      isQuarantined: false,
      save: jest.fn().mockResolvedValue(undefined),
    };
    StockBatch.findOne.mockReturnValue({ session: jest.fn().mockResolvedValue(batch) });
    InventoryBatch.find.mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      session: jest.fn().mockResolvedValue([]),
    });
    const body = checkoutBody({
      deviceId: IDS.deviceId,
      offlineSnapshotCapability: issueCapability({
        id: snapshotId,
        companyId: IDS.company,
        userId: IDS.cashier,
        deviceId: IDS.deviceId,
        registerId: IDS.registerId,
        warehouseId: IDS.warehouse,
        tillSessionId: IDS.till,
        fiscalMode: 'none',
        entitlementVersion: 1,
        issuedAt,
        expiresAt,
      }),
      offlineReceiptNumber: 'INV-2026-00004',
      offlineSaleId: 'offline-sale-legacy-batch-0001',
      offlineOperationId: 'offline-operation-legacy-batch-0001',
      offlinePaymentFlow: 'LEGACY',
      offlineCreatedAt: new Date(issuedAt + 500).toISOString(),
      items: [saleLine({
        taxRate: 18,
        taxCode: 'B',
        unit: 'pcs',
        catalogUnitPrice: 1000,
        unitPrice: 1000,
      })],
    });

    const res = mockRes();
    await createDirectSale(makeReq({
      body,
      headers: { 'Idempotency-Key': 'offline-idempotency-key-legacy-batch-0001' },
    }), res, (error) => { throw error; });

    expect(res.statusCode).toBe(201);
    expect(db.stockBatch.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        companyId: IDS.company,
        productId: IDS.product,
        warehouseId: IDS.warehouse,
      }),
      take: 500,
    }));
    expect(StockBatch.findOne).toHaveBeenCalledWith({
      _id: batchId,
      company: IDS.company,
      product: IDS.product,
      warehouse: IDS.warehouse,
    });
    expect(StockMovement.insertMany).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({
        batchNumber: 'LOT-LEGACY:1',
        notes: expect.stringContaining('legacy offline batch allocation reconstructed at sync'),
      })]),
      expect.objectContaining({ session: null }),
    );
  });
});
