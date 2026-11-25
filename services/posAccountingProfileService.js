'use strict';

const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');

const MAPPING_MODULE = 'pos_accounting';
const ACCOUNT_FIELDS = Object.freeze([
  { key: 'posRegisterCash', label: 'Register cash', allowedTypes: ['asset'], required: true },
  { key: 'cardClearing', label: 'Card clearing', allowedTypes: ['asset'] },
  { key: 'mtnMoMo', label: 'MTN MoMo clearing', allowedTypes: ['asset'] },
  { key: 'airtelMoney', label: 'Airtel Money clearing', allowedTypes: ['asset'] },
  { key: 'cashAtBank', label: 'Bank transfer clearing', allowedTypes: ['asset'] },
  { key: 'chequesInHand', label: 'Cheques in hand', allowedTypes: ['asset'] },
  { key: 'bankDepositClearing', label: 'Bank deposit clearing (cash in transit)', allowedTypes: ['asset'] },
  { key: 'accountsReceivable', label: 'Accounts receivable', allowedTypes: ['asset'], required: true },
  { key: 'customerAdvances', label: 'Customer advances', allowedTypes: ['liability'] },
  { key: 'giftCardLiability', label: 'Gift card liability', allowedTypes: ['liability'] },
  { key: 'storeCreditLiability', label: 'Store credit liability', allowedTypes: ['liability'] },
  { key: 'loyaltyWalletLiability', label: 'Loyalty wallet liability', allowedTypes: ['liability'] },
  { key: 'loyaltyPointsLiability', label: 'Loyalty points liability', allowedTypes: ['liability'] },
  { key: 'loyaltyRewardsExpense', label: 'Loyalty rewards expense', allowedTypes: ['expense'] },
  { key: 'stockAdjustmentLoss', label: 'Stock adjustment loss', allowedTypes: ['cogs', 'expense'] },
  { key: 'inventory', label: 'Inventory', allowedTypes: ['asset'], required: true },
  { key: 'salesRevenue', label: 'Sales revenue', allowedTypes: ['revenue'], required: true },
  { key: 'vatOutput', label: 'VAT output', allowedTypes: ['liability'], required: true },
  { key: 'costOfGoodsSold', label: 'Cost of goods sold', allowedTypes: ['cogs', 'expense'], required: true },
  { key: 'tipsPayable', label: 'Tips payable', allowedTypes: ['liability'] },
  { key: 'serviceChargeIncome', label: 'Service charge income', allowedTypes: ['revenue'] },
  { key: 'serviceChargePayable', label: 'Service charge payable', allowedTypes: ['liability'] },
]);
const FIELD_BY_KEY = new Map(ACCOUNT_FIELDS.map((field) => [field.key, field]));

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cleanIdentifier(value, label) {
  const identifier = String(value || '').trim();
  if (!identifier || identifier.length > 100) {
    throw new TypeError(`${label} must be a non-empty value of at most 100 characters.`);
  }
  return identifier;
}

function mapScopeFields(value, scope, scopeId) {
  if (value == null) return {};
  if (!isRecord(value)) throw new TypeError(`${scope} mappings must be an object.`);
  const result = {};
  for (const [key, rawCode] of Object.entries(value)) {
    if (!FIELD_BY_KEY.has(key)) throw new TypeError(`Unknown POS accounting mapping: ${key}.`);
    if (rawCode == null || String(rawCode).trim() === '') continue;
    const accountCode = String(rawCode).trim();
    if (accountCode.length > 64) throw new TypeError(`Account code for ${key} is too long.`);
    result[key] = accountCode;
  }
  return result;
}

function normalizeProfile(profile) {
  if (!isRecord(profile)) throw new TypeError('The POS accounting profile must be an object.');
  const companyDefaults = mapScopeFields(profile.companyDefaults, 'Company', null);
  const tillTypeOverrides = {};
  const registerOverrides = {};

  for (const [rawTillType, fields] of Object.entries(profile.tillTypeOverrides || {})) {
    const tillType = cleanIdentifier(rawTillType, 'Till type');
    const mappedFields = mapScopeFields(fields, 'Till type', tillType);
    if (Object.keys(mappedFields).length) tillTypeOverrides[tillType] = mappedFields;
  }
  for (const [rawRegisterId, fields] of Object.entries(profile.registerOverrides || {})) {
    const registerId = cleanIdentifier(rawRegisterId, 'Register');
    const mappedFields = mapScopeFields(fields, 'Register', registerId);
    if (Object.keys(mappedFields).length) registerOverrides[registerId] = mappedFields;
  }

  return { companyDefaults, tillTypeOverrides, registerOverrides };
}

function mappingKey(scope, scopeId, fieldKey) {
  if (scope === 'company') return `company:${fieldKey}`;
  return `${scope}:${encodeURIComponent(scopeId)}:${fieldKey}`;
}

function profileFromRows(rows) {
  const profile = { companyDefaults: {}, tillTypeOverrides: {}, registerOverrides: {} };
  for (const row of rows) {
    const parts = String(row.key || '').split(':');
    let target;
    let fieldKey;
    if (parts.length === 2 && parts[0] === 'company') {
      target = profile.companyDefaults;
      fieldKey = parts[1];
    } else if (parts.length === 3 && ['till', 'register'].includes(parts[0])) {
      let scopeId;
      try {
        scopeId = decodeURIComponent(parts[1]);
      } catch {
        continue;
      }
      const groups = parts[0] === 'till' ? profile.tillTypeOverrides : profile.registerOverrides;
      target = groups[scopeId] || (groups[scopeId] = {});
      fieldKey = parts[2];
    } else {
      continue;
    }

    if (FIELD_BY_KEY.has(fieldKey) && (typeof row.accountCode === 'string' || typeof row.accountCode === 'number')) {
      target[fieldKey] = String(row.accountCode);
    }
  }
  return profile;
}

function allProfileValues(profile) {
  const values = [];
  for (const [key, accountCode] of Object.entries(profile.companyDefaults)) {
    values.push({ scope: 'company', scopeId: null, key, accountCode });
  }
  for (const [scopeId, fields] of Object.entries(profile.tillTypeOverrides)) {
    for (const [key, accountCode] of Object.entries(fields)) {
      values.push({ scope: 'till', scopeId, key, accountCode });
    }
  }
  for (const [scopeId, fields] of Object.entries(profile.registerOverrides)) {
    for (const [key, accountCode] of Object.entries(fields)) {
      values.push({ scope: 'register', scopeId, key, accountCode });
    }
  }
  return values;
}

function buildProfileStatus(profile, chartAccounts) {
  const accountsByCode = new Map(chartAccounts.map((account) => [String(account.code), account]));
  const validationErrors = [];
  for (const mapping of allProfileValues(profile)) {
    const definition = FIELD_BY_KEY.get(mapping.key);
    const account = accountsByCode.get(mapping.accountCode);
    const location = mapping.scope === 'company'
      ? 'Company defaults'
      : `${mapping.scope === 'till' ? 'Till type' : 'Register'} ${mapping.scopeId}`;
    if (!account) {
      validationErrors.push({ ...mapping, message: `${location}: account ${mapping.accountCode} was not found in this company.` });
    } else if (account.isActive === false) {
      validationErrors.push({ ...mapping, message: `${location}: account ${mapping.accountCode} is inactive.` });
    } else if (account.allowDirectPosting !== true) {
      validationErrors.push({ ...mapping, message: `${location}: account ${mapping.accountCode} does not allow direct posting.` });
    } else if (!definition.allowedTypes.includes(String(account.type).toLowerCase())) {
      validationErrors.push({
        ...mapping,
        message: `${location}: ${definition.label} must use ${definition.allowedTypes.join(' or ')} accounts; ${mapping.accountCode} is ${account.type}.`,
      });
    }
  }

  const missingMappings = ACCOUNT_FIELDS
    .filter((field) => field.required && !profile.companyDefaults[field.key])
    .map(({ key, label }) => ({ key, label }));
  return {
    isComplete: missingMappings.length === 0 && validationErrors.length === 0,
    missingMappings,
    validationErrors,
  };
}

async function validateRegisterOverrides(companyId, registerOverrides, client = prisma, { throwOnInvalid = true } = {}) {
  const registerIds = Object.keys(registerOverrides);
  if (!registerIds.length) return [];
  const registers = await client.posRegister.findMany({
    where: { companyId: String(companyId), id: { in: registerIds } },
    select: { id: true },
  });
  const validIds = new Set(registers.map((register) => String(register.id)));
  const invalidIds = registerIds.filter((registerId) => !validIds.has(registerId));
  if (invalidIds.length && throwOnInvalid) {
    const invalidId = invalidIds[0];
    const error = new TypeError(`Register ${invalidId} is not available in the selected company.`);
    error.code = 'POS_ACCOUNTING_REGISTER_INVALID';
    throw error;
  }
  return invalidIds;
}

async function validateProfile(companyId, profile, client = prisma, options = {}) {
  const invalidRegisterIds = await validateRegisterOverrides(
    companyId,
    profile.registerOverrides,
    client,
    { throwOnInvalid: options.throwOnInvalidRegister !== false },
  );
  const accountCodes = [...new Set(allProfileValues(profile).map((item) => item.accountCode))];
  const chartAccounts = accountCodes.length
    ? await client.chartOfAccount.findMany({
      where: { companyId: String(companyId), code: { in: accountCodes } },
      select: { code: true, type: true, isActive: true, allowDirectPosting: true },
    })
    : [];
  const status = buildProfileStatus(profile, chartAccounts);
  for (const registerId of invalidRegisterIds) {
    status.validationErrors.push({
      scope: 'register',
      scopeId: registerId,
      key: '__register__',
      accountCode: '',
      message: `Register ${registerId} is no longer available in this company. Clear its overrides to remove them.`,
    });
  }
  status.isComplete = status.missingMappings.length === 0 && status.validationErrors.length === 0;
  return status;
}

async function getProfile(companyId, client = prisma) {
  const rows = await client.accountMapping.findMany({
    where: { companyId: String(companyId), module: MAPPING_MODULE },
    select: { key: true, accountCode: true },
  });
  const profile = profileFromRows(rows);
  const status = await validateProfile(companyId, profile, client, { throwOnInvalidRegister: false });
  return { ...profile, ...status };
}

async function saveProfile(companyId, userId, payload) {
  const profile = normalizeProfile(payload);
  const status = await validateProfile(companyId, profile);
  if (status.validationErrors.length) {
    const error = new TypeError('Fix the invalid account mappings before saving.');
    error.code = 'POS_ACCOUNTING_PROFILE_INVALID';
    error.validationErrors = status.validationErrors;
    throw error;
  }

  const mappings = allProfileValues(profile);
  await prisma.$transaction(async (tx) => {
    await tx.accountMapping.deleteMany({
      where: { companyId: String(companyId), module: MAPPING_MODULE },
    });
    if (mappings.length) {
      await tx.accountMapping.createMany({
        data: mappings.map((mapping) => ({
          id: generateObjectId(),
          companyId: String(companyId),
          module: MAPPING_MODULE,
          key: mappingKey(mapping.scope, mapping.scopeId, mapping.key),
          accountCode: mapping.accountCode,
          description: `POS accounting ${mapping.scope} mapping: ${mapping.key}`,
          createdById: userId ? String(userId) : null,
        })),
      });
    }
  });

  return { ...profile, ...status };
}

function resolveAccount(profile, key, { tillType, registerId } = {}) {
  if (!FIELD_BY_KEY.has(key)) throw new TypeError(`Unknown POS accounting mapping: ${key}.`);
  if (registerId && profile.registerOverrides?.[String(registerId)]?.[key]) {
    return profile.registerOverrides[String(registerId)][key];
  }
  if (tillType && profile.tillTypeOverrides?.[String(tillType)]?.[key]) {
    return profile.tillTypeOverrides[String(tillType)][key];
  }
  return profile.companyDefaults?.[key] || null;
}

function assertAccountMappings(profile, keys, scope = {}) {
  const resolved = {};
  for (const key of keys) {
    const definition = FIELD_BY_KEY.get(key);
    if (!definition) throw new TypeError(`Unknown POS accounting mapping: ${key}.`);
    const accountCode = resolveAccount(profile, key, scope);
    if (!accountCode) {
      throw Object.assign(new TypeError(
        `Configure an account for ${definition.label} in the POS accounting profile before enabling Restaurant billing features.`,
      ), { code: 'POS_ACCOUNT_MAPPING_REQUIRED', key });
    }
    const invalid = (profile.validationErrors || []).find((error) => (
      error.key === key && String(error.accountCode) === String(accountCode)
    ));
    if (invalid) {
      throw Object.assign(new TypeError(
        `The ${definition.label} account is invalid: ${invalid.message}`,
      ), { code: 'POS_ACCOUNT_MAPPING_INVALID', key, accountCode });
    }
    resolved[key] = accountCode;
  }
  return resolved;
}

function mappingForTender(tender) {
  const method = String(tender.paymentMethod || tender.method || '').toLowerCase();
  if (method === 'cash') return { method, key: 'posRegisterCash' };
  if (method === 'card') return { method, key: 'cardClearing' };
  if (method === 'mobile_money') {
    const provider = String(tender.provider || '').toLowerCase();
    if (provider === 'airtel' || provider === 'airtel_money') return { method, key: 'airtelMoney' };
    if (provider === 'mtn' || provider === 'momo' || provider === 'mtn_momo') return { method, key: 'mtnMoMo' };
    if (!provider && tender.accountCode) {
      return { method, key: 'cashAtBank', accountCode: tender.accountCode };
    }
    throw Object.assign(new TypeError('A mobile money tender must identify its provider as MTN MoMo or Airtel.'), {
      code: 'POS_PAYMENT_ACCOUNT_MAPPING_REQUIRED',
    });
  }
  if (method === 'bank_transfer') {
    return { method, key: 'cashAtBank', accountCode: tender.accountCode || null };
  }
  if (method === 'cheque') return { method, key: 'chequesInHand' };
  if (method === 'gift_card') return { method, key: 'giftCardLiability' };
  if (method === 'store_credit') return { method, key: 'storeCreditLiability' };
  if (method === 'loyalty_wallet') return { method, key: 'loyaltyWalletLiability' };
  if (method === 'loyalty_points') return { method, key: 'loyaltyPointsLiability' };
  if (method === 'customer_credit' || method === 'credit') return { method, key: 'accountsReceivable' };
  if (method === 'insurance') return { method, key: 'accountsReceivable' };
  if (method === 'loyalty') return { method, key: 'customerAdvances' };
  return null;
}

async function assertTenderMappings(
  profile,
  tenders,
  scope = {},
  { requireAccountsReceivable = false } = {},
  client = prisma,
) {
  const requiredMappings = (tenders || []).map(mappingForTender).filter(Boolean);
  const directMappings = [];
  if (requireAccountsReceivable) {
    requiredMappings.push({ method: 'customer_credit', key: 'accountsReceivable' });
  }
  for (const mapping of requiredMappings) {
    const accountCode = mapping.accountCode || resolveAccount(profile, mapping.key, scope);
    if (!accountCode) {
      throw Object.assign(new TypeError(
        `Configure an account for ${FIELD_BY_KEY.get(mapping.key).label} in the POS accounting profile before posting this payment.`,
      ), { code: 'POS_PAYMENT_ACCOUNT_MAPPING_REQUIRED' });
    }
    const invalidMapping = (profile.validationErrors || []).find((error) => (
      error.key === mapping.key && String(error.accountCode) === String(accountCode)
    ));
    if (invalidMapping) {
      throw Object.assign(new TypeError(
        `The ${FIELD_BY_KEY.get(mapping.key).label} account is invalid: ${invalidMapping.message}`,
      ), { code: 'POS_PAYMENT_ACCOUNT_MAPPING_INVALID' });
    }
    if (mapping.accountCode) directMappings.push({ ...mapping, accountCode: String(accountCode) });
  }
  if (directMappings.length) {
    if (!scope.companyId) {
      throw Object.assign(new TypeError('A company is required to validate the selected POS payment account.'), {
        code: 'POS_PAYMENT_ACCOUNT_MAPPING_INVALID',
      });
    }
    const accounts = await client.chartOfAccount.findMany({
      where: {
        companyId: String(scope.companyId),
        code: { in: [...new Set(directMappings.map((mapping) => mapping.accountCode))] },
      },
      select: { code: true, type: true, isActive: true, allowDirectPosting: true },
    });
    const accountsByCode = new Map(accounts.map((account) => [String(account.code), account]));
    for (const mapping of directMappings) {
      const account = accountsByCode.get(mapping.accountCode);
      const definition = FIELD_BY_KEY.get(mapping.key);
      if (!account
        || account.isActive !== true
        || account.allowDirectPosting !== true
        || !definition.allowedTypes.includes(String(account.type).toLowerCase())) {
        throw Object.assign(new TypeError(
          `The selected account for ${definition.label} must be an active, directly-postable ${definition.allowedTypes.join(' or ')} account in this company.`,
        ), { code: 'POS_PAYMENT_ACCOUNT_MAPPING_INVALID' });
      }
    }
  }
}

module.exports = {
  ACCOUNT_FIELDS,
  MAPPING_MODULE,
  normalizeProfile,
  profileFromRows,
  buildProfileStatus,
  validateProfile,
  getProfile,
  saveProfile,
  resolveAccount,
  assertAccountMappings,
  assertTenderMappings,
};
