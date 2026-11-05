'use strict';

const posPaymentService = require('../services/posPaymentService');
const { requestIp } = require('../services/posAuditService');

const SETTINGS_VALIDATION_ERRORS = new Set([
  'POS_PAYMENT_COMPANY_REQUIRED',
  'POS_PAYMENT_PROVIDER_NOT_CONFIGURED',
  'POS_PAYMENT_API_UNAVAILABLE',
  'POS_PAYMENT_REGISTER_METHOD_DISABLED',
  'POS_PAYMENT_REGISTER_METHOD_REQUIRED',
  'POS_PAYMENT_REGISTER_OVERRIDE_INVALID',
  'POS_PAYMENT_AUDIT_CONTEXT_REQUIRED',
  'POS_PAYMENT_SETTINGS_INVALID',
]);

function sendKnownError(res, error) {
  if (SETTINGS_VALIDATION_ERRORS.has(error.code)) return sendValidationError(res, error);
  if (['POS_PROVIDER_ENCRYPTION_KEY_REQUIRED', 'POS_PROVIDER_ENCRYPTION_KEY_INVALID', 'POS_PROVIDER_CONFIG_DECRYPT_FAILED'].includes(error.code)) {
    return res.status(503).json({ success: false, code: error.code, message: error.message });
  }
  return null;
}

function companyIdFromSession(req) {
  return String(req.posAuthContext?.company?.id || '');
}

function companyIdFromUser(req) {
  return String(req.user?.company?._id || req.user?.company?.id || req.user?.companyId || req.companyId || '');
}

function publicSettings(settings) {
  const providerMethods = ['MTN_MOMO', 'AIRTEL_MONEY'];
  const isConfigured = (method) => settings.providers?.[method]?.configured === true;
  const filterUnavailableProviders = (methods) => methods.filter(
    (method) => !providerMethods.includes(method) || isConfigured(method),
  );
  return {
    enabledMethods: filterUnavailableProviders(settings.enabledMethods),
    registerOverrides: Object.fromEntries(
      Object.entries(settings.registerOverrides).map(([registerId, methods]) => [
        registerId,
        filterUnavailableProviders(methods),
      ]),
    ),
    paymentFlow: settings.paymentFlow,
    registerPaymentFlowOverrides: settings.registerPaymentFlowOverrides,
    pendingSaleExpiryPolicy: settings.pendingSaleExpiryPolicy,
    pendingSaleMaxAgeHours: settings.pendingSaleMaxAgeHours,
    paidSaleRefundApprovalAmount: settings.paidSaleRefundApprovalAmount,
    paidSaleRefundApprovalCount: settings.paidSaleRefundApprovalCount,
    posReturnWindowDays: settings.posReturnWindowDays,
    writeOffApprovalThresholdRwf: settings.writeOffApprovalThresholdRwf,
    writeOffApprovalThresholdByTillType: settings.writeOffApprovalThresholdByTillType,
    momoTimeoutSec: settings.momoTimeoutSec,
    cashRounding: settings.cashRounding,
    allowOverCreditLimit: settings.allowOverCreditLimit,
    bankTransferNeedsConfirm: settings.bankTransferNeedsConfirm,
    providerEnvironment: settings.providerEnvironment,
    manualMobileMoneyMode: settings.manualMobileMoneyMode,
    manualMobileMoneyReceivers: settings.manualMobileMoneyReceivers,
    automaticConfirmationAvailable: false,
    providers: Object.fromEntries(providerMethods.map((method) => [
      method,
      { configured: settings.providers?.[method]?.configured === true },
    ])),
  };
}

function sendValidationError(res, error) {
  return res.status(400).json({
    success: false,
    code: error.code,
    message: error.message,
  });
}

exports.getSettings = async (req, res, next) => {
  try {
    const companyId = companyIdFromSession(req);
    const [settings, registers] = await Promise.all([
      posPaymentService.getPaymentSettings(companyId),
      posPaymentService.listPaymentRegisters(companyId),
    ]);
    return res.json({
      success: true,
      data: {
        settings: publicSettings(settings),
        registers: registers.map(({ id, code, name, isActive, systemTillType }) => ({
          id, code, name, isActive, systemTillType: systemTillType || 'retail',
        })),
      },
    });
  } catch (error) {
    const knownError = sendKnownError(res, error);
    if (knownError) return knownError;
    return next(error);
  }
};

exports.getMethods = async (req, res, next) => {
  try {
    const context = req.posAuthContext;
    const settings = await posPaymentService.getPaymentSettings(companyIdFromSession(req));
    return res.json({
      success: true,
      data: {
        registerId: String(context.register.id),
        methods: posPaymentService.resolveEnabledMethods(settings, String(context.register.id)),
        paymentFlow: posPaymentService.resolvePaymentFlow(settings, String(context.register.id)),
        providerEnvironment: settings.providerEnvironment,
        manualMobileMoneyMode: settings.manualMobileMoneyMode,
        manualMobileMoneyReceivers: settings.manualMobileMoneyReceivers,
        automaticConfirmationAvailable: false,
      },
    });
  } catch (error) {
    const knownError = sendKnownError(res, error);
    if (knownError) return knownError;
    return next(error);
  }
};

exports.updateSettings = async (req, res, next) => {
  try {
    const context = req.posAuthContext;
    const settings = await posPaymentService.savePaymentSettings({
      companyId: companyIdFromSession(req),
      settings: req.body,
      userId: String(context.user.id),
      registerId: String(context.register.id),
      ip: requestIp(req),
    });
    return res.json({ success: true, data: publicSettings(settings) });
  } catch (error) {
    const knownError = sendKnownError(res, error);
    if (knownError) return knownError;
    return next(error);
  }
};

exports.getAdminSettings = async (req, res, next) => {
  try {
    const companyId = companyIdFromUser(req);
    const [settings, registers] = await Promise.all([
      posPaymentService.getPaymentSettings(companyId),
      posPaymentService.listPaymentRegisters(companyId),
    ]);
    return res.json({
      success: true,
      data: {
        settings: publicSettings(settings),
        registers: registers.map(({ id, code, name, isActive, systemTillType }) => ({
          id, code, name, isActive, systemTillType: systemTillType || 'retail',
        })),
      },
    });
  } catch (error) {
    const knownError = sendKnownError(res, error);
    if (knownError) return knownError;
    return next(error);
  }
};

exports.updateAdminSettings = async (req, res, next) => {
  try {
    const companyId = companyIdFromUser(req);
    const registerId = String(req.body?.registerId || '');
    const userId = String(req.user?.id || req.user?._id || '');
    if (!/^[a-f\d]{24}$/i.test(registerId)) {
      return res.status(400).json({
        success: false,
        code: 'POS_PAYMENT_REGISTER_REQUIRED',
        message: 'Select a valid POS register to audit this payment-settings change.',
      });
    }
    const registers = await posPaymentService.listPaymentRegisters(companyId);
    if (!registers.some((register) => String(register.id) === registerId)) {
      return res.status(404).json({
        success: false,
        code: 'POS_PAYMENT_REGISTER_NOT_FOUND',
        message: 'The selected POS register does not belong to this company.',
      });
    }
    const settings = await posPaymentService.savePaymentSettings({
      companyId,
      settings: req.body?.settings,
      userId,
      registerId,
      ip: requestIp(req),
    });
    return res.json({ success: true, data: publicSettings(settings) });
  } catch (error) {
    const knownError = sendKnownError(res, error);
    if (knownError) return knownError;
    return next(error);
  }
};
