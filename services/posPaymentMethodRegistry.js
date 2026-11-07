'use strict';

const { DEFAULT_SYSTEM_TILL_TYPES } = require('./posDiscountSettingsService');

const PAYMENT_METHOD_REGISTRY = Object.freeze([
  {
    id: 'CASH',
    type: 'cash',
    displayName: 'Cash',
    order: 0,
    countsAsDrawerCash: true,
    changeAllowed: true,
  },
  {
    id: 'MOBILE_MONEY',
    type: 'mobile_money',
    displayName: 'Mobile money',
    order: 1,
    providers: ['MTN', 'AIRTEL'],
    requiresReference: true,
    referenceLabel: 'Transaction ID',
    referenceUniqueness: 'strict',
  },
  {
    id: 'CARD',
    type: 'card',
    displayName: 'Card',
    order: 2,
    requiresReference: true,
    referenceLabel: 'Card slip reference',
    referenceUniqueness: 'scoped',
  },
  {
    id: 'BANK_TRANSFER',
    type: 'bank_transfer',
    displayName: 'Bank transfer',
    order: 3,
    requiresReference: true,
    referenceLabel: 'Bank transaction reference',
    referenceUniqueness: 'strict',
    requiresCustomer: true,
    confirmationMode: 'pending',
  },
  {
    id: 'CHEQUE',
    type: 'cheque',
    displayName: 'Cheque',
    order: 4,
    requiresReference: true,
    referenceLabel: 'Cheque number',
    referenceUniqueness: 'scoped',
    requiresCustomer: true,
  },
  {
    id: 'GIFT_CARD',
    type: 'gift_card',
    displayName: 'Gift card',
    order: 5,
    requiresReference: true,
    referenceLabel: 'Gift card code',
  },
  {
    id: 'STORE_CREDIT',
    type: 'store_credit',
    displayName: 'Store credit',
    order: 6,
    requiresCustomer: true,
  },
  {
    id: 'LOYALTY_WALLET',
    type: 'loyalty_wallet',
    displayName: 'Loyalty wallet',
    order: 7,
    enabled: false,
    requiresCustomer: true,
  },
  {
    id: 'LOYALTY_POINTS',
    type: 'loyalty_points',
    displayName: 'Loyalty points',
    order: 8,
    enabled: false,
    requiresCustomer: true,
  },
  {
    id: 'CUSTOMER_CREDIT',
    type: 'customer_credit',
    displayName: 'Customer credit',
    order: 9,
    requiresCustomer: true,
  },
]);

const METHOD_BY_ID = new Map(PAYMENT_METHOD_REGISTRY.map((method) => [method.id, method]));
const REGISTRY_SETTING_FIELDS = new Set([
  'enabled',
  'displayName',
  'order',
  'requiresReference',
  'referenceLabel',
  'referenceUniqueness',
  'requiresCustomer',
  'countsAsDrawerCash',
  'changeAllowed',
  'minAmount',
  'maxAmount',
  'approvalThreshold',
  'confirmationMode',
  'providers',
]);
const UNIQUENESS_RULES = new Set(['strict', 'scoped', 'warn_only']);
const CONFIRMATION_MODES = new Set(['instant', 'pending']);
const MOBILE_PROVIDERS = new Set(['MTN', 'AIRTEL']);
const LEGACY_METHOD_ORDER = [
  'CASH',
  'MTN_MOMO',
  'AIRTEL_MONEY',
  'CARD',
  'BANK_TRANSFER',
  'CREDIT',
  'GIFT_CARD',
  'STORE_CREDIT',
  'LOYALTY_POINTS',
];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function registryError(message) {
  return Object.assign(new Error(message), { code: 'POS_PAYMENT_SETTINGS_INVALID' });
}

function defaultMethodSettings(method, enabled) {
  return {
    enabled: enabled ?? method.enabled ?? false,
    displayName: method.displayName,
    order: method.order,
    requiresReference: method.requiresReference ?? false,
    referenceLabel: method.referenceLabel ?? 'Reference',
    referenceUniqueness: method.referenceUniqueness ?? 'warn_only',
    requiresCustomer: method.requiresCustomer ?? false,
    countsAsDrawerCash: method.countsAsDrawerCash ?? false,
    changeAllowed: method.changeAllowed ?? false,
    minAmount: method.minAmount ?? 1,
    maxAmount: method.maxAmount ?? null,
    approvalThreshold: method.approvalThreshold ?? null,
    confirmationMode: method.confirmationMode ?? 'instant',
    providers: [...(method.providers || [])],
  };
}

function normalizeMethodSettings(method, input, base, partial = false) {
  if (!isRecord(input)) throw registryError(`Settings for ${method.id} must be an object.`);
  const unknown = Object.keys(input).find((key) => !REGISTRY_SETTING_FIELDS.has(key));
  if (unknown) throw registryError(`Unsupported payment method setting: ${unknown}.`);
  const value = { ...base };
  for (const [key, raw] of Object.entries(input)) {
    if (key === 'enabled' || key === 'requiresReference' || key === 'requiresCustomer'
      || key === 'countsAsDrawerCash' || key === 'changeAllowed') {
      if (typeof raw !== 'boolean') throw registryError(`${method.id} ${key} must be a boolean.`);
      value[key] = raw;
    } else if (key === 'displayName' || key === 'referenceLabel') {
      if (typeof raw !== 'string' || !raw.trim() || raw.trim().length > 80) {
        throw registryError(`${method.id} ${key} must contain 1 to 80 characters.`);
      }
      value[key] = raw.trim();
    } else if (key === 'order') {
      if (!Number.isSafeInteger(raw) || raw < 0 || raw > 1000) {
        throw registryError(`${method.id} order must be a whole number between 0 and 1000.`);
      }
      value[key] = raw;
    } else if (key === 'minAmount') {
      if (!Number.isSafeInteger(raw) || raw < 0) {
        throw registryError(`${method.id} minAmount must be a non-negative whole RWF amount.`);
      }
      value[key] = raw;
    } else if (key === 'maxAmount' || key === 'approvalThreshold') {
      if (raw !== null && (!Number.isSafeInteger(raw) || raw < 0)) {
        throw registryError(`${method.id} ${key} must be null or a non-negative whole RWF amount.`);
      }
      value[key] = raw;
    } else if (key === 'referenceUniqueness') {
      if (!UNIQUENESS_RULES.has(raw)) throw registryError(`${method.id} referenceUniqueness is invalid.`);
      value[key] = raw;
    } else if (key === 'confirmationMode') {
      if (!CONFIRMATION_MODES.has(raw)) throw registryError(`${method.id} confirmationMode is invalid.`);
      value[key] = raw;
    } else if (key === 'providers') {
      if (!Array.isArray(raw)
        || raw.some((provider) => !MOBILE_PROVIDERS.has(provider))
        || new Set(raw).size !== raw.length) {
        throw registryError(`${method.id} providers must be a unique list of MTN and Airtel.`);
      }
      if (method.type !== 'mobile_money' && raw.length) {
        throw registryError(`${method.id} cannot configure mobile money providers.`);
      }
      value[key] = [...raw];
    }
  }
  if (!partial && value.maxAmount !== null && value.maxAmount < value.minAmount) {
    throw registryError(`${method.id} maxAmount must be greater than or equal to minAmount.`);
  }
  if (method.type !== 'mobile_money' && value.providers.length) {
    throw registryError(`${method.id} cannot configure mobile money providers.`);
  }
  return partial
    ? Object.fromEntries(Object.keys(input).map((key) => [key, value[key]]))
    : value;
}

function methodIdForLegacyCode(code) {
  if (code === 'MTN_MOMO' || code === 'AIRTEL_MONEY') return 'MOBILE_MONEY';
  if (code === 'CREDIT') return 'CUSTOMER_CREDIT';
  if (code === 'LOYALTY') return 'LOYALTY_WALLET';
  return METHOD_BY_ID.has(code) ? code : null;
}

function legacyCodesForMethod(methodId, config) {
  if (!config.enabled) return [];
  if (methodId === 'MOBILE_MONEY') {
    return config.providers.flatMap((provider) => provider === 'MTN'
      ? ['MTN_MOMO']
      : provider === 'AIRTEL' ? ['AIRTEL_MONEY'] : []);
  }
  if (methodId === 'CUSTOMER_CREDIT') return ['CREDIT'];
  if (methodId === 'LOYALTY_WALLET') return ['LOYALTY'];
  return ['CASH', 'CARD', 'BANK_TRANSFER', 'CHEQUE', 'GIFT_CARD', 'STORE_CREDIT', 'LOYALTY_POINTS']
    .includes(methodId) ? [methodId] : [];
}

function makeLegacyMethodRegistry(enabledMethods = [], registerOverrides = {}) {
  const methods = {};
  for (const method of PAYMENT_METHOD_REGISTRY) {
    methods[method.id] = defaultMethodSettings(method, false);
  }
  const providers = [];
  for (const code of enabledMethods) {
    const id = methodIdForLegacyCode(code);
    if (!id) continue;
    if (id === 'MOBILE_MONEY') {
      providers.push(code === 'MTN_MOMO' ? 'MTN' : 'AIRTEL');
      methods[id].enabled = true;
    } else {
      methods[id].enabled = true;
    }
  }
  methods.MOBILE_MONEY.providers = [...new Set(providers)];

  const registerConfig = {};
  for (const [registerId, codes] of Object.entries(registerOverrides || {})) {
    if (!Array.isArray(codes)) continue;
    const enabled = new Set(codes);
    const registerMethods = {};
    for (const method of PAYMENT_METHOD_REGISTRY) {
      const methodCodes = method.id === 'MOBILE_MONEY'
        ? ['MTN_MOMO', 'AIRTEL_MONEY']
        : method.id === 'CUSTOMER_CREDIT'
          ? ['CREDIT']
          : method.id === 'LOYALTY_WALLET'
            ? ['LOYALTY']
          : [method.id];
      registerMethods[method.id] = {
        enabled: methodCodes.some((code) => enabled.has(code)),
        ...(method.id === 'MOBILE_MONEY'
          ? { providers: methodCodes.flatMap((code) => enabled.has(code) ? [code === 'MTN_MOMO' ? 'MTN' : 'AIRTEL'] : []) }
          : {}),
      };
    }
    registerConfig[registerId] = registerMethods;
  }
  return { company: methods, tillTypeOverrides: {}, registerOverrides: registerConfig };
}

function normalizeMethodRegistry(value, legacyEnabledMethods = [], legacyRegisterOverrides = {}) {
  const source = isRecord(value) && Object.keys(value).length
    ? value
    : makeLegacyMethodRegistry(legacyEnabledMethods, legacyRegisterOverrides);
  if (!isRecord(source)) throw registryError('methodRegistry must be an object.');
  const unknownGroups = Object.keys(source).filter((key) => (
    !['methods', 'company', 'tillTypeOverrides', 'registerOverrides'].includes(key)
  ));
  if (unknownGroups.length) throw registryError(`Unsupported methodRegistry section: ${unknownGroups[0]}.`);
  if (source.methods !== undefined && (
    !Array.isArray(source.methods)
    || source.methods.length !== PAYMENT_METHOD_REGISTRY.length
    || source.methods.some((method, index) => (
      !isRecord(method)
      || method.id !== PAYMENT_METHOD_REGISTRY[index].id
      || method.type !== PAYMENT_METHOD_REGISTRY[index].type
    ))
  )) {
    throw registryError('methodRegistry.methods is a read-only payment-method definition list.');
  }
  if (!isRecord(source.company)) throw registryError('methodRegistry.company must be an object.');
  const company = {};
  for (const method of PAYMENT_METHOD_REGISTRY) {
    const base = defaultMethodSettings(method);
    company[method.id] = normalizeMethodSettings(method, source.company[method.id] ?? {}, base);
  }
  const normalizeOverrides = (raw, scopeLabel) => {
    if (raw == null) raw = {};
    if (!isRecord(raw) || Object.keys(raw).length > 500) {
      throw registryError(`${scopeLabel} must be an object with no more than 500 entries.`);
    }
    const result = {};
    for (const [scopeId, entries] of Object.entries(raw)) {
      if (!scopeId.trim() || !isRecord(entries)) throw registryError(`${scopeLabel} contains an invalid entry.`);
      const overrides = {};
      for (const [methodId, input] of Object.entries(entries)) {
        const method = METHOD_BY_ID.get(methodId);
        if (!method) throw registryError(`Unsupported payment method: ${methodId}.`);
        overrides[methodId] = normalizeMethodSettings(
          method,
          input,
          company[methodId],
          true,
        );
      }
      result[scopeId] = overrides;
    }
    return result;
  };
  const tillTypeOverrides = normalizeOverrides(source.tillTypeOverrides, 'methodRegistry.tillTypeOverrides');
  for (const tillType of Object.keys(tillTypeOverrides)) {
    if (!DEFAULT_SYSTEM_TILL_TYPES.includes(tillType.toLowerCase())) {
      throw registryError(`Unsupported system till type for payment settings: ${tillType}.`);
    }
  }
  const registerOverrides = normalizeOverrides(source.registerOverrides, 'methodRegistry.registerOverrides');
  return { company, tillTypeOverrides, registerOverrides };
}

function resolveMethodRegistry(registry, { tillType, registerId } = {}) {
  const result = {};
  for (const method of PAYMENT_METHOD_REGISTRY) {
    result[method.id] = {
      ...registry.company[method.id],
      ...(registry.tillTypeOverrides[String(tillType || '').toLowerCase()]?.[method.id] || {}),
      ...(registry.registerOverrides[String(registerId || '')]?.[method.id] || {}),
    };
  }
  return result;
}

function registryToLegacyMethods(methods) {
  const enabled = new Set(PAYMENT_METHOD_REGISTRY.flatMap(
    (method) => legacyCodesForMethod(method.id, methods[method.id]),
  ));
  return LEGACY_METHOD_ORDER.filter((method) => enabled.has(method));
}

function registryToLegacyOverrides(registry, registers = []) {
  const overrides = {};
  const registersById = new Map(registers.map((register) => [String(register.id), register]));
  for (const [registerId, values] of Object.entries(registry.registerOverrides)) {
    const register = registersById.get(registerId);
    if (!register) continue;
    const methods = resolveMethodRegistry(registry, {
      registerId,
      tillType: register.systemTillType || 'retail',
    });
    overrides[registerId] = registryToLegacyMethods(methods);
  }
  for (const register of registers) {
    const registerId = String(register.id);
    if (Object.hasOwn(overrides, registerId)) continue;
    const methods = resolveMethodRegistry(registry, {
      registerId,
      tillType: register.systemTillType || 'retail',
    });
    const companyMethods = registryToLegacyMethods(registry.company);
    const effectiveMethods = registryToLegacyMethods(methods);
    if (JSON.stringify(companyMethods) !== JSON.stringify(effectiveMethods)) {
      overrides[registerId] = effectiveMethods;
    }
  }
  return overrides;
}

module.exports = {
  PAYMENT_METHOD_REGISTRY,
  makeLegacyMethodRegistry,
  normalizeMethodRegistry,
  resolveMethodRegistry,
  registryToLegacyMethods,
  registryToLegacyOverrides,
};
