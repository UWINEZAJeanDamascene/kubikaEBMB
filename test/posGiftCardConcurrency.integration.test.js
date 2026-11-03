'use strict';

const { randomBytes } = require('crypto');
const { hashStoredValueCode } = require('../services/posStoredValueCodeService');

jest.mock('../controllers/salesLegacyController', () => ({
  createDirectSale: jest.fn(),
}));

jest.mock('../config/redis', () => ({
  redisClient: {},
  isRedisConfigured: () => false,
  isRedisRequired: () => false,
  createQueueConnection: () => null,
}));

jest.mock('../services/posPaymentService', () => {
  const actual = jest.requireActual('../services/posPaymentService');
  return {
    ...actual,
    getPaymentSettings: jest.fn().mockResolvedValue({ paymentFlow: 'PAYMENTS_V2' }),
    resolvePaymentFlow: jest.fn(() => 'PAYMENTS_V2'),
    assertPaymentMethodEnabled: jest.fn().mockResolvedValue(undefined),
  };
});

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
let createDirectSale;
let closeShift;

if (testDatabaseUrl) {
  process.env.DATABASE_URL = testDatabaseUrl;
  ({ prisma, disconnectPrisma } = require('../lib/prisma'));
  controller = require('../controllers/posPaymentsV2Controller');
  ({ createDirectSale } = require('../controllers/salesLegacyController'));
  ({ close: closeShift } = require('../controllers/posShiftCloseController'));
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

function paymentRequest({ companyId, registerId, cashierId, saleId, key, code, amount = 80 }) {
  const headers = { 'idempotency-key': key };
  return {
    params: { saleId },
    body: { payments: [{ method: 'GIFT_CARD', amount, giftCardCode: code }] },
    headers,
    get(name) {
      return headers[String(name).toLowerCase()];
    },
    posAuthContext: {
      company: { id: companyId },
      register: { id: registerId, code: 'CONCURRENCY-TEST', claimedDeviceId: 'test-device' },
      user: { id: cashierId, name: 'Concurrency test cashier' },
      session: { id: objectId() },
    },
    posPermissions: ['pos.payment.take', 'pos.giftcard.redeem'],
  };
}

async function submitPayment(req) {
  const res = response();
  await controller.recordCashPayment(req, res, (error) => {
    if (error) throw error;
  });
  return res;
}

function posRequestContext(fixture, index = 0) {
  return {
    company: { id: fixture.companyId },
    register: {
      id: fixture.registerIds[index],
      code: `POS-GC-TEST-${fixture.companyId}-${index + 1}`,
      claimedDeviceId: 'test-device',
    },
    user: { id: fixture.cashierIds[index], name: 'POS regression cashier' },
    session: {
      id: objectId(),
      companyId: fixture.companyId,
      registerId: fixture.registerIds[index],
      userId: fixture.cashierIds[index],
    },
  };
}

function controllerRequest(fixture, index, saleId, key, body = {}) {
  const headers = { 'idempotency-key': key };
  return {
    params: { saleId },
    body,
    headers,
    get(name) {
      return headers[String(name).toLowerCase()];
    },
    posAuthContext: posRequestContext(fixture, index),
    posPermissions: ['pos.payment.take', 'pos.giftcard.redeem'],
  };
}

function cancelRequest(fixture, key, index = 0) {
  return controllerRequest(fixture, index, fixture.saleIds[index], key, {
    reasonCode: 'CUSTOMER_REQUEST',
    note: 'Gift card cancellation regression.',
    confirmRefund: true,
  });
}

async function assertLedgerMatchesBalance(companyId, accountId) {
  const [account, ledger] = await Promise.all([
    prisma.posStoredValueAccount.findFirst({ where: { id: accountId, companyId } }),
    prisma.posStoredValueLedger.findMany({ where: { companyId, accountId } }),
  ]);
  const ledgerBalance = ledger.reduce((sum, entry) => {
    const amount = Number(entry.amount);
    if (entry.operationType === 'REDEEM') return sum - amount;
    if (['ISSUE', 'LOAD', 'REFUND'].includes(entry.operationType)) return sum + amount;
    throw new Error(`Unexpected operation ${entry.operationType} in gift-card balance assertion.`);
  }, 0);
  expect(Number(account.balance)).toBe(ledgerBalance);
  return { account, ledger };
}

async function createFixture({ userCount = 2, saleAmount = 80, balance = 100 } = {}) {
  const companyId = objectId();
  const cashierIds = Array.from({ length: userCount }, () => objectId());
  const clientId = objectId();
  const registerIds = Array.from({ length: userCount }, () => objectId());
  const shiftIds = Array.from({ length: userCount }, () => objectId());
  const saleIds = Array.from({ length: userCount }, () => objectId());
  const accountId = objectId();
  const rawCode = `KB-${randomBytes(12).toString('hex').toUpperCase()}`;
  let createdCompany = false;
  let triggerName;
  let functionName;

  const cleanup = async () => {
    const cleanupSteps = [];
    if (triggerName) {
      cleanupSteps.push(() => prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS "${triggerName}" ON pos_stored_value_ledger`,
      ));
    }
    if (functionName) {
      cleanupSteps.push(() => prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`));
    }
    if (createdCompany) {
      cleanupSteps.push(
        () => prisma.posAuditLog.deleteMany({ where: { companyId } }),
        () => prisma.posPaymentRefund.deleteMany({ where: { companyId } }),
        () => prisma.posStoredValueLedger.deleteMany({ where: { companyId } }),
        () => prisma.posPayment.deleteMany({ where: { companyId } }),
        () => prisma.invoice.deleteMany({ where: { companyId } }),
        () => prisma.posStoredValueAccount.deleteMany({ where: { companyId } }),
        () => prisma.posShift.deleteMany({ where: { companyId } }),
        () => prisma.posRegister.deleteMany({ where: { companyId } }),
        () => prisma.client.deleteMany({ where: { companyId } }),
        () => prisma.user.deleteMany({ where: { companyId } }),
        () => prisma.company.deleteMany({ where: { id: companyId } }),
      );
    }
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
        id: companyId,
        name: 'POS Gift Card Regression Test',
        code: `POS-GC-${companyId}`,
      },
    });
    createdCompany = true;
    for (let index = 0; index < userCount; index += 1) {
      await prisma.user.create({
        data: {
          id: cashierIds[index],
          companyId,
          name: `POS regression cashier ${index + 1}`,
          email: `pos-gift-card-${companyId}-${index + 1}@example.invalid`,
          password: 'integration-test-only',
        },
      });
      await prisma.posRegister.create({
        data: {
          id: registerIds[index],
          companyId,
          code: `POS-GC-TEST-${companyId}-${index + 1}`,
          name: `POS gift card regression register ${index + 1}`,
        },
      });
      await prisma.posShift.create({
        data: {
          id: shiftIds[index],
          companyId,
          registerId: registerIds[index],
          shiftNumber: 1,
          openedById: cashierIds[index],
          openingFloat: 0,
        },
      });
    }
    await prisma.client.create({
      data: {
        id: clientId,
        companyId,
        name: 'POS gift card regression customer',
        code: `POS-GC-${companyId}`,
      },
    });
    for (let index = 0; index < userCount; index += 1) {
      await prisma.invoice.create({
        data: {
          id: saleIds[index],
          companyId,
          clientId,
          referenceNo: `POS-GC-${companyId}-${index + 1}`,
          status: 'PENDING_PAYMENT',
          posOrigin: true,
          shiftId: shiftIds[index],
          registerId: registerIds[index],
          cashierId: cashierIds[index],
          totalAmount: saleAmount,
          amountOutstanding: saleAmount,
          dueDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });
    }
    await prisma.posStoredValueAccount.create({
      data: {
        id: accountId,
        companyId,
        kind: 'gift_card',
        codeHash: hashStoredValueCode(rawCode),
        codeSuffix: rawCode.slice(-4),
        currencyCode: 'RWF',
        balance,
        createdById: cashierIds[0],
      },
    });
    await prisma.posStoredValueLedger.create({
      data: {
        id: objectId(),
        companyId,
        accountId,
        operationType: 'ISSUE',
        kind: 'gift_card',
        entryType: 'issue',
        amount: balance,
        balanceAfter: balance,
        reference: rawCode.slice(-4),
        idempotencyKey: `fixture-issue-${companyId}`,
        createdById: cashierIds[0],
      },
    });
  } catch (error) {
    await cleanup();
    throw error;
  }

  return {
    companyId,
    cashierIds,
    registerIds,
    shiftIds,
    saleIds,
    accountId,
    rawCode,
    requestFor(index, key, amount = saleAmount) {
      return paymentRequest({
        companyId,
        registerId: registerIds[index],
        cashierId: cashierIds[index],
        saleId: saleIds[index],
        key,
        code: rawCode,
        amount,
      });
    },
    async installLedgerFailureTrigger() {
      functionName = `pos_gc_fail_${companyId}`;
      triggerName = `pos_gc_fail_${companyId}`;
      await prisma.$executeRawUnsafe(
        `CREATE FUNCTION "${functionName}"() RETURNS trigger AS $body$ BEGIN IF NEW.company_id = '${companyId}' THEN RAISE EXCEPTION 'test gift card ledger failure'; END IF; RETURN NEW; END; $body$ LANGUAGE plpgsql`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER "${triggerName}" BEFORE INSERT ON pos_stored_value_ledger FOR EACH ROW EXECUTE FUNCTION "${functionName}"()`,
      );
    },
    cleanup,
  };
}

describe('POS gift-card redemption concurrency (PostgreSQL integration)', () => {
  const integrationTest = testDatabaseUrl ? test : test.skip;
  integrationTest('only one concurrent redemption can spend the final available balance', async () => {
    const fixture = await createFixture();
    try {
      const results = await Promise.all([
        submitPayment(fixture.requestFor(0, `gift-card-concurrency-${fixture.companyId}-1`)),
        submitPayment(fixture.requestFor(1, `gift-card-concurrency-${fixture.companyId}-2`)),
      ]);

      expect(results.map((result) => result.statusCode).sort()).toEqual([201, 409]);
      expect(results.filter((result) => result.body.code === 'POS_GIFT_CARD_INSUFFICIENT')).toHaveLength(1);

      const [account, payments, ledger] = await Promise.all([
        prisma.posStoredValueAccount.findUnique({ where: { id: fixture.accountId } }),
        prisma.posPayment.findMany({ where: { companyId: fixture.companyId } }),
        prisma.posStoredValueLedger.findMany({
          where: { companyId: fixture.companyId, accountId: fixture.accountId, operationType: 'REDEEM' },
        }),
      ]);
      expect(Number(account.balance)).toBe(20);
      expect(payments).toHaveLength(1);
      expect(payments[0].amount).toBe(80);
      expect(ledger).toHaveLength(1);
      expect(Number(ledger[0].balanceAfter)).toBe(20);
      await assertLedgerMatchesBalance(fixture.companyId, fixture.accountId);
    } finally {
      await fixture.cleanup();
    }
  });

  integrationTest('ten concurrent redemptions never overspend and the ledger equals the final balance', async () => {
    const fixture = await createFixture({ userCount: 10, saleAmount: 10, balance: 100 });
    try {
      const results = await Promise.all(fixture.saleIds.map((_, index) => submitPayment(
        fixture.requestFor(index, `gift-card-tenway-${fixture.companyId}-${index}`, 10),
      )));
      expect(results.every((result) => result.statusCode === 201)).toBe(true);

      const [account, payments, ledger] = await Promise.all([
        prisma.posStoredValueAccount.findUnique({ where: { id: fixture.accountId } }),
        prisma.posPayment.findMany({ where: { companyId: fixture.companyId } }),
        prisma.posStoredValueLedger.findMany({ where: { companyId: fixture.companyId, accountId: fixture.accountId } }),
      ]);
      const ledgerBalance = ledger.reduce((sum, entry) => (
        sum + (entry.operationType === 'REDEEM' ? -Number(entry.amount) : Number(entry.amount))
      ), 0);
      expect(payments).toHaveLength(10);
      expect(ledger.filter((entry) => entry.operationType === 'REDEEM')).toHaveLength(10);
      expect(Number(account.balance)).toBe(0);
      expect(ledgerBalance).toBe(Number(account.balance));
      await assertLedgerMatchesBalance(fixture.companyId, fixture.accountId);
    } finally {
      await fixture.cleanup();
    }
  });

  integrationTest('replaying the same redemption key returns the original payment without a second debit', async () => {
    const fixture = await createFixture({ userCount: 1 });
    try {
      const req = fixture.requestFor(0, `gift-card-retry-${fixture.companyId}`);
      const first = await submitPayment(req);
      const retry = await submitPayment(req);
      const [account, payments, ledger] = await Promise.all([
        prisma.posStoredValueAccount.findUnique({ where: { id: fixture.accountId } }),
        prisma.posPayment.findMany({ where: { companyId: fixture.companyId } }),
        prisma.posStoredValueLedger.findMany({
          where: { companyId: fixture.companyId, accountId: fixture.accountId, operationType: 'REDEEM' },
        }),
      ]);

      expect(first.statusCode).toBe(201);
      expect(retry.statusCode).toBe(200);
      expect(retry.body.replayed).toBe(true);
      expect(retry.body.data.payment.id).toBe(first.body.data.payment.id);
      expect(payments).toHaveLength(1);
      expect(ledger).toHaveLength(1);
      expect(Number(account.balance)).toBe(20);
      await assertLedgerMatchesBalance(fixture.companyId, fixture.accountId);
    } finally {
      await fixture.cleanup();
    }
  });

  integrationTest('a redemption racing its refund keeps the balance equal to its ledger', async () => {
    const fixture = await createFixture({ userCount: 2 });
    try {
      const initial = await submitPayment(fixture.requestFor(0, `gift-card-refund-race-${fixture.companyId}-1`));
      expect(initial.statusCode).toBe(201);
      const paymentId = initial.body.data.payment.id;
      const removeReq = fixture.requestFor(0, `gift-card-refund-race-${fixture.companyId}-remove`);
      removeReq.params.paymentId = paymentId;
      removeReq.body = { reasonCode: 'WRONG_SALE', note: 'Concurrent refund regression.' };
      const refundResponse = response();
      const redeemRequest = fixture.requestFor(1, `gift-card-refund-race-${fixture.companyId}-2`);

      const [, redemption] = await Promise.all([
        controller.removePayment(removeReq, refundResponse, (error) => {
          if (error) throw error;
        }),
        submitPayment(redeemRequest),
      ]);
      expect(refundResponse.statusCode).toBe(201);
      expect([201, 409]).toContain(redemption.statusCode);

      const [account, ledger] = await Promise.all([
        prisma.posStoredValueAccount.findUnique({ where: { id: fixture.accountId } }),
        prisma.posStoredValueLedger.findMany({ where: { companyId: fixture.companyId, accountId: fixture.accountId } }),
      ]);
      const ledgerBalance = ledger.reduce((sum, entry) => (
        sum + (entry.operationType === 'REDEEM' ? -Number(entry.amount) : Number(entry.amount))
      ), 0);
      expect(Number(account.balance)).toBeGreaterThanOrEqual(0);
      expect(ledgerBalance).toBe(Number(account.balance));
      await assertLedgerMatchesBalance(fixture.companyId, fixture.accountId);
    } finally {
      await fixture.cleanup();
    }
  });

  integrationTest('a failed gift-card payment transaction rolls back its payment and balance changes', async () => {
    const fixture = await createFixture({ userCount: 1 });
    try {
      await fixture.installLedgerFailureTrigger();
      await expect(submitPayment(
        fixture.requestFor(0, `gift-card-rollback-${fixture.companyId}`),
      )).rejects.toThrow('test gift card ledger failure');

      const [account, payments, ledger] = await Promise.all([
        prisma.posStoredValueAccount.findUnique({ where: { id: fixture.accountId } }),
        prisma.posPayment.findMany({ where: { companyId: fixture.companyId } }),
        prisma.posStoredValueLedger.findMany({
          where: { companyId: fixture.companyId, accountId: fixture.accountId, operationType: 'REDEEM' },
        }),
      ]);
      expect(Number(account.balance)).toBe(100);
      expect(payments).toHaveLength(0);
      expect(ledger).toHaveLength(0);
      await assertLedgerMatchesBalance(fixture.companyId, fixture.accountId);
    } finally {
      await fixture.cleanup();
    }
  });

  integrationTest('gift-card codes are isolated to the issuing company', async () => {
    const fixture = await createFixture({ userCount: 1 });
    const foreign = await createFixture({ userCount: 1 });
    try {
      const req = fixture.requestFor(0, `gift-card-tenant-${fixture.companyId}`);
      req.body.payments[0].giftCardCode = foreign.rawCode;
      const result = await submitPayment(req);
      const [account, payments, ledger] = await Promise.all([
        prisma.posStoredValueAccount.findUnique({ where: { id: fixture.accountId } }),
        prisma.posPayment.findMany({ where: { companyId: fixture.companyId } }),
        prisma.posStoredValueLedger.findMany({
          where: { companyId: fixture.companyId, accountId: fixture.accountId, operationType: 'REDEEM' },
        }),
      ]);

      expect(result.statusCode).toBe(409);
      expect(result.body.code).toBe('POS_GIFT_CARD_UNAVAILABLE');
      expect(Number(account.balance)).toBe(100);
      expect(payments).toHaveLength(0);
      expect(ledger).toHaveLength(0);
      await assertLedgerMatchesBalance(fixture.companyId, fixture.accountId);
      await assertLedgerMatchesBalance(foreign.companyId, foreign.accountId);
    } finally {
      try {
        await foreign.cleanup();
      } finally {
        await fixture.cleanup();
      }
    }
  });

  integrationTest('cancelling a gift-card sale concurrently and replaying it writes one refund', async () => {
    const fixture = await createFixture({ userCount: 1 });
    try {
      const paymentResponse = await submitPayment(
        fixture.requestFor(0, `gift-card-cancel-payment-${fixture.companyId}`),
      );
      expect(paymentResponse.statusCode).toBe(201);
      const key = `gift-card-cancel-${fixture.companyId}`;
      const responses = [response(), response()];
      await Promise.all(responses.map((res) => controller.refundAndCancel(
        cancelRequest(fixture, key),
        res,
        (error) => { if (error) throw error; },
      )));
      const replay = response();
      await controller.refundAndCancel(
        cancelRequest(fixture, key),
        replay,
        (error) => { if (error) throw error; },
      );

      expect(responses.map((res) => res.statusCode).sort()).toEqual([200, 201]);
      expect(responses.filter((res) => res.body.replayed === false)).toHaveLength(1);
      expect(replay.statusCode).toBe(200);
      expect(replay.body.replayed).toBe(true);
      const { ledger } = await assertLedgerMatchesBalance(fixture.companyId, fixture.accountId);
      expect(ledger.filter((entry) => entry.operationType === 'REFUND')).toHaveLength(1);
      expect(ledger.filter((entry) => entry.operationType === 'REFUND')[0]).toMatchObject({
        accountId: fixture.accountId,
        posPaymentId: paymentResponse.body.data.payment.id,
        invoiceId: fixture.saleIds[0],
        kind: 'gift_card',
      });
      expect(Number(ledger.find((entry) => entry.operationType === 'REFUND').amount)).toBe(80);
      expect(await prisma.posPaymentRefund.count({
        where: {
          companyId: fixture.companyId,
          paymentId: paymentResponse.body.data.payment.id,
          method: 'GIFT_CARD',
          status: 'DONE',
        },
      })).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });

  integrationTest.each([
    ['missing redemption ledger', 'missing'],
    ['reversed redemption ledger', 'reversed'],
    ['redemption linked to a different card', 'different-card'],
    ['redemption recorded only under another company', 'different-company'],
  ])('completeSale rejects a %s', async (_label, corruption) => {
    const fixture = await createFixture({ userCount: 1 });
    let foreignFixture;
    try {
      const paymentResponse = await submitPayment(
        fixture.requestFor(0, `gift-card-invalid-${corruption}-${fixture.companyId}`),
      );
      expect(paymentResponse.statusCode).toBe(201);
      const paymentId = paymentResponse.body.data.payment.id;
      const redemption = await prisma.posStoredValueLedger.findFirst({
        where: {
          companyId: fixture.companyId,
          accountId: fixture.accountId,
          posPaymentId: paymentId,
          operationType: 'REDEEM',
        },
      });
      expect(redemption).toBeTruthy();

      if (corruption === 'missing') {
        await prisma.posStoredValueLedger.delete({ where: { id: redemption.id } });
        await prisma.posStoredValueAccount.update({
          where: { id: fixture.accountId },
          data: { balance: 100 },
        });
      } else if (corruption === 'reversed') {
        await prisma.posStoredValueAccount.update({
          where: { id: fixture.accountId },
          data: { balance: 100 },
        });
        await prisma.posStoredValueLedger.create({
          data: {
            id: objectId(),
            companyId: fixture.companyId,
            accountId: fixture.accountId,
            posPaymentId: paymentId,
            invoiceId: fixture.saleIds[0],
            idempotencyKey: `reversal-${fixture.companyId}`,
            operationType: 'REFUND',
            kind: 'gift_card',
            entryType: 'refund',
            amount: 80,
            balanceAfter: 100,
            reference: fixture.rawCode.slice(-4),
            notes: 'Reversal integrity test.',
            createdById: fixture.cashierIds[0],
          },
        });
      } else if (corruption === 'different-card') {
        const secondCode = `KB-${randomBytes(12).toString('hex').toUpperCase()}`;
        const secondAccountId = objectId();
        await prisma.posStoredValueAccount.create({
          data: {
            id: secondAccountId,
            companyId: fixture.companyId,
            kind: 'gift_card',
            codeHash: hashStoredValueCode(secondCode),
            codeSuffix: secondCode.slice(-4),
            currencyCode: 'RWF',
            balance: 100,
            createdById: fixture.cashierIds[0],
          },
        });
        await prisma.posStoredValueLedger.create({
          data: {
            id: objectId(),
            companyId: fixture.companyId,
            accountId: secondAccountId,
            operationType: 'ISSUE',
            kind: 'gift_card',
            entryType: 'issue',
            amount: 100,
            balanceAfter: 100,
            reference: secondCode.slice(-4),
            idempotencyKey: `second-issue-${fixture.companyId}`,
            createdById: fixture.cashierIds[0],
          },
        });
        await prisma.posStoredValueAccount.update({
          where: { id: fixture.accountId },
          data: { balance: 100 },
        });
        await prisma.posStoredValueAccount.update({
          where: { id: secondAccountId },
          data: { balance: 20 },
        });
        await prisma.posStoredValueLedger.update({
          where: { id: redemption.id },
          data: {
            accountId: secondAccountId,
            reference: secondCode.slice(-4),
            balanceAfter: 20,
          },
        });
      } else {
        foreignFixture = await createFixture({ userCount: 1 });
        await prisma.posStoredValueAccount.update({
          where: { id: fixture.accountId },
          data: { balance: 100 },
        });
        await prisma.posStoredValueAccount.update({
          where: { id: foreignFixture.accountId },
          data: { balance: 20 },
        });
        await prisma.posStoredValueLedger.update({
          where: { id: redemption.id },
          data: {
            companyId: foreignFixture.companyId,
            accountId: foreignFixture.accountId,
            reference: foreignFixture.rawCode.slice(-4),
            balanceAfter: 20,
            idempotencyKey: `foreign-redemption-${foreignFixture.companyId}`,
          },
        });
      }

      const req = controllerRequest(
        fixture,
        0,
        fixture.saleIds[0],
        `gift-card-complete-invalid-${fixture.companyId}`,
      );
      const res = response();
      await controller.completeSale(req, res, (error) => { if (error) throw error; });

      expect(res.statusCode).toBe(409);
      expect(['POS_GIFT_CARD_REDEMPTION_MISSING', 'POS_GIFT_CARD_REDEMPTION_MISMATCH'])
        .toContain(res.body.code);
      expect(createDirectSale).not.toHaveBeenCalled();
      await assertLedgerMatchesBalance(fixture.companyId, fixture.accountId);
      if (corruption === 'different-card') {
        const secondAccount = await prisma.posStoredValueAccount.findFirst({
          where: { companyId: fixture.companyId, id: { not: fixture.accountId }, kind: 'gift_card' },
        });
        await assertLedgerMatchesBalance(fixture.companyId, secondAccount.id);
      }
      if (foreignFixture) {
        await assertLedgerMatchesBalance(foreignFixture.companyId, foreignFixture.accountId);
      }
    } finally {
      try {
        if (foreignFixture) await foreignFixture.cleanup();
      } finally {
        await fixture.cleanup();
      }
    }
  });

  integrationTest('a pending sale with a successful gift-card payment prevents shift close', async () => {
    const fixture = await createFixture({ userCount: 1 });
    try {
      const paymentResponse = await submitPayment(
        fixture.requestFor(0, `gift-card-shift-close-${fixture.companyId}`),
      );
      expect(paymentResponse.statusCode).toBe(201);
      const req = {
        params: { shiftId: fixture.shiftIds[0] },
        headers: { 'idempotency-key': `gift-card-shift-close-${fixture.companyId}` },
        body: { closingCount: { 5000: 0, 2000: 0, 1000: 0, 500: 0, 100: 0, 50: 0, other: 0 } },
        get(name) {
          return this.headers[String(name).toLowerCase()];
        },
        posAuthContext: { session: posRequestContext(fixture).session },
      };
      const res = response();
      await closeShift(req, res, (error) => { if (error) throw error; });

      expect(res.statusCode).toBe(409);
      expect(res.body.code).toBe('POS_SHIFT_PENDING_PAYMENTS');
      expect(res.body.pendingPaymentCount).toBe(1);
      await assertLedgerMatchesBalance(fixture.companyId, fixture.accountId);
    } finally {
      await fixture.cleanup();
    }
  });

  afterAll(async () => {
    if (disconnectPrisma) await disconnectPrisma();
    const redisClient = require('../config/redis').redisClient;
    if (typeof redisClient?.quit === 'function') {
      await redisClient.quit();
    } else if (typeof redisClient?.disconnect === 'function') {
      await redisClient.disconnect();
    }
  });
});
