const Company = require('../models/Company');
const AuditLogService = require('./AuditLogService');

function approvalFromCompany(company) {
  const status = company?.rraVsdcApprovalStatus
    || company?.rra_vsdc_approval_status
    || 'not_confirmed';
  return {
    status: status === 'approved' ? 'approved' : 'not_confirmed',
    reference: company?.rraVsdcApprovalReference || company?.rra_vsdc_approval_reference || null,
    reason: company?.rraVsdcApprovalReason || company?.rra_vsdc_approval_reason || null,
    approvedAt: company?.rraVsdcApprovedAt || company?.rra_vsdc_approved_at || null,
    approvedBy: company?.rraVsdcApprovedBy || company?.rra_vsdc_approved_by || null,
  };
}

async function getApproval(companyId) {
  const query = Company.findById(companyId);
  const company = query && typeof query.lean === 'function' ? await query.lean() : await query;
  if (!company) {
    const error = new Error('Company not found.');
    error.statusCode = 404;
    error.code = 'COMPANY_NOT_FOUND';
    throw error;
  }
  return {
    companyId: company.id || company._id,
    companyName: company.name,
    ...approvalFromCompany(company),
  };
}

async function assertApproved(companyId) {
  if (!companyId) {
    const error = new Error('Company context is required to verify RRA VSDC approval.');
    error.statusCode = 403;
    error.code = 'EBM_RRA_APPROVAL_REQUIRED';
    error.retryable = false;
    throw error;
  }

  const approval = await getApproval(companyId);
  if (approval.status !== 'approved' || !approval.reference) {
    const error = new Error('RRA VSDC approval has not been confirmed for this company. Record the RRA approval reference in Platform Administration before using the live VSDC.');
    error.statusCode = 403;
    error.code = 'EBM_RRA_APPROVAL_REQUIRED';
    error.retryable = false;
    throw error;
  }
  return approval;
}

async function updateApproval(companyId, { approved, reference, reason, userId, ipAddress, userAgent }) {
  if (typeof approved !== 'boolean') {
    const error = new Error('approved must be a boolean.');
    error.statusCode = 400;
    error.code = 'EBM_APPROVAL_STATUS_INVALID';
    throw error;
  }
  const normalizedReference = typeof reference === 'string' ? reference.trim() : '';
  const normalizedReason = typeof reason === 'string' ? reason.trim() : '';
  if (approved && !normalizedReference) {
    const error = new Error('An RRA approval reference is required before recording approval.');
    error.statusCode = 400;
    error.code = 'EBM_APPROVAL_REFERENCE_REQUIRED';
    throw error;
  }
  if (!normalizedReason) {
    const error = new Error('A reason is required for every RRA approval status change.');
    error.statusCode = 400;
    error.code = 'EBM_APPROVAL_REASON_REQUIRED';
    throw error;
  }

  const current = await getApproval(companyId);
  const now = new Date();
  const update = {
    rraVsdcApprovalStatus: approved ? 'approved' : 'not_confirmed',
    rraVsdcApprovalReference: approved ? normalizedReference : null,
    rraVsdcApprovalReason: normalizedReason,
    rraVsdcApprovedAt: approved ? now : null,
    rraVsdcApprovedBy: approved ? userId : null,
  };
  const company = await Company.findByIdAndUpdate(companyId, update, { new: true });
  if (!company) {
    const error = new Error('Company not found.');
    error.statusCode = 404;
    error.code = 'COMPANY_NOT_FOUND';
    throw error;
  }

  const approval = {
    companyId: company.id || company._id,
    companyName: company.name || current.companyName,
    ...approvalFromCompany(company),
  };
  await AuditLogService.log({
    companyId,
    userId,
    action: 'company.rra_vsdc_approval.updated',
    entityType: 'company_rra_vsdc_approval',
    entityId: companyId,
    changes: {
      previous: {
        status: current.status,
        reference: current.reference,
      },
      current: {
        status: approval.status,
        reference: approval.reference,
        reason: approval.reason,
        approvedAt: approval.approvedAt,
      },
    },
    ipAddress,
    userAgent,
  });
  return approval;
}

module.exports = { approvalFromCompany, getApproval, assertApproved, updateApproval };
