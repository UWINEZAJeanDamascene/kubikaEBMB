'use strict';

jest.mock('../lib/prisma', () => ({ dbClient: jest.fn() }));

const { dbClient } = require('../lib/prisma');
const { pullChanges } = require('../services/posOfflineSyncDeltaService');

describe('POS offline incremental sync changes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns a bounded settings delta and advances the numeric cursor', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{
        id: 21n,
        entityType: 'settings',
        entityId: 'settings-id',
        warehouseId: null,
        deleted: false,
      }])
      .mockResolvedValueOnce([{
        pos_offline_enabled: true,
        pos_offline_max_hours: 24,
        pos_offline_queue_limit: 10000,
        pos_negative_stock_escalation_days: 3,
        allow_negative_stock: false,
      }]);
    dbClient.mockReturnValue({ $queryRawUnsafe: query });

    const result = await pullChanges({
      companyId: 'company-id',
      warehouseId: 'warehouse-id',
      cursor: '20',
    });

    expect(result).toMatchObject({
      cursor: '21',
      hasMore: false,
      fullSnapshot: false,
      changes: {
        catalog: { upserts: [], deleted: [] },
        prices: [],
        customers: { upserts: [], deleted: [] },
        settings: { pos_offline_enabled: true },
      },
    });
    expect(query.mock.calls[0][0]).toContain('LIMIT 201');
    expect(query.mock.calls[0].slice(1)).toEqual(['company-id', '20', 'warehouse-id']);
  });

  test('rejects malformed cursors before querying the change log', async () => {
    const query = jest.fn();
    dbClient.mockReturnValue({ $queryRawUnsafe: query });

    await expect(pullChanges({
      companyId: 'company-id',
      warehouseId: 'warehouse-id',
      cursor: 'invalid',
    })).rejects.toMatchObject({ code: 'POS_SYNC_CURSOR_INVALID', status: 400 });
    expect(query).not.toHaveBeenCalled();
  });
});
