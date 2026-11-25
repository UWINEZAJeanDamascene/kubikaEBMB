'use strict';

const { dbClient } = require('../lib/prisma');
const { runInTransaction } = require('./transactionService');
const { writePosAuditLog } = require('./posAuditService');
const { DEFAULT_SYSTEM_TILL_TYPES } = require('./posDiscountSettingsService');
const {
  PAYMENT_METHOD_REGISTRY,
  normalizeMethodRegistry,
  resolveMethodRegistry,
  registryToLegacyMethods,
  registryToLegacyOverrides,
} = require('./posPaymentMethodRegistry');
const posAccountingProfileService = require('./posAccountingProfileService');
const {
  API_UNAVAILABLE_MESSAGE,
  MOBILE_MONEY_PROVIDERS,
  MANUAL_MOBILE_MONEY_PROVIDERS,
  normalizeReceivers,
} = require('./posPaymentProviders/manualMobileMoney');

const PAYMENT_METHODS = Object.freeze([
  'CASH',
  'MTN_MOMO',
  'AIRTEL_MONEY',
  'CARD',
  'BANK_TRANSFER',
  'CHEQUE',
  'CREDIT',
  'GIFT_CARD',
  'STORE_CREDIT',
  'LOYALTY',
  'LOYALTY_WALLET',
  'LOYALTY_POINTS',
  'INSURANCE',
]);
const PAYMENT_METHOD_SET = new Set(PAYMENT_METHODS);
const PAYMENT_ENVIRONMENTS = Object.freeze(['sandbox', 'production']);
const PAYMENT_FLOWS = Object.freeze(['LEGACY', 'PAYMENTS_V2']);
const MOBILE_PAYMENT_METHODS = MOBILE_MONEY_PROVIDERS;
const PROVIDER_ADAPTERS = MANUAL_MOBILE_MONEY_PROVIDERS;
const PAYMENT_SETTINGS_SELECT = Object.freeze({
  companyId: true,
  enabledMethods: true,
  registerOverrides: true,
  paymentFlow: true,
  registerPaymentFlowOverrides: true,
  pendingSaleExpiryPolicy: true,
  pendingSaleMaxAgeHours: true,
  paidSaleRefundApprovalAmount: true,
  paidSaleRefundApprovalCount: true,
  posReturnWindowDays: true,
  writeOffApprovalThresholdRwf: true,
  writeOffApprovalThresholdByTillType: true,
  momoTimeoutSec: true,
  cashRounding: true,
  allowOverCreditLimit: true,
  bankTransferNeedsConfirm: true,
  providerEnvironment: true,
  manualMobileMoneyMode: true,
  manualMobileMoneyReceivers: true,
  methodRegistry: true,
});
const PAYMENT_SETTINGS_FIELDS = new Set([
  'enabledMethods',
  'registerOverrides',
  'paymentFlow',
  'registerPaymentFlowOverrides',
  'pendingSaleExpiryPolicy',
  'pendingSaleMaxAgeHours',
  'paidSaleRefundApprovalAmount',
  'paidSaleRefundApprovalCount',
  'posReturnWindowDays',
  'writeOffApprovalThresholdRwf',
  'writeOffApprovalThresholdByTillType',
  'momoTimeoutSec',
  'cashRounding',
  'allowOverCreditLimit',
  'bankTransferNeedsConfirm',
  'providerEnvironment',
  'manualMobileMoneyMode',
  'manualMobileMoneyReceivers',
  'methodRegistry',
  'providers',
]);

function paymentError(code, message) {
  return Object.assign(new Error(message), { code });
}

function requireCompanyId(companyId) {
  if (typeof companyId !== 'string' || !companyId.trim()) {
    throw paymentError('POS_PAYMENT_COMPANY_REQUIRED', 'A company is required to load POS payment settings.');
  }
  return companyId.trim();
}

function validateMethod(method) {
  if (!PAYMENT_METHOD_SET.has(method)) {
    throw paymentError('POS_PAYMENT_METHOD_INVALID', `Unsupported POS payment method: ${String(method)}.`);
  }
}

function paymentMethodRegistryId(method) {
  if (method === 'MTN_MOMO' || method === 'AIRTEL_MONEY') return 'MOBILE_MONEY';
  if (method === 'CREDIT') return 'CUSTOMER_CREDIT';
  if (method === 'LOYALTY' || method === 'LOYALTY_WALLET') return 'LOYALTY_WALLET';
  return method;
}

function validateTenderConfiguration(settings, {
  registerId,
  tillType,
  method,
  amount,
  reference,
  customerId,
  tendered,
  allowOptionalReference = false,
} = {}) {
  validateMethod(method);
  if (method === 'INSURANCE') {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw paymentError('POS_PAYMENT_AMOUNT_INVALID', 'Insurance claim amounts must be positive.');
    }
    const normalizedReference = typeof reference === 'string' ? reference.normalize('NFKC').trim() : '';
    if (normalizedReference.length > 160 || /[\u0000-\u001f\u007f]/.test(normalizedReference)) {
      throw paymentError('POS_PAYMENT_REFERENCE_INVALID', 'Insurance references must be valid and no more than 160 characters.');
    }
    return {
      id: 'INSURANCE',
      type: 'insurance',
      displayName: 'Insurance claim',
      minAmount: 0.01,
      maxAmount: null,
      requiresCustomer: false,
      requiresReference: false,
      changeAllowed: false,
      confirmationMode: 'instant',
    };
  }
  const normalized = normalizeSettings(settings);
  const config = resolveMethodRegistry(normalized.methodRegistry, { registerId, tillType })[
    paymentMethodRegistryId(method)
  ];
  if (!config) {
    throw paymentError('POS_PAYMENT_METHOD_INVALID', `Unsupported POS payment method: ${method}.`);
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw paymentError('POS_PAYMENT_AMOUNT_INVALID', 'Payment amounts must be positive.');
  }
  if (amount < config.minAmount) {
    throw paymentError(
      'POS_PAYMENT_AMOUNT_BELOW_MINIMUM',
      `${config.displayName} requires a minimum payment of ${config.minAmount} RWF.`,
    );
  }
  if (config.maxAmount !== null && amount > config.maxAmount) {
    throw paymentError(
      'POS_PAYMENT_AMOUNT_ABOVE_MAXIMUM',
      `${config.displayName} allows a maximum payment of ${config.maxAmount} RWF.`,
    );
  }
  if (config.requiresCustomer && (!customerId || customerId === 'walk-in')) {
    throw paymentError('POS_PAYMENT_CUSTOMER_REQUIRED', `Select a named customer to pay with ${config.displayName}.`);
  }
  const normalizedReference = typeof reference === 'string' ? reference.normalize('NFKC').trim() : '';
  if (config.requiresReference && !normalizedReference && !allowOptionalReference) {
    throw paymentError(
      'POS_PAYMENT_REFERENCE_REQUIRED',
      `Enter the ${config.referenceLabel.toLowerCase()} for ${config.displayName}.`,
    );
  }
  if (normalizedReference.length > 160 || /[\u0000-\u001f\u007f]/.test(normalizedReference)) {
    throw paymentError('POS_PAYMENT_REFERENCE_INVALID', 'Payment references must be valid and no more than 160 characters.');
  }
  if (tendered !== undefined && tendered > amount && !config.changeAllowed) {
    throw paymentError('POS_PAYMENT_CHANGE_NOT_ALLOWED', `${config.displayName} does not allow change.`);
  }
  if (config.confirmationMode === 'pending') {
    throw paymentError(
      'POS_PAYMENT_CONFIRMATION_UNAVAILABLE',
      `${config.displayName} is configured for pending confirmation, which is not available in this checkout yet.`,
    );
  }
  return config;
}

function normalizeWriteOffApprovalThresholds(value) {
  if (value == null) value = {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw paymentError('POS_PAYMENT_SETTINGS_INVALID', 'writeOffApprovalThresholdByTillType must be an object.');
  }
  const entries = Object.entries(value);
  const invalidType = entries.find(([type]) => !/^[a-z][a-z0-9_-]{0,39}$/i.test(String(type).trim()));
  if (invalidType) {
    throw paymentError('POS_PAYMENT_SETTINGS_INVALID', `Invalid system till type for write-off approval: ${invalidType[0]}.`);
  }
  return Object.fromEntries(entries.map(([type, threshold]) => {
    if (!Number.isSafeInteger(threshold) || threshold < 0) {
      throw paymentError('POS_PAYMENT_SETTINGS_INVALID', `Write-off approval threshold for ${type} must be a non-negative whole RWF amount.`);
    }
    return [String(type).trim().toLowerCase(), threshold];
  }));
}

function resolveWriteOffApprovalThreshold(settings, tillType = 'retail') {
  const companyThreshold = settings?.writeOffApprovalThresholdRwf ?? 10000;
  const overrides = normalizeWriteOffApprovalThresholds(settings?.writeOffApprovalThresholdByTillType);
  const type = String(tillType || 'retail').trim().toLowerCase();
  return Object.hasOwn(overrides, type) ? overrides[type] : companyThreshold;
}

function providerStatuses(receivers = {}, mode = 'INSTANT') {
  return Object.fromEntries(MOBILE_PAYMENT_METHODS.map((method) => [
    method,
    {
      configured: PROVIDER_ADAPTERS[method].isConfigured({
        mode: 'MANUAL',
        receiver: receivers?.[method],
      }),
    },
  ]));
}

function assertProviderMethodsConfigured(methods, receivers) {
  for (const method of methods) {
    if (PROVIDER_ADAPTERS[method] && !PROVIDER_ADAPTERS[method].isConfigured({
      mode: 'MANUAL',
      receiver: receivers?.[method],
    })) {
      throw paymentError(
        'POS_PAYMENT_PROVIDER_NOT_CONFIGURED',
        `${method === 'MTN_MOMO' ? 'MTN MoMo' : 'Airtel Money'} needs a receiving number or merchant code in POS payment settings.`,
      );
    }
  }
}

function validateProviderStatusEcho(value) {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((provider) => !MOBILE_PAYMENT_METHODS.includes(provider))
    || Object.values(value).some((status) => (
      !status || typeof status !== 'object' || Array.isArray(status)
      || typeof status.configured !== 'boolean'
      || Object.keys(status).some((field) => field !== 'configured')
    ))) {
    throw paymentError('POS_PAYMENT_SETTINGS_INVALID', 'Provider status fields are read-only.');
  }
}

function accountingTendersForMethod(method) {
  if (method === 'MTN_MOMO') return [{ paymentMethod: 'mobile_money', provider: 'mtn' }];
  if (method === 'AIRTEL_MONEY') return [{ paymentMethod: 'mobile_money', provider: 'airtel' }];
  if (method === 'CREDIT') return [{ paymentMethod: 'customer_credit' }];
  if (method === 'INSURANCE') return [{ paymentMethod: 'insurance' }];
  if (method === 'LOYALTY') {
    return [{ paymentMethod: 'loyalty' }, { paymentMethod: 'loyalty_wallet' }];
  }
  if (method === 'LOYALTY_WALLET') return [{ paymentMethod: 'loyalty_wallet' }];
  return [{ paymentMethod: method.toLowerCase() }];
}

async function assertPaymentAccountingReady({
  companyId,
  registerId,
  tillType,
  method,
  client = dbClient(),
}) {
  const profile = await posAccountingProfileService.getProfile(companyId, client);
  const missingBaseMappings = profile.missingMappings || [];
  if (missingBaseMappings.length) {
    throw paymentError(
      'POS_PAYMENT_ACCOUNT_MAPPING_REQUIRED',
      `Configure required POS accounting mappings before enabling payments: ${missingBaseMappings.map(({ label }) => label).join(', ')}.`,
    );
  }
  const requiredBaseKeys = new Set(
    posAccountingProfileService.ACCOUNT_FIELDS
      .filter((field) => field.required)
      .map((field) => field.key),
  );
  const invalidBaseMapping = (profile.validationErrors || []).find((error) => (
    error.scope === 'company'
    && requiredBaseKeys.has(error.key)
    && String(error.accountCode) === String(profile.companyDefaults?.[error.key] || '')
  ));
  if (invalidBaseMapping) {
    throw paymentError('POS_PAYMENT_ACCOUNT_MAPPING_INVALID', invalidBaseMapping.message);
  }
  await posAccountingProfileService.assertTenderMappings(
    profile,
    accountingTendersForMethod(method),
    { companyId, registerId, tillType },
    {},
    client,
  );
}

function normalizeMethodList(methods, fieldName) {
  if (!Array.isArray(methods)) {
    throw paymentError('POS_PAYMENT_SETTINGS_INVALID', `${fieldName} must be an array of POS payment methods.`);
  }

  const seen = new Set();
  for (const method of methods) {
    validateMethod(method);
    if (seen.has(method)) {
      throw paymentError('POS_PAYMENT_SETTINGS_INVALID', `${fieldName} cannot contain duplicate methods.`);
    }
    seen.add(method);
  }
  return [...methods];
}

function normalizeRegisterOverrides(overrides) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw paymentError('POS_PAYMENT_SETTINGS_INVALID', 'Register payment overrides must be an object keyed by register ID.');
  }

  return Object.fromEntries(
    Object.entries(overrides).map(([registerId, methods]) => {
      if (!registerId.trim()) {
        throw paymentError('POS_PAYMENT_SETTINGS_INVALID', 'Register payment overrides must use a non-empty register ID.');
      }
      return [registerId, normalizeMethodList(methods, `Payment methods for register ${registerId}`)];
    }),
  );
}

function normalizePaymentFlowOverrides(overrides) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw paymentError('POS_PAYMENT_SETTINGS_INVALID', 'Register payment-flow overrides must be an object keyed by register ID.');
  }
  const entries = Object.entries(overrides);
  if (entries.length > 500) {
    throw paymentError('POS_PAYMENT_SETTINGS_INVALID', 'Payment-flow overrides cannot exceed 500 registers.');
  }
  return Object.fromEntries(entries.map(([registerId, flow]) => {
    if (!/^[a-f\d]{24}$/i.test(registerId) || !PAYMENT_FLOWS.includes(flow)) {
      throw paymentError('POS_PAYMENT_SETTINGS_INVALID', 'Payment-flow overrides must use valid register IDs and payment flows.');
    }
    return [registerId, flow];
  }));
}

function normalizeSettings(settings) {
  if (!settings) {
    return {
      enabledMethods: [],
      registerOverrides: {},
      paymentFlow: 'LEGACY',
      registerPaymentFlowOverrides: {},
      pendingSaleExpiryPolicy: 'SHIFT_CLOSE',
      pendingSaleMaxAgeHours: null,
      paidSaleRefundApprovalAmount: 20000,
      paidSaleRefundApprovalCount: 3,
      posReturnWindowDays: 30,
      writeOffApprovalThresholdRwf: 10000,
      writeOffApprovalThresholdByTillType: {},
      momoTimeoutSec: 120,
      cashRounding: null,
      allowOverCreditLimit: false,
      bankTransferNeedsConfirm: true,
      providerEnvironment: 'sandbox',
      manualMobileMoneyMode: 'INSTANT',
      manualMobileMoneyReceivers: {},
      methodRegistry: normalizeMethodRegistry({}, [], {}),
      providers: providerStatuses({}, 'INSTANT'),
    };
  }

  const legacyEnabledMethods = normalizeMethodList(settings.enabledMethods ?? [], 'enabledMethods');
  const legacyRegisterOverrides = normalizeRegisterOverrides(settings.registerOverrides ?? {});
  const methodRegistry = normalizeMethodRegistry(
    settings.methodRegistry,
    legacyEnabledMethods,
    legacyRegisterOverrides,
  );
  const enabledMethods = registryToLegacyMethods(methodRegistry.company);
  const registerOverrides = legacyRegisterOverrides;
  const paymentFlow = settings.paymentFlow ?? 'LEGACY';
  if (!PAYMENT_FLOWS.includes(paymentFlow)) {
    throw paymentError('POS_PAYMENT_SETTINGS_INVALID', 'paymentFlow must be LEGACY or PAYMENTS_V2.');
  }
  const registerPaymentFlowOverrides = normalizePaymentFlowOverrides(settings.registerPaymentFlowOverrides ?? {});
  const pendingSaleExpiryPolicy = settings.pendingSaleExpiryPolicy ?? 'SHIFT_CLOSE';
  if (pendingSaleExpiryPolicy !== 'SHIFT_CLOSE') {
    throw paymentError('POS_PAYMENT_SETTINGS_INVALID', 'pendingSaleExpiryPolicy must be SHIFT_CLOSE.');
  }
  const pendingSaleMaxAgeHours = settings.pendingSaleMaxAgeHours ?? null;
  if (pendingSaleMaxAgeHours !== null
    && (!Number.isSafeInteger(pendingSaleMaxAgeHours) || pendingSaleMaxAgeHours <= 0)) {
    throw paymentError('POS_PAYMENT_SETTINGS_INVALID', 'pendingSaleMaxAgeHours must be a positive whole number of hours or null.');
  }
  const paidSaleRefundApprovalAmount = settings.paidSaleRefundApprovalAmount ?? 20000;
  if (!Number.isSafeInteger(paidSaleRefundApprovalAmount) || paidSaleRefundApprovalAmount < 0) {
    throw paymentError('POS_PAYMENT_SETTINGS_INVALID', 'paidSaleRefundApprovalAmount must be a non-negative whole RWF amount.');
  }
  const paidSaleRefundApprovalCount = settings.paidSaleRefundApprovalCount ?? 3;
  if (!Number.isSafeInteger(paidSaleRefundApprovalCount) || paidSaleRefundApprovalCount < 0) {
    throw paymentError('POS_PAYMENT_SETTINGS_INVALID', 'paidSaleRefundApprovalCount must be a non-negative whole number.');
  }
  const posReturnWindowDays = settings.posReturnWindowDays ?? 30;
  if (!Number.isSafeInteger(posReturnWindowDays) || posReturnWindowDays < 0 || posReturnWindowDays > 3650) {
    throw paymentError('POS_PAYMENT_SETTINGS_INVALID', 'posReturnWindowDays must be a whole number between 0 and 3650.');
  }
  const writeOffApprovalThresholdRwf = settings.writeOffApprovalThresholdRwf ?? 10000;
  if (!Number.isSafeInteger(writeOffApprovalThresholdRwf) || writeOffApprovalThresholdRwf < 0) {
    throw paymentError('POS_PAYMENT_SETTINGS_INVALID', 'writeOffApprovalThresholdRwf must be a non-negative whole RWF amount.');
  }
  const writeOffApprovalThresholdByTillType = normalizeWriteOffApprovalThresholds(
    settings.writeOffApprovalThresholdByTillType,
  );
  if (!Number.isInteger(settings.momoTimeoutSec) || settings.momoTimeoutSec < 1) {
    throw paymentError('POS_PAYMENT_SETTINGS_INVALID', 'momoTimeoutSec must be a positive whole number of seconds.');
  }
  if (settings.cashRounding !== null && settings.cashRounding !== undefined) {
    throw paymentError(
      'POS_PAYMENT_SETTINGS_INVALID',
      'Cash rounding is not enabled until its payment allocation and accounting behavior is defined.',
    );
  }
  for (const field of ['allowOverCreditLimit', 'bankTransferNeedsConfirm']) {
    if (typeof settings[field] !== 'boolean') {
      throw paymentError('POS_PAYMENT_SETTINGS_INVALID', `${field} must be a boolean.`);
    }
  }
  if (!PAYMENT_ENVIRONMENTS.includes(settings.providerEnvironment)) {
    throw paymentError('POS_PAYMENT_SETTINGS_INVALID', 'providerEnvironment must be sandbox or production.');
  }
  const configuredManualMobileMoneyMode = settings.manualMobileMoneyMode ?? 'INSTANT';
  if (!['INSTANT', 'VERIFY'].includes(configuredManualMobileMoneyMode)) {
    throw paymentError('POS_PAYMENT_SETTINGS_INVALID', 'manualMobileMoneyMode must be INSTANT or VERIFY.');
  }
  const manualMobileMoneyMode = 'INSTANT';
  const manualMobileMoneyReceivers = normalizeReceivers(settings.manualMobileMoneyReceivers ?? {});

  return {
    enabledMethods,
    registerOverrides,
    paymentFlow,
    registerPaymentFlowOverrides,
    pendingSaleExpiryPolicy,
    pendingSaleMaxAgeHours,
    paidSaleRefundApprovalAmount,
    paidSaleRefundApprovalCount,
    posReturnWindowDays,
    writeOffApprovalThresholdRwf,
    writeOffApprovalThresholdByTillType,
    momoTimeoutSec: settings.momoTimeoutSec,
    cashRounding: settings.cashRounding ?? null,
    allowOverCreditLimit: settings.allowOverCreditLimit,
    bankTransferNeedsConfirm: settings.bankTransferNeedsConfirm,
    providerEnvironment: settings.providerEnvironment,
    manualMobileMoneyMode,
    manualMobileMoneyReceivers,
    methodRegistry,
    providers: providerStatuses(manualMobileMoneyReceivers, manualMobileMoneyMode),
  };
}

async function getPaymentSettings(companyId) {
  const scopedCompanyId = requireCompanyId(companyId);
  let settings;
  try {
    settings = await dbClient().posPaymentSettings.findUnique({
      where: { companyId: scopedCompanyId },
      select: PAYMENT_SETTINGS_SELECT,
    });
  } catch (error) {
    // During rolling deployments, the API/schema can be newer than the
    // tenant database. Keep POS refunds usable with the documented safe
    // default until `pos_return_window_days` is migrated, while surfacing all
    // unrelated schema/database errors normally.
    const missingMethodRegistry = error?.code === 'P2022'
      && String(error?.meta?.column || '').includes('method_registry');
    if (missingMethodRegistry) {
      throw paymentError(
        'POS_PAYMENT_METHOD_REGISTRY_MIGRATION_REQUIRED',
        'POS payment method settings are unavailable because the method registry database migration has not been applied.',
      );
    }
    const missingSettingsColumn = error?.code === 'P2022'
      && String(error?.meta?.column || '').includes('pos_return_window_days');
    if (!missingSettingsColumn) throw error;
    const legacySelect = { ...PAYMENT_SETTINGS_SELECT };
    delete legacySelect.posReturnWindowDays;
    settings = await dbClient().posPaymentSettings.findUnique({
      where: { companyId: scopedCompanyId },
      select: legacySelect,
    });
    return normalizeSettings(settings ? {
      ...settings,
      posReturnWindowDays: settings.posReturnWindowDays ?? 30,
    } : null);
  }
  if (!settings) return normalizeSettings(null);
  return normalizeSettings(settings);
}

async function listPaymentRegisters(companyId) {
  const scopedCompanyId = requireCompanyId(companyId);
  const where = { companyId: scopedCompanyId };
  const registerCount = await dbClient().posRegister.count({ where });
  if (registerCount > 500) {
    throw paymentError('POS_PAYMENT_SETTINGS_INVALID', 'Payment settings cannot be loaded for more than 500 POS registers.');
  }
  const registers = await dbClient().posRegister.findMany({
    where,
    select: { id: true, code: true, name: true, isActive: true, systemTillType: true },
    orderBy: [{ name: 'asc' }, { code: 'asc' }],
    take: 500,
  });
  return registers;
}

function safeSettingsSnapshot(settings) {
  const { providers, manualMobileMoneyReceivers, ...safeSettings } = normalizeSettings(settings);
  return {
    ...safeSettings,
    manualMobileMoneyReceivers: Object.fromEntries(
      Object.keys(manualMobileMoneyReceivers).map((method) => [method, '***']),
    ),
    providers,
  };
}

async function savePaymentSettings({ companyId, settings, userId, registerId, ip }) {
  const scopedCompanyId = requireCompanyId(companyId);
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw paymentError('POS_PAYMENT_SETTINGS_INVALID', 'Payment settings must be provided as an object.');
  }
  if (Object.hasOwn(settings, 'providerCredentials')) {
    throw paymentError('POS_PAYMENT_API_UNAVAILABLE', API_UNAVAILABLE_MESSAGE);
  }
  const unknownFields = Object.keys(settings).filter((field) => !PAYMENT_SETTINGS_FIELDS.has(field));
  if (unknownFields.length) {
    throw paymentError('POS_PAYMENT_SETTINGS_INVALID', `Unsupported payment setting: ${unknownFields[0]}.`);
  }
  if (!userId || !registerId) {
    throw paymentError('POS_PAYMENT_AUDIT_CONTEXT_REQUIRED', 'A POS user and register are required to update payment settings.');
  }
  const normalized = normalizeSettings(settings);
  validateProviderStatusEcho(settings.providers);
  assertProviderMethodsConfigured(
    normalized.enabledMethods,
    normalized.manualMobileMoneyReceivers,
  );
  for (const methods of Object.values(normalized.registerOverrides)) {
    assertProviderMethodsConfigured(methods, normalized.manualMobileMoneyReceivers);
  }
  const registerIds = Object.keys(normalized.registerOverrides);
  const flowRegisterIds = Object.keys(normalized.registerPaymentFlowOverrides);

  if (registerIds.length > 500 || [...registerIds, ...flowRegisterIds].some((id) => !/^[a-f\d]{24}$/i.test(id))) {
    throw paymentError(
      'POS_PAYMENT_SETTINGS_INVALID',
      'Register overrides must use valid register IDs and cannot exceed 500 registers.',
    );
  }

  const data = {
    enabledMethods: registryToLegacyMethods(normalized.methodRegistry.company),
    registerOverrides: normalized.registerOverrides,
    methodRegistry: normalized.methodRegistry,
    paymentFlow: normalized.paymentFlow,
    registerPaymentFlowOverrides: normalized.registerPaymentFlowOverrides,
    pendingSaleExpiryPolicy: normalized.pendingSaleExpiryPolicy,
    pendingSaleMaxAgeHours: normalized.pendingSaleMaxAgeHours,
    paidSaleRefundApprovalAmount: normalized.paidSaleRefundApprovalAmount,
    paidSaleRefundApprovalCount: normalized.paidSaleRefundApprovalCount,
    posReturnWindowDays: normalized.posReturnWindowDays,
    writeOffApprovalThresholdRwf: normalized.writeOffApprovalThresholdRwf,
    writeOffApprovalThresholdByTillType: normalized.writeOffApprovalThresholdByTillType,
    momoTimeoutSec: normalized.momoTimeoutSec,
    cashRounding: normalized.cashRounding,
    allowOverCreditLimit: normalized.allowOverCreditLimit,
    bankTransferNeedsConfirm: normalized.bankTransferNeedsConfirm,
    providerEnvironment: normalized.providerEnvironment,
    manualMobileMoneyMode: normalized.manualMobileMoneyMode,
    manualMobileMoneyReceivers: normalized.manualMobileMoneyReceivers,
  };

  return runInTransaction(async (tx) => {
    const registerCount = await tx.posRegister.count({
      where: { companyId: scopedCompanyId },
    });
    if (registerCount > 500) {
      throw paymentError('POS_PAYMENT_SETTINGS_INVALID', 'Payment settings cannot be saved for more than 500 POS registers.');
    }
    const registers = await tx.posRegister.findMany({
      where: { companyId: scopedCompanyId },
      select: { id: true, isActive: true, systemTillType: true },
      take: 500,
    });
    const registerById = new Map(registers.map((register) => [register.id, register]));
    const methodRegisterIds = Object.keys(normalized.methodRegistry.registerOverrides);
    const unknownRegister = [...registerIds, ...flowRegisterIds, ...methodRegisterIds]
      .find((id) => !registerById.has(id));
    if (unknownRegister) {
      throw paymentError(
        'POS_PAYMENT_REGISTER_OVERRIDE_INVALID',
        'A register payment override refers to a register that does not belong to this company.',
      );
    }
    data.registerOverrides = registryToLegacyOverrides(normalized.methodRegistry, registers);
    for (const register of registers) {
      const flow = normalized.registerPaymentFlowOverrides[register.id] ?? normalized.paymentFlow;
      const methods = resolveEnabledMethods(
        normalized,
        String(register.id),
        String(register.systemTillType || 'retail'),
      );
      if (register.isActive && flow === 'PAYMENTS_V2' && !methods.includes('CASH')) {
        throw paymentError(
          'POS_PAYMENT_REGISTER_METHOD_REQUIRED',
          'Each register using V2 payments must have cash enabled.',
        );
      }
    }
    const emptyRegister = registers.find((register) => register.isActive
      && resolveEnabledMethods(
        normalized,
        String(register.id),
        String(register.systemTillType || 'retail'),
      ).length === 0);
    if (emptyRegister) {
      throw paymentError(
        'POS_PAYMENT_REGISTER_METHOD_REQUIRED',
        'Each active POS register must have at least one enabled payment method.',
      );
    }

    const beforeRow = await tx.posPaymentSettings.findUnique({
      where: { companyId: scopedCompanyId },
      select: PAYMENT_SETTINGS_SELECT,
    });
    const previousSettings = normalizeSettings(beforeRow);
    const activeRegisters = registers.filter((register) => register.isActive);
    const accountingScopes = [
      ...[...new Set([
        ...DEFAULT_SYSTEM_TILL_TYPES,
        ...Object.keys(normalized.methodRegistry.tillTypeOverrides),
        ...activeRegisters.map((register) => String(register.systemTillType || 'retail').toLowerCase()),
      ])].map((tillType) => ({ tillType })),
      ...activeRegisters.map((register) => ({
        registerId: String(register.id),
        tillType: String(register.systemTillType || 'retail'),
      })),
    ];
    for (const scope of accountingScopes) {
      const previousMethods = new Set(resolveEnabledMethods(
        previousSettings,
        scope.registerId,
        scope.tillType,
      ));
      const nextMethods = resolveEnabledMethods(normalized, scope.registerId, scope.tillType);
      for (const method of nextMethods) {
        if (!previousMethods.has(method)) {
          await assertPaymentAccountingReady({
            companyId: scopedCompanyId,
            ...scope,
            method,
            client: tx,
          });
        }
      }
    }
    assertProviderMethodsConfigured(
      registryToLegacyMethods(normalized.methodRegistry.company),
      normalized.manualMobileMoneyReceivers,
    );
    for (const register of registers) {
      assertProviderMethodsConfigured(
        resolveEnabledMethods(
          normalized,
          String(register.id),
          String(register.systemTillType || 'retail'),
        ),
        normalized.manualMobileMoneyReceivers,
      );
    }
    const before = safeSettingsSnapshot(beforeRow);
    const savedSettings = await tx.posPaymentSettings.upsert({
      where: { companyId: scopedCompanyId },
      create: { companyId: scopedCompanyId, ...data },
      update: data,
      select: PAYMENT_SETTINGS_SELECT,
    });
    const after = safeSettingsSnapshot(savedSettings);
    const updatedSettings = normalizeSettings(savedSettings);
    await writePosAuditLog({
      companyId: scopedCompanyId,
      registerId,
      userId,
      event: 'PAYMENT_SETTINGS_UPDATED',
      metadata: { before, after },
      ip,
    }, tx);
    return updatedSettings;
  });
}

function resolveEnabledMethods(settings, registerId, tillType) {
  const normalized = normalizeSettings(settings);
  const methods = registryToLegacyMethods(resolveMethodRegistry(
    normalized.methodRegistry,
    { registerId, tillType },
  ));
  return methods.filter((method) => {
    return !PROVIDER_ADAPTERS[method] || normalized.providers[method]?.configured === true;
  });
}

function getEffectiveMethodRegistry(settings, { registerId, tillType } = {}) {
  const normalized = normalizeSettings(settings);
  const resolved = resolveMethodRegistry(normalized.methodRegistry, { registerId, tillType });
  return {
    methods: PAYMENT_METHOD_REGISTRY.map((method) => ({
      ...method,
      ...resolved[method.id],
    })),
    company: normalized.methodRegistry.company,
    tillTypeOverrides: normalized.methodRegistry.tillTypeOverrides,
    registerOverrides: normalized.methodRegistry.registerOverrides,
  };
}

function resolvePaymentFlow(settings, registerId) {
  const normalized = normalizeSettings(settings);
  return registerId && Object.hasOwn(normalized.registerPaymentFlowOverrides, registerId)
    ? normalized.registerPaymentFlowOverrides[registerId]
    : normalized.paymentFlow;
}

async function isPaymentMethodEnabled({ companyId, registerId, method, tillType }) {
  validateMethod(method);
  if (method === 'INSURANCE') {
    let effectiveTillType = tillType;
    if (!effectiveTillType && registerId) {
      const register = await dbClient().posRegister.findFirst({
        where: { id: String(registerId), companyId: requireCompanyId(companyId) },
        select: { systemTillType: true },
      });
      effectiveTillType = register?.systemTillType || '';
    }
    if (String(effectiveTillType || '').toLowerCase() !== 'pharmacy') return false;
    return Boolean(await dbClient().pharmacyInsuranceProvider.findFirst({
      where: { companyId: requireCompanyId(companyId), isActive: true },
      select: { id: true },
    }));
  }
  const settings = await getPaymentSettings(companyId);
  return resolveEnabledMethods(settings, registerId, tillType).includes(method);
}

async function assertPaymentMethodEnabled({ companyId, registerId, method, tillType }) {
  validateMethod(method);
  const scopedCompanyId = requireCompanyId(companyId);
  let effectiveTillType = tillType;
  if (!effectiveTillType) {
    const register = await dbClient().posRegister.findFirst({
      where: { id: String(registerId || ''), companyId: scopedCompanyId },
      select: { systemTillType: true },
    });
    if (!register) {
      throw paymentError('POS_PAYMENT_REGISTER_OVERRIDE_INVALID', 'The selected POS register does not belong to this company.');
    }
    effectiveTillType = register.systemTillType || 'retail';
  }
  if (method === 'INSURANCE') {
    if (String(effectiveTillType).toLowerCase() !== 'pharmacy') {
      throw paymentError('POS_PAYMENT_METHOD_DISABLED', 'Insurance claims are available only on a Pharmacy register.');
    }
    const provider = await dbClient().pharmacyInsuranceProvider.findFirst({
      where: { companyId: scopedCompanyId, isActive: true },
      select: { id: true },
    });
    if (!provider) {
      throw paymentError('POS_PAYMENT_METHOD_DISABLED', 'Configure an active insurer before accepting an insurance claim.');
    }
    await assertPaymentAccountingReady({
      companyId: scopedCompanyId,
      registerId,
      tillType: effectiveTillType,
      method,
    });
    return;
  }
  const settings = await getPaymentSettings(scopedCompanyId);
  if (PROVIDER_ADAPTERS[method] && settings.providers[method]?.configured !== true) {
    throw paymentError(
      'POS_PAYMENT_PROVIDER_NOT_CONFIGURED',
      `${method === 'MTN_MOMO' ? 'MTN MoMo' : 'Airtel Money'} needs a receiving number or merchant code in POS payment settings.`,
    );
  }
  const enabledCode = method === 'LOYALTY_WALLET' ? 'LOYALTY' : method;
  if (!resolveEnabledMethods(settings, registerId, effectiveTillType).includes(enabledCode)) {
    const code = method === 'MTN_MOMO' || method === 'AIRTEL_MONEY'
      ? 'MOBILE_MONEY'
      : method === 'CREDIT' ? 'CUSTOMER_CREDIT'
        : method === 'LOYALTY_WALLET' ? 'LOYALTY_WALLET' : method;
    const displayName = resolveMethodRegistry(settings.methodRegistry, {
      registerId,
      tillType: effectiveTillType,
    })[code]?.displayName || method.replace(/_/g, ' ').toLowerCase();
    throw paymentError(
      'POS_PAYMENT_METHOD_DISABLED',
      `${displayName} is turned off for this register. Ask a manager to enable it.`,
    );
  }
  await assertPaymentAccountingReady({
    companyId: scopedCompanyId,
    registerId,
    tillType: effectiveTillType,
    method,
  });
}

async function getProviderStatus({ payment, attempt }) {
  const adapter = PROVIDER_ADAPTERS[payment?.method];
  if (!adapter) throw paymentError('POS_PAYMENT_API_UNAVAILABLE', API_UNAVAILABLE_MESSAGE);
  return adapter.getStatus({
    payment,
    attempt,
    config: null,
    environment: 'manual',
  });
}

async function requestProviderPayment({ payment, timeoutSec }) {
  const adapter = PROVIDER_ADAPTERS[payment?.method];
  if (!adapter) throw paymentError('POS_PAYMENT_API_UNAVAILABLE', API_UNAVAILABLE_MESSAGE);
  return adapter.requestPayment({
    payment,
    config: null,
    environment: 'manual',
    timeoutSec,
  });
}

function requireWholeRwf(value, fieldName, { allowZero = false } = {}) {
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
    const qualifier = allowZero ? 'a non-negative' : 'a positive';
    throw paymentError('POS_PAYMENT_AMOUNT_INVALID', `${fieldName} must be ${qualifier} whole RWF.`);
  }
}

function calculatePaymentTotals(invoiceTotal, payments) {
  requireWholeRwf(invoiceTotal, 'invoiceTotal', { allowZero: true });
  if (!Array.isArray(payments)) {
    throw paymentError('POS_PAYMENT_AMOUNT_INVALID', 'payments must be an array.');
  }

  let allocatedTotal = 0;
  let cashTenderedTotal = 0;
  const normalizedPayments = payments.map((payment, index) => {
    if (!payment || typeof payment !== 'object' || Array.isArray(payment)) {
      throw paymentError('POS_PAYMENT_AMOUNT_INVALID', `Payment ${index + 1} must be an object.`);
    }
    validateMethod(payment.method);
    requireWholeRwf(payment.amount, `Payment ${index + 1} amount`);
    allocatedTotal += payment.amount;
    if (!Number.isSafeInteger(allocatedTotal)) {
      throw paymentError('POS_PAYMENT_AMOUNT_INVALID', 'The allocated payment total exceeds the supported RWF range.');
    }

    let tendered = null;
    let changeGiven = 0;
    if (payment.method === 'CASH') {
      tendered = payment.tendered === undefined ? payment.amount : payment.tendered;
      requireWholeRwf(tendered, `Payment ${index + 1} tendered amount`);
      if (tendered < payment.amount) {
        throw paymentError('POS_CASH_TENDERED_INSUFFICIENT', `Cash payment ${index + 1} is less than its allocated amount.`);
      }
      changeGiven = tendered - payment.amount;
      cashTenderedTotal += tendered;
      if (!Number.isSafeInteger(cashTenderedTotal)) {
        throw paymentError('POS_PAYMENT_AMOUNT_INVALID', 'The cash tendered total exceeds the supported RWF range.');
      }
    } else if (payment.tendered !== undefined) {
      throw paymentError('POS_PAYMENT_AMOUNT_INVALID', `Payment ${index + 1} cannot include cash tender for ${payment.method}.`);
    }

    return { method: payment.method, amount: payment.amount, tendered, changeGiven };
  });

  if (allocatedTotal > invoiceTotal) {
    throw paymentError('POS_PAYMENT_TOTAL_EXCEEDS_INVOICE', 'Allocated payment amounts cannot exceed the invoice total.');
  }

  const changeGiven = normalizedPayments.reduce((total, payment) => total + payment.changeGiven, 0);
  return {
    invoiceTotal,
    allocatedTotal,
    balanceDue: invoiceTotal - allocatedTotal,
    cashTenderedTotal,
    changeGiven,
    payments: normalizedPayments,
  };
}

module.exports = {
  PAYMENT_METHODS,
  PAYMENT_METHOD_REGISTRY,
  PROVIDER_ADAPTERS,
  API_UNAVAILABLE_MESSAGE,
  getPaymentSettings,
  getProviderStatus,
  listPaymentRegisters,
  savePaymentSettings,
  resolveEnabledMethods,
  getEffectiveMethodRegistry,
  resolvePaymentFlow,
  isPaymentMethodEnabled,
  assertPaymentMethodEnabled,
  validateTenderConfiguration,
  requestProviderPayment,
  calculatePaymentTotals,
  normalizeWriteOffApprovalThresholds,
  resolveWriteOffApprovalThreshold,
};
