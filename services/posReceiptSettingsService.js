'use strict';

const DEFAULT_RECEIPT_SETTINGS = Object.freeze({
  paperWidth: 80,
  columns: 42,
  showCashier: true,
  showCustomer: true,
  showSku: false,
  showBarcode: false,
  headerNote: '',
  footerNote: 'Thank you for shopping with us.',
  returnPolicy: '',
  logoUrl: '',
  autoPrintOnSale: false,
  digitalReceiptsEnabled: true,
  digitalReceiptExpiryDays: 30,
});

function parseStoredSettings(stored) {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return { company: {}, branches: {} };
  if (stored.default && typeof stored.default === 'object' && stored.byBranch && typeof stored.byBranch === 'object') {
    return { company: stored.default, branches: stored.byBranch };
  }
  // Preserve existing flat JSON rows as the company-wide defaults.
  return { company: stored, branches: {} };
}

function resolveReceiptSettings(stored, branchId = null) {
  const parsed = parseStoredSettings(stored);
  const branch = branchId ? parsed.branches[String(branchId)] : null;
  return {
    ...DEFAULT_RECEIPT_SETTINGS,
    ...parsed.company,
    ...(branch && typeof branch === 'object' ? branch : {}),
  };
}

function hasBranchReceiptOverride(stored, branchId) {
  if (!branchId) return false;
  const parsed = parseStoredSettings(stored);
  return Boolean(parsed.branches[String(branchId)]);
}

function saveReceiptSettings(stored, settings, branchId = null) {
  const parsed = parseStoredSettings(stored);
  if (branchId) {
    return {
      default: parsed.company,
      byBranch: { ...parsed.branches, [String(branchId)]: settings },
    };
  }
  return { default: settings, byBranch: parsed.branches };
}

function clearBranchReceiptSettings(stored, branchId) {
  const parsed = parseStoredSettings(stored);
  const branches = { ...parsed.branches };
  delete branches[String(branchId)];
  return { default: parsed.company, byBranch: branches };
}

function normalizeReceiptSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Receipt settings must be an object.');
  const paperWidth = Number(value.paperWidth);
  if (![58, 80].includes(paperWidth)) throw new TypeError('Receipt paper width must be 58 or 80 mm.');
  const columns = value.columns == null ? (paperWidth === 58 ? 32 : 42) : Number(value.columns);
  if (![32, 42, 48].includes(columns)) throw new TypeError('Receipt columns must be 32, 42, or 48.');
  for (const key of ['showCashier', 'showCustomer', 'showSku', 'showBarcode']) {
    if (typeof value[key] !== 'boolean') throw new TypeError(`${key} must be a boolean.`);
  }
  const autoPrintOnSale = value.autoPrintOnSale ?? false;
  const digitalReceiptsEnabled = value.digitalReceiptsEnabled ?? true;
  if (typeof autoPrintOnSale !== 'boolean') throw new TypeError('autoPrintOnSale must be enabled or disabled.');
  if (typeof digitalReceiptsEnabled !== 'boolean') throw new TypeError('digitalReceiptsEnabled must be enabled or disabled.');
  for (const key of ['headerNote', 'footerNote']) {
    if (typeof value[key] !== 'string' || value[key].length > 240) throw new TypeError(`${key} must be text with at most 240 characters.`);
  }
  const returnPolicy = value.returnPolicy ?? '';
  if (typeof returnPolicy !== 'string' || returnPolicy.length > 500) {
    throw new TypeError('Return policy must be text with at most 500 characters.');
  }
  const logoReference = value.logoUrl ?? '';
  if (typeof logoReference !== 'string' || logoReference.length > 500) throw new TypeError('Receipt logo reference must be at most 500 characters.');
  const logoUrl = logoReference.trim();
  if (logoUrl && !logoUrl.startsWith('/') && !/^https:\/\//i.test(logoUrl)) {
    throw new TypeError('Receipt logo must use a secure URL or a local path.');
  }
  if (logoUrl.startsWith('//')) throw new TypeError('Receipt logo local path is invalid.');
  const digitalReceiptExpiryDays = value.digitalReceiptExpiryDays == null ? 30 : Number(value.digitalReceiptExpiryDays);
  if (!Number.isInteger(digitalReceiptExpiryDays) || digitalReceiptExpiryDays < 1 || digitalReceiptExpiryDays > 365) {
    throw new RangeError('Digital receipt expiry must be between 1 and 365 days.');
  }
  return {
    paperWidth, columns,
    showCashier: value.showCashier, showCustomer: value.showCustomer,
    showSku: value.showSku, showBarcode: value.showBarcode,
    headerNote: value.headerNote.trim(), footerNote: value.footerNote.trim(),
    returnPolicy: returnPolicy.trim(), logoUrl,
    autoPrintOnSale,
    digitalReceiptsEnabled,
    digitalReceiptExpiryDays,
  };
}

module.exports = {
  DEFAULT_RECEIPT_SETTINGS,
  normalizeReceiptSettings,
  resolveReceiptSettings,
  hasBranchReceiptOverride,
  saveReceiptSettings,
  clearBranchReceiptSettings,
};
