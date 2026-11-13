'use strict';

const { generateKeyPairSync } = require('crypto');

jest.mock('../lib/prisma', () => ({
  dbClient: jest.fn(),
  prisma: {
    systemSettings: { findUnique: jest.fn() },
    user: { findFirst: jest.fn() },
    posRegisterAccess: { findFirst: jest.fn() },
  },
}));
jest.mock('../controllers/salesLegacyController', () => ({ createDirectSale: jest.fn() }));
jest.mock('../controllers/posCashMovementController', () => ({ create: jest.fn() }));
jest.mock('../controllers/posPaymentsV2Controller', () => ({
  createPendingSale: jest.fn(),
  recordCashPayment: jest.fn(),
  recordManualMobileMoneyPayment: jest.fn(),
  completeSale: jest.fn(),
}));
jest.mock('../services/posOfflineActionUsageService', () => ({
  reserveOfflineActionUsage: jest.fn().mockResolvedValue({ reserved: true }),
  reserveOfflineSaleUsage: jest.fn().mockResolvedValue({ reserved: true }),
  releaseOfflineActionUsage: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/posOfflineCapabilityService', () => ({
  verifyCapability: jest.fn(() => ({
    companyId: 'company-1',
    deviceId: 'device-1',
    registerId: 'POS-1',
    userId: 'pos-cashier-2',
    id: 'snapshot-1',
    issuedAt: Date.parse('2026-10-15T00:00:00.000Z'),
    expiresAt: Date.parse('2026-10-16T00:00:00.000Z'),
  })),
}));
jest.mock('../services/posOfflineReceiptNumberService', () => ({
  retireUnusedReceiptNumbersForSnapshots: jest.fn().mockResolvedValue(0),
}));
jest.mock('../services/posAuditService', () => ({
  requestIp: jest.fn(() => '127.0.0.1'),
  writePosAuditLog: jest.fn().mockResolvedValue({}),
}));
jest.mock('../middleware/posAuthMiddleware', () => ({
  hasPosPermission: jest.fn(),
}));

const { dbClient, prisma } = require('../lib/prisma');
const { createDirectSale } = require('../controllers/salesLegacyController');
const posCashMovementController = require('../controllers/posCashMovementController');
const posPaymentsV2Controller = require('../controllers/posPaymentsV2Controller');
const { reserveOfflineActionUsage, reserveOfflineSaleUsage } = require('../services/posOfflineActionUsageService');
const { retireUnusedReceiptNumbersForSnapshots } = require('../services/posOfflineReceiptNumberService');
const { writePosAuditLog } = require('../services/posAuditService');
const { hasPosPermission } = require('../middleware/posAuthMiddleware');
const { signOperationEnvelope } = require('../services/posSyncOperationContract');
const {
  _private,
  push,
  quarantineRevokedPush,
  acknowledgeDeviceWipe,
} = require('../controllers/posOfflineSyncController');

describe('POS offline sync operation processing', () => {
  const signingKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const devicePublicKey = signingKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  let storedOperation;
  const db = {
    $queryRawUnsafe: jest.fn(),
    $executeRawUnsafe: jest.fn(),
    $transaction: jest.fn(async (callback) => callback({})),
    posDevice: { update: jest.fn().mockResolvedValue({}) },
  };
  const request = {
    posAuthContext: {
      company: { id: 'company-1' },
      register: { id: 'register-1', code: 'POS-1', claimedDeviceId: 'device-1' },
      posDevice: { id: 'device-record-1', companyId: 'company-1', deviceId: 'device-1', publicKey: devicePublicKey, status: 'active' },
      session: { userId: 'pos-cashier-2' },
      user: { id: 'pos-cashier-2', name: 'POS cashier' },
    },
    posDevice: { id: 'device-record-1', companyId: 'company-1', deviceId: 'device-1', publicKey: devicePublicKey, status: 'active' },
    headers: {},
    user: { id: 'cashier-1' },
  };

  function operation(overrides = {}) {
    const unsigned = {
      operationId: 'offline-operation-0001',
      deviceId: 'device-1',
      registerId: 'POS-1',
      companyId: 'company-1',
      sequence: 1,
      type: 'SALE_COMPLETE',
      payload: { displayTotal: 1200, items: [{ productId: 'product-1', quantity: 1 }] },
      deviceTime: '2026-10-15T12:00:00.000Z',
      schemaVersion: 2,
      paymentFlow: 'LEGACY',
      appVersion: '0.0.1',
      snapshotVersion: null,
      signature: null,
      ...overrides,
    };
    return { ...unsigned, signature: signOperationEnvelope(unsigned, signingKeys.privateKey) };
  }

  beforeEach(() => {
    storedOperation = null;
    db.$queryRawUnsafe.mockReset().mockImplementation(async (sql, ...args) => {
      if (sql.startsWith('INSERT INTO pos_processed_operations')) {
        if (storedOperation) return [];
        return [{ id: 'processed-operation' }];
      }
      if (sql.startsWith('SELECT payload_hash')) {
        return storedOperation ? [storedOperation] : [];
      }
      if (sql.startsWith('UPDATE pos_processed_operations SET payload_hash')) {
        const errorCode = args[3];
        if (storedOperation
          && storedOperation.state === 'needs_review'
          && storedOperation.error?.code === errorCode
          && storedOperation.payloadHash === args[5]) {
          storedOperation = {
            ...storedOperation,
            payloadHash: args[6],
            state: 'processing',
            error: null,
            receivedAt: new Date(),
          };
          return [{ id: 'processed-operation' }];
        }
        return [];
      }
      if (sql.includes("SET operation_state = 'processing'")) {
        const [companyId, deviceId, operationId, expectedState, , payloadHash] = args;
        const expectedReceivedAt = args[6];
        if (storedOperation
          && storedOperation.state === expectedState
          && storedOperation.payloadHash === payloadHash
          && (!expectedReceivedAt
            || new Date(storedOperation.receivedAt).getTime() === new Date(expectedReceivedAt).getTime())
          && companyId === 'company-1'
          && deviceId === 'device-1'
          && operationId === 'offline-operation-0001') {
          storedOperation = {
            ...storedOperation,
            state: 'processing',
            receivedAt: new Date(),
          };
          return [{ id: 'processed-operation' }];
        }
        return [];
      }
      return [];
    });
    db.$executeRawUnsafe.mockReset().mockImplementation(async (sql, ...args) => {
      if (sql.startsWith('UPDATE pos_processed_operations')) {
        storedOperation = {
          payloadHash: _private.hashOperation(operation()),
          state: args[3],
          result: args[4] ? JSON.parse(args[4]) : null,
          error: args[5] ? JSON.parse(args[5]) : null,
          processedAt: new Date(),
        };
      }
      return 1;
    });
    db.posDevice.update.mockReset().mockResolvedValue({});
    prisma.systemSettings.findUnique.mockReset().mockResolvedValue({ posRolePermissions: {} });
    prisma.user.findFirst.mockReset().mockResolvedValue({
      id: 'manager-1',
      role: 'manager',
      roles: [],
    });
    prisma.posRegisterAccess.findFirst.mockReset().mockResolvedValue({ id: 'register-access-1' });
    hasPosPermission.mockReset().mockResolvedValue(true);
    posCashMovementController.create.mockReset();
    dbClient.mockReturnValue(db);
    reserveOfflineActionUsage.mockReset().mockResolvedValue({ reserved: true });
    retireUnusedReceiptNumbersForSnapshots.mockReset().mockResolvedValue(0);
    writePosAuditLog.mockReset().mockResolvedValue({});
    createDirectSale.mockReset().mockImplementation(async (_req, res) => (
      res.status(201).json({ success: true, data: { _id: 'invoice-1', referenceNo: 'INV-2026-00001' } })
    ));
    posPaymentsV2Controller.createPendingSale.mockReset();
    posPaymentsV2Controller.recordCashPayment.mockReset();
    posPaymentsV2Controller.recordManualMobileMoneyPayment.mockReset();
    posPaymentsV2Controller.completeSale.mockReset();
  });

  test('holds manager-approved offline actions for review without auto-posting', async () => {
    const signedOperation = operation({
      payload: {
        offlineSnapshotCapability: 'signed-snapshot',
        payments: [{ paymentMethod: 'card', amount: 1200 }],
        offlineApprovals: [{
          action: 'card',
          amount: 1200,
          managerUserId: 'manager-1',
          approvedAt: '2026-10-15T12:00:00.000Z',
        }],
      },
    });
    const result = await _private.processOperation(request, signedOperation);

    expect(result).toMatchObject({
      status: 'needs_review',
      error: { code: 'POS_OFFLINE_MANAGER_APPROVAL_REVIEW_REQUIRED' },
    });
    expect(reserveOfflineActionUsage).toHaveBeenCalledWith(expect.objectContaining({
      action: 'card',
      managerApproved: true,
      amount: 1200,
    }));
    expect(createDirectSale).not.toHaveBeenCalled();
    expect(posPaymentsV2Controller.createPendingSale).not.toHaveBeenCalled();
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'APPROVAL_GRANTED',
    }));
  });

  test('replays the original result after a lost acknowledgment without creating another sale', async () => {
    const signedOperation = operation();

    const first = await _private.processOperation(request, signedOperation);
    const retry = await _private.processOperation(request, signedOperation);

    expect(first).toMatchObject({
      operationId: signedOperation.operationId,
      status: 'synced',
      replayed: false,
      result: { _id: 'invoice-1', referenceNo: 'INV-2026-00001' },
    });
    expect(retry).toMatchObject({
      operationId: signedOperation.operationId,
      status: 'synced',
      replayed: true,
      result: { _id: 'invoice-1', referenceNo: 'INV-2026-00001' },
    });
    expect(createDirectSale).toHaveBeenCalledTimes(1);
  });

  test.each(['retry_wait', 'processing'])(
    'claims a stale %s operation once when duplicate retries arrive concurrently',
    async (state) => {
      const signedOperation = operation();
      storedOperation = {
        payloadHash: _private.hashOperation(signedOperation),
        state,
        receivedAt: new Date(Date.now() - 180_000),
      };
      let releaseSale;
      let markSaleEntered;
      const saleGate = new Promise((resolve) => {
        releaseSale = resolve;
      });
      const saleEntered = new Promise((resolve) => {
        markSaleEntered = resolve;
      });
      createDirectSale.mockImplementation(async (_req, res) => {
        markSaleEntered();
        await saleGate;
        return res.status(201).json({
          success: true,
          data: { _id: 'invoice-1', referenceNo: 'INV-2026-00001' },
        });
      });

      try {
        const firstAttempt = _private.processOperation(request, signedOperation);
        await saleEntered;
        const concurrentRetry = await _private.processOperation(request, signedOperation);

        expect(concurrentRetry).toMatchObject({
          operationId: signedOperation.operationId,
          status: 'processing',
        });
        releaseSale();
        await expect(firstAttempt).resolves.toMatchObject({ status: 'synced' });
        expect(createDirectSale).toHaveBeenCalledTimes(1);
      } finally {
        releaseSale();
      }
    },
  );

  test('uses the validated POS-session cashier identity for checkout', async () => {
    await _private.processOperation(request, operation());

    expect(createDirectSale.mock.calls[0][0].user).toMatchObject({
      id: 'pos-cashier-2',
      _id: 'pos-cashier-2',
      companyId: 'company-1',
      company: { id: 'company-1', _id: 'company-1' },
    });
    expect(createDirectSale.mock.calls[0][0].body.registerId).toBe('POS-1');
    expect(createDirectSale.mock.calls[0][0].get('Idempotency-Key')).toBe('offline-operation-0001');
  });

  test('matches the operation register code to the authenticated register code', async () => {
    const result = await _private.processOperation(
      request,
      operation({ registerId: 'register-1' }),
    );

    expect(result).toMatchObject({
      operationId: 'offline-operation-0001',
      status: 'needs_review',
      error: { code: 'POS_SYNC_REGISTER_MISMATCH' },
    });

    expect(createDirectSale).not.toHaveBeenCalled();
  });

  test('syncs a signed paid-in movement through the existing shift controller and reserves the current cap', async () => {
    posCashMovementController.create.mockImplementation(async (_req, res) => (
      res.status(201).json({ success: true, data: { movement: { id: 'movement-1' } } })
    ));
    const movementOperation = {
      operationId: 'offline-movement-0001',
      deviceId: 'device-1',
      registerId: 'POS-1',
      payload: {
        type: 'cash_in',
        amount: 500,
        reasonCode: 'FLOAT_TOP_UP',
        shiftId: 'shift-1',
        offlineSnapshotCapability: 'signed-snapshot',
      },
      deviceTime: '2026-10-15T12:00:00.000Z',
      paymentFlow: 'LEGACY',
    };

    await expect(_private.executeCashMovement(request, movementOperation)).resolves.toMatchObject({
      success: true,
      data: { movement: { id: 'movement-1' } },
    });
    expect(reserveOfflineActionUsage).toHaveBeenCalledWith(expect.objectContaining({
      companyId: 'company-1',
      snapshotId: 'snapshot-1',
      operationId: 'offline-movement-0001',
      deviceId: 'device-1',
      registerId: 'POS-1',
      action: 'paid_in',
      amount: 500,
    }));
    expect(posCashMovementController.create.mock.calls[0][0].params).toEqual({ shiftId: 'shift-1' });
  });

  test('audits a conflicting replay and leaves the cash movement unposted for review', async () => {
    reserveOfflineActionUsage.mockRejectedValueOnce(Object.assign(
      new Error('This operation already has an offline cap reservation with different amount or details; the operation requires review.'),
      {
        code: 'POS_OFFLINE_ACTION_USAGE_IDEMPOTENCY_CONFLICT',
        statusCode: 409,
        auditDetails: {
          snapshotId: 'snapshot-1',
          action: 'paid_in',
          conflictFields: ['amount'],
          existingAmount: '500',
          requestedAmount: '750',
        },
      },
    ));
    const movementOperation = operation({
      type: 'CASH_MOVEMENT',
      payload: {
        type: 'cash_in',
        amount: 750,
        reasonCode: 'FLOAT_TOP_UP',
        shiftId: 'shift-1',
        offlineSnapshotCapability: 'signed-snapshot',
      },
    });

    const result = await _private.processOperation(request, movementOperation);

    expect(result).toMatchObject({
      status: 'needs_review',
      error: { code: 'POS_OFFLINE_ACTION_USAGE_IDEMPOTENCY_CONFLICT' },
    });
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      companyId: 'company-1',
      registerId: 'register-1',
      userId: 'pos-cashier-2',
      event: 'POS_OFFLINE_ACTION_USAGE_IDEMPOTENCY_CONFLICT',
      metadata: expect.objectContaining({
        operationId: movementOperation.operationId,
        action: 'paid_in',
        conflictFields: ['amount'],
      }),
    }));
    expect(posCashMovementController.create).not.toHaveBeenCalled();
    expect(db.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO pos_sync_exceptions'),
      expect.any(String),
      'company-1',
      'device-1',
      movementOperation.operationId,
      'POS_OFFLINE_ACTION_USAGE_IDEMPOTENCY_CONFLICT',
      expect.any(String),
      expect.any(String),
    );
  });

  test('syncs offline mixed tenders with aggregate cap reservations and stable payment requests', async () => {
    posPaymentsV2Controller.createPendingSale.mockImplementation(async (_req, res) => (
      res.status(201).json({ success: true, data: { _id: 'sale-v2-split', totalAmount: 1000 } })
    ));
    posPaymentsV2Controller.recordCashPayment.mockImplementation(async (_req, res) => (
      res.status(201).json({ success: true, data: { payment: { id: 'payment-standard' } } })
    ));
    posPaymentsV2Controller.recordManualMobileMoneyPayment.mockImplementation(async (_req, res) => (
      res.status(201).json({ success: true, data: { payment: { id: 'payment-mobile' } } })
    ));
    posPaymentsV2Controller.completeSale.mockImplementation(async (_req, res) => (
      res.status(200).json({ success: true, data: { _id: 'sale-v2-split', status: 'completed' } })
    ));
    const splitOperation = operation({
      paymentFlow: 'PAYMENTS_V2',
      payload: {
        displayTotal: 1000,
        paymentMethod: 'cash',
        paymentAmount: 1000,
        confirmReceived: true,
        offlineSnapshotCapability: 'signed-snapshot',
        splitTender: true,
        payments: [
          { paymentMethod: 'cash', amount: 300 },
          { paymentMethod: 'card', amount: 250, reference: 'CARD-123' },
          { paymentMethod: 'card', amount: 150, reference: 'CARD-456' },
          {
            paymentMethod: 'mobile_money',
            amount: 300,
            provider: 'momo',
            reference: 'MOMO-123',
            payerPhone: '+250788123456',
          },
        ],
      },
    });

    const result = await _private.processOperation(request, splitOperation);

    expect(result).toMatchObject({
      operationId: splitOperation.operationId,
      status: 'synced',
      result: { _id: 'sale-v2-split', status: 'completed' },
    });
    expect(reserveOfflineActionUsage).toHaveBeenCalledWith(expect.objectContaining({
      operationId: splitOperation.operationId,
      action: 'card',
      amount: 400,
    }));
    expect(reserveOfflineActionUsage).toHaveBeenCalledWith(expect.objectContaining({
      operationId: splitOperation.operationId,
      action: 'mobile_money',
      amount: 300,
    }));
    expect(posPaymentsV2Controller.recordCashPayment.mock.calls[0][0]).toMatchObject({
      body: {
        payments: [
          { method: 'CARD', amount: 250, reference: 'CARD-123' },
          { method: 'CARD', amount: 150, reference: 'CARD-456' },
          { method: 'CASH', amount: 300, tendered: 300 },
        ],
      },
    });
    expect(posPaymentsV2Controller.recordManualMobileMoneyPayment.mock.calls[0][0]).toMatchObject({
      body: {
        provider: 'MTN_MOMO',
        amount: 300,
        reference: 'MOMO-123',
        payerPhone: '+250788123456',
        confirmReceived: true,
      },
    });
    expect(posPaymentsV2Controller.completeSale).toHaveBeenCalledTimes(1);
  });

  test('forwards offline split payments intact through the legacy sale flow', async () => {
    const splitOperation = operation({
      paymentFlow: 'LEGACY',
      payload: {
        displayTotal: 1000,
        paymentMethod: 'cash',
        paymentAmount: 1000,
        offlineSnapshotCapability: 'signed-snapshot',
        splitTender: true,
        payments: [
          { paymentMethod: 'cash', amount: 600 },
          { paymentMethod: 'card', amount: 400, reference: 'CARD-123' },
        ],
      },
    });

    const result = await _private.processOperation(request, splitOperation);

    expect(result).toMatchObject({ status: 'synced', result: { _id: 'invoice-1' } });
    expect(createDirectSale.mock.calls[0][0].body.payments).toEqual(splitOperation.payload.payments);
    expect(createDirectSale.mock.calls[0][0].body.offlineOperationId).toBe(splitOperation.operationId);
  });

  test('rejects a split payment amount that disagrees with its tender lines before sale creation', async () => {
    const invalidOperation = operation({
      paymentFlow: 'PAYMENTS_V2',
      payload: {
        displayTotal: 1000,
        paymentMethod: 'cash',
        paymentAmount: 999,
        offlineSnapshotCapability: 'signed-snapshot',
        splitTender: true,
        payments: [
          { paymentMethod: 'cash', amount: 600 },
          { paymentMethod: 'card', amount: 400, reference: 'CARD-123' },
        ],
      },
    });

    const result = await _private.processOperation(request, invalidOperation);

    expect(result).toMatchObject({
      status: 'needs_review',
      error: { code: 'POS_OFFLINE_PAYMENT_INVALID' },
    });
    expect(posPaymentsV2Controller.createPendingSale).not.toHaveBeenCalled();
  });

  test.each([
    [
      'partial',
      [{ paymentMethod: 'cash', amount: 900 }],
      900,
    ],
    [
      'non-cash over-allocation',
      [
        { paymentMethod: 'card', amount: 700, reference: 'CARD-1' },
        { paymentMethod: 'mobile_money', amount: 400, provider: 'momo', reference: 'MOMO-1', payerPhone: '+250788123456' },
      ],
      1100,
    ],
  ])('quarantines %s split allocations without posting tenders', async (_label, payments, paymentAmount) => {
    posPaymentsV2Controller.createPendingSale.mockImplementation(async (_req, res) => (
      res.status(201).json({ success: true, data: { _id: 'sale-v2-invalid-split', totalAmount: 1000 } })
    ));
    const invalidOperation = operation({
      paymentFlow: 'PAYMENTS_V2',
      payload: {
        displayTotal: 1000,
        paymentMethod: payments[0].paymentMethod,
        paymentAmount,
        confirmReceived: true,
        offlineSnapshotCapability: 'signed-snapshot',
        splitTender: true,
        payments,
      },
    });

    const result = await _private.processOperation(request, invalidOperation);

    expect(result).toMatchObject({
      status: 'needs_review',
      error: { code: 'POS_OFFLINE_PAYMENT_AMOUNT_INVALID' },
    });
    expect(posPaymentsV2Controller.recordCashPayment).not.toHaveBeenCalled();
    expect(posPaymentsV2Controller.recordManualMobileMoneyPayment).not.toHaveBeenCalled();
  });

  test('rejects unsupported or multiple manual mobile-money offline tenders before creating a sale', async () => {
    const invalidOperation = operation({
      paymentFlow: 'PAYMENTS_V2',
      payload: {
        displayTotal: 1000,
        paymentMethod: 'cash',
        paymentAmount: 1000,
        offlineSnapshotCapability: 'signed-snapshot',
        splitTender: true,
        payments: [
          { paymentMethod: 'cash', amount: 100 },
          { paymentMethod: 'mobile_money', amount: 400, provider: 'momo', reference: 'MOMO-1', payerPhone: '+250788123456' },
          { paymentMethod: 'mobile_money', amount: 500, provider: 'airtel', reference: 'AIRTEL-1', payerPhone: '+250788123456' },
        ],
        confirmReceived: true,
      },
    });

    const result = await _private.processOperation(request, invalidOperation);

    expect(result).toMatchObject({
      status: 'needs_review',
      error: { code: 'POS_OFFLINE_PAYMENT_INVALID' },
    });
    expect(posPaymentsV2Controller.createPendingSale).not.toHaveBeenCalled();
  });

  test('syncs offline mobile money using the server-calculated total and reserves its cap', async () => {
    posPaymentsV2Controller.createPendingSale.mockImplementation(async (_req, res) => (
      res.status(201).json({ success: true, data: { _id: 'sale-v2-1', totalAmount: 500 } })
    ));
    posPaymentsV2Controller.recordManualMobileMoneyPayment.mockImplementation(async (_req, res) => (
      res.status(201).json({ success: true, data: { payment: { id: 'payment-1' } } })
    ));
    posPaymentsV2Controller.completeSale.mockImplementation(async (_req, res) => (
      res.status(200).json({ success: true, data: { _id: 'sale-v2-1', status: 'completed' } })
    ));
    const saleOperation = {
      operationId: 'offline-mobile-money-0001',
      deviceId: 'device-1',
      registerId: 'POS-1',
      paymentFlow: 'PAYMENTS_V2',
      deviceTime: '2026-10-15T12:00:00.000Z',
      payload: {
        items: [{ productId: 'product-1', quantity: 1 }],
        displayTotal: 500,
        paymentMethod: 'mobile_money',
        paymentAmount: 500,
        paymentProvider: 'MTN_MOMO',
        paymentReference: 'momo-ref-1',
        payerPhone: '+250788123456',
        confirmReceived: true,
        offlineSnapshotCapability: 'signed-snapshot',
      },
    };

    await expect(_private.executeSale(request, saleOperation)).resolves.toMatchObject({
      _id: 'sale-v2-1',
      status: 'completed',
    });
    expect(reserveOfflineActionUsage).toHaveBeenCalledWith(expect.objectContaining({
      companyId: 'company-1',
      snapshotId: 'snapshot-1',
      operationId: 'offline-mobile-money-0001',
      action: 'mobile_money',
      amount: 500,
    }));
    expect(posPaymentsV2Controller.recordManualMobileMoneyPayment.mock.calls[0][0]).toMatchObject({
      body: {
        provider: 'MTN_MOMO',
        amount: 500,
        reference: 'momo-ref-1',
        payerPhone: '+250788123456',
        confirmReceived: true,
      },
      params: { saleId: 'sale-v2-1' },
    });
  });

  test('quarantines cross-company operations without creating sales', async () => {
    const result = await _private.processOperation(request, operation({ companyId: 'company-2' }));

    expect(result).toMatchObject({
      operationId: 'offline-operation-0001',
      status: 'needs_review',
      error: { code: 'POS_SYNC_TENANT_MISMATCH' },
    });
    expect(db.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO pos_sync_exceptions'),
      expect.any(String),
      'company-1',
      'device-1',
      'offline-operation-0001',
      'POS_SYNC_TENANT_MISMATCH',
      expect.any(String),
      expect.any(String),
    );
    expect(createDirectSale).not.toHaveBeenCalled();
  });

  test('quarantines malformed envelopes instead of only returning a client review result', async () => {
    const invalidOperation = operation({ sequence: 0 });

    const result = await _private.processOperation(request, invalidOperation);

    expect(result).toMatchObject({
      operationId: invalidOperation.operationId,
      status: 'needs_review',
      error: { code: 'POS_SYNC_SEQUENCE_INVALID' },
    });
    expect(db.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO pos_sync_exceptions'),
      expect.any(String),
      'company-1',
      'device-1',
      invalidOperation.operationId,
      'POS_SYNC_SEQUENCE_INVALID',
      expect.any(String),
      expect.any(String),
    );
    expect(createDirectSale).not.toHaveBeenCalled();
  });

  test('quarantines a changed payload when an operation ID was already processed', async () => {
    const original = operation();
    storedOperation = {
      payloadHash: _private.hashOperation(original),
      state: 'synced',
      result: { _id: 'invoice-1' },
      receivedAt: new Date(),
    };
    const changed = operation({
      payload: { displayTotal: 1800, items: [{ productId: 'product-1', quantity: 1 }] },
    });

    const result = await _private.processOperation(request, changed);

    expect(result).toMatchObject({
      operationId: changed.operationId,
      status: 'needs_review',
      error: { code: 'POS_SYNC_IDEMPOTENCY_CONFLICT' },
    });
    expect(db.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO pos_sync_exceptions'),
      expect.any(String),
      'company-1',
      'device-1',
      changed.operationId,
      'POS_SYNC_IDEMPOTENCY_CONFLICT',
      expect.any(String),
      expect.any(String),
    );
    expect(createDirectSale).not.toHaveBeenCalled();
  });

  test('replays a synced later sequence without requiring its predecessor to remain in the ledger', async () => {
    const completed = operation({ sequence: 2, dependencyOperationId: 'offline-operation-0000' });
    storedOperation = {
      payloadHash: _private.hashOperation(completed),
      state: 'synced',
      result: { _id: 'invoice-2', referenceNo: 'INV-2026-00002' },
      receivedAt: new Date(),
    };

    const result = await _private.processOperation(request, completed);

    expect(result).toMatchObject({
      operationId: completed.operationId,
      status: 'synced',
      replayed: true,
      result: { _id: 'invoice-2' },
    });
    expect(db.$queryRawUnsafe).not.toHaveBeenCalledWith(
      expect.stringContaining('SELECT operation_id, sequence, operation_state'),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(createDirectSale).not.toHaveBeenCalled();
  });

  test('creates V2 pending sales without payment details, then records cash and completes', async () => {
    posPaymentsV2Controller.createPendingSale.mockImplementation(async (_req, res) => (
      res.status(201).json({ success: true, data: { _id: 'pending-sale-1', totalAmount: 1200 } })
    ));
    posPaymentsV2Controller.recordCashPayment.mockImplementation(async (_req, res) => (
      res.status(201).json({ success: true, data: { payment: { id: 'payment-1' } } })
    ));
    posPaymentsV2Controller.completeSale.mockImplementation(async (_req, res) => (
      res.status(200).json({ success: true, data: { _id: 'invoice-1', referenceNo: 'INV-2026-00001' } })
    ));

    const result = await _private.processOperation(request, operation({
      paymentFlow: 'PAYMENTS_V2',
      payload: {
        displayTotal: 1200,
        paymentMethod: 'cash',
        paymentAmount: 1200,
        payments: [{ paymentMethod: 'cash', amount: 1200 }],
        offlineReceiptNumber: 'INV-2026-00001',
      },
    }));

    expect(result).toMatchObject({
      operationId: 'offline-operation-0001',
      status: 'synced',
      result: { _id: 'invoice-1', referenceNo: 'INV-2026-00001' },
    });
    const pendingRequest = posPaymentsV2Controller.createPendingSale.mock.calls[0][0];
    expect(pendingRequest.body).toMatchObject({
      paymentMethod: 'cash',
      paymentAmount: 0,
      payments: [],
    });
    expect(posPaymentsV2Controller.recordCashPayment.mock.calls[0][0]).toMatchObject({
      body: { amount: 1200, tendered: 1200 },
      params: { saleId: 'pending-sale-1' },
    });
    expect(posPaymentsV2Controller.completeSale.mock.calls[0][0].params).toEqual({ saleId: 'pending-sale-1' });
    expect(posPaymentsV2Controller.completeSale.mock.calls[0][0].get('Idempotency-Key'))
      .toBe('offline-operation-0001');
  });

  test('retries a previously rejected V2 operation instead of replaying its saved pre-creation error', async () => {
    posPaymentsV2Controller.createPendingSale.mockImplementation(async (_req, res) => (
      res.status(201).json({ success: true, data: { _id: 'pending-sale-1', totalAmount: 1200 } })
    ));
    posPaymentsV2Controller.recordCashPayment.mockImplementation(async (_req, res) => (
      res.status(201).json({ success: true, data: { payment: { id: 'payment-1' } } })
    ));
    posPaymentsV2Controller.completeSale.mockImplementation(async (_req, res) => (
      res.status(200).json({ success: true, data: { _id: 'invoice-1', referenceNo: 'INV-2026-00001' } })
    ));
    const signedOperation = operation({
      paymentFlow: 'PAYMENTS_V2',
      payload: {
        displayTotal: 1200,
        paymentMethod: 'cash',
        paymentAmount: 1200,
        offlinePaymentFlow: 'PAYMENTS_V2',
        offlineReceiptNumber: 'INV-2026-00001',
      },
    });
    storedOperation = {
      payloadHash: _private.hashOperation(signedOperation),
      state: 'needs_review',
      error: {
        code: 'POS_PAYMENT_V2_SEPARATE_PAYMENT_REQUIRED',
        message: 'Create the pending sale first, then record cash through the POS Payments V2 payment screen.',
      },
      receivedAt: new Date(Date.now() - 180_000),
    };

    const result = await _private.processOperation(request, signedOperation);

    expect(result).toMatchObject({
      operationId: signedOperation.operationId,
      status: 'synced',
      result: { _id: 'invoice-1', referenceNo: 'INV-2026-00001' },
    });
    expect(posPaymentsV2Controller.createPendingSale).toHaveBeenCalledTimes(1);
    expect(db.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining("status = 'resolved', resolution = 'SYNC_SUCCEEDED'"),
      'company-1',
      'device-1',
      signedOperation.operationId,
    );
  });

  test('accepts a receipt-only correction after the invalid receipt was saved as an exception', async () => {
    posPaymentsV2Controller.createPendingSale.mockImplementation(async (_req, res) => (
      res.status(201).json({ success: true, data: { _id: 'pending-sale-1', totalAmount: 1200 } })
    ));
    posPaymentsV2Controller.recordCashPayment.mockImplementation(async (_req, res) => (
      res.status(201).json({ success: true, data: { payment: { id: 'payment-1' } } })
    ));
    posPaymentsV2Controller.completeSale.mockImplementation(async (_req, res) => (
      res.status(200).json({ success: true, data: { _id: 'invoice-1', referenceNo: 'INV-2026-00002' } })
    ));
    const previousOperation = operation({
      paymentFlow: 'PAYMENTS_V2',
      payload: {
        displayTotal: 1200,
        paymentMethod: 'cash',
        paymentAmount: 1200,
        offlinePaymentFlow: 'PAYMENTS_V2',
        offlineReceiptNumber: 'offline-operation-0001',
      },
    });
    storedOperation = {
      payloadHash: _private.hashOperation(previousOperation),
      state: 'needs_review',
      error: {
        code: 'POS_OFFLINE_RECEIPT_NUMBER_INVALID',
        message: 'This offline sale has no valid receipt number.',
      },
      exceptionPayload: previousOperation.payload,
      receivedAt: new Date(Date.now() - 180_000),
    };
    const correctedOperation = operation({
      ...previousOperation,
      payload: {
        ...previousOperation.payload,
        offlineReceiptNumber: 'INV-2026-00002',
      },
    });

    const result = await _private.processOperation(request, correctedOperation);

    expect(result).toMatchObject({
      operationId: correctedOperation.operationId,
      status: 'synced',
      result: { _id: 'invoice-1', referenceNo: 'INV-2026-00002' },
    });
    expect(posPaymentsV2Controller.createPendingSale).toHaveBeenCalledTimes(1);
  });

  test('does not allow payload edits alongside an invalid receipt correction', async () => {
    const previousOperation = operation({
      payload: {
        displayTotal: 1200,
        offlineReceiptNumber: 'offline-operation-0001',
      },
    });
    storedOperation = {
      payloadHash: _private.hashOperation(previousOperation),
      state: 'needs_review',
      error: { code: 'POS_OFFLINE_RECEIPT_NUMBER_INVALID' },
      exceptionPayload: previousOperation.payload,
      receivedAt: new Date(Date.now() - 180_000),
    };

    const result = await _private.processOperation(request, operation({
      payload: {
        ...previousOperation.payload,
        displayTotal: 1500,
        offlineReceiptNumber: 'INV-2026-00002',
      },
    }));

    expect(result).toMatchObject({
      status: 'needs_review',
      error: { code: 'POS_SYNC_IDEMPOTENCY_CONFLICT' },
    });
    expect(createDirectSale).not.toHaveBeenCalled();
  });

  test('returns per-operation outcomes and continues after an invalid signature', async () => {
    const validOperation = operation();
    const invalidOperation = { ...validOperation, operationId: 'offline-operation-0002', sequence: 2, signature: 'invalid' };
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    await push({
      ...request,
      body: { operations: [invalidOperation, validOperation], queueDepth: 2 },
      get: () => undefined,
    }, response, jest.fn());

    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        results: [
          {
            operationId: invalidOperation.operationId,
            status: 'needs_review',
            error: { code: 'POS_SYNC_SIGNATURE_INVALID', message: 'Operation signature is missing or invalid.' },
          },
            expect.objectContaining({ operationId: validOperation.operationId, status: 'synced' }),
        ],
        unusedReceiptNumbersRetired: 0,
        deviceState: { status: 'active', remoteWipeRequested: false },
      }),
    }));
    expect(createDirectSale).toHaveBeenCalledTimes(1);
    expect(db.posDevice.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ queueDepth: 1 }),
    }));
  });

  test('retires unused receipt numbers only after a fully synchronized queue drain', async () => {
    retireUnusedReceiptNumbersForSnapshots.mockResolvedValue(7);
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    const signedSale = operation({
      payload: {
        offlineSnapshotCapability: 'signed-snapshot',
        displayTotal: 1200,
        items: [{ productId: 'product-1', quantity: 1 }],
        payments: [{ paymentMethod: 'cash', amount: 1200 }],
        paymentAmount: 1200,
      },
    });

    await push({
      ...request,
      body: { operations: [signedSale], queueDepth: 1, queueDrained: true },
      get: () => undefined,
    }, response, jest.fn());

    expect(retireUnusedReceiptNumbersForSnapshots).toHaveBeenCalledWith({}, {
      companyId: 'company-1', deviceId: 'device-1', snapshotIds: ['snapshot-1'],
    });
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ unusedReceiptNumbersRetired: 7 }),
    }));
  });

  test('does not retire receipt numbers while any operation remains pending', async () => {
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    const signedSale = operation({
      payload: {
        offlineSnapshotCapability: 'signed-snapshot', displayTotal: 1200,
        payments: [{ paymentMethod: 'cash', amount: 1200 }], paymentAmount: 1200,
      },
    });
    createDirectSale.mockImplementationOnce(async () => { throw Object.assign(new Error('retry'), { statusCode: 503 }); });

    await push({
      ...request,
      body: { operations: [signedSale], queueDepth: 2, queueDrained: true },
      get: () => undefined,
    }, response, jest.fn());

    expect(retireUnusedReceiptNumbersForSnapshots).not.toHaveBeenCalled();
  });

  test('quarantines revoked-device operations, reports wipe state, and updates queue depth', async () => {
    const revokedDevice = {
      ...request.posDevice,
      status: 'revoked',
      wipeRequestedAt: new Date(),
      wipeAcknowledgedAt: null,
    };
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    await quarantineRevokedPush({
      ...request,
      posDevice: revokedDevice,
      body: { operations: [operation()], queueDepth: 3, appVersion: '0.0.1' },
    }, response, jest.fn());

    expect(response.json).toHaveBeenCalledWith({
      success: true,
      data: {
        results: [{
          operationId: 'offline-operation-0001',
          status: 'needs_review',
          error: {
            code: 'POS_SYNC_DEVICE_REVOKED',
            message: 'This device was revoked. Its operation was quarantined and was not posted.',
          },
        }],
        deviceState: { status: 'revoked', remoteWipeRequested: true },
      },
    });
    expect(db.posDevice.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'device-record-1' },
      data: expect.objectContaining({ queueDepth: 3, lastSyncAt: expect.any(Date) }),
    }));
    expect(db.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO pos_sync_exceptions'),
      expect.any(String),
      'company-1',
      'device-1',
      'offline-operation-0001',
      'POS_SYNC_DEVICE_REVOKED',
      expect.any(String),
      expect.any(String),
    );
    expect(createDirectSale).not.toHaveBeenCalled();
  });

  test('requires a confirmed export before acknowledging a wipe with queued operations', async () => {
    const device = {
      ...request.posDevice,
      wipeRequestedAt: new Date(),
      wipeAcknowledgedAt: null,
    };
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    await acknowledgeDeviceWipe({
      posDevice: device,
      body: { queueDepth: 2, exported: false },
    }, response, jest.fn());

    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'POS_DEVICE_WIPE_EXPORT_REQUIRED',
    }));
    expect(db.posDevice.update).not.toHaveBeenCalled();
  });
});
