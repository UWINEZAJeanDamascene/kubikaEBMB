jest.mock('../models/Company', () => ({
  findById: jest.fn(),
  findByIdAndUpdate: jest.fn(),
}));

jest.mock('../services/AuditLogService', () => ({
  log: jest.fn().mockResolvedValue({}),
}));

describe('RRA VSDC approval readiness', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('blocks live VSDC use until platform-admin approval and its reference are recorded', async () => {
    const Company = require('../models/Company');
    const approvalService = require('../services/ebmApprovalService');
    Company.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: 'company-1',
        rra_vsdc_approval_status: 'not_confirmed',
      }),
    });

    await expect(approvalService.assertApproved('company-1'))
      .rejects.toMatchObject({ code: 'EBM_RRA_APPROVAL_REQUIRED', statusCode: 403, retryable: false });
  });

  it('rejects an approval without a recorded RRA reference', async () => {
    const Company = require('../models/Company');
    const approvalService = require('../services/ebmApprovalService');
    Company.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: 'company-1',
        rra_vsdc_approval_status: 'approved',
        rra_vsdc_approval_reference: null,
      }),
    });

    await expect(approvalService.assertApproved('company-1'))
      .rejects.toMatchObject({ code: 'EBM_RRA_APPROVAL_REQUIRED', statusCode: 403 });
  });

  it('allows live VSDC use only with confirmed status and reference', async () => {
    const Company = require('../models/Company');
    const approvalService = require('../services/ebmApprovalService');
    Company.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: 'company-1',
        name: 'Example Company',
        rra_vsdc_approval_status: 'approved',
        rra_vsdc_approval_reference: 'RRA-APP-2026-17',
      }),
    });

    await expect(approvalService.assertApproved('company-1')).resolves.toMatchObject({
      status: 'approved',
      reference: 'RRA-APP-2026-17',
    });
  });

  it('requires an approval reference and reason, stores the change, and audits it', async () => {
    const Company = require('../models/Company');
    const AuditLogService = require('../services/AuditLogService');
    const approvalService = require('../services/ebmApprovalService');
    const currentCompany = {
      _id: 'company-1',
      name: 'Example Company',
      rra_vsdc_approval_status: 'not_confirmed',
    };
    Company.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue(currentCompany),
    });
    Company.findByIdAndUpdate.mockResolvedValue({
      _id: 'company-1',
      name: 'Example Company',
      rra_vsdc_approval_status: 'approved',
      rra_vsdc_approval_reference: 'RRA-APP-2026-17',
      rra_vsdc_approval_reason: 'Verified against RRA approval notice.',
      rra_vsdc_approved_at: new Date('2026-10-13T08:00:00.000Z'),
      rra_vsdc_approved_by: 'admin-1',
    });

    const result = await approvalService.updateApproval('company-1', {
      approved: true,
      reference: ' RRA-APP-2026-17 ',
      reason: ' Verified against RRA approval notice. ',
      userId: 'admin-1',
      ipAddress: '127.0.0.1',
      userAgent: 'test',
    });

    expect(Company.findByIdAndUpdate).toHaveBeenCalledWith('company-1', expect.objectContaining({
      rraVsdcApprovalStatus: 'approved',
      rraVsdcApprovalReference: 'RRA-APP-2026-17',
      rraVsdcApprovalReason: 'Verified against RRA approval notice.',
      rraVsdcApprovedBy: 'admin-1',
    }), { new: true });
    expect(AuditLogService.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'company.rra_vsdc_approval.updated',
      entityId: 'company-1',
      userId: 'admin-1',
    }));
    expect(result).toMatchObject({ status: 'approved', reference: 'RRA-APP-2026-17' });
  });

  it('does not record approval without its evidence reference', async () => {
    const Company = require('../models/Company');
    const approvalService = require('../services/ebmApprovalService');
    Company.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ _id: 'company-1', rra_vsdc_approval_status: 'not_confirmed' }),
    });

    await expect(approvalService.updateApproval('company-1', {
      approved: true,
      reference: '',
      reason: 'Checked',
      userId: 'admin-1',
    })).rejects.toMatchObject({ code: 'EBM_APPROVAL_REFERENCE_REQUIRED', statusCode: 400 });
    expect(Company.findByIdAndUpdate).not.toHaveBeenCalled();
  });
});
