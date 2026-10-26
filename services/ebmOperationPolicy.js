function normalizeBranchId(value) {
  const rawBranchId = String(value == null || value === '' ? '00' : value).trim();
  if (!/^\d{1,2}$/.test(rawBranchId)) {
    const error = new Error('A valid one- or two-digit RRA branch ID is required.');
    error.code = 'EBM_BRANCH_ID_INVALID';
    error.statusCode = 422;
    error.retryable = false;
    throw error;
  }
  return rawBranchId.padStart(2, '0');
}

function assertHeadOfficeOperation(operation, branchId) {
  const normalized = normalizeBranchId(branchId);
  if (normalized !== '00') {
    const error = new Error(`${operation} is restricted to the head office RRA branch (00).`);
    error.code = 'EBM_HEAD_OFFICE_ONLY';
    error.statusCode = 403;
    error.retryable = false;
    throw error;
  }
  return normalized;
}

function isPharmacyBusiness(company) {
  return /\b(pharmacy|pharmaceutical)\b/i.test(String(company?.industry || '').trim());
}

function assertPharmacyInsurance(company) {
  if (!isPharmacyBusiness(company)) {
    const error = new Error('RRA branch insurance submissions apply to pharmacy businesses only. Update the company industry or remove the insurance configuration before submitting.');
    error.code = 'EBM_PHARMACY_ONLY';
    error.statusCode = 422;
    error.retryable = false;
    throw error;
  }
}

module.exports = { normalizeBranchId, assertHeadOfficeOperation, isPharmacyBusiness, assertPharmacyInsurance };
