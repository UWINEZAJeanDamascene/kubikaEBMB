const { EBM_SYNC_TYPES } = require('../constants/ebmSyncTypes');

const LOOKUP_SYNC_TYPES = Object.freeze([
  EBM_SYNC_TYPES.STANDARD_CODES,
  EBM_SYNC_TYPES.ITEM_CLASSES,
  EBM_SYNC_TYPES.TINS,
  EBM_SYNC_TYPES.BRANCHES,
  EBM_SYNC_TYPES.NOTICES,
]);

const SYNC_TYPE_LABELS = Object.freeze({
  [EBM_SYNC_TYPES.STANDARD_CODES]: 'Reference codes',
  [EBM_SYNC_TYPES.ITEM_CLASSES]: 'Item classes',
  [EBM_SYNC_TYPES.TINS]: 'Customer TINs',
  [EBM_SYNC_TYPES.BRANCHES]: 'Branches',
  [EBM_SYNC_TYPES.NOTICES]: 'RRA notices',
  [EBM_SYNC_TYPES.IMPORTED_ITEMS]: 'Imported items',
  [EBM_SYNC_TYPES.PURCHASE_SALES]: 'Purchase summaries',
  [EBM_SYNC_TYPES.REGISTERED_ITEMS]: 'Registered items',
  [EBM_SYNC_TYPES.SALES_SUMMARY]: 'Sales summaries',
});

const READINESS_ACTIONS = Object.freeze({
  company_tin: { actionLabel: 'Set company TIN', actionPath: '/company-settings' },
  device_initialized: { actionLabel: 'Initialize device', actionPath: '/company-settings' },
  branch_registered: { actionLabel: 'Manage branches', actionPath: '/warehouses' },
  codes_synced: { actionLabel: 'Sync codes now', actionPath: null, actionId: 'sync_codes' },
  products_registered: { actionLabel: 'Review products', actionPath: '/products?filter=ebm' },
});

function formatSyncStates(syncStates = [], branchId = '00', mode = 'unknown') {
  const normalizedBranchId = String(branchId).padStart(2, '0').slice(-2);
  const branchStates = syncStates
    .filter((state) => String(state.branchId || '00') === normalizedBranchId);
  const byType = new Map(branchStates.map((state) => [state.syncType, state]));
  const lookupStates = LOOKUP_SYNC_TYPES.map((syncType) => byType.get(syncType) || {
    syncType,
    branchId: normalizedBranchId,
    mode,
    summary: {},
  });
  const lookupTypeSet = new Set(LOOKUP_SYNC_TYPES);
  const otherStates = branchStates.filter((state) => !lookupTypeSet.has(state.syncType));

  return [...lookupStates, ...otherStates]
    .map((state) => {
      const lastSyncedAt = state.lastSuccessfulSyncAt || null;
      const lastErrorMessage = state.lastErrorMessage || null;
      const status = state.syncType === EBM_SYNC_TYPES.TINS
        ? 'local_cache'
        : (lastErrorMessage
          ? (lastSyncedAt ? 'failed_previous_sync_available' : 'failed')
          : (lastSyncedAt ? 'synced' : 'never_synced'));
      return {
        syncType: state.syncType,
        label: state.syncType === EBM_SYNC_TYPES.TINS
          ? 'Customer TIN cache (local)'
          : (SYNC_TYPE_LABELS[state.syncType] || String(state.syncType || '').replace(/_/g, ' ')),
        branchId: state.branchId || normalizedBranchId,
        mode: state.mode || mode,
        status,
        lastSyncedAt,
        lastAttemptAt: state.lastAttemptAt || null,
        lastErrorMessage,
        sourceLabel: state.syncType === EBM_SYNC_TYPES.TINS
          ? 'Built from locally verified client records; live RRA verification is a separate action.'
          : null,
        summary: state.summary || {},
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

module.exports = {
  LOOKUP_SYNC_TYPES,
  SYNC_TYPE_LABELS,
  READINESS_ACTIONS,
  formatSyncStates,
};
