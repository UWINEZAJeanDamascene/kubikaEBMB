'use strict';

const LIMIT_KEYS = Object.freeze([
  'maxLineDiscountPercent',
  'maxCartDiscountPercent',
  'maxSaleDiscountRwf',
]);

const TILL_FEATURE_KEYS = Object.freeze([
  'manualDiscounts',
  'promotions',
  'vouchers',
  'customerCredit',
]);
const DEFAULT_TILL_TYPE_FEATURES = Object.freeze({
  manualDiscounts: true,
  promotions: true,
  vouchers: true,
  customerCredit: true,
});
const DEFAULT_SYSTEM_TILL_TYPES = Object.freeze(['retail', 'restaurant']);

const DEFAULT_DISCOUNT_SETTINGS = Object.freeze({
  defaultLimits: Object.freeze({
    maxLineDiscountPercent: null,
    maxCartDiscountPercent: null,
    maxSaleDiscountRwf: null,
  }),
  rules: Object.freeze([]),
  discountReasons: Object.freeze([]),
  systemTillTypes: DEFAULT_SYSTEM_TILL_TYPES,
  tillTypeFeatures: Object.freeze({
    retail: DEFAULT_TILL_TYPE_FEATURES,
    restaurant: DEFAULT_TILL_TYPE_FEATURES,
  }),
  registerLabels: Object.freeze([]),
});

function normalizeLimit(value, key) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  const maximum = key === 'maxSaleDiscountRwf' ? Number.MAX_SAFE_INTEGER : 100;
  if (!Number.isFinite(number) || number < 0 || number > maximum
    || (key === 'maxSaleDiscountRwf' && !Number.isSafeInteger(number))) {
    throw new RangeError(key === 'maxSaleDiscountRwf'
      ? 'Sale discount cap must be a non-negative whole RWF amount.'
      : 'Discount percentage caps must be from 0 to 100.');
  }
  return number;
}

function normalizeLimits(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Discount limits must be an object.');
  }
  const unknown = Object.keys(value).filter((key) => !LIMIT_KEYS.includes(key));
  if (unknown.length) throw new TypeError(`Unsupported discount limit: ${unknown.join(', ')}.`);
  return Object.fromEntries(LIMIT_KEYS.map((key) => [key, normalizeLimit(value[key], key)]));
}

function normalizeTillTypeFeatures(value, systemTillTypes) {
  if (value == null) value = {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Till-type features must be configured by till type.');
  }
  const configuredTypes = new Set(systemTillTypes);
  const featuresByType = new Map(Object.entries(value).map(([type, features]) => [type.toLocaleLowerCase(), features]));
  const unknownTypes = [...featuresByType.keys()].filter((type) => !configuredTypes.has(type));
  if (unknownTypes.length) throw new TypeError(`Till features refer to an unconfigured till type: ${unknownTypes.join(', ')}.`);

  return Object.fromEntries(systemTillTypes.map((type) => {
    const rawFeatures = featuresByType.get(type) || {};
    if (typeof rawFeatures !== 'object' || Array.isArray(rawFeatures)) {
      throw new TypeError(`Features for ${type} must be an object.`);
    }
    const unknownFeatures = Object.keys(rawFeatures).filter((key) => !TILL_FEATURE_KEYS.includes(key));
    if (unknownFeatures.length) {
      throw new TypeError(`Unsupported ${type} till feature: ${unknownFeatures.join(', ')}.`);
    }
    const features = Object.fromEntries(TILL_FEATURE_KEYS.map((key) => {
      const enabled = rawFeatures[key] ?? DEFAULT_TILL_TYPE_FEATURES[key];
      if (typeof enabled !== 'boolean') {
        throw new TypeError(`${key} for ${type} must be enabled or disabled.`);
      }
      return [key, enabled];
    }));
    return [type, features];
  }));
}

function normalizeStringList(value, label, { maximumItems, maximumLength, required = false } = {}) {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new TypeError(`${label} must be a list of up to ${maximumItems} entries.`);
  }
  const normalized = [];
  const seen = new Set();
  for (const raw of value) {
    if (typeof raw !== 'string') throw new TypeError(`${label} entries must be text.`);
    const item = raw.trim();
    if (!item || item.length > maximumLength) {
      throw new TypeError(`${label} entries must be between 1 and ${maximumLength} characters.`);
    }
    const key = item.toLocaleLowerCase();
    if (seen.has(key)) throw new TypeError(`${label} entries must be unique.`);
    seen.add(key);
    normalized.push(item);
  }
  if (required && !normalized.length) throw new TypeError(`Add at least one ${label.toLowerCase()} entry.`);
  return normalized;
}

function normalizeDiscountSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Provide the POS discount settings before saving.');
  }
  const unknown = Object.keys(value).filter((key) => ![
    'defaultLimits', 'rules', 'discountReasons', 'systemTillTypes', 'tillTypeFeatures', 'registerLabels',
  ].includes(key));
  if (unknown.length) throw new TypeError(`Unsupported POS discount setting: ${unknown.join(', ')}.`);

  const defaultLimits = normalizeLimits(value.defaultLimits);
  if (!Array.isArray(value.rules) || value.rules.length > 1000) {
    throw new TypeError('Discount rules must be a list of up to 1,000 entries.');
  }
  const ruleKeys = new Set();
  const rules = value.rules.map((rule) => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      throw new TypeError('Each discount rule must be an object.');
    }
    const roleId = rule.roleId == null || rule.roleId === '' ? null : String(rule.roleId);
    const registerLabel = rule.registerLabel == null || rule.registerLabel === ''
      ? null
      : String(rule.registerLabel).trim();
    if (!roleId && !registerLabel) throw new TypeError('A discount rule must specify a role, a register label, or both.');
    if (roleId && !/^[a-f\d]{24}$/i.test(roleId)) throw new TypeError('Select a valid role for each discount rule.');
    if (registerLabel && (registerLabel.length > 80 || registerLabel !== rule.registerLabel.trim())) {
      throw new TypeError('Select a valid register discount label for each discount rule.');
    }
    const key = `${roleId || '*'}:${(registerLabel || '*').toLocaleLowerCase()}`;
    if (ruleKeys.has(key)) throw new TypeError('Each role and register-label combination can have only one discount rule.');
    ruleKeys.add(key);
    return { roleId, registerLabel, limits: normalizeLimits(rule.limits) };
  });
  const systemTillTypes = normalizeStringList(value.systemTillTypes, 'System till types', {
    maximumItems: 50, maximumLength: 40, required: true,
  }).map((type) => type.toLocaleLowerCase());
  if (!systemTillTypes.includes('retail')) throw new TypeError('The retail system till type must remain available.');
  const tillTypeFeatures = normalizeTillTypeFeatures(value.tillTypeFeatures, systemTillTypes);
  const registerLabels = normalizeStringList(value.registerLabels, 'Register discount labels', {
    maximumItems: 100, maximumLength: 80,
  });
  const validLabels = new Set(registerLabels.map((label) => label.toLocaleLowerCase()));
  if (rules.some((rule) => rule.registerLabel && !validLabels.has(rule.registerLabel.toLocaleLowerCase()))) {
    throw new TypeError('Every discount rule label must exist in the register label list.');
  }
  return {
    defaultLimits,
    rules,
    discountReasons: normalizeStringList(value.discountReasons, 'Discount reasons', {
      maximumItems: 50, maximumLength: 120,
    }),
    systemTillTypes,
    tillTypeFeatures,
    registerLabels,
  };
}

function normalizeStoredDiscountSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return structuredClone(DEFAULT_DISCOUNT_SETTINGS);
  }
  const systemTillTypes = Array.isArray(value.systemTillTypes) ? value.systemTillTypes : [...DEFAULT_SYSTEM_TILL_TYPES];
  const legacyTillTypes = !value.tillTypeFeatures
    ? [...new Set([...systemTillTypes, 'restaurant'].map((type) => String(type).toLocaleLowerCase()))]
    : systemTillTypes;
  return normalizeDiscountSettings({
    defaultLimits: value.defaultLimits || DEFAULT_DISCOUNT_SETTINGS.defaultLimits,
    rules: Array.isArray(value.rules) ? value.rules : [],
    discountReasons: Array.isArray(value.discountReasons) ? value.discountReasons : [],
    systemTillTypes: legacyTillTypes,
    tillTypeFeatures: value.tillTypeFeatures || {},
    registerLabels: Array.isArray(value.registerLabels) ? value.registerLabels : [],
  });
}

function getTillTypeFeatures(settings, systemTillType = 'retail') {
  const normalized = normalizeStoredDiscountSettings(settings);
  const type = String(systemTillType || 'retail').trim().toLocaleLowerCase();
  return normalized.tillTypeFeatures[type] || { ...DEFAULT_TILL_TYPE_FEATURES };
}

function getApplicableDiscountLimits(settings, roleIds = [], registerLabel = null) {
  const normalized = normalizeStoredDiscountSettings(settings);
  const activeRoles = new Set(roleIds.map(String));
  const candidates = [];
  if (!registerLabel) candidates.push(normalized.defaultLimits);
  for (const rule of normalized.rules) {
    const matchesRole = rule.roleId ? activeRoles.has(rule.roleId) : true;
    const matchesLabel = rule.registerLabel
      ? Boolean(registerLabel && rule.registerLabel.toLocaleLowerCase() === String(registerLabel).toLocaleLowerCase())
      : true;
    if (matchesRole && matchesLabel) candidates.push(rule.limits);
  }
  return Object.fromEntries(LIMIT_KEYS.map((key) => {
    const configured = candidates.map((limits) => limits[key]).filter((value) => value !== null);
    return [key, configured.length ? Math.min(...configured) : null];
  }));
}

function evaluateDiscountCaps({ limits, lineDiscounts = [], cartDiscountPercent = 0, totalDiscountRwf = 0 }) {
  const exceeded = [];
  for (const line of lineDiscounts) {
    if (limits.maxLineDiscountPercent !== null && line.percent > limits.maxLineDiscountPercent) {
      exceeded.push({ cap: 'maxLineDiscountPercent', actual: line.percent, limit: limits.maxLineDiscountPercent });
    }
  }
  if (limits.maxCartDiscountPercent !== null && cartDiscountPercent > limits.maxCartDiscountPercent) {
    exceeded.push({
      cap: 'maxCartDiscountPercent',
      actual: cartDiscountPercent,
      limit: limits.maxCartDiscountPercent,
    });
  }
  if (limits.maxSaleDiscountRwf !== null && totalDiscountRwf > limits.maxSaleDiscountRwf) {
    exceeded.push({
      cap: 'maxSaleDiscountRwf',
      actual: totalDiscountRwf,
      limit: limits.maxSaleDiscountRwf,
    });
  }
  return exceeded;
}

module.exports = {
  DEFAULT_DISCOUNT_SETTINGS,
  DEFAULT_SYSTEM_TILL_TYPES,
  DEFAULT_TILL_TYPE_FEATURES,
  LIMIT_KEYS,
  TILL_FEATURE_KEYS,
  evaluateDiscountCaps,
  getApplicableDiscountLimits,
  getTillTypeFeatures,
  normalizeDiscountSettings,
  normalizeStoredDiscountSettings,
};
