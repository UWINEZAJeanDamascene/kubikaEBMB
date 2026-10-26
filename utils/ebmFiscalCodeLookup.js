const EBMCode = require('../models/EBMCode');

/** Resolve only an active, explicitly synchronized code from its RRA class. */
async function listActiveFiscalCodes(companyId, codeClass) {
  if (!companyId || !/^\d{2}$/.test(String(codeClass))) {
    const error = new Error('Fiscal code lookup requires a company and exact two-character RRA class ID.');
    error.code = 'EBM_CODE_CLASS_ID_REQUIRED';
    error.retryable = false;
    throw error;
  }
  const rows = await EBMCode.find({
    company: companyId,
    codeClass: String(codeClass),
    active: true,
  }).sort({ sortOrder: 1, code: 1 }).lean();
  return rows.filter((row) => row.active === true && row.useYn === 'Y' && row.codeClassUseYn === 'Y');
}

async function assertActiveFiscalCode(companyId, codeClass, value, fieldName) {
  const requested = value == null ? '' : String(value).trim();
  const rows = await listActiveFiscalCodes(companyId, codeClass);
  const matches = rows.filter((row) => String(row.code) === requested);
  if (matches.length !== 1) {
    const error = new Error(`${fieldName} must match exactly one active synchronized RRA code in class ${codeClass}.`);
    error.code = matches.length ? 'EBM_CODE_AMBIGUOUS' : 'EBM_CODE_CLASS_MISMATCH';
    error.statusCode = 422;
    error.retryable = false;
    error.dispatched = false;
    throw error;
  }
  return matches[0];
}

module.exports = { listActiveFiscalCodes, assertActiveFiscalCode };
