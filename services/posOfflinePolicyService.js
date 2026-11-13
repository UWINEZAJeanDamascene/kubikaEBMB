'use strict';

const ACTIONS = Object.freeze([
  'cash_sales', 'manual_mobile_money', 'manual_card', 'cash_paid_in', 'cash_paid_out',
  'receipt_printing', 'local_x_report', 'cached_customer_search', 'customer_quick_add',
  'gift_card_issue', 'gift_card_redemption', 'voucher_redemption', 'credit_sales',
  'credit_account_payments', 'store_credit', 'loyalty_wallet', 'loyalty_points',
  'bank_transfer', 'cheque', 'refunds', 'voids', 'manager_approvals', 'price_overrides',
  'discounts_above_limit', 'ebm_required_sales', 'shift_open', 'shift_close',
]);

const DEFAULT_ACTIONS = Object.freeze({
  cash_sales: true, manual_mobile_money: true, manual_card: true, cash_paid_in: true,
  cash_paid_out: true, receipt_printing: true, local_x_report: true,
  // Customer records are not included in the current offline snapshot.
  cached_customer_search: false, customer_quick_add: false, gift_card_issue: false,
  gift_card_redemption: false, voucher_redemption: false, credit_sales: false,
  credit_account_payments: false, store_credit: false, loyalty_wallet: false,
  loyalty_points: false, bank_transfer: false, cheque: false, refunds: false, voids: false,
  manager_approvals: false, price_overrides: false, discounts_above_limit: false,
  ebm_required_sales: false, shift_open: false, shift_close: false,
});

const DEFAULT_LIMITS = Object.freeze({ enabled: false, maxHours: 12, maxSales: 200, maxTotalValueRwf: 1000000, maxSingleSaleRwf: 1000000 });
// Provisional fiscal receipts remain disabled until the RRA/accountant decision is confirmed.
const PROVISIONAL_FISCAL_RECEIPTS_CONFIRMED = false;
const SUPPORTED_CONFIGURABLE_ACTIONS = new Set([
  'cash_sales', 'manual_mobile_money', 'manual_card', 'cash_paid_in', 'cash_paid_out',
  'receipt_printing', 'local_x_report',
]);

function record(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function validateLimit(value, field, fallback) {
  if (value == null) return fallback;
  const n = Number(value);
  const minimum = field === 'maxHours' || field === 'maxSales' || field === 'maxTotalValueRwf' || field === 'maxSingleSaleRwf' ? 1 : 0;
  const maximum = field === 'maxHours' ? 720 : field === 'maxSales' ? 1000000 : 1000000000;
  if (!Number.isSafeInteger(n) || n < minimum || n > maximum) throw new RangeError(`${field} must be a whole number from ${minimum.toLocaleString()} to ${maximum.toLocaleString()}.`);
  return n;
}

function normalizeActions(value, { rejectUnsupportedEnable = true, partial = false } = {}) {
  const raw = record(value) ? value : {};
  const result = partial ? {} : { ...DEFAULT_ACTIONS };
  for (const [key, enabled] of Object.entries(raw)) {
    if (!ACTIONS.includes(key) || typeof enabled !== 'boolean') throw new TypeError(`Invalid offline action policy: ${key}.`);
    if (enabled && rejectUnsupportedEnable && !SUPPORTED_CONFIGURABLE_ACTIONS.has(key)) {
      throw new TypeError(`${key.replaceAll('_', ' ')} is not available offline yet.`);
    }
    result[key] = enabled;
  }
  return result;
}

function normalizeOverrides(value, legacyDefaults, scope) {
  if (!record(value)) throw new TypeError(`${scope} offline policy overrides must be an object.`);
  const result = {};
  for (const [id, override] of Object.entries(value)) {
    const validId = scope === 'register' ? /^[a-f\d]{24}$/i.test(id) : /^[a-z\d][a-z\d_-]{0,39}$/i.test(id);
    if (!validId || !record(override)) throw new TypeError(`Invalid ${scope} offline policy override.`);
    const normalized = {};
    for (const field of Object.keys(DEFAULT_LIMITS)) {
      if (override[field] == null) continue;
      if (field === 'enabled') {
        if (typeof override[field] !== 'boolean') throw new TypeError(`${scope} offline enabled override must be a boolean.`);
        normalized[field] = override[field];
      } else {
        normalized[field] = validateLimit(override[field], `${scope}.${field}`, legacyDefaults[field]);
      }
    }
    if (override.actions != null) normalized.actions = normalizeActions(override.actions, { partial: true });
    result[id] = normalized;
  }
  return result;
}

function normalizeOfflinePolicy(value, settings = {}) {
  const raw = record(value) ? value : {};
  const requestedProvisionalFiscalReceipts = raw.provisionalFiscalReceiptsAllowed === true;
  if (requestedProvisionalFiscalReceipts && !PROVISIONAL_FISCAL_RECEIPTS_CONFIRMED) {
    throw new TypeError('Provisional fiscal receipts are not approved for offline use yet.');
  }
  const maxTotalValueRwf = validateLimit(settings.posOfflineQueueLimit, 'maxTotalValueRwf', DEFAULT_LIMITS.maxTotalValueRwf);
  const companyDefaults = {
    enabled: typeof settings.posOfflineEnabled === 'boolean' ? settings.posOfflineEnabled : DEFAULT_LIMITS.enabled,
    maxHours: validateLimit(settings.posOfflineMaxHours, 'maxHours', DEFAULT_LIMITS.maxHours),
    maxSales: validateLimit(settings.posOfflineMaxSales, 'maxSales', DEFAULT_LIMITS.maxSales),
    maxTotalValueRwf,
    maxSingleSaleRwf: validateLimit(settings.posOfflineMaxSingleSale, 'maxSingleSaleRwf', Math.min(DEFAULT_LIMITS.maxSingleSaleRwf, maxTotalValueRwf)),
    actions: normalizeActions(raw.companyActions),
  };
  const tillTypeOverrides = normalizeOverrides(raw.tillTypeOverrides || {}, companyDefaults, 'till type');
  const registerOverrides = normalizeOverrides(raw.registerOverrides || {}, companyDefaults, 'register');
  const validateScope = (limits, label) => {
    const effective = { ...companyDefaults, ...limits };
    if (effective.maxSingleSaleRwf > effective.maxTotalValueRwf) {
      throw new RangeError(`${label} maximum single offline sale cannot exceed its total-value limit.`);
    }
  };
  validateScope({}, 'Company');
  for (const [type, override] of Object.entries(tillTypeOverrides)) validateScope(override, `Till type ${type}`);
  for (const [register, override] of Object.entries(registerOverrides)) validateScope(override, `Register ${register}`);
  return {
    companyDefaults,
    provisionalFiscalReceiptsAllowed: PROVISIONAL_FISCAL_RECEIPTS_CONFIRMED && requestedProvisionalFiscalReceipts,
    tillTypeOverrides,
    registerOverrides,
  };
}

function resolveOfflinePolicy(value, { settings = {}, tillType, registerId } = {}) {
  const config = normalizeOfflinePolicy(value, settings);
  const typeOverride = config.tillTypeOverrides[String(tillType || '').trim().toLowerCase()] || {};
  const registerOverride = config.registerOverrides[String(registerId || '').trim()] || {};
  const limits = { ...config.companyDefaults, ...typeOverride, ...registerOverride };
  if (limits.maxSingleSaleRwf > limits.maxTotalValueRwf) {
    throw new RangeError('The maximum single offline sale cannot exceed the offline total-value limit.');
  }
  const actions = {
    ...config.companyDefaults.actions,
    ...(typeOverride.actions || {}),
    ...(registerOverride.actions || {}),
  };
  return { ...limits, actions, scope: Object.keys(registerOverride).length ? 'register' : Object.keys(typeOverride).length ? 'tillType' : 'company' };
}

function assertOfflineSaleWithinPolicy({ amount, currentValue, currentCount, policy }) {
  if (!policy.enabled) return { allowed: false, code: 'POS_OFFLINE_DISABLED', message: 'Offline sales are disabled for this register.' };
  if (!policy.actions.cash_sales) return { allowed: false, code: 'POS_OFFLINE_ACTION_BLOCKED', message: 'Offline cash sales are disabled for this register. Reconnect or ask a manager.' };
  if (!Number.isSafeInteger(amount) || amount <= 0) return { allowed: false, code: 'POS_OFFLINE_SALE_AMOUNT_INVALID', message: 'Offline sale total must be a positive whole RWF amount.' };
  if (amount > policy.maxSingleSaleRwf) return { allowed: false, code: 'POS_OFFLINE_SINGLE_SALE_LIMIT', message: `This sale exceeds the offline single-sale limit of RWF ${policy.maxSingleSaleRwf}.` };
  if (currentCount + 1 > policy.maxSales) return { allowed: false, code: 'POS_OFFLINE_SALES_LIMIT', message: `This register has reached its ${policy.maxSales}-sale offline limit.` };
  if (currentValue + amount > policy.maxTotalValueRwf) return { allowed: false, code: 'POS_OFFLINE_VALUE_LIMIT', message: `This register has reached its offline total-value limit of RWF ${policy.maxTotalValueRwf}.` };
  return { allowed: true };
}

function shouldBlockOfflineFiscalSale({
  ebmEnabled,
  snapshotRequiresFiscalSubmission,
  capabilityAllowsProvisionalReceipt,
  companyAllowsProvisionalReceipt,
}) {
  // Treat unknown company fiscal configuration as EBM-enabled (fail closed).
  const requiresFiscalSubmission = ebmEnabled !== false
    || snapshotRequiresFiscalSubmission !== false;
  const provisionalAllowed = PROVISIONAL_FISCAL_RECEIPTS_CONFIRMED
    && capabilityAllowsProvisionalReceipt === true
    && companyAllowsProvisionalReceipt === true;
  return requiresFiscalSubmission && !provisionalAllowed;
}

module.exports = { ACTIONS, DEFAULT_ACTIONS, DEFAULT_LIMITS, PROVISIONAL_FISCAL_RECEIPTS_CONFIRMED, normalizeActions, normalizeOfflinePolicy, resolveOfflinePolicy, assertOfflineSaleWithinPolicy, shouldBlockOfflineFiscalSale };
