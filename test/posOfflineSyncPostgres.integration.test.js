'use strict';

const { generateKeyPairSync, randomBytes } = require('crypto');

jest.mock('../controllers/salesLegacyController', () => ({
  createDirectSale: jest.fn(),
}));
jest.mock('../controllers/posPaymentsV2Controller', () => ({}));

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
let contract;
let saleController;

if (testDatabaseUrl) {
  process.env.DATABASE_URL = testDatabaseUrl;
  ({ prisma, disconnectPrisma } = require('../lib/prisma'));
  controller = require('../controllers/posOfflineSyncController');
  contract = require('../services/posSyncOperationContract');
  saleController = require('../controllers/salesLegacyController').createDirectSale;
}

const deviceToken = 'registered-postgres-test-device-token';
const signingKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const devicePublicKey = signingKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

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

function operation(fixture, sequence, operationId, displayTotal = 1200) {
  const unsigned = {
    operationId,
    deviceId: fixture.deviceId,
    registerId: fixture.registerId,
    companyId: fixture.companyId,
    sequence,
    type: 'SALE_COMPLETE',
    payload: { displayTotal, items: [{ productId: 'product-1', quantity: 1 }] },
    deviceTime: new Date().toISOString(),
    schemaVersion: 2,
    paymentFlow: 'LEGACY',
    appVersion: '0.0.1',
    snapshotVersion: null,
    signature: null,
  };
  return { ...unsigned, signature: contract.signOperationEnvelope(unsigned, signingKeys.privateKey) };
}

function request(fixture, operations) {
  const headers = { 'x-device-token': deviceToken };
  return {
    headers,
    body: { operations },
    user: { id: fixture.userId },
    posAuthContext: {
      company: { id: fixture.companyId },
      register: { id: fixture.registerId, claimedDeviceId: fixture.deviceId },
      posDevice: {
        id: objectId(),
        companyId: fixture.companyId,
        deviceId: fixture.deviceId,
        publicKey: devicePublicKey,
        status: 'active',
      },
    },
    posDevice: {
      id: objectId(),
      companyId: fixture.companyId,
      deviceId: fixture.deviceId,
      publicKey: devicePublicKey,
      status: 'active',
    },
    get(name) {
      return headers[String(name).toLowerCase()];
    },
  };
}

async function cleanup(companyId) {
  await prisma.$executeRawUnsafe('DELETE FROM pos_sync_exceptions WHERE company_id = $1', companyId);
  await prisma.$executeRawUnsafe('DELETE FROM pos_processed_operations WHERE company_id = $1', companyId);
}

describe('POS offline sync PostgreSQL integration', () => {
  const integrationTest = testDatabaseUrl ? test : test.skip;

  beforeEach(() => {
    saleController.mockReset();
  });

  integrationTest('replays a lost acknowledgment without processing the sale twice', async () => {
    const fixture = {
      companyId: objectId(),
      deviceId: `device-${objectId()}`,
      registerId: objectId(),
      userId: objectId(),
    };
    const signedOperation = operation(fixture, 1, `lost-ack-${objectId()}`);
    let releaseSale;
    let markSaleEntered;
    const saleGate = new Promise((resolve) => {
      releaseSale = resolve;
    });
    const saleEntered = new Promise((resolve) => {
      markSaleEntered = resolve;
    });
    saleController.mockImplementation(async (_req, res) => {
      markSaleEntered();
      await saleGate;
      return res.status(201).json({
        success: true,
        data: { _id: 'invoice-once', referenceNo: 'INV-ONCE' },
      });
    });
    const syncRequest = request(fixture, [signedOperation]);

    try {
      const firstAttempt = controller._private.processOperation(syncRequest, signedOperation, deviceToken);
      await saleEntered;

      const concurrentRetry = await controller._private.processOperation(syncRequest, signedOperation, deviceToken);
      expect(concurrentRetry).toMatchObject({
        operationId: signedOperation.operationId,
        status: 'processing',
      });

      releaseSale();
      await expect(firstAttempt).resolves.toMatchObject({
        status: 'synced',
        result: { _id: 'invoice-once', referenceNo: 'INV-ONCE' },
      });
      await expect(controller._private.processOperation(syncRequest, signedOperation, deviceToken))
        .resolves.toMatchObject({
          status: 'synced',
          replayed: true,
          result: { _id: 'invoice-once', referenceNo: 'INV-ONCE' },
        });

      const rows = await prisma.$queryRawUnsafe(
        'SELECT operation_state AS state, result FROM pos_processed_operations WHERE company_id = $1 AND device_id = $2 AND operation_id = $3',
        fixture.companyId,
        fixture.deviceId,
        signedOperation.operationId,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].state).toBe('synced');
      expect(rows[0].result).toMatchObject({ referenceNo: 'INV-ONCE' });
      expect(saleController).toHaveBeenCalledTimes(1);
    } finally {
      releaseSale();
      await cleanup(fixture.companyId);
    }
  });

  integrationTest('persists independent outcomes when a batch contains a terminal failure', async () => {
    const fixture = {
      companyId: objectId(),
      deviceId: `device-${objectId()}`,
      registerId: objectId(),
      userId: objectId(),
    };
    const failed = operation(fixture, 1, `invalid-sale-${objectId()}`, 999);
    const succeeded = operation(fixture, 2, `valid-sale-${objectId()}`, 1200);
    saleController.mockImplementation(async (req, res) => {
      if (req.body.displayTotal === 999) {
        return res.status(422).json({
          success: false,
          code: 'POS_TEST_TERMINAL_FAILURE',
          message: 'A test operation failed validation.',
        });
      }
      return res.status(201).json({
        success: true,
        data: { _id: 'independent-invoice', referenceNo: 'INV-INDEPENDENT' },
      });
    });
    const res = response();

    try {
      await controller.push(request(fixture, [failed, succeeded]), res, (error) => {
        if (error) throw error;
      });

      expect(res.statusCode).toBe(200);
      expect(res.body.data.results).toMatchObject([
        {
          operationId: failed.operationId,
          status: 'needs_review',
          error: { code: 'POS_TEST_TERMINAL_FAILURE' },
        },
        {
          operationId: succeeded.operationId,
          status: 'synced',
          result: { _id: 'independent-invoice', referenceNo: 'INV-INDEPENDENT' },
        },
      ]);
      const rows = await prisma.$queryRawUnsafe(
        'SELECT operation_id AS "operationId", operation_state AS state FROM pos_processed_operations WHERE company_id = $1 AND device_id = $2 ORDER BY sequence',
        fixture.companyId,
        fixture.deviceId,
      );
      const exceptions = await prisma.$queryRawUnsafe(
        'SELECT operation_id AS "operationId", error_code AS code FROM pos_sync_exceptions WHERE company_id = $1 AND device_id = $2',
        fixture.companyId,
        fixture.deviceId,
      );
      expect(rows).toEqual([
        { operationId: failed.operationId, state: 'needs_review' },
        { operationId: succeeded.operationId, state: 'synced' },
      ]);
      expect(exceptions).toEqual([{ operationId: failed.operationId, code: 'POS_TEST_TERMINAL_FAILURE' }]);
      expect(saleController).toHaveBeenCalledTimes(2);
    } finally {
      await cleanup(fixture.companyId);
    }
  });

  afterAll(async () => {
    if (disconnectPrisma) await disconnectPrisma();
  });
});
