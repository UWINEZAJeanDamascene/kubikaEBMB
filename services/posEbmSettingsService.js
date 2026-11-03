'use strict';

// Provisional business policy defaults are documented in docs/ebm/decisions.md.
// Keep absent-row behavior aligned with the database defaults until RRA confirms otherwise.
const DEFAULT_POS_EBM_SETTINGS = Object.freeze({
  signatureWaitTimeoutSeconds: 10,
  queueWhenUnavailable: false,
  offlineSubmissionDeadlineMinutes: null,
  copyReceiptSubmitToVsdc: false,
  tenderMappings: Object.freeze({
    CASH: '01',
    CREDIT: '02',
    CARD: '05',
    MTN_MOMO: '06',
    AIRTEL_MONEY: '06',
  }),
  splitTenderPolicy: 'LARGEST_TENDER_PROVISIONAL',
  roundingPolicy: 'NONE',
  shiftCloseFiscalPolicy: 'REQUIRE_APPROVAL',
  policyStatuses: Object.freeze({
    saleBeforeSignature: 'PROVISIONAL',
    offlineQueue: 'PROVISIONAL',
    copySubmission: 'PROVISIONAL',
    refundBeforeSignature: 'PROVISIONAL',
    unknownOutcome: 'PROVISIONAL',
    tenderMappings: 'PROVISIONAL',
    splitTender: 'PROVISIONAL',
    rounding: 'PROVISIONAL',
    shiftClose: 'PROVISIONAL',
  }),
});

async function getPosEbmSettings(db, companyId) {
  if (!companyId) throw new Error('Company context is required for POS fiscal settings.');
  const row = await db.posEbmSettings.findUnique({ where: { companyId: String(companyId) } });
  if (!row) {
    return {
      ...DEFAULT_POS_EBM_SETTINGS,
      tenderMappings: { ...DEFAULT_POS_EBM_SETTINGS.tenderMappings },
      policyStatuses: { ...DEFAULT_POS_EBM_SETTINGS.policyStatuses },
    };
  }
  return {
    ...DEFAULT_POS_EBM_SETTINGS,
    ...row,
    tenderMappings: { ...DEFAULT_POS_EBM_SETTINGS.tenderMappings, ...(row.tenderMappings || {}) },
    policyStatuses: { ...DEFAULT_POS_EBM_SETTINGS.policyStatuses, ...(row.policyStatuses || {}) },
  };
}

module.exports = { DEFAULT_POS_EBM_SETTINGS, getPosEbmSettings };
