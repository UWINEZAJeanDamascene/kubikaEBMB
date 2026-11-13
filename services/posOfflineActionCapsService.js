'use strict';

const ACTIONS = Object.freeze(['mobile_money', 'card', 'paid_in', 'paid_out']);
const CAP_FIELDS = Object.freeze(['maxPerTransaction', 'maxTotalPerPeriod', 'maxCountPerPeriod']);
const MAX_CAP = Number.MAX_SAFE_INTEGER;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function zeroCap() {
  return { maxPerTransaction: 0, maxTotalPerPeriod: 0, maxCountPerPeriod: 0 };
}

function defaultOfflineActionCaps() {
  return {
    companyDefaults: Object.fromEntries(ACTIONS.map((action) => [action, zeroCap()])),
    tillTypeOverrides: {},
    registerOverrides: {},
    offlineManagerApproval: {
      enabled: false,
      caps: Object.fromEntries(ACTIONS.map((action) => [action, zeroCap()])),
    },
  };
}

function normalizeCap(value, label) {
  if (!isRecord(value)) throw new TypeError(`${label} must contain all three offline caps.`);
  const result = {};
  for (const field of CAP_FIELDS) {
    const raw = value[field];
    if (raw === '' || raw == null) {
      result[field] = 0;
      continue;
    }
    if (!Number.isSafeInteger(raw) || raw < 0 || raw > MAX_CAP) {
      throw new RangeError(`${label}.${field} must be a non-negative whole-number RWF amount or count.`);
    }
    result[field] = raw;
  }
  return result;
}

function normalizeScopeOverrides(value, scope) {
  if (!isRecord(value)) throw new TypeError(`${scope} overrides must be an object.`);
  const normalized = {};
  for (const [scopeId, actions] of Object.entries(value)) {
    const normalizedId = String(scopeId).trim();
    const validScopeId = scope === 'register'
      ? /^[a-f\d]{24}$/i.test(normalizedId)
      : /^[a-z\d][a-z\d_-]{0,39}$/i.test(normalizedId);
    if (!validScopeId || !isRecord(actions)) {
      throw new TypeError(`Invalid ${scope} offline cap override.`);
    }
    const normalizedActions = {};
    for (const [action, caps] of Object.entries(actions)) {
      if (!ACTIONS.includes(action)) throw new TypeError(`Unsupported offline cap action: ${action}.`);
      normalizedActions[action] = normalizeCap(caps, `${scopeId}.${action}`);
    }
    normalized[normalizedId] = normalizedActions;
  }
  return normalized;
}

function normalizeOfflineActionCaps(value) {
  const raw = isRecord(value) ? value : {};
  const defaults = isRecord(raw.companyDefaults) ? raw.companyDefaults : {};
  const approval = isRecord(raw.offlineManagerApproval) ? raw.offlineManagerApproval : {};
  if (approval.enabled != null && typeof approval.enabled !== 'boolean') {
    throw new TypeError('offlineManagerApproval.enabled must be a boolean.');
  }
  const approvalCaps = isRecord(approval.caps) ? approval.caps : {};
  const offlineManagerApproval = {
    enabled: approval.enabled === true,
    caps: Object.fromEntries(ACTIONS.map((action) => [
      action,
      approvalCaps[action] == null
        ? zeroCap()
        : normalizeCap(approvalCaps[action], `offlineManagerApproval.caps.${action}`),
    ])),
  };
  const companyDefaults = Object.fromEntries(ACTIONS.map((action) => [
    action,
    defaults[action] == null ? zeroCap() : normalizeCap(defaults[action], `companyDefaults.${action}`),
  ]));
  const unsupportedApprovalActions = Object.keys(approvalCaps).filter((action) => !ACTIONS.includes(action));
  if (unsupportedApprovalActions.length) {
    throw new TypeError(`Unsupported offline manager approval cap action: ${unsupportedApprovalActions[0]}.`);
  }
  return {
    companyDefaults,
    tillTypeOverrides: normalizeScopeOverrides(raw.tillTypeOverrides || {}, 'till type'),
    registerOverrides: normalizeScopeOverrides(raw.registerOverrides || {}, 'register'),
    offlineManagerApproval,
  };
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function resolveOfflineActionCap(value, { action, tillType, registerId }) {
  const config = normalizeOfflineActionCaps(value);
  const requestedAction = String(action);
  if (requestedAction.startsWith('manager_')) {
    const approvalAction = requestedAction.slice('manager_'.length);
    if (!ACTIONS.includes(approvalAction) || !config.offlineManagerApproval.enabled) {
      throw new TypeError(`Offline manager approval is disabled or unsupported for ${approvalAction}.`);
    }
    return { ...config.offlineManagerApproval.caps[approvalAction], scope: 'offline_manager_approval' };
  }
  if (!ACTIONS.includes(requestedAction)) throw new TypeError(`Unsupported offline cap action: ${action}.`);
  const register = config.registerOverrides[String(registerId || '').trim()];
  if (register && hasOwn(register, requestedAction)) return { ...register[requestedAction], scope: 'register' };
  const till = config.tillTypeOverrides[String(tillType || '').trim().toLowerCase()];
  if (till && hasOwn(till, requestedAction)) return { ...till[requestedAction], scope: 'tillType' };
  return { ...config.companyDefaults[requestedAction], scope: 'company' };
}

function evaluateOfflineActionCap({ action, amount, currentTotal = 0, currentCount = 0, cap }) {
  if (!ACTIONS.includes(action)) throw new TypeError(`Unsupported offline cap action: ${action}.`);
  if (!Number.isSafeInteger(amount) || amount <= 0
    || !Number.isSafeInteger(currentTotal) || currentTotal < 0
    || !Number.isSafeInteger(currentCount) || currentCount < 0) {
    throw new TypeError('Offline action usage must use non-negative whole-number RWF values and counts.');
  }
  const limits = normalizeCap(cap, action);
  const labels = {
    mobile_money: 'Offline mobile money',
    card: 'Offline card',
    paid_in: 'Offline paid-in',
    paid_out: 'Offline paid-out',
  };
  const checks = [
    { field: 'maxPerTransaction', current: amount, label: 'per-transaction' },
    { field: 'maxTotalPerPeriod', current: currentTotal + amount, label: 'offline-period total' },
    { field: 'maxCountPerPeriod', current: currentCount + 1, label: 'offline-period count' },
  ];
  const failed = checks.find(({ field, current }) => limits[field] <= 0 || current > limits[field]);
  if (!failed) return { allowed: true, cap: limits };
  const limit = limits[failed.field];
  const actionLabel = labels[action];
  const remediation = 'Ask a manager to configure a safe limit or wait for the connection.';
  const message = limit <= 0
    ? `${actionLabel} is blocked because its ${failed.label} cap is zero. ${remediation}`
    : `${actionLabel} ${failed.label} cap reached (${limit}). ${remediation}`;
  return {
    allowed: false,
    code: 'POS_OFFLINE_ACTION_CAP_EXCEEDED',
    action,
    cap: failed.field,
    limit,
    current: failed.current,
    message,
  };
}

module.exports = {
  ACTIONS,
  CAP_FIELDS,
  defaultOfflineActionCaps,
  normalizeOfflineActionCaps,
  resolveOfflineActionCap,
  evaluateOfflineActionCap,
};
