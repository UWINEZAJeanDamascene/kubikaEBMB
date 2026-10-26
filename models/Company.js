/**
 * Company model — PostgreSQL (Prisma) backed.
 *
 * Exposes a Mongoose-compatible query facade so not-yet-migrated domains can
 * keep calling `Company.findById(...)`, `Company.find(...)`, etc. Returned
 * documents use the legacy snake_case field names (see utils/authMappers).
 *
 */

const { prisma } = require('../lib/prisma');
const { makeCompatModel } = require('../utils/prismaCompat');
const { generateObjectId, toIdString } = require('../utils/objectId');
const { companyToApi, companyInputToPrisma } = require('../utils/authMappers');

const FIELD_MAP = {
  _id: { target: 'id', isId: true },
  id: { target: 'id', isId: true },
  name: { target: 'name' },
  code: { target: 'code', transform: (v) => ({ code: typeof v === 'string' ? v.toUpperCase() : v }) },
  email: { target: 'email', transform: (v) => ({ email: typeof v === 'string' ? v.toLowerCase() : v }) },
  phone: { target: 'phone' },
  industry: { target: 'industry' },
  isActive: { target: 'isActive' },
  approvalStatus: { target: 'approvalStatus' },
  is_vat_registered: { target: 'isVatRegistered' },
  base_currency: { target: 'baseCurrency' },
  subscription_plan: { target: 'subscriptionPlan' },
  subscription_status: { target: 'subscriptionStatus' },
  ebm_enabled: { target: 'ebmEnabled' },
  ebmEnabled: { target: 'ebmEnabled' },
  ebm_toggle_reason: { target: 'ebmToggleReason' },
  ebmToggleReason: { target: 'ebmToggleReason' },
  ebm_toggle_changed_at: { target: 'ebmToggleChangedAt' },
  ebmToggleChangedAt: { target: 'ebmToggleChangedAt' },
  ebm_toggle_changed_by: { target: 'ebmToggleChangedBy', isId: true },
  ebmToggleChangedBy: { target: 'ebmToggleChangedBy', isId: true },
  rra_vsdc_approval_status: { target: 'rraVsdcApprovalStatus' },
  rraVsdcApprovalStatus: { target: 'rraVsdcApprovalStatus' },
  rra_vsdc_approval_reference: { target: 'rraVsdcApprovalReference' },
  rraVsdcApprovalReference: { target: 'rraVsdcApprovalReference' },
  rra_vsdc_approval_reason: { target: 'rraVsdcApprovalReason' },
  rraVsdcApprovalReason: { target: 'rraVsdcApprovalReason' },
  rra_vsdc_approved_at: { target: 'rraVsdcApprovedAt' },
  rraVsdcApprovedAt: { target: 'rraVsdcApprovedAt' },
  rra_vsdc_approved_by: { target: 'rraVsdcApprovedBy', isId: true },
  rraVsdcApprovedBy: { target: 'rraVsdcApprovedBy', isId: true },
  rra_vsdc_approval_status: { target: 'rraVsdcApprovalStatus' },
  rraVsdcApprovalStatus: { target: 'rraVsdcApprovalStatus' },
  rra_vsdc_approval_reference: { target: 'rraVsdcApprovalReference' },
  rraVsdcApprovalReference: { target: 'rraVsdcApprovalReference' },
  rra_vsdc_approval_reason: { target: 'rraVsdcApprovalReason' },
  rraVsdcApprovalReason: { target: 'rraVsdcApprovalReason' },
  rra_vsdc_approved_at: { target: 'rraVsdcApprovedAt' },
  rraVsdcApprovedAt: { target: 'rraVsdcApprovedAt' },
  rra_vsdc_approved_by: { target: 'rraVsdcApprovedBy', isId: true },
  rraVsdcApprovedBy: { target: 'rraVsdcApprovedBy', isId: true },
  created_by: { target: 'createdById', isId: true },
  createdAt: { target: 'createdAt' },
  updatedAt: { target: 'updatedAt' },
};

function defaultCode(name) {
  return (name || 'COMPANY').toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 4)
    + Date.now().toString(36).toUpperCase();
}

async function translateCreate(data) {
  const mapped = companyInputToPrisma(data);
  return {
    id: toIdString(data._id || data.id) || generateObjectId(),
    ...mapped,
    code: (mapped.code || defaultCode(data.name)).toUpperCase(),
    createdById: data.created_by ? toIdString(data.created_by) : null,
  };
}

function translateUpdate(update = {}) {
  const direct = { ...update };
  if (direct.$set) {
    Object.assign(direct, direct.$set);
    delete direct.$set;
  }
  delete direct.$unset;
  return companyInputToPrisma(direct);
}

const Company = makeCompatModel({
  delegate: () => prisma.company,
  delegateName: 'company',
  fieldMap: FIELD_MAP,
  toApi: companyToApi,
  translateCreate,
  translateUpdate,
});

module.exports = Company;
