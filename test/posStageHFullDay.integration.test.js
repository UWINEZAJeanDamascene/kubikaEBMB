'use strict';

const { randomBytes } = require('crypto');

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
let reportController;
let trialBalanceService;
let JournalService;
let saleJournalBuilder;

if (testDatabaseUrl) {
  process.env.DATABASE_URL = testDatabaseUrl;
  ({ prisma, disconnectPrisma } = require('../lib/prisma'));
  reportController = require('../controllers/posAccountingReportsController');
  trialBalanceService = require('../services/trialBalanceService');
  JournalService = require('../services/journalService');
  saleJournalBuilder = require('../services/posSaleJournalBuilder').buildPosSaleJournalEntries;
}

function id() {
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

async function createFixture() {
  const fixture = {
    companyId: id(),
    otherCompanyId: id(),
    cashierId: id(),
    clientId: id(),
    registerId: id(),
    shiftId: id(),
    categoryId: id(),
    warehouseId: id(),
    productId: id(),
    invoiceId: id(),
    storedValueAccountId: id(),
    creditNoteId: id(),
  };
  const day = new Date('2026-11-06T10:00:00+02:00');
  const accountCodes = {
    posRegisterCash: '1000',
    cardClearing: '1100',
    mtnMoMo: '1200',
    airtelMoney: '1210',
    cashAtBank: '1100',
    chequesInHand: '1130',
    bankDepositClearing: '1120',
    accountsReceivable: '1300',
    customerAdvances: '2860',
    giftCardLiability: '2850',
    storeCreditLiability: '2860',
    loyaltyWalletLiability: '2860',
    loyaltyPointsLiability: '2860',
    loyaltyRewardsExpense: '5850',
    stockAdjustmentLoss: '5150',
    inventory: '1400',
    salesRevenue: '4000',
    vatOutput: '2220',
    costOfGoodsSold: '5000',
  };
  const accountTypes = {
    '1000': ['Cash in hand', 'asset'],
    '1100': ['Cash at bank and card clearing', 'asset'],
    '1120': ['Bank deposit clearing', 'asset'],
    '1130': ['Cheques in hand', 'asset'],
    '1200': ['MTN MoMo clearing', 'asset'],
    '1210': ['Airtel Money clearing', 'asset'],
    '1300': ['Accounts receivable', 'asset'],
    '1400': ['Inventory', 'asset'],
    '2220': ['VAT output', 'liability'],
    '2850': ['Gift card liability', 'liability'],
    '2860': ['Stored value and customer advances', 'liability'],
    '4000': ['Sales revenue', 'revenue'],
    '5000': ['Cost of goods sold', 'cogs'],
    '5150': ['Stock write-off loss', 'cogs'],
    '5850': ['Loyalty rewards expense', 'expense'],
  };
  const journalIds = {};
  const cleanup = async () => {
    const cleanupSteps = [
      () => prisma.posPaymentRefund.deleteMany({ where: { companyId: fixture.companyId } }),
      () => prisma.posStoredValueLedger.deleteMany({ where: { companyId: fixture.companyId } }),
      () => prisma.posPayment.deleteMany({ where: { companyId: fixture.companyId } }),
      () => prisma.posCashMovement.deleteMany({ where: { companyId: fixture.companyId } }),
      () => prisma.creditNoteLine.deleteMany({ where: { companyId: fixture.companyId } }),
      () => prisma.creditNote.deleteMany({ where: { companyId: fixture.companyId } }),
      () => prisma.invoiceLine.deleteMany({ where: { companyId: fixture.companyId } }),
      () => prisma.invoice.deleteMany({ where: { companyId: fixture.companyId } }),
      () => prisma.journalEntryLine.deleteMany({ where: { companyId: fixture.companyId } }),
      () => prisma.journalEntry.deleteMany({ where: { companyId: fixture.companyId } }),
      () => prisma.posShift.deleteMany({ where: { companyId: fixture.companyId } }),
      () => prisma.posRegister.deleteMany({ where: { companyId: fixture.companyId } }),
      () => prisma.posStoredValueAccount.deleteMany({ where: { companyId: fixture.companyId } }),
      () => prisma.accountMapping.deleteMany({ where: { companyId: fixture.companyId } }),
      () => prisma.chartOfAccount.deleteMany({ where: { companyId: fixture.companyId } }),
      () => prisma.stockLevel.deleteMany({ where: { companyId: fixture.companyId } }),
      () => prisma.product.deleteMany({ where: { companyId: fixture.companyId } }),
      () => prisma.category.deleteMany({ where: { companyId: fixture.companyId } }),
      () => prisma.warehouse.deleteMany({ where: { companyId: fixture.companyId } }),
      () => prisma.user.deleteMany({ where: { companyId: fixture.companyId } }),
      () => prisma.company.deleteMany({ where: { id: fixture.companyId } }),
      () => prisma.company.deleteMany({ where: { id: fixture.otherCompanyId } }),
    ];
    let firstError;
    for (const step of cleanupSteps) {
      try {
        await step();
      } catch (error) {
        firstError ||= error;
      }
    }
    if (firstError) throw firstError;
  };

  await prisma.company.create({
    data: {
      id: fixture.companyId,
      name: 'POS Stage H Full Day Qualification',
      code: `POS-STAGE-H-${fixture.companyId}`,
    },
  });
  try {
    await prisma.company.create({
      data: {
        id: fixture.otherCompanyId,
        name: 'POS Stage H Isolation Control',
        code: `POS-STAGE-H-OTHER-${fixture.otherCompanyId}`,
      },
    });
    await prisma.user.create({
      data: {
        id: fixture.cashierId,
        companyId: fixture.companyId,
        name: 'Stage H qualification cashier',
        email: `pos-stage-h-${fixture.companyId}@example.invalid`,
        password: 'integration-test-only',
      },
    });
    await prisma.client.create({
      data: {
        id: fixture.clientId,
        companyId: fixture.companyId,
        name: 'Stage H qualification customer',
        code: `POS-STAGE-H-${fixture.companyId}`,
      },
    });
    await prisma.chartOfAccount.createMany({
      data: Object.entries(accountTypes).map(([code, [name, type]]) => ({
        id: id(),
        companyId: fixture.companyId,
        code,
        name,
        type,
        allowDirectPosting: true,
        isActive: true,
      })),
    });
    await prisma.accountMapping.createMany({
      data: Object.entries(accountCodes).map(([key, accountCode]) => ({
        id: id(),
        companyId: fixture.companyId,
        module: 'pos_accounting',
        key: `company:${key}`,
        accountCode,
      })),
    });
    await prisma.posRegister.create({
      data: {
        id: fixture.registerId,
        companyId: fixture.companyId,
        code: `STAGE-H-${fixture.companyId}`,
        name: 'Stage H hospitality till',
        systemTillType: 'hospitality',
      },
    });
    await prisma.posShift.create({
      data: {
        id: fixture.shiftId,
        companyId: fixture.companyId,
        registerId: fixture.registerId,
        shiftNumber: 1,
        openedById: fixture.cashierId,
        openingFloat: 100,
        openedAt: day,
      },
    });
    await prisma.warehouse.create({
      data: {
        id: fixture.warehouseId,
        companyId: fixture.companyId,
        name: 'Stage H qualification warehouse',
        code: `STAGE-H-${fixture.companyId}`,
      },
    });
    await prisma.category.create({
      data: {
        id: fixture.categoryId,
        companyId: fixture.companyId,
        name: `Stage H ${fixture.companyId}`,
      },
    });
    await prisma.product.create({
      data: {
        id: fixture.productId,
        companyId: fixture.companyId,
        name: 'Stage H qualification product',
        sku: `STAGE-H-${fixture.companyId}`,
        categoryId: fixture.categoryId,
        defaultWarehouseId: fixture.warehouseId,
        currentStock: 10,
        averageCost: 110,
        costPrice: 110,
        sellingPrice: 500,
        taxCode: 'B',
        taxRate: 18,
        isStockable: true,
        trackingType: 'none',
      },
    });
    await prisma.stockLevel.create({
      data: {
        id: id(),
        companyId: fixture.companyId,
        productId: fixture.productId,
        warehouseId: fixture.warehouseId,
        qtyOnHand: 10,
        avgCost: 110,
        totalValue: 1100,
      },
    });
    await prisma.invoice.create({
      data: {
        id: fixture.invoiceId,
        companyId: fixture.companyId,
        clientId: fixture.clientId,
        referenceNo: `STAGE-H-${fixture.companyId}`,
        status: 'fully_paid',
        posOrigin: true,
        shiftId: fixture.shiftId,
        cashierId: fixture.cashierId,
        registerId: fixture.registerId,
        currencyCode: 'RWF',
        subtotal: 1100,
        totalDiscount: 100,
        taxAmount: 180,
        totalAmount: 1180,
        amountPaid: 1180,
        amountOutstanding: 0,
        invoiceDate: day,
        dueDate: new Date('2026-11-07T10:00:00+02:00'),
        payments: [],
        ebm: { paymentFlow: 'PAYMENTS_V2' },
      },
    });
    const lines = [
      { lineOrder: 0, quantity: 2, unitPrice: 500, discountPct: 10, lineSubtotal: 1000, lineTax: 162, lineTotal: 1062, cogsAmount: 400 },
      { lineOrder: 1, quantity: 2, unitPrice: 50, discountPct: 0, lineSubtotal: 100, lineTax: 18, lineTotal: 118, cogsAmount: 40 },
    ];
    await prisma.invoiceLine.createMany({
      data: lines.map(({ quantity, ...line }) => ({
        id: id(),
        companyId: fixture.companyId,
        invoiceId: fixture.invoiceId,
        productId: fixture.productId,
        warehouseId: fixture.warehouseId,
        ...line,
        qty: quantity,
        taxRate: 18,
        taxCode: 'B',
        serialNumbers: [],
      })),
    });

    await prisma.posStoredValueAccount.create({
      data: {
        id: fixture.storedValueAccountId,
        companyId: fixture.companyId,
        clientId: fixture.clientId,
        kind: 'gift_card',
        codeHash: 'stage-h-gift-card-hash',
        codeSuffix: 'STGH',
        currencyCode: 'RWF',
        balance: 150,
        createdById: fixture.cashierId,
      },
    });
    const issueLedgerId = id();
    const [issueEntry] = await JournalService.createEntriesAtomic(
      fixture.companyId,
      fixture.cashierId,
      [{
        date: day,
        description: 'Cash-funded gift-card issue',
        sourceType: 'pos_stored_value',
        sourceId: issueLedgerId,
        sourceReference: `STGH-${fixture.companyId}`,
        lines: [
          JournalService.createDebitLine('1000', 150, 'Cash-funded gift-card issue'),
          JournalService.createCreditLine('2850', 150, 'Gift-card liability'),
        ],
        isAutoGenerated: true,
        skipBankTransactions: true,
      }],
      { allowDuplicate: false },
    );
    journalIds.giftCardIssue = String(issueEntry._id || issueEntry.id);
    await prisma.posStoredValueLedger.create({
      data: {
        id: issueLedgerId,
        companyId: fixture.companyId,
        accountId: fixture.storedValueAccountId,
        operationType: 'ISSUE',
        kind: 'gift_card',
        entryType: 'issue',
        amount: 150,
        balanceAfter: 150,
        reference: 'STGH',
        idempotencyKey: `stage-h-issue-${fixture.companyId}`,
        createdById: fixture.cashierId,
        journalEntryId: journalIds.giftCardIssue,
        postingStatus: 'posted',
        createdAt: day,
      },
    });
    const tenders = [
      { paymentMethod: 'cash', amount: 150 },
      { paymentMethod: 'card', amount: 100 },
      { paymentMethod: 'mobile_money', provider: 'momo', amount: 100 },
      { paymentMethod: 'mobile_money', provider: 'airtel', amount: 100 },
      { paymentMethod: 'bank_transfer', amount: 100 },
      { paymentMethod: 'cheque', amount: 100 },
      { paymentMethod: 'customer_credit', amount: 100 },
      { paymentMethod: 'gift_card', amount: 100, storedValueAccountId: fixture.storedValueAccountId },
      { paymentMethod: 'store_credit', amount: 100 },
      { paymentMethod: 'loyalty_wallet', amount: 100 },
      { paymentMethod: 'loyalty_points', amount: 130 },
    ];
    const builtSale = await saleJournalBuilder({
      companyId: fixture.companyId,
      userId: fixture.cashierId,
      invoice: {
        id: fixture.invoiceId,
        referenceNo: `STAGE-H-${fixture.companyId}`,
        invoiceDate: day,
        ebm: { paymentFlow: 'PAYMENTS_V2' },
      },
      register: { id: fixture.registerId, systemTillType: 'hospitality' },
      tenders,
      lines: lines.map((line) => ({ ...line, lineTax: line.lineTax, lineTotal: line.lineTotal })),
      totalAmount: 1180,
      subtotal: 1100,
      totalDiscount: 100,
      taxAmount: 180,
      amountPaid: 1180,
      amountOutstanding: 0,
      cogsAmount: 440,
      paymentFlow: 'PAYMENTS_V2',
    });
    const saleEntries = await JournalService.createEntriesAtomic(
      fixture.companyId,
      fixture.cashierId,
      builtSale.journalEntries.map((entry) => ({ ...entry, skipBankTransactions: true })),
      { allowDuplicate: false },
    );
    journalIds.sale = String(saleEntries[0]._id || saleEntries[0].id);
    await prisma.invoice.update({
      where: { id: fixture.invoiceId },
      data: { revenueJournalEntryId: journalIds.sale, posPostingStatus: 'posted' },
    });

    const paymentSpecs = [
      ['CASH', 150],
      ['CARD', 100],
      ['MTN_MOMO', 100],
      ['AIRTEL_MONEY', 100],
      ['BANK_TRANSFER', 100],
      ['CHEQUE', 100],
      ['CREDIT', 100],
      ['GIFT_CARD', 100],
      ['STORE_CREDIT', 100],
      ['LOYALTY_WALLET', 100],
      ['LOYALTY_POINTS', 130],
    ];
    const paymentIds = Object.fromEntries(paymentSpecs.map(([method]) => [method, id()]));
    await prisma.posPayment.createMany({
      data: paymentSpecs.map(([method, amount]) => ({
        id: paymentIds[method],
        companyId: fixture.companyId,
        saleId: fixture.invoiceId,
        shiftId: fixture.shiftId,
        registerId: fixture.registerId,
        cashierId: fixture.cashierId,
        method,
        status: 'SUCCESS',
        amount,
        idempotencyKey: `stage-h-${method}-${fixture.companyId}`,
        createdAt: day,
        completedAt: day,
      })),
    });
    const redemptionLedgerId = id();
    await prisma.posStoredValueLedger.create({
      data: {
        id: redemptionLedgerId,
        companyId: fixture.companyId,
        accountId: fixture.storedValueAccountId,
        posPaymentId: paymentIds.GIFT_CARD,
        operationType: 'REDEEM',
        invoiceId: fixture.invoiceId,
        kind: 'gift_card',
        entryType: 'redeem',
        amount: 100,
        balanceAfter: 50,
        reference: `STAGE-H-${fixture.invoiceId}`,
        idempotencyKey: `stage-h-redeem-${fixture.companyId}`,
        createdById: fixture.cashierId,
        journalEntryId: journalIds.sale,
        postingStatus: 'posted',
        createdAt: day,
      },
    });
    await prisma.posStoredValueAccount.update({
      where: { id: fixture.storedValueAccountId },
      data: { balance: 50 },
    });

    await prisma.creditNote.create({
      data: {
        id: fixture.creditNoteId,
        companyId: fixture.companyId,
        referenceNo: `STAGE-H-CN-${fixture.companyId}`,
        invoiceId: fixture.invoiceId,
        clientId: fixture.clientId,
        creditDate: day,
        reason: 'One unit restocked; one unit written off',
        type: 'return',
        status: 'confirmed',
        posOrigin: true,
        currencyCode: 'RWF',
        subtotal: 100,
        taxAmount: 18,
        totalAmount: 118,
        amountRefunded: 118,
        posPostingStatus: 'posted',
        stockReversed: true,
        payments: [{ id: `stage-h-refund-${fixture.companyId}`, idempotencyKey: `stage-h-refund-${fixture.companyId}`, amount: 118, method: 'CASH', postingStatus: 'posted' }],
        createdById: fixture.cashierId,
        confirmedById: fixture.cashierId,
        confirmedAt: day,
      },
    });
    await prisma.creditNoteLine.createMany({
      data: [
        {
          id: id(),
          companyId: fixture.companyId,
          creditNoteId: fixture.creditNoteId,
          lineOrder: 0,
          productId: fixture.productId,
          productName: 'Stage H qualification product',
          quantity: 1,
          originalQty: 2,
          unitPrice: 50,
          unitCost: 20,
          taxRate: 18,
          lineSubtotal: 50,
          lineTax: 9,
          lineTotal: 59,
          returnToWarehouseId: fixture.warehouseId,
          returnDisposition: 'restock',
        },
        {
          id: id(),
          companyId: fixture.companyId,
          creditNoteId: fixture.creditNoteId,
          lineOrder: 1,
          productId: fixture.productId,
          productName: 'Stage H qualification product',
          quantity: 1,
          originalQty: 2,
          unitPrice: 50,
          unitCost: 20,
          taxRate: 18,
          lineSubtotal: 50,
          lineTax: 9,
          lineTotal: 59,
          returnDisposition: 'write_off',
          writeOffReason: 'Damaged',
        },
      ],
    });
    const creditEntries = await JournalService.createEntriesAtomic(
      fixture.companyId,
      fixture.cashierId,
      [
        {
          date: day,
          description: 'POS credit-note revenue and VAT reversal',
          sourceType: 'credit_note',
          sourceId: fixture.creditNoteId,
          sourceReference: `STAGE-H-CN-${fixture.companyId}`,
          lines: [
            JournalService.createDebitLine('4000', 100, 'Sales revenue reversal'),
            JournalService.createDebitLine('2220', 18, 'VAT reversal'),
            JournalService.createCreditLine('1000', 118, 'Cash refund'),
          ],
          isAutoGenerated: true,
          skipBankTransactions: true,
        },
        {
          date: day,
          description: 'POS credit-note restock reversal',
          sourceType: 'credit_note_cogs',
          sourceId: fixture.creditNoteId,
          sourceReference: `STAGE-H-CN-RESTOCK-${fixture.companyId}`,
          lines: [
            JournalService.createDebitLine('1400', 20, 'Restock returned inventory'),
            JournalService.createCreditLine('5000', 20, 'Reverse original COGS'),
          ],
          isAutoGenerated: true,
          skipBankTransactions: true,
        },
        {
          date: day,
          description: 'POS credit-note write-off',
          sourceType: 'credit_note_writeoff',
          sourceId: fixture.creditNoteId,
          sourceReference: `STAGE-H-CN-WRITEOFF-${fixture.companyId}`,
          lines: [
            JournalService.createDebitLine('5150', 20, 'Write-off loss'),
            JournalService.createCreditLine('1400', 20, 'Remove written-off inventory'),
          ],
          isAutoGenerated: true,
          skipBankTransactions: true,
        },
      ],
      { allowDuplicate: false },
    );
    journalIds.creditRevenue = String(creditEntries[0]._id || creditEntries[0].id);
    journalIds.creditRestock = String(creditEntries[1]._id || creditEntries[1].id);
    journalIds.creditWriteOff = String(creditEntries[2]._id || creditEntries[2].id);
    await prisma.creditNote.update({
      where: { id: fixture.creditNoteId },
      data: {
        revenueReversalEntryId: journalIds.creditRevenue,
        cogsReversalEntryId: journalIds.creditRestock,
        writeOffReversalEntryId: journalIds.creditWriteOff,
      },
    });
    await prisma.posPaymentRefund.create({
      data: {
        id: id(),
        companyId: fixture.companyId,
        paymentId: paymentIds.CASH,
        saleId: fixture.invoiceId,
        method: 'CASH',
        amount: 118,
        status: 'DONE',
        reason: 'Credit note refund',
        idempotencyKey: `stage-h-refund-${fixture.companyId}`,
        createdAt: day,
      },
    });
    await prisma.stockLevel.updateMany({
      where: { companyId: fixture.companyId, productId: fixture.productId },
      data: { qtyOnHand: 7 },
    });

    const depositMovementId = id();
    const [depositEntry] = await JournalService.createEntriesAtomic(
      fixture.companyId,
      fixture.cashierId,
      [{
        date: day,
        description: 'Cash bank deposit in transit',
        sourceType: 'pos_bank_deposit',
        sourceId: depositMovementId,
        sourceReference: `STAGE-H-SLIP-${fixture.companyId}`,
        lines: [
          JournalService.createDebitLine('1120', 100, 'Cash in transit'),
          JournalService.createCreditLine('1000', 100, 'Cash deposited'),
        ],
        isAutoGenerated: true,
        skipBankTransactions: true,
      }],
      { allowDuplicate: false },
    );
    journalIds.deposit = String(depositEntry._id || depositEntry.id);
    await prisma.posCashMovement.createMany({
      data: [
        {
          id: id(),
          companyId: fixture.companyId,
          shiftId: fixture.shiftId,
          registerId: fixture.registerId,
          type: 'cash_in',
          amount: 150,
          reasonCode: 'OTHER',
          reference: 'Gift-card issue',
          performedById: fixture.cashierId,
          journalEntryId: journalIds.giftCardIssue,
          postingStatus: 'posted',
          idempotencyKey: `stage-h-gift-cash-${fixture.companyId}`,
          createdAt: day,
        },
        {
          id: id(),
          companyId: fixture.companyId,
          shiftId: fixture.shiftId,
          registerId: fixture.registerId,
          type: 'REFUND',
          amount: 118,
          reasonCode: 'POS_PAYMENT_REMOVAL',
          reference: `STAGE-H-CN-${fixture.companyId}`,
          performedById: fixture.cashierId,
          journalEntryId: journalIds.creditRevenue,
          postingStatus: 'posted',
          idempotencyKey: `stage-h-refund-cash-${fixture.companyId}`,
          createdAt: day,
        },
        {
          id: depositMovementId,
          companyId: fixture.companyId,
          shiftId: fixture.shiftId,
          registerId: fixture.registerId,
          type: 'cash_out',
          amount: 100,
          reasonCode: 'BANK_DEPOSIT',
          reference: `STAGE-H-SLIP-${fixture.companyId}`,
          bankSlipReference: `STAGE-H-SLIP-${fixture.companyId}`,
          performedById: fixture.cashierId,
          journalEntryId: journalIds.deposit,
          postingStatus: 'posted',
          idempotencyKey: `stage-h-deposit-${fixture.companyId}`,
          createdAt: day,
        },
      ],
    });
    const shortageEntryId = id();
    const [shortageEntry] = await JournalService.createEntriesAtomic(
      fixture.companyId,
      fixture.cashierId,
      [{
        date: day,
        description: 'POS shift cash shortage',
        sourceType: 'pos_shift_close',
        sourceId: fixture.shiftId,
        sourceReference: `Z-STAGE-H-${fixture.companyId}`,
        lines: [
          JournalService.createDebitLine('6100', 25, 'Cash shortage expense'),
          JournalService.createCreditLine('1000', 25, 'Cash shortage'),
        ],
        isAutoGenerated: true,
        skipBankTransactions: true,
      }],
      { allowDuplicate: false },
    );
    journalIds.shortage = String(shortageEntry._id || shortageEntry.id);
    await prisma.posShift.update({
      where: { id: fixture.shiftId },
      data: {
        status: 'closed',
        closedById: fixture.cashierId,
        closedAt: day,
        expectedCash: 182,
        countedCash: 157,
        difference: -25,
        differenceReason: 'Stage H deliberate cash shortage',
        postingStatus: 'posted',
        journalEntryId: journalIds.shortage,
      },
    });

    return { fixture, day, journalIds, cleanup };
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      error.cleanupError = cleanupError;
    }
    throw error;
  }
}

describe('Stage H full-day accounting report qualification (PostgreSQL)', () => {
  const integrationTest = testDatabaseUrl ? test : test.skip;

  afterAll(async () => {
    if (disconnectPrisma) await disconnectPrisma();
  });

  integrationTest('reconciles all hospitality-till events and balances the daily trial balance', async () => {
    const { fixture, day, journalIds, cleanup } = await createFixture();
    try {
      const reconciliationResponse = response();
      await reportController.getReport({
        user: { companyId: fixture.companyId },
        query: { report: 'reconciliation', from: '2026-11-06', to: '2026-11-06', tillType: 'hospitality' },
      }, reconciliationResponse, (error) => { throw error; });
      expect(reconciliationResponse.statusCode).toBe(200);
      expect(reconciliationResponse.body.data.totals).toMatchObject({
        saleCount: 1,
        posSalesTotal: 1062,
        ledgerSalesTotal: 1062,
        difference: 0,
        isZeroDifference: true,
        bankDepositClearingBalance: 100,
      });
      expect(reconciliationResponse.body.data.rows).toEqual([
        expect.objectContaining({
          registerId: fixture.registerId,
          tillType: 'hospitality',
          posSalesTotal: 1062,
          ledgerSalesTotal: 1062,
          difference: 0,
          isZeroDifference: true,
          bankDepositClearingBalance: 100,
        }),
      ]);
      expect(reconciliationResponse.body.data.giftCardLiability).toMatchObject({
        storedValueBalance: 50,
        ledgerLiabilityBalance: 50,
        difference: 0,
        isZeroDifference: true,
      });

      const paymentResponse = response();
      await reportController.getReport({
        user: { companyId: fixture.companyId },
        query: { report: 'payments-by-method', from: '2026-11-06', to: '2026-11-06', tillType: 'hospitality' },
      }, paymentResponse, (error) => { throw error; });
      expect(paymentResponse.body.data).toMatchObject({ totalPayments: 11, totalAmount: 1180 });

      const liabilityResponse = response();
      await reportController.getReport({
        user: { companyId: fixture.companyId },
        query: { report: 'gift-card-liability', from: '2026-11-06', to: '2026-11-06' },
      }, liabilityResponse, (error) => { throw error; });
      expect(liabilityResponse.body.data).toMatchObject({
        storedValueBalance: 50,
        ledgerLiabilityBalance: 50,
        difference: 0,
        isZeroDifference: true,
      });

      const cashResponse = response();
      await reportController.getReport({
        user: { companyId: fixture.companyId },
        query: { report: 'cash-over-short', from: '2026-11-06', to: '2026-11-06', tillType: 'hospitality' },
      }, cashResponse, (error) => { throw error; });
      expect(cashResponse.body.data.shifts).toEqual([
        expect.objectContaining({
          expectedCash: 182,
          countedCash: 157,
          difference: -25,
          postingStatus: 'posted',
          journalEntryId: journalIds.shortage,
        }),
      ]);

      const writeOffResponse = response();
      await reportController.getReport({
        user: { companyId: fixture.companyId },
        query: { report: 'write-off-losses', from: '2026-11-06', to: '2026-11-06', tillType: 'hospitality' },
      }, writeOffResponse, (error) => { throw error; });
      expect(writeOffResponse.body.data).toHaveLength(1);
      const [writeOff] = writeOffResponse.body.data;
      expect(writeOff).toMatchObject({
        creditNoteId: fixture.creditNoteId,
        journalEntryId: journalIds.creditWriteOff,
        journalStatus: 'posted',
      });
      expect(Number(writeOff.lossDebit)).toBe(20);
      expect(Number(writeOff.lossCredit)).toBe(20);

      const trialBalance = await trialBalanceService.generate(fixture.companyId, {
        dateFrom: day,
        dateTo: day,
      });
      expect(trialBalance.is_balanced).toBe(true);
      expect(trialBalance.difference).toBe(0);
      expect(trialBalance.total_dr).toBe(trialBalance.total_cr);

      const refundCount = await prisma.posPaymentRefund.count({
        where: { companyId: fixture.companyId, idempotencyKey: `stage-h-refund-${fixture.companyId}` },
      });
      const depositCount = await prisma.posCashMovement.count({
        where: { companyId: fixture.companyId, idempotencyKey: `stage-h-deposit-${fixture.companyId}` },
      });
      expect(refundCount).toBe(1);
      expect(depositCount).toBe(1);

      const isolatedResponse = response();
      await reportController.getReport({
        user: { companyId: fixture.otherCompanyId },
        query: { report: 'reconciliation', from: '2026-11-06', to: '2026-11-06' },
      }, isolatedResponse, (error) => { throw error; });
      expect(isolatedResponse.statusCode).toBe(200);
      expect(isolatedResponse.body.data.rows).toEqual([]);
      expect(isolatedResponse.body.data.totals).toMatchObject({
        posSalesTotal: 0,
        ledgerSalesTotal: 0,
        difference: 0,
        isZeroDifference: true,
      });
    } finally {
      await cleanup();
      expect(await prisma.company.count({ where: { id: fixture.companyId } })).toBe(0);
      expect(await prisma.company.count({ where: { id: fixture.otherCompanyId } })).toBe(0);
    }
  });
});
