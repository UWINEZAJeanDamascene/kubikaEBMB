const Company = require('../models/Company');
const Warehouse = require('../models/Warehouse');
const Product = require('../models/Product');
const EBMDevice = require('../models/EBMDevice');
const EBMCode = require('../models/EBMCode');
const EBMSyncState = require('../models/EBMSyncState');
const ebmService = require('./ebmService');
const { EBM_DEVICE_STATUSES } = require('../models/EBMDevice');
const { READINESS_ACTIONS, formatSyncStates } = require('../constants/ebmUiMetadata');

const VSDC_OFFLINE_LIMIT_MS = 24 * 60 * 60 * 1000;

function normalizeBranchId(value) {
  return String(value || '00').padStart(2, '0').slice(-2);
}

class EBMReadinessService {
  static async getReadiness(companyId, branchId = '00') {
    const normalizedBranchId = normalizeBranchId(branchId);
    const mode = ebmService.getConfig().mode;
    const [company, warehouse, device, codeCount, syncStates, unregisteredProducts] = await Promise.all([
      Company.findById(companyId)
        .select('tax_identification_number registration_number tin name rra_vsdc_approval_status rra_vsdc_approval_reference rra_vsdc_approval_reason rra_vsdc_approved_at rra_vsdc_approved_by')
        .lean(),
      Warehouse.findOne({ company: companyId, rraBranchId: normalizedBranchId }).lean(),
      EBMDevice.findOne({
        company: companyId,
        branchId: normalizedBranchId,
        environment: mode,
        status: EBM_DEVICE_STATUSES.INITIALIZED,
        initializedMode: mode,
      }).lean(),
      EBMCode.countDocuments({ company: companyId, active: { $ne: false } }),
      EBMSyncState.find({ company: companyId, mode }).lean(),
      Product.countDocuments({
        company: companyId,
        isActive: { $ne: false },
        $or: [
          { 'ebm.registrationStatus': { $ne: 'registered' } },
          { 'ebm.ebmItemCode': { $in: [null, ''] } },
        ],
      }),
    ]);

    const tin = String(
      company?.tax_identification_number ||
      company?.registration_number ||
      company?.tin ||
      '',
    ).trim();

    const config = ebmService.getConfig();
    const lastContactAt = device?.lastSuccessfulContactAt || device?.initializedAt || null;
    const lastFiscalAt = device?.lastSuccessfulFiscalAt || null;
    const lastContactAgeMs = lastContactAt ? Math.max(0, Date.now() - new Date(lastContactAt).getTime()) : null;
    const connectivityWarning = config.isMock
      ? null
      : !lastContactAt || lastContactAgeMs >= VSDC_OFFLINE_LIMIT_MS
        ? 'No successful VSDC response has been recorded within 24 hours. This does not prove the internet is down; verify VSDC and RRA connectivity. VSDC may stop issuing receipt numbers after an internet outage of this duration.'
        : null;
    const rraApproval = require('./ebmApprovalService').approvalFromCompany(company);
    const deviceSequenceReady = Boolean(device)
      && !['pending', 'failed'].includes(device.sequenceSeedStatus);

    const checks = [
      {
        id: 'rra_approval_confirmed',
        label: 'RRA VSDC approval confirmed',
        ok: config.isMock || (rraApproval.status === 'approved' && Boolean(rraApproval.reference)),
        detail: config.isMock
          ? 'Approval is not required for local mock transport; confirm RRA approval before using Test or Production VSDC.'
          : rraApproval.status === 'approved' && rraApproval.reference
            ? `RRA approval recorded${rraApproval.approvedAt ? ` on ${new Date(rraApproval.approvedAt).toLocaleDateString()}` : ''} (reference: ${rraApproval.reference})`
            : 'RRA approval is not confirmed. A platform administrator must record the RRA approval reference before using Test or Production VSDC.',
      },
      {
        id: 'transport_configured',
        label: 'EBM transport configured',
        ok: config.transportConfigured,
        detail: config.isMock
          ? 'Mock transport is active for development; responses are not RRA fiscal acceptance.'
          : `${config.modeLabel} uses the configured VSDC service.`,
      },
      {
        id: 'company_tin',
        label: 'Company TIN configured',
        ok: /^\d{9}$/.test(tin),
        detail: tin || 'Add your 9-digit Rwanda TIN in company settings',
        ...READINESS_ACTIONS.company_tin,
      },
      {
        id: 'device_initialized',
        label: `EBM device initialized (${mode})`,
        ok: deviceSequenceReady,
        detail: deviceSequenceReady
          ? `Ready since ${device.initializedAt ? new Date(device.initializedAt).toLocaleString() : 'initialization'}`
          : device
            ? 'RRA initialization succeeded, but local fiscal sequence setup is incomplete. Reconcile it before sending fiscal operations; do not initialize the device again.'
            : 'Connect and initialize your branch device in the current environment before sending invoices to RRA',
        ...READINESS_ACTIONS.device_initialized,
      },
      {
        id: 'branch_registered',
        label: 'Branch registered with RRA',
        ok: warehouse?.ebmRegistrationStatus === 'registered',
        detail: warehouse?.ebmRegistrationStatus === 'registered'
          ? `Branch ${normalizedBranchId} is registered`
          : 'Register this warehouse branch with RRA before fiscal submissions',
        ...READINESS_ACTIONS.branch_registered,
      },
      {
        id: 'codes_synced',
        label: 'RRA reference codes synced',
        ok: codeCount > 0,
        detail: codeCount > 0
          ? `${codeCount} active code(s) available locally`
          : 'Sync payment methods, receipt types, and tax codes from RRA',
        ...READINESS_ACTIONS.codes_synced,
      },
      {
        id: 'products_registered',
        label: 'Products registered with RRA',
        ok: unregisteredProducts === 0,
        detail: unregisteredProducts === 0
          ? 'All active products have RRA item codes'
          : `${unregisteredProducts} active product(s) still need RRA registration`,
        ...READINESS_ACTIONS.products_registered,
      },
    ];

    const ready = checks.every((check) => check.ok);
    const syncSummary = formatSyncStates(syncStates, normalizedBranchId, mode);
    return {
      companyId,
      branchId: normalizedBranchId,
      mode,
      ready,
      checks,
      runtime: {
        modeLabel: config.modeLabel,
        isMock: config.isMock,
        transportConfigured: config.transportConfigured,
        lastSuccessfulContactAt: lastContactAt,
        lastSuccessfulFiscalAt: lastFiscalAt,
        connectivityWarning,
      },
      warnings: connectivityWarning ? [connectivityWarning] : [],
      syncStates,
      syncSummary,
    };
  }
}

module.exports = EBMReadinessService;
