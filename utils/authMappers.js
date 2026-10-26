/**
 * Maps Prisma auth/tenancy rows to the legacy Mongoose JSON shapes the
 * frontend already consumes (Mongo `_id`, snake_case company fields, etc.).
 */

const { generateObjectId, toIdString } = require('./objectId');
const { mergeUpdatePayload } = require('./masterDataMappers');

function roleToApi(role) {
  if (!role) return null;
  if (typeof role === 'string') return role;
  return {
    _id: role.id,
    id: role.id,
    company_id: role.companyId ?? null,
    company: role.companyId ?? null,
    name: role.name,
    description: role.description ?? null,
    is_system_role: Boolean(role.isSystemRole),
    permissions: Array.isArray(role.permissions) ? role.permissions : [],
    createdAt: role.createdAt,
    updatedAt: role.updatedAt,
  };
}

/**
 * Legacy Mongo Company documents use snake_case for most fields with a few
 * camelCase exceptions (approvalStatus, isActive, createdAt, updatedAt).
 */
function companyToApi(company) {
  if (!company) return null;
  if (typeof company === 'string') return company;
  return {
    _id: company.id,
    id: company.id,
    name: company.name,
    code: company.code,
    legal_name: company.legalName ?? null,
    registration_number: company.registrationNumber ?? '',
    tax_identification_number: company.taxIdentificationNumber ?? '',
    email: company.email ?? null,
    phone: company.phone ?? '',
    website: company.website ?? '',
    address: company.address ?? {},
    logo_url: company.logoUrl ?? '',
    base_currency: company.baseCurrency ?? 'RWF',
    fiscal_year_start_month: company.fiscalYearStartMonth ?? 1,
    default_payment_terms_days: company.defaultPaymentTermsDays ?? 30,
    industry: company.industry ?? '',
    isActive: Boolean(company.isActive),
    approvalStatus: company.approvalStatus,
    registration_rejection_reason: company.registrationRejectionReason ?? null,
    is_vat_registered: Boolean(company.isVatRegistered),
    vat_rate_pct: company.vatRatePct ?? 18,
    setup_completed: Boolean(company.setupCompleted),
    setup_steps_completed: company.setupStepsCompleted ?? {},
    subscription_plan: company.subscriptionPlan ?? 'starter',
    subscription_status: company.subscriptionStatus ?? 'active',
    billing_cycle: company.billingCycle ?? 'monthly',
    // Decimal(19,4) in Postgres — frontend expects a plain number
    billing_amount: company.billingAmount != null ? Number(company.billingAmount) : 0,
    next_billing_date: company.nextBillingDate ?? null,
    feature_access: company.featureAccess ?? {},
    subscription_modules: company.subscriptionModules ?? [],
    platform_notes: company.platformNotes ?? '',
    ebm_enabled: company.ebmEnabled ?? true,
    ebm_toggle_reason: company.ebmToggleReason ?? null,
    ebm_toggle_changed_at: company.ebmToggleChangedAt ?? null,
    ebm_toggle_changed_by: company.ebmToggleChangedBy ?? null,
    rra_vsdc_approval_status: company.rraVsdcApprovalStatus ?? 'not_confirmed',
    rra_vsdc_approval_reference: company.rraVsdcApprovalReference ?? null,
    rra_vsdc_approval_reason: company.rraVsdcApprovalReason ?? null,
    rra_vsdc_approved_at: company.rraVsdcApprovedAt ?? null,
    rra_vsdc_approved_by: company.rraVsdcApprovedBy ?? null,
    last_payment_reminder_at: company.lastPaymentReminderAt ?? null,
    last_platform_message_at: company.lastPlatformMessageAt ?? null,
    trial_ends_at: company.trialEndsAt ?? null,
    created_by: company.createdById ?? null,
    createdAt: company.createdAt,
    updatedAt: company.updatedAt,
  };
}

/**
 * Maps a Prisma user row (optionally with `company` / `roles` / `createdBy`
 * relations included) to the legacy Mongoose `user.toJSON()` shape.
 * Secrets (password, refresh hashes, reset/2FA tokens) are always stripped.
 */
function userToApi(user) {
  if (!user) return null;
  const roles = Array.isArray(user.roles)
    ? user.roles
        .map((entry) => {
          if (!entry) return null;
          if (entry.role) return roleToApi(entry.role);
          if (entry.roleId) return toIdString(entry.roleId);
          return roleToApi(entry);
        })
        .filter(Boolean)
    : [];

  let createdBy = user.createdById ?? null;
  if (user.createdBy && typeof user.createdBy === 'object') {
    createdBy = {
      _id: user.createdBy.id,
      id: user.createdBy.id,
      name: user.createdBy.name,
      email: user.createdBy.email,
    };
  }

  return {
    _id: user.id,
    id: user.id,
    name: user.name,
    email: user.email,
    company: user.company && typeof user.company === 'object'
      ? companyToApi(user.company)
      : (user.companyId ?? null),
    role: user.role,
    roles,
    department: user.departmentId ?? null,
    branch: user.branchId ?? null,
    ebmBranchUsers: Array.isArray(user.ebmBranchUsers) ? user.ebmBranchUsers : [],
    isActive: Boolean(user.isActive),
    lastLogin: user.lastLogin ?? null,
    createdBy,
    mustChangePassword: Boolean(user.mustChangePassword),
    passwordChangedAt: user.passwordChangedAt ?? null,
    tempPassword: Boolean(user.tempPassword),
    avatar: user.avatar ?? null,
    phone: user.phone ?? null,
    jobTitle: user.jobTitle ?? null,
    bio: user.bio ?? null,
    twoFAEnabled: Boolean(user.twoFAEnabled),
    twoFAConfirmed: Boolean(user.twoFAConfirmed),
    ipWhitelist: user.ipWhitelist ?? [],
    failed_login_attempts: user.failedLoginAttempts ?? 0,
    locked_until: user.lockedUntil ?? null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

/** Whitelist-maps legacy snake_case company payloads to Prisma column names. */
function companyInputToPrisma(data = {}) {
  const map = {
    name: 'name',
    code: 'code',
    legal_name: 'legalName',
    legalName: 'legalName',
    registration_number: 'registrationNumber',
    registrationNumber: 'registrationNumber',
    tax_identification_number: 'taxIdentificationNumber',
    taxIdentificationNumber: 'taxIdentificationNumber',
    email: 'email',
    phone: 'phone',
    website: 'website',
    address: 'address',
    logo_url: 'logoUrl',
    logoUrl: 'logoUrl',
    base_currency: 'baseCurrency',
    baseCurrency: 'baseCurrency',
    fiscal_year_start_month: 'fiscalYearStartMonth',
    default_payment_terms_days: 'defaultPaymentTermsDays',
    industry: 'industry',
    isActive: 'isActive',
    is_active: 'isActive',
    approvalStatus: 'approvalStatus',
    registration_rejection_reason: 'registrationRejectionReason',
    is_vat_registered: 'isVatRegistered',
    vat_rate_pct: 'vatRatePct',
    setup_completed: 'setupCompleted',
    setup_steps_completed: 'setupStepsCompleted',
    subscription_plan: 'subscriptionPlan',
    subscription_status: 'subscriptionStatus',
    billing_cycle: 'billingCycle',
    billing_amount: 'billingAmount',
    next_billing_date: 'nextBillingDate',
    feature_access: 'featureAccess',
    subscription_modules: 'subscriptionModules',
    platform_notes: 'platformNotes',
    ebm_enabled: 'ebmEnabled',
    ebmEnabled: 'ebmEnabled',
    ebm_toggle_reason: 'ebmToggleReason',
    ebmToggleReason: 'ebmToggleReason',
    ebm_toggle_changed_at: 'ebmToggleChangedAt',
    ebmToggleChangedAt: 'ebmToggleChangedAt',
    ebm_toggle_changed_by: 'ebmToggleChangedBy',
    ebmToggleChangedBy: 'ebmToggleChangedBy',
    rra_vsdc_approval_status: 'rraVsdcApprovalStatus',
    rraVsdcApprovalStatus: 'rraVsdcApprovalStatus',
    rra_vsdc_approval_reference: 'rraVsdcApprovalReference',
    rraVsdcApprovalReference: 'rraVsdcApprovalReference',
    rra_vsdc_approval_reason: 'rraVsdcApprovalReason',
    rraVsdcApprovalReason: 'rraVsdcApprovalReason',
    rra_vsdc_approved_at: 'rraVsdcApprovedAt',
    rraVsdcApprovedAt: 'rraVsdcApprovedAt',
    rra_vsdc_approved_by: 'rraVsdcApprovedBy',
    rraVsdcApprovedBy: 'rraVsdcApprovedBy',
    last_payment_reminder_at: 'lastPaymentReminderAt',
    last_platform_message_at: 'lastPlatformMessageAt',
    trial_ends_at: 'trialEndsAt',
  };
  const out = {};
  for (const [key, value] of Object.entries(data)) {
    const target = map[key];
    if (!target || value === undefined) continue;
    if (['nextBillingDate', 'trialEndsAt', 'lastPaymentReminderAt', 'lastPlatformMessageAt'].includes(target)) {
      out[target] = value ? new Date(value) : null;
    } else {
      out[target] = value;
    }
  }
  return out;
}

/** Whitelist-maps legacy user update payloads to Prisma column names. */
function userInputToPrisma(data = {}) {
  const map = {
    name: 'name',
    email: 'email',
    role: 'role',
    isActive: 'isActive',
    avatar: 'avatar',
    phone: 'phone',
    jobTitle: 'jobTitle',
    bio: 'bio',
    department: 'departmentId',
    branch: 'branchId',
    defaultWarehouse: 'branchId',
    mustChangePassword: 'mustChangePassword',
    tempPassword: 'tempPassword',
    twoFAEnabled: 'twoFAEnabled',
    twoFAConfirmed: 'twoFAConfirmed',
    ipWhitelist: 'ipWhitelist',
  };
  const out = {};
  for (const [key, value] of Object.entries(data)) {
    const target = map[key];
    if (!target || value === undefined) continue;
    if (target === 'email' && value) {
      out.email = String(value).toLowerCase();
    } else if (['departmentId', 'branchId'].includes(target)) {
      out[target] = value ? toIdString(value) : null;
    } else {
      out[target] = value;
    }
  }
  return out;
}

function ipWhitelistToApi(entry) {
  if (!entry) return null;
  return {
    _id: entry.id,
    id: entry.id,
    ip: entry.ip,
    company: entry.companyId ?? null,
    companyId: entry.companyId ?? null,
    description: entry.description ?? null,
    enabled: entry.enabled,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

const IP_WHITELIST_FIELDS = {
  ip: 'ip',
  description: 'description',
  enabled: 'enabled',
};

function ipWhitelistTranslateCreate(data = {}) {
  const companyId = data.company ?? data.companyId ?? null;
  return {
    id: toIdString(data._id || data.id) || generateObjectId(),
    ip: String(data.ip || '').trim(),
    companyId: companyId ? toIdString(companyId) : null,
    description: data.description ?? null,
    enabled: data.enabled === undefined ? true : Boolean(data.enabled),
  };
}

function ipWhitelistTranslateUpdate(update = {}) {
  const merged = mergeUpdatePayload(update);
  const out = {};
  for (const [key, target] of Object.entries(IP_WHITELIST_FIELDS)) {
    if (merged[key] !== undefined) out[target] = merged[key];
  }
  const companyId = merged.company ?? merged.companyId;
  if (companyId !== undefined) out.companyId = companyId ? toIdString(companyId) : null;
  return out;
}

module.exports = {
  roleToApi,
  companyToApi,
  userToApi,
  companyInputToPrisma,
  userInputToPrisma,
  ipWhitelistToApi,
  ipWhitelistTranslateCreate,
  ipWhitelistTranslateUpdate,
};
