'use strict';

const { dbClient } = require('../lib/prisma');
const { runInTransaction } = require('./transactionService');
const { writePosAuditLog } = require('./posAuditService');
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
  'CREDIT',
  'GIFT_CARD',
  'STORE_CREDIT',
  'LOYALTY_POINTS',
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
  momoTimeoutSec: true,
  cashRounding: true,
  allowOverCreditLimit: true,
  bankTransferNeedsConfirm: true,
  providerEnvironment: true,
  manualMobileMoneyMode: true,
  manualMobileMoneyReceivers: true,
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
  'momoTimeoutSec',
  'cashRounding',
  'allowOverCreditLimit',
  'bankTransferNeedsConfirm',
  'providerEnvironment',
  'manualMobileMoneyMode',
  'manualMobileMoneyReceivers',
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

function providerStatuses(receivers = {}, mode = 'VERIFY') {
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
      momoTimeoutSec: 120,
      cashRounding: null,
      allowOverCreditLimit: false,
      bankTransferNeedsConfirm: true,
      providerEnvironment: 'sandbox',
      manualMobileMoneyMode: 'VERIFY',
      manualMobileMoneyReceivers: {},
      providers: providerStatuses({}, 'VERIFY'),
    };
  }

  const enabledMethods = normalizeMethodList(settings.enabledMethods, 'enabledMethods');
  const registerOverrides = normalizeRegisterOverrides(settings.registerOverrides);
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
  const manualMobileMoneyMode = settings.manualMobileMoneyMode ?? 'VERIFY';
  if (!['INSTANT', 'VERIFY'].includes(manualMobileMoneyMode)) {
    throw paymentError('POS_PAYMENT_SETTINGS_INVALID', 'manualMobileMoneyMode must be INSTANT or VERIFY.');
  }
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
    momoTimeoutSec: settings.momoTimeoutSec,
    cashRounding: settings.cashRounding ?? null,
    allowOverCreditLimit: settings.allowOverCreditLimit,
    bankTransferNeedsConfirm: settings.bankTransferNeedsConfirm,
    providerEnvironment: settings.providerEnvironment,
    manualMobileMoneyMode,
    manualMobileMoneyReceivers,
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
    const missingReturnWindowColumn = error?.code === 'P2022'
      && String(error?.meta?.column || '').includes('pos_return_window_days');
    if (!missingReturnWindowColumn) throw error;
    const legacySelect = { ...PAYMENT_SETTINGS_SELECT };
    delete legacySelect.posReturnWindowDays;
    settings = await dbClient().posPaymentSettings.findUnique({
      where: { companyId: scopedCompanyId },
      select: legacySelect,
    });
    return normalizeSettings(settings ? { ...settings, posReturnWindowDays: 30 } : null);
  }
  if (!settings) return normalizeSettings(null);
  return normalizeSettings(settings);
}

async function listPaymentRegisters(companyId) {
  const scopedCompanyId = requireCompanyId(companyId);
  const registers = await dbClient().posRegister.findMany({
    where: { companyId: scopedCompanyId },
    select: { id: true, code: true, name: true, isActive: true },
    orderBy: [{ name: 'asc' }, { code: 'asc' }],
    take: 501,
  });
  if (registers.length > 500) {
    throw paymentError('POS_PAYMENT_SETTINGS_INVALID', 'Payment settings cannot be loaded for more than 500 POS registers.');
  }
  return registers;
}

function safeSettingsSnapshot(settings) {
  const { providers, ...safeSettings } = normalizeSettings(settings);
  return { ...safeSettings, providers };
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
    enabledMethods: normalized.enabledMethods,
    registerOverrides: normalized.registerOverrides,
    paymentFlow: normalized.paymentFlow,
    registerPaymentFlowOverrides: normalized.registerPaymentFlowOverrides,
    pendingSaleExpiryPolicy: normalized.pendingSaleExpiryPolicy,
    pendingSaleMaxAgeHours: normalized.pendingSaleMaxAgeHours,
    paidSaleRefundApprovalAmount: normalized.paidSaleRefundApprovalAmount,
    paidSaleRefundApprovalCount: normalized.paidSaleRefundApprovalCount,
    posReturnWindowDays: normalized.posReturnWindowDays,
    momoTimeoutSec: normalized.momoTimeoutSec,
    cashRounding: normalized.cashRounding,
    allowOverCreditLimit: normalized.allowOverCreditLimit,
    bankTransferNeedsConfirm: normalized.bankTransferNeedsConfirm,
    providerEnvironment: normalized.providerEnvironment,
    manualMobileMoneyMode: normalized.manualMobileMoneyMode,
    manualMobileMoneyReceivers: normalized.manualMobileMoneyReceivers,
  };

  return runInTransaction(async (tx) => {
    const registers = await tx.posRegister.findMany({
      where: { companyId: scopedCompanyId },
      select: { id: true, isActive: true },
      take: 501,
    });
    if (registers.length > 500) {
      throw paymentError('POS_PAYMENT_SETTINGS_INVALID', 'Payment settings cannot be saved for more than 500 POS registers.');
    }
    const registerById = new Map(registers.map((register) => [register.id, register]));
    const unknownRegister = [...registerIds, ...flowRegisterIds].find((id) => !registerById.has(id));
    if (unknownRegister) {
      throw paymentError(
        'POS_PAYMENT_REGISTER_OVERRIDE_INVALID',
        'A register payment override refers to a register that does not belong to this company.',
      );
    }
    for (const [id, methods] of Object.entries(normalized.registerOverrides)) {
      const disabledMethod = methods.find((method) => !normalized.enabledMethods.includes(method));
      if (disabledMethod) {
        throw paymentError(
          'POS_PAYMENT_REGISTER_METHOD_DISABLED',
          `Register overrides cannot enable ${disabledMethod} when the company has disabled it.`,
        );
      }
      if (registerById.get(id)?.isActive && methods.length === 0) {
        throw paymentError(
          'POS_PAYMENT_REGISTER_METHOD_REQUIRED',
          'Each active POS register must have at least one enabled payment method.',
        );
      }
    }
    for (const register of registers) {
      const flow = normalized.registerPaymentFlowOverrides[register.id] ?? normalized.paymentFlow;
      const methods = normalized.registerOverrides[register.id] ?? normalized.enabledMethods;
      if (register.isActive && flow === 'PAYMENTS_V2' && !methods.includes('CASH')) {
        throw paymentError(
          'POS_PAYMENT_REGISTER_METHOD_REQUIRED',
          'Each register using V2 payments must have cash enabled.',
        );
      }
    }
    const emptyRegister = registers.find((register) => register.isActive
      && (normalized.registerOverrides[register.id] ?? normalized.enabledMethods).length === 0);
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
    assertProviderMethodsConfigured(
      normalized.enabledMethods,
      normalized.manualMobileMoneyReceivers,
    );
    for (const methods of Object.values(normalized.registerOverrides)) {
      assertProviderMethodsConfigured(methods, normalized.manualMobileMoneyReceivers);
    }
    const before = safeSettingsSnapshot(beforeRow);
    const savedSettings = await tx.posPaymentSettings.upsert({
      where: { companyId: scopedCompanyId },
      create: { companyId: scopedCompanyId, ...data },
      update: data,
      select: PAYMENT_SETTINGS_SELECT,
    });
    const after = safeSettingsSnapshot(savedSettings);
    await writePosAuditLog({
      companyId: scopedCompanyId,
      registerId,
      userId,
      event: 'PAYMENT_SETTINGS_UPDATED',
      metadata: { before, after },
      ip,
    }, tx);
    return after;
  });
}

function resolveEnabledMethods(settings, registerId) {
  const normalized = normalizeSettings(settings);
  const methods = registerId && Object.hasOwn(normalized.registerOverrides, registerId)
    ? normalized.registerOverrides[registerId]
    : normalized.enabledMethods;
  return methods.filter((method) => {
    return !PROVIDER_ADAPTERS[method] || normalized.providers[method]?.configured === true;
  });
}

function resolvePaymentFlow(settings, registerId) {
  const normalized = normalizeSettings(settings);
  return registerId && Object.hasOwn(normalized.registerPaymentFlowOverrides, registerId)
    ? normalized.registerPaymentFlowOverrides[registerId]
    : normalized.paymentFlow;
}

async function isPaymentMethodEnabled({ companyId, registerId, method }) {
  validateMethod(method);
  const settings = await getPaymentSettings(companyId);
  return resolveEnabledMethods(settings, registerId).includes(method);
}

async function assertPaymentMethodEnabled({ companyId, registerId, method }) {
  const settings = await getPaymentSettings(companyId);
  if (PROVIDER_ADAPTERS[method] && settings.providers[method]?.configured !== true) {
    throw paymentError(
      'POS_PAYMENT_PROVIDER_NOT_CONFIGURED',
      `${method === 'MTN_MOMO' ? 'MTN MoMo' : 'Airtel Money'} needs a receiving number or merchant code in POS payment settings.`,
    );
  }
  if (!resolveEnabledMethods(settings, registerId).includes(method)) {
    throw paymentError(
      'POS_PAYMENT_METHOD_DISABLED',
      `${method} is not enabled for this company or register. Ask a manager to review POS payment settings.`,
    );
  }
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
  PROVIDER_ADAPTERS,
  API_UNAVAILABLE_MESSAGE,
  getPaymentSettings,
  getProviderStatus,
  listPaymentRegisters,
  savePaymentSettings,
  resolveEnabledMethods,
  resolvePaymentFlow,
  isPaymentMethodEnabled,
  assertPaymentMethodEnabled,
  requestProviderPayment,
  calculatePaymentTotals,
};
