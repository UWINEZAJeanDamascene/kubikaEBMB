const { formatSyncStates } = require('../constants/ebmUiMetadata');
const { EBM_SYNC_TYPES } = require('../constants/ebmSyncTypes');

describe('EBM lookup sync presentation metadata', () => {
  it('returns all lookup sequences with status and branch/environment context', () => {
    const result = formatSyncStates([
      {
        syncType: EBM_SYNC_TYPES.STANDARD_CODES,
        branchId: '02',
        mode: 'sandbox',
        lastSuccessfulSyncAt: '2026-10-13T12:00:00.000Z',
        lastAttemptAt: '2026-10-13T12:01:00.000Z',
        summary: { receivedClasses: 3, receivedDetails: 8 },
      },
      {
        syncType: EBM_SYNC_TYPES.ITEM_CLASSES,
        branchId: '02',
        mode: 'sandbox',
        lastErrorMessage: 'RRA unavailable',
      },
    ], '02', 'sandbox');

    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({
        syncType: EBM_SYNC_TYPES.STANDARD_CODES,
        status: 'synced',
        branchId: '02',
        mode: 'sandbox',
        lastAttemptAt: '2026-10-13T12:01:00.000Z',
      }),
      expect.objectContaining({
        syncType: EBM_SYNC_TYPES.ITEM_CLASSES,
        status: 'failed',
        lastErrorMessage: 'RRA unavailable',
      }),
      expect.objectContaining({
        syncType: EBM_SYNC_TYPES.TINS,
        status: 'local_cache',
        label: 'Customer TIN cache (local)',
        sourceLabel: expect.stringContaining('live RRA verification is a separate action'),
      }),
      expect.objectContaining({ syncType: EBM_SYNC_TYPES.BRANCHES, status: 'never_synced' }),
      expect.objectContaining({ syncType: EBM_SYNC_TYPES.NOTICES, status: 'never_synced' }),
    ]));
  });
});
