'use strict';

const { randomBytes, randomUUID } = require('crypto');
const { hashStoredValueCode } = require('../services/posStoredValueCodeService');
const { issueCapability } = require('../services/posOfflineCapabilityService');
const { getWarehousePriceListPrices, effectivePrice } = require('../services/priceListService');

jest.mock('../config/redis', () => ({
  redisClient: { keys: jest.fn().mockResolvedValue([]) },
  isRedisConfigured: () => false,
  isRedisRequired: () => false,
  createQueueConnection: () => null,
}));

jest.mock('../services/posPaymentService', () => {
  const actual = jest.requireActual('../services/posPaymentService');
  return {
    ...actual,
    getPaymentSettings: jest.fn().mockResolvedValue({
      paymentFlow: 'PAYMENTS_V2',
      registerPaymentFlowOverrides: {},
      enabledMethods: ['CASH', 'GIFT_CARD', 'MTN_MOMO'],
      manualMobileMoneyMode: 'INSTANT',
      manualMobileMoneyReceivers: { MTN_MOMO: '*182*8#' },
      momoTimeoutSec: 120,
      allowOverCreditLimit: false,
      bankTransferNeedsConfirm: false,
      providerEnvironment: 'sandbox',
    }),
    resolvePaymentFlow: jest.fn(() => 'PAYMENTS_V2'),
    assertPaymentMethodEnabled: jest.fn().mockResolvedValue(undefined),
  };
});

jest.mock('../services/ebmService', () => ({
  ...jest.requireActual('../services/ebmService'),
  getConfig: jest.fn(() => ({ mode: 'sandbox' })),
}));

jest.mock('../services/ebmSalesService', () => ({
  submitInvoiceAsync: jest.fn(),
  prepareV2SaleSubmission: jest.fn().mockRejectedValue(Object.assign(
    new Error('Fiscal payload preconditions are not configured in this integration fixture.'),
    { code: 'EBM_TEST_PAYLOAD_PREPARATION' },
  )),
}));

jest.mock('../services/emailService', () => ({
  sendInvoiceEmail: jest.fn().mockResolvedValue(false),
}));

jest.mock('../services/smsService', () => ({
  sendLargeOrderSMS: jest.fn().mockResolvedValue([]),
}));

jest.mock('../services/notificationDeliveryService', () => ({
  sendInvoiceDelivery: jest.fn().mockResolvedValue(undefined),
  sendLargeOrderAlert: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/inventoryService', () => ({
  ...jest.requireActual('../services/inventoryService'),
  // Offline stock cost-layer allocation is backed by the legacy inventory
  // adapter. Keep this integration test focused on PostgreSQL sale posting.
  consumeAvailable: jest.fn(async (_companyId, _productId, quantity) => ({
    allocations: [],
    consumed: Number(quantity),
    shortfall: 0,
    totalCost: 10 * Number(quantity),
  })),
}));

const allowLocalDatabase = process.env.POS_TEST_ALLOW_LOCAL_DATABASE === 'true';
if (allowLocalDatabase && !process.env.DATABASE_URL) {
  require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
}

function validateTestDatabaseUrl(value) {
  if (!value) return null;
  const parsed = new URL(value);
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
    || !loopbackHosts.has(parsed.hostname)
    || (!allowLocalDatabase && !/(^|_)test$/i.test(databaseName))) {
    throw new Error(
      allowLocalDatabase
        ? 'DATABASE_URL must point to a local PostgreSQL database when POS_TEST_ALLOW_LOCAL_DATABASE is enabled.'
        : 'POS_TEST_DATABASE_URL must point to a local PostgreSQL database whose name ends in "_test".',
    );
  }
  return parsed.toString();
}

const testDatabaseUrl = validateTestDatabaseUrl(
  process.env.POS_TEST_DATABASE_URL || (allowLocalDatabase ? process.env.DATABASE_URL : null),
);
let prisma;
let disconnectPrisma;
let controller;

if (testDatabaseUrl) {
  process.env.DATABASE_URL = testDatabaseUrl;
  ({ prisma, disconnectPrisma } = require('../lib/prisma'));
  controller = require('../controllers/posPaymentsV2Controller');
}

function objectId() {
  return randomBytes(12).toString('hex');
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function requestFor(fixture, { payment = false, paymentMethod = 'GIFT_CARD', amount = 80, key, alternateTill = false }) {
  const headers = { 'idempotency-key': key };
  const registerId = alternateTill ? fixture.otherRegisterId : fixture.registerId;
  const registerCode = alternateTill ? fixture.otherRegisterCode : fixture.registerCode;
  const cashierId = alternateTill ? fixture.otherCashierId : fixture.cashierId;
  const deviceId = alternateTill ? fixture.otherDeviceId : fixture.deviceId;
  return {
    params: { saleId: fixture.saleId },
    body: payment
      ? paymentMethod === 'CASH'
        ? { payments: [{ method: 'CASH', amount, tendered: amount }] }
        : { payments: [{ method: 'GIFT_CARD', amount, giftCardCode: fixture.rawCode }] }
      : {},
    headers,
    get(name) {
      return headers[String(name).toLowerCase()];
    },
    posAuthContext: {
      company: { id: fixture.companyId },
      register: {
        id: registerId,
        code: registerCode,
        claimedDeviceId: deviceId,
      },
      user: { id: cashierId, name: 'POS completion integration cashier' },
      session: {
        id: objectId(),
        companyId: fixture.companyId,
        registerId,
        userId: cashierId,
      },
    },
    posPermissions: ['pos.payment.take', 'pos.giftcard.redeem'],
  };
}

async function assertLedgerMatchesBalance(companyId, accountId) {
  const [account, ledger] = await Promise.all([
    prisma.posStoredValueAccount.findFirst({ where: { id: accountId, companyId } }),
    prisma.posStoredValueLedger.findMany({ where: { companyId, accountId } }),
  ]);
  const ledgerBalance = ledger.reduce((sum, entry) => (
    sum + (entry.operationType === 'REDEEM' ? -Number(entry.amount) : Number(entry.amount))
  ), 0);
  expect(Number(account.balance)).toBe(ledgerBalance);
  return { account, ledger };
}

async function recordGiftCardPayment(fixture) {
  const res = response();
  await controller.recordCashPayment(
    requestFor(fixture, {
      payment: true,
      key: `completion-payment-${fixture.companyId}`,
    }),
    res,
    (error) => { if (error) throw error; },
  );
  expect(res.statusCode).toBe(201);
  return res;
}

async function recordOfflineCashPayment(fixture, amount = 80) {
  const res = response();
  await controller.recordCashPayment(
    requestFor(fixture, {
      payment: true,
      paymentMethod: 'CASH',
      amount,
      key: `offline-completion-payment-${fixture.companyId}`,
    }),
    res,
    (error) => { if (error) throw error; },
  );
  if (res.statusCode !== 201) throw new Error(`Offline cash setup failed: ${JSON.stringify(res.body)}`);
  return res;
}

async function createFixture() {
  const fixture = {
    companyId: objectId(),
    cashierId: objectId(),
    otherCashierId: objectId(),
    clientId: objectId(),
    registerId: objectId(),
    otherRegisterId: objectId(),
    shiftId: objectId(),
    otherShiftId: objectId(),
    tillSessionId: objectId(),
    otherTillSessionId: objectId(),
    warehouseId: objectId(),
    categoryId: objectId(),
    productId: objectId(),
    stockLevelId: objectId(),
    inventoryLayerId: objectId(),
    saleId: objectId(),
    accountId: objectId(),
    deviceId: randomUUID(),
    otherDeviceId: randomUUID(),
    rawCode: `KB-${randomBytes(12).toString('hex').toUpperCase()}`,
    triggerName: '',
    functionName: '',
    failureMarkerSequenceName: '',
    finalizationTriggerName: '',
    finalizationFunctionName: '',
    finalizationTableName: '',
  };
  // The offline snapshot's register binding is stored in CHAR(24), matching
  // the register identifiers used by its signed capability.
  fixture.registerCode = fixture.registerId;
  fixture.otherRegisterCode = fixture.otherRegisterId;

  const cleanup = async () => {
    const cleanupSteps = [];
    if (fixture.triggerName) {
      cleanupSteps.push(() => prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS "${fixture.triggerName}" ON journal_entries`,
      ));
    }
    if (fixture.finalizationTriggerName) {
      cleanupSteps.push(() => prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS "${fixture.finalizationTriggerName}" ON invoices`,
      ));
    }
    if (fixture.functionName) {
      cleanupSteps.push(() => prisma.$executeRawUnsafe(
        `DROP FUNCTION IF EXISTS "${fixture.functionName}"()`,
      ));
    }
    if (fixture.finalizationFunctionName) {
      cleanupSteps.push(() => prisma.$executeRawUnsafe(
        `DROP FUNCTION IF EXISTS "${fixture.finalizationFunctionName}"()`,
      ));
    }
    if (fixture.finalizationTableName) {
      cleanupSteps.push(() => prisma.$executeRawUnsafe(
        `DROP TABLE IF EXISTS "${fixture.finalizationTableName}"`,
      ));
    }
    if (fixture.failureMarkerSequenceName) {
      cleanupSteps.push(() => prisma.$executeRawUnsafe(
        `DROP SEQUENCE IF EXISTS "${fixture.failureMarkerSequenceName}"`,
      ));
    }
    cleanupSteps.push(
      () => prisma.$executeRawUnsafe('DELETE FROM pos_sale_requests WHERE company_id = $1', fixture.companyId),
      () => prisma.$executeRawUnsafe('DELETE FROM pos_receipt_number_allocations WHERE company_id = $1', fixture.companyId),
      () => prisma.$executeRawUnsafe('DELETE FROM pos_offline_snapshots WHERE company_id = $1', fixture.companyId),
      () => prisma.posAuditLog.deleteMany({ where: { companyId: fixture.companyId } }),
      () => prisma.posPaymentRefund.deleteMany({ where: { companyId: fixture.companyId } }),
      () => prisma.posStoredValueLedger.deleteMany({ where: { companyId: fixture.companyId } }),
      () => prisma.posPaymentAttempt.deleteMany({ where: { companyId: fixture.companyId } }),
      () => prisma.posPayment.deleteMany({ where: { companyId: fixture.companyId } }),
      () => prisma.ebmSubmissionQueue.deleteMany({ where: { companyId: fixture.companyId } }),
      () => prisma.invoiceLine.deleteMany({ where: { companyId: fixture.companyId } }),
      () => prisma.bankTransaction.deleteMany({ where: { companyId: fixture.companyId } }),
      () => prisma.taxTransaction.deleteMany({ where: { companyId: fixture.companyId } }),
      () => prisma.journalEntryLine.deleteMany({ where: { companyId: fixture.companyId } }),
      () => prisma.journalEntry.deleteMany({ where: { companyId: fixture.companyId } }),
      () => prisma.accountBalance.deleteMany({ where: { companyId: fixture.companyId } }),
      () => prisma.stockMovement.deleteMany({ where: { companyId: fixture.companyId } }),
      () => prisma.inventoryLayer.deleteMany({ where: { companyId: fixture.companyId } }),
      () => prisma.stockLevel.deleteMany({ where: { companyId: fixture.companyId } }),
      () => prisma.posEffectivePrice.deleteMany({ where: { companyId: fixture.companyId } }),
      () => prisma.invoice.deleteMany({ where: { companyId: fixture.companyId } }),
      () => prisma.posStoredValueAccount.deleteMany({ where: { companyId: fixture.companyId } }),
      () => prisma.tillSession.deleteMany({ where: { companyId: fixture.companyId } }),
      () => prisma.posShift.deleteMany({ where: { companyId: fixture.companyId } }),
      () => prisma.posRegister.deleteMany({ where: { companyId: fixture.companyId } }),
      () => prisma.product.deleteMany({ where: { companyId: fixture.companyId } }),
      () => prisma.category.deleteMany({ where: { companyId: fixture.companyId } }),
      () => prisma.warehouse.deleteMany({ where: { companyId: fixture.companyId } }),
      () => prisma.user.deleteMany({ where: { companyId: fixture.companyId } }),
      () => prisma.company.deleteMany({ where: { id: fixture.companyId } }),
    );

    let cleanupError = null;
    for (const step of cleanupSteps) {
      try {
        await step();
      } catch (error) {
        if (!cleanupError) cleanupError = error;
      }
    }
    if (cleanupError) throw cleanupError;
  };

  try {
    await prisma.company.create({
      data: {
        id: fixture.companyId,
        name: 'POS Sale Completion Integration Test',
        code: `POS-SALE-COMPLETE-${fixture.companyId}`,
      },
    });
    const accountingAccounts = [
      { code: '1000', name: 'POS cash', type: 'asset' },
      { code: '1200', name: 'MTN MoMo clearing', type: 'asset' },
      { code: '1300', name: 'Accounts receivable', type: 'asset' },
      { code: '1400', name: 'Inventory', type: 'asset' },
      { code: '2220', name: 'VAT output', type: 'liability' },
      { code: '2850', name: 'Gift card liability', type: 'liability' },
      { code: '4000', name: 'Sales revenue', type: 'revenue' },
      { code: '5000', name: 'Cost of goods sold', type: 'cogs' },
    ];
    await prisma.chartOfAccount.createMany({
      data: accountingAccounts.map((account) => ({
        id: objectId(),
        companyId: fixture.companyId,
        ...account,
      })),
    });
    await prisma.accountMapping.createMany({
      data: [
        ['posRegisterCash', '1000'],
        ['mtnMoMo', '1200'],
        ['accountsReceivable', '1300'],
        ['inventory', '1400'],
        ['vatOutput', '2220'],
        ['giftCardLiability', '2850'],
        ['salesRevenue', '4000'],
        ['costOfGoodsSold', '5000'],
      ].map(([key, accountCode]) => ({
        id: objectId(),
        companyId: fixture.companyId,
        module: 'pos_accounting',
        key: `company:${key}`,
        accountCode,
      })),
    });
    await prisma.user.create({
      data: {
        id: fixture.cashierId,
        companyId: fixture.companyId,
        name: 'POS completion integration cashier',
        email: `pos-sale-completion-${fixture.companyId}@example.invalid`,
        password: 'integration-test-only',
      },
    });
    await prisma.user.create({
      data: {
        id: fixture.otherCashierId,
        companyId: fixture.companyId,
        name: 'POS completion alternate cashier',
        email: `pos-sale-completion-alt-${fixture.companyId}@example.invalid`,
        password: 'integration-test-only',
      },
    });
    await prisma.client.create({
      data: {
        id: fixture.clientId,
        companyId: fixture.companyId,
        name: 'POS completion integration customer',
        code: `POS-COMPLETE-${fixture.companyId}`,
      },
    });
    await prisma.posRegister.create({
      data: {
        id: fixture.registerId,
        companyId: fixture.companyId,
        code: fixture.registerCode,
        name: 'POS completion integration register',
        claimedDeviceId: fixture.deviceId,
      },
    });
    await prisma.posRegister.create({
      data: {
        id: fixture.otherRegisterId,
        companyId: fixture.companyId,
        code: fixture.otherRegisterCode,
        name: 'POS completion alternate register',
        claimedDeviceId: fixture.otherDeviceId,
      },
    });
    await prisma.posShift.create({
      data: {
        id: fixture.shiftId,
        companyId: fixture.companyId,
        registerId: fixture.registerId,
        shiftNumber: 1,
        openedById: fixture.cashierId,
        openingFloat: 0,
      },
    });
    await prisma.posShift.create({
      data: {
        id: fixture.otherShiftId,
        companyId: fixture.companyId,
        registerId: fixture.otherRegisterId,
        shiftNumber: 1,
        openedById: fixture.otherCashierId,
        openingFloat: 0,
      },
    });
    await prisma.tillSession.create({
      data: {
        id: fixture.tillSessionId,
        companyId: fixture.companyId,
        openedById: fixture.cashierId,
        registerId: fixture.registerCode,
        registerName: 'POS completion integration register',
      },
    });
    await prisma.tillSession.create({
      data: {
        id: fixture.otherTillSessionId,
        companyId: fixture.companyId,
        openedById: fixture.otherCashierId,
        registerId: fixture.otherRegisterCode,
        registerName: 'POS completion alternate register',
      },
    });
    await prisma.warehouse.create({
      data: {
        id: fixture.warehouseId,
        companyId: fixture.companyId,
        name: 'POS completion integration warehouse',
        code: `POS-COMPLETE-${fixture.companyId}`,
      },
    });
    await prisma.category.create({
      data: {
        id: fixture.categoryId,
        companyId: fixture.companyId,
        name: `POS Completion ${fixture.companyId}`,
      },
    });
    await prisma.product.create({
      data: {
        id: fixture.productId,
        companyId: fixture.companyId,
        name: 'POS completion integration product',
        sku: `POS-COMPLETE-${fixture.companyId}`,
        categoryId: fixture.categoryId,
        defaultWarehouseId: fixture.warehouseId,
        currentStock: 5,
        averageCost: 10,
        costPrice: 10,
        sellingPrice: 80,
        taxCode: 'A',
        taxRate: 0,
        isStockable: true,
        trackingType: 'none',
      },
    });
    await prisma.stockLevel.create({
      data: {
        id: fixture.stockLevelId,
        companyId: fixture.companyId,
        productId: fixture.productId,
        warehouseId: fixture.warehouseId,
        qtyOnHand: 5,
        avgCost: 10,
        totalValue: 50,
      },
    });
    await prisma.inventoryLayer.create({
      data: {
        id: fixture.inventoryLayerId,
        companyId: fixture.companyId,
        productId: fixture.productId,
        warehouseId: fixture.warehouseId,
        qtyReceived: 5,
        qtyRemaining: 5,
        unitCost: 10,
        createdById: fixture.cashierId,
      },
    });
    await prisma.invoice.create({
      data: {
        id: fixture.saleId,
        companyId: fixture.companyId,
        clientId: fixture.clientId,
        referenceNo: `POS-COMPLETE-${fixture.companyId}`,
        status: 'PENDING_PAYMENT',
        posOrigin: true,
        tillSessionId: fixture.tillSessionId,
        shiftId: fixture.shiftId,
        cashierId: fixture.cashierId,
        registerId: fixture.registerId,
        currencyCode: 'RWF',
        subtotal: 80,
        totalAmount: 80,
        amountOutstanding: 80,
        dueDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
        posCheckoutPayload: {
          warehouseId: fixture.warehouseId,
          items: [{
            productId: fixture.productId,
            quantity: 1,
            unitPrice: 80,
            discountPct: 0,
            serialNumbers: [],
          }],
        },
      },
    });
    await prisma.invoiceLine.create({
      data: {
        id: objectId(),
        companyId: fixture.companyId,
        invoiceId: fixture.saleId,
        lineOrder: 0,
        productId: fixture.productId,
        qty: 1,
        unitPrice: 80,
        discountPct: 0,
        taxRate: 0,
        taxCode: 'A',
        lineSubtotal: 80,
        lineTax: 0,
        lineTotal: 80,
        warehouseId: fixture.warehouseId,
        serialNumbers: [],
      },
    });
    await prisma.posStoredValueAccount.create({
      data: {
        id: fixture.accountId,
        companyId: fixture.companyId,
        kind: 'gift_card',
        codeHash: hashStoredValueCode(fixture.rawCode),
        codeSuffix: fixture.rawCode.slice(-4),
        currencyCode: 'RWF',
        balance: 100,
        createdById: fixture.cashierId,
      },
    });
    await prisma.posStoredValueLedger.create({
      data: {
        id: objectId(),
        companyId: fixture.companyId,
        accountId: fixture.accountId,
        operationType: 'ISSUE',
        kind: 'gift_card',
        entryType: 'issue',
        amount: 100,
        balanceAfter: 100,
        reference: fixture.rawCode.slice(-4),
        idempotencyKey: `completion-issue-${fixture.companyId}`,
        createdById: fixture.cashierId,
      },
    });
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      error.cleanupError = cleanupError;
    }
    throw error;
  }

  return {
    ...fixture,
    cleanup,
    async readFailureMarker() {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT last_value::int AS value FROM "${fixture.failureMarkerSequenceName}"`,
      );
      return rows[0].value;
    },
    async installJournalFailureTrigger() {
      fixture.functionName = `pos_sale_fail_${fixture.companyId}`;
      fixture.triggerName = fixture.functionName;
      fixture.failureMarkerSequenceName = `pos_sale_fail_marker_${fixture.companyId}`;
      await prisma.$executeRawUnsafe(
        `CREATE SEQUENCE "${fixture.failureMarkerSequenceName}"`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE FUNCTION "${fixture.functionName}"() RETURNS trigger AS $body$ BEGIN IF NEW.company_id = '${fixture.companyId}' THEN IF NOT EXISTS (SELECT 1 FROM stock_levels WHERE company_id = '${fixture.companyId}' AND product_id = '${fixture.productId}' AND warehouse_id = '${fixture.warehouseId}' AND qty_on_hand = 4) OR NOT EXISTS (SELECT 1 FROM products WHERE company_id = '${fixture.companyId}' AND id = '${fixture.productId}' AND current_stock = 4) OR NOT EXISTS (SELECT 1 FROM inventory_layers WHERE company_id = '${fixture.companyId}' AND id = '${fixture.inventoryLayerId}' AND qty_remaining = 4) OR NOT EXISTS (SELECT 1 FROM stock_movements WHERE company_id = '${fixture.companyId}' AND product_id = '${fixture.productId}') THEN RAISE EXCEPTION 'journal insert reached before stock deduction'; END IF; PERFORM nextval('${fixture.failureMarkerSequenceName}'); RAISE EXCEPTION 'test POS journal posting failure after stock deduction'; END IF; RETURN NEW; END; $body$ LANGUAGE plpgsql`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER "${fixture.triggerName}" BEFORE INSERT ON journal_entries FOR EACH ROW EXECUTE FUNCTION "${fixture.functionName}"()`,
      );
    },
    async removeJournalFailureTrigger() {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS "${fixture.triggerName}" ON journal_entries`,
      );
      await prisma.$executeRawUnsafe(
        `DROP FUNCTION IF EXISTS "${fixture.functionName}"()`,
      );
      await prisma.$executeRawUnsafe(
        `DROP SEQUENCE IF EXISTS "${fixture.failureMarkerSequenceName}"`,
      );
      fixture.triggerName = '';
      fixture.functionName = '';
      fixture.failureMarkerSequenceName = '';
    },
    async installCompletionAuditTrigger() {
      fixture.finalizationTableName = `pos_complete_audit_${fixture.companyId}`;
      fixture.finalizationFunctionName = `pos_complete_audit_fn_${fixture.companyId}`;
      fixture.finalizationTriggerName = `pos_complete_audit_tr_${fixture.companyId}`;
      await prisma.$executeRawUnsafe(
        `CREATE TABLE "${fixture.finalizationTableName}" (invoice_id CHAR(24) NOT NULL)`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE FUNCTION "${fixture.finalizationFunctionName}"() RETURNS trigger AS $body$ BEGIN INSERT INTO "${fixture.finalizationTableName}" (invoice_id) VALUES (NEW.id); RETURN NEW; END; $body$ LANGUAGE plpgsql`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER "${fixture.finalizationTriggerName}" AFTER UPDATE OF pos_completion_key ON invoices FOR EACH ROW WHEN (OLD.pos_completion_key IS DISTINCT FROM NEW.pos_completion_key AND NEW.pos_completion_key IS NOT NULL) EXECUTE FUNCTION "${fixture.finalizationFunctionName}"()`,
      );
    },
    async countInvoiceFinalizations() {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS count FROM "${fixture.finalizationTableName}" WHERE invoice_id = $1`,
        fixture.saleId,
      );
      return rows[0].count;
    },
  };
}

describe('POS sale completion posting (PostgreSQL integration)', () => {
  const integrationTest = testDatabaseUrl ? test : test.skip;

  beforeEach(() => {
    require('../services/ebmSalesService').submitInvoiceAsync.mockClear();
    require('../services/ebmSalesService').prepareV2SaleSubmission.mockClear().mockRejectedValue(Object.assign(
      new Error('Fiscal payload preconditions are not configured in this integration fixture.'),
      { code: 'EBM_TEST_PAYLOAD_PREPARATION' },
    ));
    require('../services/emailService').sendInvoiceEmail.mockClear();
    require('../services/smsService').sendLargeOrderSMS.mockClear();
    require('../services/notificationDeliveryService').sendInvoiceDelivery.mockClear();
    require('../services/notificationDeliveryService').sendLargeOrderAlert.mockClear();
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  integrationTest('commits one V2 sale, payment, receipt, and journal across concurrent retries and a lost acknowledgment', async () => {
    const fixture = await createFixture();
    const operationId = `offline-operation-${fixture.companyId}`;
    try {
      const issuedAt = Date.now() - 10_000;
      const expiresAt = issuedAt + 60 * 60 * 1000;
      const saleCreatedAt = new Date(issuedAt + 5_000);
      const snapshotId = objectId();
      const receiptNumber = `INV-2026-${String(Number.parseInt(fixture.companyId.slice(-6), 16) % 999999 + 1).padStart(6, '0')}`;
      const effectivePriceRow = await prisma.posEffectivePrice.findFirst({
        where: { companyId: fixture.companyId, productId: fixture.productId, priceListId: null },
        select: { id: true },
      });
      if (effectivePriceRow) {
        await prisma.posEffectivePrice.update({
          where: { id: effectivePriceRow.id },
          data: { price: 80, effectiveFrom: new Date(issuedAt - 60_000), effectiveTo: null },
        });
      } else {
        await prisma.posEffectivePrice.create({
          data: {
            id: objectId(),
            companyId: fixture.companyId,
            productId: fixture.productId,
            price: 80,
            effectiveFrom: new Date(issuedAt - 60_000),
          },
        });
      }
      const pricing = await getWarehousePriceListPrices(
        fixture.companyId,
        fixture.warehouseId,
        [fixture.productId],
        saleCreatedAt,
        null,
        true,
      );
      const offlineUnitPrice = effectivePrice(fixture.productId, 80, pricing.priceByProduct);
      const snapshotData = {
        paymentFlow: 'PAYMENTS_V2',
        receiptNumbers: [receiptNumber],
        products: {
          [fixture.productId]: {
            name: 'POS completion integration product',
            sku: `POS-COMPLETE-${fixture.companyId}`,
            unit: 'pcs',
            standardPrice: offlineUnitPrice,
            price: offlineUnitPrice,
            taxRate: 0,
            taxCode: 'A',
            isStockable: true,
            trackingType: 'none',
            averageCost: 10,
            availableStock: 5,
            batches: [],
            serialNumbers: [],
            incomingTransfers: [],
            outgoingTransfers: [],
          },
        },
        promotions: [],
        negativeStockAllowed: false,
        escalationDays: 3,
      };
      const capability = issueCapability({
        id: snapshotId,
        companyId: fixture.companyId,
        userId: fixture.cashierId,
        deviceId: fixture.deviceId,
        registerId: fixture.registerCode,
        warehouseId: fixture.warehouseId,
        tillSessionId: fixture.tillSessionId,
        paymentFlow: 'PAYMENTS_V2',
        receiptNumbers: [receiptNumber],
        issuedAt,
        expiresAt,
      });
      await prisma.$executeRawUnsafe(
        'INSERT INTO pos_offline_snapshots (id, company_id, user_id, device_id, register_id, warehouse_id, till_session_id, snapshot_data, queue_limit, issued_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::numeric, $10::timestamptz, $11::timestamptz)',
        snapshotId,
        fixture.companyId,
        fixture.cashierId,
        fixture.deviceId,
        fixture.registerCode,
        fixture.warehouseId,
        fixture.tillSessionId,
        JSON.stringify(snapshotData),
        1000,
        new Date(issuedAt),
        new Date(expiresAt),
      );
      await prisma.$executeRawUnsafe(
        'INSERT INTO pos_receipt_number_allocations (id, company_id, device_id, register_id, block_id, block_index, receipt_number, expires_at) VALUES ($1, $2, $3, $4, $5, 0, $6, $7::timestamptz)',
        objectId(),
        fixture.companyId,
        fixture.deviceId,
        fixture.registerId,
        snapshotId,
        receiptNumber,
        new Date(expiresAt),
      );
      await prisma.invoice.update({
        where: { id: fixture.saleId },
        data: {
          referenceNo: receiptNumber,
          posCheckoutPayload: {
            warehouseId: fixture.warehouseId,
            offlineOperationId: operationId,
            offlineSaleId: operationId,
            offlineCreatedAt: saleCreatedAt.toISOString(),
            offlineSnapshotCapability: capability,
            offlineReceiptNumber: receiptNumber,
            offlinePaymentFlow: 'PAYMENTS_V2',
            items: [{
              productId: fixture.productId,
              quantity: 1,
              unitPrice: offlineUnitPrice,
              catalogUnitPrice: offlineUnitPrice,
              discountPct: 0,
              serialNumbers: [],
            }],
          },
        },
      });
      await recordOfflineCashPayment(fixture, offlineUnitPrice);

      // Keep the first completion transaction open during journal insertion
      // so the second request races the same idempotency key before commit.
      fixture.functionName = `pos_exactly_once_pause_${fixture.companyId}`;
      fixture.triggerName = `pos_exactly_once_pause_${fixture.companyId}`;
      await prisma.$executeRawUnsafe(
        `CREATE FUNCTION "${fixture.functionName}"() RETURNS trigger AS $body$ BEGIN IF NEW.company_id = '${fixture.companyId}' THEN PERFORM pg_sleep(0.5); END IF; RETURN NEW; END; $body$ LANGUAGE plpgsql`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER "${fixture.triggerName}" BEFORE INSERT ON journal_entries FOR EACH ROW EXECUTE FUNCTION "${fixture.functionName}"()`,
      );

      // The server commits and sends success, but the client loses that
      // acknowledgment. The overlapping retry must replay the same result.
      const droppedAck = response();
      let responseWrites = 0;
      droppedAck.json = (body) => {
        responseWrites += 1;
        droppedAck.body = body;
        return droppedAck;
      };
      const concurrentRetry = response();
      await Promise.all([
        controller.completeSale(
          requestFor(fixture, { key: operationId }),
          droppedAck,
          (error) => { if (error) throw error; },
        ),
        controller.completeSale(
          requestFor(fixture, { key: operationId }),
          concurrentRetry,
          (error) => { if (error) throw error; },
        ),
      ]);
      expect(droppedAck.body).toMatchObject({ success: true, data: { _id: fixture.saleId } });
      expect(responseWrites).toBe(1);

      const secondConcurrentRetry = response();
      await controller.completeSale(
        requestFor(fixture, { key: operationId }),
        secondConcurrentRetry,
        (error) => { if (error) throw error; },
      );
      for (const res of [concurrentRetry, secondConcurrentRetry]) {
        if (![200, 201].includes(res.statusCode)) {
          throw new Error(`Offline V2 completion failed: ${JSON.stringify(res.body)}`);
        }
        expect(res.body.success).toBe(true);
        expect(String(res.body.data?.id || res.body.data?._id)).toBe(fixture.saleId);
      }
      // The discarded acknowledgment was written once; each retry replays it.
      expect(responseWrites).toBe(1);

      const [invoices, requestRows, payments, journals, fiscalReceipts, movements] = await Promise.all([
        prisma.invoice.findMany({ where: { companyId: fixture.companyId, id: fixture.saleId } }),
        prisma.$queryRawUnsafe(
          'SELECT request_key AS "requestKey", invoice_id AS "invoiceId", status FROM pos_sale_requests WHERE company_id = $1 AND request_key = $2',
          fixture.companyId,
          operationId,
        ),
        prisma.posPayment.findMany({ where: { companyId: fixture.companyId, saleId: fixture.saleId, status: 'SUCCESS' } }),
        prisma.journalEntry.findMany({ where: { companyId: fixture.companyId, sourceType: 'invoice', sourceId: fixture.saleId } }),
        prisma.ebmSubmissionQueue.findMany({ where: { companyId: fixture.companyId, documentType: 'pos', documentId: fixture.saleId } }),
        prisma.stockMovement.findMany({ where: { companyId: fixture.companyId, productId: fixture.productId } }),
      ]);

      expect(invoices).toHaveLength(1);
      expect(invoices[0]).toMatchObject({
        referenceNo: receiptNumber,
        posCompletionKey: operationId,
        status: 'fully_paid',
      });
      expect(invoices.filter((invoice) => invoice.referenceNo === receiptNumber)).toHaveLength(1);
      expect(requestRows).toEqual([{
        requestKey: operationId,
        invoiceId: fixture.saleId,
        status: 'completed',
      }]);
      expect(payments).toHaveLength(1);
      expect(invoices[0].payments).toHaveLength(1);
      expect(journals).toHaveLength(1);
      expect(fiscalReceipts).toHaveLength(1);
      const receiptAllocations = await prisma.$queryRawUnsafe(
        'SELECT receipt_number AS "receiptNumber", operation_id AS "operationId" FROM pos_receipt_number_allocations WHERE company_id = $1 AND device_id = $2 AND register_id = $3 AND operation_id = $4',
        fixture.companyId,
        fixture.deviceId,
        fixture.registerId,
        operationId,
      );
      expect(receiptAllocations).toEqual([{ receiptNumber, operationId }]);
      expect(movements).toHaveLength(1);
      expect(Number(movements[0].quantity)).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });

  integrationTest('defers a failed posting, then retries once before replaying concurrent completions', async () => {
    const EBMSalesService = require('../services/ebmSalesService');
    const JournalService = require('../services/journalService');
    const emailService = require('../services/emailService');
    const notificationDeliveryService = require('../services/notificationDeliveryService');
    const createEntriesAtomic = jest.spyOn(JournalService, 'createEntriesAtomic');
    const fixture = await createFixture();
    try {
      await recordGiftCardPayment(fixture);
      const { ledger } = await assertLedgerMatchesBalance(fixture.companyId, fixture.accountId);
      expect(ledger.filter((entry) => entry.operationType === 'REDEEM')).toHaveLength(1);

      await fixture.installCompletionAuditTrigger();
      await fixture.installJournalFailureTrigger();
      const failedResponse = response();
      const expectedPostingFailureLog = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await controller.completeSale(
          requestFor(fixture, { key: `completion-retry-${fixture.companyId}` }),
          failedResponse,
          (error) => { if (error) throw error; },
        );
      } finally {
        expectedPostingFailureLog.mockRestore();
      }

      expect(failedResponse.statusCode).toBe(201);
      expect(failedResponse.body.success).toBe(true);
      const [pendingInvoice, deferredJournals, deferredStock, deferredProduct, deferredLayer, deferredMovements, deferredPayments] = await Promise.all([
        prisma.invoice.findUnique({ where: { id: fixture.saleId } }),
        prisma.journalEntry.findMany({ where: { companyId: fixture.companyId, sourceId: fixture.saleId } }),
        prisma.stockLevel.findUnique({ where: { id: fixture.stockLevelId } }),
        prisma.product.findUnique({ where: { id: fixture.productId } }),
        prisma.inventoryLayer.findUnique({ where: { id: fixture.inventoryLayerId } }),
        prisma.stockMovement.findMany({ where: { companyId: fixture.companyId, productId: fixture.productId } }),
        prisma.posPayment.findMany({ where: { companyId: fixture.companyId, saleId: fixture.saleId } }),
      ]);
      expect(pendingInvoice.status).toBe('fully_paid');
      expect(pendingInvoice.posPostingStatus).toBe('pending');
      expect(pendingInvoice.posCompletionKey).toBe(`completion-retry-${fixture.companyId}`);
      const transactionalRequest = await prisma.$queryRawUnsafe(
        'SELECT request_key AS "requestKey", invoice_id AS "invoiceId", status FROM pos_sale_requests WHERE company_id = $1 AND request_key = $2',
        fixture.companyId,
        `completion-retry-${fixture.companyId}`,
      );
      expect(transactionalRequest).toEqual([{
        requestKey: `completion-retry-${fixture.companyId}`,
        invoiceId: fixture.saleId,
        status: 'completed',
      }]);
      expect(deferredJournals).toHaveLength(0);
      expect(Number(deferredStock.qtyOnHand)).toBe(4);
      expect(Number(deferredProduct.currentStock)).toBe(4);
      expect(Number(deferredLayer.qtyRemaining)).toBe(4);
      expect(deferredMovements).toHaveLength(1);
      expect(deferredPayments).toHaveLength(1);
      expect(await fixture.countInvoiceFinalizations()).toBe(1);
      expect(await fixture.readFailureMarker()).toBe(1);
      await assertLedgerMatchesBalance(fixture.companyId, fixture.accountId);

      await fixture.removeJournalFailureTrigger();
      await prisma.$executeRawUnsafe(
        `UPDATE "pos_accounting_postings"
         SET "next_retry_at" = CURRENT_TIMESTAMP - INTERVAL '1 second'
         WHERE "company_id" = $1 AND "source_type" = 'pos_sale' AND "source_id" = $2`,
        fixture.companyId,
        fixture.saleId,
      );
      await expect(require('../services/posAccountingPostingService').processDuePostings())
        .resolves.toMatchObject({ processed: 1, posted: 1, deferred: 0, failed: 0 });

      const completionKey = `completion-retry-${fixture.companyId}`;
      const successfulResponses = [response(), response()];
      await Promise.all(successfulResponses.map((res) => controller.completeSale(
        requestFor(fixture, { key: completionKey }),
        res,
        (error) => { if (error) throw error; },
      )));

      expect(successfulResponses.map((res) => res.statusCode)).toEqual([200, 200]);
      expect(successfulResponses.every((res) => res.body.success)).toBe(true);
      expect(successfulResponses.filter((res) => res.body.replayed === true)).toHaveLength(2);
      expect(successfulResponses.map((res) => res.body.data.id)).toEqual([fixture.saleId, fixture.saleId]);
      const replayedTransactionalRequests = await prisma.$queryRawUnsafe(
        'SELECT request_key AS "requestKey", invoice_id AS "invoiceId", status FROM pos_sale_requests WHERE company_id = $1 AND request_key = $2',
        fixture.companyId,
        completionKey,
      );
      expect(replayedTransactionalRequests).toEqual([{
        requestKey: completionKey,
        invoiceId: fixture.saleId,
        status: 'completed',
      }]);
      const [completedInvoice, journals, stock, product, layer, movements] = await Promise.all([
        prisma.invoice.findUnique({ where: { id: fixture.saleId } }),
        prisma.journalEntry.findMany({
          where: { companyId: fixture.companyId, sourceType: 'invoice', sourceId: fixture.saleId },
          include: { lines: true },
        }),
        prisma.stockLevel.findUnique({ where: { id: fixture.stockLevelId } }),
        prisma.product.findUnique({ where: { id: fixture.productId } }),
        prisma.inventoryLayer.findUnique({ where: { id: fixture.inventoryLayerId } }),
        prisma.stockMovement.findMany({
          where: { companyId: fixture.companyId, productId: fixture.productId },
        }),
      ]);
      expect(completedInvoice.status).toBe('fully_paid');
      expect(completedInvoice.posCompletionKey).toBe(completionKey);
      expect(completedInvoice.stockDeducted).toBe(true);
      expect(completedInvoice.posCheckoutPayload).toBeNull();
      expect(completedInvoice.payments).toHaveLength(1);
      expect(completedInvoice.payments[0]).toMatchObject({
        amount: 80,
        paymentMethod: 'gift_card',
        storedValueAccountId: fixture.accountId,
      });
      expect(journals).toHaveLength(1);
      expect(createEntriesAtomic).toHaveBeenCalledTimes(2);
      expect(createEntriesAtomic.mock.calls.map((call) => call[2])).toEqual([
        [expect.objectContaining({ sourceId: fixture.saleId })],
        [expect.objectContaining({ sourceId: fixture.saleId })],
      ]);
      expect(journals[0].lines.length).toBeGreaterThanOrEqual(4);
      expect(Number(journals[0].totalDebit)).toBe(Number(journals[0].totalCredit));
      expect(Number(stock.qtyOnHand)).toBe(4);
      expect(Number(product.currentStock)).toBe(4);
      expect(Number(layer.qtyRemaining)).toBe(4);
      expect(movements).toHaveLength(1);
      expect(Number(movements[0].quantity)).toBe(1);
      const { ledger: finalLedger } = await assertLedgerMatchesBalance(fixture.companyId, fixture.accountId);
      const linkedPayments = await prisma.posPayment.findMany({
        where: { companyId: fixture.companyId, saleId: fixture.saleId, status: 'SUCCESS' },
      });
      expect(linkedPayments).toHaveLength(1);
      expect(finalLedger.find((entry) => entry.operationType === 'REDEEM').posPaymentId).toBe(linkedPayments[0].id);
      expect(await fixture.countInvoiceFinalizations()).toBe(1);
      expect(EBMSalesService.submitInvoiceAsync).toHaveBeenCalledTimes(1);
      expect(EBMSalesService.submitInvoiceAsync).toHaveBeenCalledWith(
        fixture.saleId,
        expect.objectContaining({ companyId: fixture.companyId, modifierUserId: fixture.cashierId, outboxId: expect.any(String) }),
      );
      const durableSubmission = await prisma.ebmSubmissionQueue.findFirst({
        where: { companyId: fixture.companyId, documentType: 'pos', documentId: fixture.saleId },
      });
      expect(durableSubmission).toMatchObject({
        ebmStatus: 'failed',
        registerId: fixture.registerCode,
        shiftId: fixture.shiftId,
        cashierId: fixture.cashierId,
        salesTyCd: 'N',
        rcptTyCd: 'S',
        requestPayloadHash: null,
      });
      expect(EBMSalesService.submitInvoiceAsync.mock.calls[0][1].outboxId).toBe(durableSubmission.id);
      expect(notificationDeliveryService.sendInvoiceDelivery.mock.calls.length).toBeLessThanOrEqual(1);
      expect(notificationDeliveryService.sendLargeOrderAlert).toHaveBeenCalledTimes(1);
      expect(emailService.sendInvoiceEmail).not.toHaveBeenCalled();
      expect(require('../services/smsService').sendLargeOrderSMS).not.toHaveBeenCalled();
      expect(finalLedger.filter((entry) => entry.operationType === 'REDEEM')).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  integrationTest('rejects a different-key completion from another till without duplicate posting', async () => {
    const EBMSalesService = require('../services/ebmSalesService');
    const fixture = await createFixture();
    try {
      await recordGiftCardPayment(fixture);
      const attempts = [
        { alternateTill: false, key: `complete-owner-${fixture.companyId}` },
        { alternateTill: true, key: `complete-other-${fixture.companyId}` },
      ];
      const responses = await Promise.all(attempts.map(async ({ alternateTill, key }) => {
        const res = response();
        await controller.completeSale(
          requestFor(fixture, { key, alternateTill }),
          res,
          (error) => { if (error) throw error; },
        );
        return { alternateTill, res };
      }));

      const ownerResult = responses.find(({ alternateTill }) => !alternateTill).res;
      const otherTillResult = responses.find(({ alternateTill }) => alternateTill).res;
      expect(ownerResult.statusCode).toBe(201);
      expect(ownerResult.body.success).toBe(true);
      expect([403, 409]).toContain(otherTillResult.statusCode);
      if (otherTillResult.statusCode === 403) {
        expect(otherTillResult.body.code).toBe('POS_PAYMENT_CONTEXT_MISMATCH');
      } else {
        expect(otherTillResult.body.code).toBe('POS_SALE_NOT_PENDING');
      }

      const [invoice, journals, stock, movements] = await Promise.all([
        prisma.invoice.findUnique({ where: { id: fixture.saleId } }),
        prisma.journalEntry.findMany({
          where: { companyId: fixture.companyId, sourceType: 'invoice', sourceId: fixture.saleId },
        }),
        prisma.stockLevel.findUnique({ where: { id: fixture.stockLevelId } }),
        prisma.stockMovement.findMany({
          where: { companyId: fixture.companyId, productId: fixture.productId },
        }),
      ]);
      expect(invoice.status).toBe('fully_paid');
      expect(invoice.posCompletionKey).toBe(`complete-owner-${fixture.companyId}`);
      expect(journals).toHaveLength(1);
      expect(Number(stock.qtyOnHand)).toBe(4);
      expect(movements).toHaveLength(1);
      expect(Number(movements[0].quantity)).toBe(1);
      expect(EBMSalesService.submitInvoiceAsync).toHaveBeenCalledTimes(1);
      const { ledger } = await assertLedgerMatchesBalance(fixture.companyId, fixture.accountId);
      expect(ledger.filter((entry) => entry.operationType === 'REDEEM')).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  integrationTest('defers journal posting after stock deduction and safely retries it', async () => {
    const fixture = await createFixture();
    try {
      await recordGiftCardPayment(fixture);
      await fixture.installCompletionAuditTrigger();
      await fixture.installJournalFailureTrigger();

      const res = response();
      const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await controller.completeSale(
          requestFor(fixture, { key: `complete-stock-rollback-${fixture.companyId}` }),
          res,
          (error) => { if (error) throw error; },
        );
      } finally {
        errorLog.mockRestore();
      }

      expect(res.statusCode).toBe(201);
      expect(res.body.success).toBe(true);
      const [invoice, journals, stock, product, layer, movements, finalizations] = await Promise.all([
        prisma.invoice.findUnique({ where: { id: fixture.saleId } }),
        prisma.journalEntry.findMany({
          where: { companyId: fixture.companyId, sourceId: fixture.saleId },
        }),
        prisma.stockLevel.findUnique({ where: { id: fixture.stockLevelId } }),
        prisma.product.findUnique({ where: { id: fixture.productId } }),
        prisma.inventoryLayer.findUnique({ where: { id: fixture.inventoryLayerId } }),
        prisma.stockMovement.findMany({
          where: { companyId: fixture.companyId, productId: fixture.productId },
        }),
        fixture.countInvoiceFinalizations(),
      ]);
      expect(invoice.status).toBe('fully_paid');
      expect(invoice.posPostingStatus).toBe('pending');
      expect(invoice.posCompletionKey).toBe(`complete-stock-rollback-${fixture.companyId}`);
      expect(journals).toHaveLength(0);
      expect(Number(stock.qtyOnHand)).toBe(4);
      expect(Number(product.currentStock)).toBe(4);
      expect(Number(layer.qtyRemaining)).toBe(4);
      expect(movements).toHaveLength(1);
      expect(finalizations).toBe(1);
      expect(await fixture.readFailureMarker()).toBe(1);
      await assertLedgerMatchesBalance(fixture.companyId, fixture.accountId);
      await fixture.removeJournalFailureTrigger();
      await prisma.$executeRawUnsafe(
        `UPDATE "pos_accounting_postings"
         SET "next_retry_at" = CURRENT_TIMESTAMP - INTERVAL '1 second'
         WHERE "company_id" = $1 AND "source_type" = 'pos_sale' AND "source_id" = $2`,
        fixture.companyId,
        fixture.saleId,
      );
      await expect(require('../services/posAccountingPostingService').processDuePostings())
        .resolves.toMatchObject({ processed: 1, posted: 1, deferred: 0, failed: 0 });
      expect(await prisma.journalEntry.count({
        where: { companyId: fixture.companyId, sourceType: 'invoice', sourceId: fixture.saleId },
      })).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });

  integrationTest('posts a split cash and manual MoMo sale to their clearing accounts without provider calls', async () => {
    const posPaymentService = require('../services/posPaymentService');
    const requestProviderPayment = jest.spyOn(posPaymentService, 'requestProviderPayment');
    const getProviderStatus = jest.spyOn(posPaymentService, 'getProviderStatus');
    const fixture = await createFixture();
    try {
      const cashRequest = requestFor(fixture, { key: `split-cash-${fixture.companyId}` });
      cashRequest.body = { payments: [{ method: 'CASH', amount: 30, tendered: 30 }] };
      const cashResponse = response();
      await controller.recordCashPayment(cashRequest, cashResponse, (error) => { if (error) throw error; });
      expect(cashResponse.statusCode).toBe(201);

      const mobileRequest = requestFor(fixture, { key: `split-momo-${fixture.companyId}` });
      mobileRequest.body = {
        provider: 'MTN_MOMO',
        amount: 50,
        reference: ' momo-split-ref ',
        payerPhone: '0781234567',
        confirmReceived: true,
      };
      const mobileResponse = response();
      await controller.recordManualMobileMoneyPayment(
        mobileRequest,
        mobileResponse,
        (error) => { if (error) throw error; },
      );
      expect(mobileResponse.statusCode).toBe(201);
      expect(mobileResponse.body.data.payment).toMatchObject({
        method: 'MTN_MOMO',
        status: 'SUCCESS',
        amount: 50,
        reference: 'momo-split-ref',
      });

      await fixture.installCompletionAuditTrigger();
      const completeResponse = response();
      await controller.completeSale(
        requestFor(fixture, { key: `split-complete-${fixture.companyId}` }),
        completeResponse,
        (error) => { if (error) throw error; },
      );
      expect(completeResponse.statusCode).toBe(201);
      expect(requestProviderPayment).not.toHaveBeenCalled();
      expect(getProviderStatus).not.toHaveBeenCalled();

      const [invoice, journals, movements] = await Promise.all([
        prisma.invoice.findUnique({ where: { id: fixture.saleId } }),
        prisma.journalEntry.findMany({
          where: { companyId: fixture.companyId, sourceType: 'invoice', sourceId: fixture.saleId },
          include: { lines: true },
        }),
        prisma.stockMovement.findMany({
          where: { companyId: fixture.companyId, productId: fixture.productId },
        }),
      ]);
      expect(invoice.status).toBe('fully_paid');
      expect(invoice.payments).toHaveLength(2);
      expect(invoice.payments).toEqual(expect.arrayContaining([
        expect.objectContaining({ paymentMethod: 'cash', amount: 30 }),
        expect.objectContaining({ paymentMethod: 'mobile_money', provider: 'momo', amount: 50 }),
      ]));
      expect(journals).toHaveLength(1);
      expect(Number(journals[0].totalDebit)).toBe(Number(journals[0].totalCredit));
      const cashLine = journals[0].lines.find((line) => line.accountCode === '1000');
      const mobileMoneyLine = journals[0].lines.find((line) => line.accountCode === '1200');
      expect(cashLine).toBeDefined();
      expect(mobileMoneyLine).toBeDefined();
      expect(Number(cashLine.debit)).toBe(30);
      expect(Number(mobileMoneyLine.debit)).toBe(50);
      expect(movements).toHaveLength(1);
      expect(Number(movements[0].quantity)).toBe(1);
      expect(await fixture.countInvoiceFinalizations()).toBe(1);
      expect(require('../services/ebmSalesService').submitInvoiceAsync).toHaveBeenCalledTimes(1);
    } finally {
      await fixture.cleanup();
    }
  });

  afterAll(async () => {
    if (disconnectPrisma) await disconnectPrisma();
  });
});
