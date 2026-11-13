'use strict';

const { reserveOfflineActionUsage, reserveOfflineSaleUsage } = require('../services/posOfflineActionUsageService');

function createTx({ cap, total = 0, count = 0, prior = null } = {}) {
  const inserts = [];
  return {
    inserts,
    $queryRawUnsafe: async (query) => {
      if (query.includes('FROM pos_offline_snapshots')) {
        return [{
          resolvedRegisterId: 'register-id',
          tillType: 'retail',
          actionCaps: { companyDefaults: { card: cap }, tillTypeOverrides: {}, registerOverrides: {} },
          snapshotData: { offlinePolicy: { enabled: true, actions: { manual_card: true } } },
        }];
      }
      if (query.includes('FROM pos_offline_action_usage') && query.includes('SELECT id')) {
        return prior ? [prior] : [];
      }
      if (query.includes('FROM pos_offline_action_usage')) return [{ total: String(total), count }];
      throw new Error(`Unexpected query: ${query}`);
    },
    $executeRawUnsafe: async (...args) => { inserts.push(args); return 1; },
  };
}

const allowedCap = {
  maxPerTransaction: 10_000,
  maxTotalPerPeriod: 20_000,
  maxCountPerPeriod: 2,
};

describe('POS offline action usage', () => {
  it('reserves an allowed action amount in the period ledger', async () => {
    const tx = createTx({ cap: allowedCap, total: 5_000, count: 1 });
    const result = await reserveOfflineActionUsage({
      tx,
      companyId: 'company',
      snapshotId: 'snapshot',
      operationId: 'operation',
      deviceId: 'device',
      registerId: 'register',
      action: 'card',
      amount: 10_000,
      occurredAt: new Date().toISOString(),
    });

    expect(result).toEqual({ reserved: true, replayed: false });
    expect(tx.inserts).toHaveLength(1);
  });

  it('uses the separate configured manager cap bucket for approved actions', async () => {
      const tx = createTx({ cap: allowedCap });
      tx.$queryRawUnsafe = async (query) => {
        if (query.includes('FROM pos_offline_snapshots')) {
          return [{
            resolvedRegisterId: 'register-id',
            tillType: 'retail',
            actionCaps: {
              companyDefaults: { card: allowedCap },
              offlineManagerApproval: { enabled: true, caps: { card: allowedCap } },
              tillTypeOverrides: {},
              registerOverrides: {},
            },
          snapshotData: { offlinePolicy: { enabled: true, actions: { manual_card: true } } },
          }];
        }
        if (query.includes('FROM pos_offline_action_usage') && query.includes('SELECT id')) return [];
        if (query.includes('FROM pos_offline_action_usage')) return [{ total: '0', count: 0 }];
        throw new Error(`Unexpected query: ${query}`);
      };
      await reserveOfflineActionUsage({
        tx,
        companyId: 'company',
        snapshotId: 'snapshot',
        operationId: 'approved-operation',
        deviceId: 'device',
        registerId: 'register',
        action: 'card',
        managerApproved: true,
        amount: 10_000,
        occurredAt: new Date().toISOString(),
      });
      expect(tx.inserts[0][7]).toBe('manager_card');
  });

  it('rejects an action that exceeds any configured cap', async () => {
    const tx = createTx({ cap: { ...allowedCap, maxTotalPerPeriod: 14_999 }, total: 5_000, count: 1 });
    await expect(reserveOfflineActionUsage({
      tx,
      companyId: 'company',
      snapshotId: 'snapshot',
      operationId: 'operation',
      deviceId: 'device',
      registerId: 'register',
      action: 'card',
      amount: 10_000,
      occurredAt: new Date().toISOString(),
    })).rejects.toMatchObject({ code: 'POS_OFFLINE_ACTION_CAP_EXCEEDED', statusCode: 409 });
    expect(tx.inserts).toHaveLength(0);
  });

  it('does not count the same operation twice', async () => {
    const occurredAt = new Date('2026-10-15T12:00:00.000Z');
    const tx = createTx({
      cap: allowedCap,
      prior: {
        id: 'existing',
        deviceId: 'device',
        registerId: 'register-id',
        amount: '10000.00',
        occurredAt,
      },
    });
    const result = await reserveOfflineActionUsage({
      tx,
      companyId: 'company',
      snapshotId: 'snapshot',
      operationId: 'operation',
      deviceId: 'device',
      registerId: 'register',
      action: 'card',
      amount: 10_000,
      occurredAt,
    });
    expect(result).toEqual({ reserved: true, replayed: true });
    expect(tx.inserts).toHaveLength(0);
  });

  it('rejects a repeated operation and action when its amount differs', async () => {
    const occurredAt = new Date('2026-10-15T12:00:00.000Z');
    const tx = createTx({
      cap: allowedCap,
      prior: {
        id: 'existing',
        deviceId: 'device',
        registerId: 'register-id',
        amount: '10000.00',
        occurredAt,
      },
    });

    await expect(reserveOfflineActionUsage({
      tx,
      companyId: 'company',
      snapshotId: 'snapshot',
      operationId: 'operation',
      deviceId: 'device',
      registerId: 'register',
      action: 'card',
      amount: 9_000,
      occurredAt,
    })).rejects.toMatchObject({
      code: 'POS_OFFLINE_ACTION_USAGE_IDEMPOTENCY_CONFLICT',
      statusCode: 409,
      auditDetails: { conflictFields: ['amount'] },
    });
    expect(tx.inserts).toHaveLength(0);
  });

  it('rejects a repeated operation and action when device details differ', async () => {
    const occurredAt = new Date('2026-10-15T12:00:00.000Z');
    const tx = createTx({
      cap: allowedCap,
      prior: {
        id: 'existing',
        deviceId: 'another-device',
        registerId: 'register-id',
        amount: '10000.00',
        occurredAt,
      },
    });

    await expect(reserveOfflineActionUsage({
      tx,
      companyId: 'company',
      snapshotId: 'snapshot',
      operationId: 'operation',
      deviceId: 'device',
      registerId: 'register',
      action: 'card',
      amount: 10_000,
      occurredAt,
    })).rejects.toMatchObject({
      code: 'POS_OFFLINE_ACTION_USAGE_IDEMPOTENCY_CONFLICT',
      statusCode: 409,
      auditDetails: { conflictFields: ['deviceId'] },
    });
    expect(tx.inserts).toHaveLength(0);
  });
});

describe('POS offline sale limits', () => {
  function saleTx({ policy, usage = { total: '0', count: 0 }, prior = [] } = {}) {
    const inserts = [];
    return {
      inserts,
      $queryRawUnsafe: jest.fn(async (query) => {
        if (query.includes('FROM pos_offline_snapshots')) return [{ snapshotData: { offlinePolicy: policy } }];
        if (query.includes("action = 'sale' LIMIT 1")) return prior;
        if (query.includes("action = 'sale'")) return [usage];
        throw new Error(`Unexpected query: ${query}`);
      }),
      $executeRawUnsafe: jest.fn(async (...args) => { inserts.push(args); return 1; }),
    };
  }

  const limits = {
    enabled: true,
    maxSingleSaleRwf: 600,
    maxSales: 2,
    maxTotalValueRwf: 1_000,
    actions: { cash_sales: true },
  };
  const input = {
    companyId: 'company', snapshotId: 'snapshot', operationId: 'operation',
    deviceId: 'device', registerId: 'register', amount: 500,
    occurredAt: new Date('2026-11-10T12:00:00.000Z'),
  };

  test('reserves the sale amount and counts it exactly once', async () => {
    const tx = saleTx({ policy: limits });
    await expect(reserveOfflineSaleUsage({ tx, ...input })).resolves.toEqual({ reserved: true, replayed: false });
    expect(tx.inserts).toHaveLength(1);
    expect(tx.inserts[0][7]).toBe(500);
  });

  test.each([
    ['single-sale', { amount: 601 }, { total: '0', count: 0 }, 'POS_OFFLINE_SINGLE_SALE_LIMIT'],
    ['sales-count', {}, { total: '0', count: 2 }, 'POS_OFFLINE_SALES_LIMIT'],
    ['total-value', {}, { total: '600', count: 1 }, 'POS_OFFLINE_VALUE_LIMIT'],
  ])('rejects a sale over the %s limit', async (_name, inputOverride, usage, code) => {
    const tx = saleTx({ policy: limits, usage });
    await expect(reserveOfflineSaleUsage({ tx, ...input, ...inputOverride }))
      .rejects.toMatchObject({ code, statusCode: 409 });
    expect(tx.inserts).toHaveLength(0);
  });

  test('blocks action usage when that tender is disabled by the signed action matrix', async () => {
    const tx = saleTx({ policy: { ...limits, actions: { manual_card: false } } });
    await expect(reserveOfflineActionUsage({ tx, ...input, action: 'card' }))
      .rejects.toMatchObject({ code: 'POS_OFFLINE_ACTION_BLOCKED', statusCode: 409 });
    expect(tx.inserts).toHaveLength(0);
  });
});
