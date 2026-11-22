'use strict';

const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
const { writePosAuditLog, requestIp } = require('./posAuditService');
const accountingProfileService = require('./posAccountingProfileService');

const DEFAULT_SETTINGS = Object.freeze({
  tipsEnabled: false,
  tipAttribution: 'closing_waiter',
  largeTipConfirmationPct: 100,
  serviceChargeMode: 'off',
  serviceChargeRatePct: null,
  serviceChargeRateByTillType: {},
  serviceChargeRateByRegister: {},
  serviceChargeTaxable: null,
  serviceChargeTaxRateId: null,
});
const ALLOWED_FIELDS = new Set(Object.keys(DEFAULT_SETTINGS));

function settingsError(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRate(value, label, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined || value === '')) return null;
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100 || !/^\d{1,3}(?:\.\d{1,4})?$/.test(String(value))) {
    throw settingsError('RESTAURANT_BILLING_SETTINGS_INVALID', `${label} must be a percentage from 0 to 100 with up to 4 decimal places.`);
  }
  return rate;
}

function normalizeRateOverrides(value, label) {
  if (value == null) return {};
  if (!isRecord(value) || Object.keys(value).length > 500) {
    throw settingsError('RESTAURANT_BILLING_SETTINGS_INVALID', `${label} must be an object with no more than 500 entries.`);
  }
  return Object.fromEntries(Object.entries(value).map(([scopeId, rate]) => {
    const key = String(scopeId).trim();
    if (!key || key.length > 100) {
      throw settingsError('RESTAURANT_BILLING_SETTINGS_INVALID', `${label} contains an invalid scope key.`);
    }
    return [key, normalizeRate(rate, `${label} rate`)];
  }));
}

function normalizeSettings(input) {
  if (!isRecord(input)) {
    throw settingsError('RESTAURANT_BILLING_SETTINGS_INVALID', 'Restaurant billing settings must be an object.');
  }
  const unsupported = Object.keys(input).find((key) => !ALLOWED_FIELDS.has(key));
  if (unsupported) {
    throw settingsError('RESTAURANT_BILLING_SETTINGS_INVALID', `Unsupported Restaurant billing setting: ${unsupported}.`);
  }
  const settings = {
    ...DEFAULT_SETTINGS,
    tipsEnabled: input.tipsEnabled ?? DEFAULT_SETTINGS.tipsEnabled,
    tipAttribution: input.tipAttribution ?? DEFAULT_SETTINGS.tipAttribution,
    largeTipConfirmationPct: input.largeTipConfirmationPct ?? DEFAULT_SETTINGS.largeTipConfirmationPct,
    serviceChargeMode: input.serviceChargeMode ?? DEFAULT_SETTINGS.serviceChargeMode,
    serviceChargeRatePct: input.serviceChargeRatePct ?? null,
    serviceChargeRateByTillType: normalizeRateOverrides(
      input.serviceChargeRateByTillType,
      'Till-type service-charge overrides',
    ),
    serviceChargeRateByRegister: normalizeRateOverrides(
      input.serviceChargeRateByRegister,
      'Register service-charge overrides',
    ),
    serviceChargeTaxable: input.serviceChargeTaxable ?? null,
    serviceChargeTaxRateId: input.serviceChargeTaxRateId == null || input.serviceChargeTaxRateId === ''
      ? null
      : String(input.serviceChargeTaxRateId).trim(),
  };
  if (typeof settings.tipsEnabled !== 'boolean') {
    throw settingsError('RESTAURANT_BILLING_SETTINGS_INVALID', 'Tips must be enabled or disabled explicitly.');
  }
  if (!['closing_waiter', 'table_waiter'].includes(settings.tipAttribution)) {
    throw settingsError('RESTAURANT_BILLING_SETTINGS_INVALID', 'Choose whether tips belong to the cashier closing the check or the table waiter.');
  }
  if (!/^\d{1,4}(?:\.\d{1,4})?$/.test(String(settings.largeTipConfirmationPct))
    || !Number.isFinite(Number(settings.largeTipConfirmationPct))
    || Number(settings.largeTipConfirmationPct) < 1
    || Number(settings.largeTipConfirmationPct) > 1000) {
    throw settingsError('RESTAURANT_BILLING_SETTINGS_INVALID', 'The large-tip confirmation threshold must be between 1 and 1000 percent.');
  }
  settings.largeTipConfirmationPct = Number(settings.largeTipConfirmationPct);
  if (!['off', 'income', 'pass-through'].includes(settings.serviceChargeMode)) {
    throw settingsError('RESTAURANT_BILLING_SETTINGS_INVALID', 'Service-charge mode must be off, income, or pass-through.');
  }
  settings.serviceChargeRatePct = normalizeRate(
    settings.serviceChargeRatePct,
    'Service-charge rate',
    { nullable: true },
  );
  if (settings.serviceChargeMode !== 'off') {
    if (settings.serviceChargeRatePct === null || settings.serviceChargeRatePct <= 0) {
      throw settingsError('RESTAURANT_BILLING_SETTINGS_INVALID', 'Set a positive company service-charge percentage before enabling the charge.');
    }
    if (typeof settings.serviceChargeTaxable !== 'boolean') {
      throw settingsError('RESTAURANT_BILLING_TAX_POLICY_REQUIRED', 'Choose whether the service charge is taxable before enabling it.');
    }
    if (!/^[a-f\d]{24}$/i.test(settings.serviceChargeTaxRateId || '')) {
      throw settingsError('RESTAURANT_BILLING_TAX_CLASS_REQUIRED', 'Choose an existing tax class for the service charge before enabling it.');
    }
  }
  for (const [label, overrides] of [
    ['Register', settings.serviceChargeRateByRegister],
    ['Till-type', settings.serviceChargeRateByTillType],
  ]) {
    if (Object.values(overrides).some((rate) => rate > 100)) {
      throw settingsError('RESTAURANT_BILLING_SETTINGS_INVALID', `${label} service-charge rates cannot exceed 100 percent.`);
    }
  }
  return settings;
}

function effectiveRate(settings, { tillType, registerId } = {}) {
  if (registerId && settings.serviceChargeRateByRegister?.[String(registerId)] != null) {
    return settings.serviceChargeRateByRegister[String(registerId)];
  }
  if (tillType && settings.serviceChargeRateByTillType?.[String(tillType)] != null) {
    return settings.serviceChargeRateByTillType[String(tillType)];
  }
  return settings.serviceChargeRatePct;
}

function accountIssue(profile, key, scope) {
  try {
    accountingProfileService.assertAccountMappings(profile, [key], scope);
    return null;
  } catch (error) {
    return { key, message: error.message };
  }
}

function requiredChargeAccount(mode) {
  if (mode === 'income') return 'serviceChargeIncome';
  if (mode === 'pass-through') return 'serviceChargePayable';
  return null;
}

async function loadCompanyData(companyId, client = prisma) {
  const [row, registers, taxClasses, profile] = await Promise.all([
    client.restaurantBillingSettings.findUnique({ where: { companyId } }),
    client.posRegister.findMany({
      where: { companyId, systemTillType: 'restaurant', isActive: true },
      select: { id: true, code: true, name: true, systemTillType: true },
      orderBy: [{ name: 'asc' }, { code: 'asc' }],
    }),
    client.taxRate.findMany({
      where: { companyId, isActive: true },
      select: { id: true, code: true, name: true, ratePct: true, effectiveFrom: true, effectiveTo: true },
      orderBy: [{ name: 'asc' }, { code: 'asc' }],
    }),
    accountingProfileService.getProfile(companyId, client),
  ]);
  const settings = normalizeSettings(row ? {
    tipsEnabled: row.tipsEnabled,
    tipAttribution: row.tipAttribution,
    largeTipConfirmationPct: Number(row.largeTipConfirmationPct),
    serviceChargeMode: row.serviceChargeMode,
    serviceChargeRatePct: row.serviceChargeRatePct == null ? null : Number(row.serviceChargeRatePct),
    serviceChargeRateByTillType: row.serviceChargeRateByTillType,
    serviceChargeRateByRegister: row.serviceChargeRateByRegister,
    serviceChargeTaxable: row.serviceChargeTaxable,
    serviceChargeTaxRateId: row.serviceChargeTaxRateId,
  } : DEFAULT_SETTINGS);
  const accountRequirements = [];
  for (const register of registers) {
    const scope = {
      tillType: String(register.systemTillType || 'restaurant').toLowerCase(),
      registerId: String(register.id),
    };
    const missing = [];
    if (settings.tipsEnabled) {
      for (const key of ['tipsPayable', 'posRegisterCash']) {
        const issue = accountIssue(profile, key, scope);
        if (issue) missing.push(issue);
      }
    }
    const chargeKey = requiredChargeAccount(settings.serviceChargeMode);
    if (chargeKey) {
      const issue = accountIssue(profile, chargeKey, scope);
      if (issue) missing.push(issue);
      if (effectiveRate(settings, scope) == null) {
        missing.push({ key: 'serviceChargeRatePct', message: `${register.name}: a service-charge rate is not configured.` });
      }
    }
    accountRequirements.push({
      registerId: String(register.id),
      registerName: register.name,
      missingMappings: missing,
      ready: missing.length === 0,
    });
  }
  return {
    ...settings,
    registers: accountRequirements,
    taxClasses: taxClasses.map((taxClass) => ({
      id: taxClass.id,
      code: taxClass.code,
      name: taxClass.name,
      ratePct: Number(taxClass.ratePct),
      effectiveFrom: taxClass.effectiveFrom,
      effectiveTo: taxClass.effectiveTo,
    })),
  };
}

async function validateEnabledScopes(companyId, settings, profile, client) {
  const registers = await client.posRegister.findMany({
    where: { companyId, systemTillType: 'restaurant', isActive: true },
    select: { id: true, name: true, systemTillType: true },
  });
  const accountKey = requiredChargeAccount(settings.serviceChargeMode);
  const missing = [];
  for (const register of registers) {
    const scope = {
      tillType: String(register.systemTillType || 'restaurant').toLowerCase(),
      registerId: String(register.id),
    };
    const keys = [
      ...(settings.tipsEnabled ? ['tipsPayable', 'posRegisterCash'] : []),
      ...(accountKey ? [accountKey] : []),
    ];
    for (const key of keys) {
      const issue = accountIssue(profile, key, scope);
      if (issue) missing.push({ ...issue, registerName: register.name });
    }
    if (accountKey && effectiveRate(settings, scope) == null) {
      missing.push({
        key: 'serviceChargeRatePct',
        registerName: register.name,
        message: `${register.name}: a service-charge rate is not configured.`,
      });
    }
  }
  if (missing.length) {
    throw Object.assign(
      settingsError('RESTAURANT_BILLING_ACCOUNT_MAPPING_REQUIRED', 'Complete the required Restaurant account mappings for every active Restaurant register before enabling these features.'),
      { validationErrors: missing },
    );
  }
  if (settings.serviceChargeMode !== 'off') {
    const taxClass = await client.taxRate.findFirst({
      where: { id: settings.serviceChargeTaxRateId, companyId, isActive: true },
      select: { id: true, code: true, ratePct: true, effectiveFrom: true, effectiveTo: true },
    });
    const now = new Date();
    const validDate = taxClass
      && taxClass.effectiveFrom <= now
      && (!taxClass.effectiveTo || taxClass.effectiveTo > now);
    if (!validDate) {
      throw settingsError('RESTAURANT_BILLING_TAX_CLASS_INVALID', 'The selected service-charge tax class is inactive or not effective.');
    }
    const rate = Number(taxClass.ratePct);
    if ((settings.serviceChargeTaxable && rate <= 0) || (!settings.serviceChargeTaxable && rate !== 0)) {
      throw settingsError('RESTAURANT_BILLING_TAX_CLASS_INVALID', 'Choose an existing tax class whose rate matches the explicit taxable setting.');
    }
  }
}

async function getSettings(companyId) {
  if (!companyId) throw settingsError('RESTAURANT_COMPANY_REQUIRED', 'A company is required to load Restaurant billing settings.');
  return loadCompanyData(String(companyId));
}

async function saveSettings(companyIdValue, userId, payload, req) {
  const companyId = String(companyIdValue || '');
  if (!/^[a-f\d]{24}$/i.test(companyId)) {
    throw settingsError('RESTAURANT_COMPANY_REQUIRED', 'Select a valid company before editing Restaurant billing settings.');
  }
  if (!userId) throw settingsError('RESTAURANT_BILLING_SETTINGS_INVALID', 'A signed-in manager is required to update Restaurant billing settings.');
  const settings = normalizeSettings(payload);
  const registers = await prisma.posRegister.findMany({
    where: { companyId },
    select: { id: true },
  });
  const registerIds = new Set(registers.map((register) => String(register.id)));
  const invalidOverride = Object.keys(settings.serviceChargeRateByRegister).find((id) => !registerIds.has(id));
  if (invalidOverride) {
    throw settingsError('RESTAURANT_BILLING_REGISTER_INVALID', 'A service-charge rate override refers to a register outside this company.');
  }
  const profile = await accountingProfileService.getProfile(companyId);
  return prisma.$transaction(async (tx) => {
    await validateEnabledScopes(companyId, settings, profile, tx);
    const beforeRow = await tx.restaurantBillingSettings.findUnique({ where: { companyId } });
    const saved = await tx.restaurantBillingSettings.upsert({
      where: { companyId },
      create: {
        companyId,
        ...settings,
        updatedById: String(userId),
      },
      update: {
        ...settings,
        updatedById: String(userId),
      },
    });
    await writePosAuditLog({
      companyId,
      userId: String(userId),
      registerId: req?.body?.registerId || null,
      event: 'RESTAURANT_BILLING_SETTINGS_UPDATED',
      metadata: {
        before: beforeRow ? {
          tipsEnabled: beforeRow.tipsEnabled,
          tipAttribution: beforeRow.tipAttribution,
          largeTipConfirmationPct: beforeRow.largeTipConfirmationPct,
          serviceChargeMode: beforeRow.serviceChargeMode,
          serviceChargeRatePct: beforeRow.serviceChargeRatePct,
          serviceChargeTaxable: beforeRow.serviceChargeTaxable,
          serviceChargeTaxRateId: beforeRow.serviceChargeTaxRateId,
        } : null,
        after: settings,
      },
      ip: requestIp(req),
    }, tx);
    return saved;
  });
}

module.exports = {
  DEFAULT_SETTINGS,
  normalizeSettings,
  effectiveRate,
  getSettings,
  saveSettings,
};
