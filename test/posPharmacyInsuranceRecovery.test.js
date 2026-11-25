'use strict';

jest.mock('../lib/prisma', () => ({ dbClient: jest.fn() }));
jest.mock('../services/posAuditService', () => ({
  writePosAuditLog: jest.fn().mockResolvedValue(undefined),
  requestIp: jest.fn().mockReturnValue('127.0.0.1'),
}));
jest.mock('../services/journalService', () => ({}));
jest.mock('../services/posAccountingProfileService', () => ({}));
jest.mock('../services/posAccountingPostingService', () => ({}));

const { dbClient } = require('../lib/prisma');
const controller = require('../controllers/posPharmacyInsuranceController');

describe('Pharmacy insurance claim recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns only completed, eligible sales that are still missing a claim', async () => {
    const recoverable = {
      id: '507f1f77bcf86cd799439021',
      coveredAmount: '80.00',
      copayAmount: '20.00',
      authorizations: [{ id: '507f1f77bcf86cd799439022', authorizedAmount: '80.00' }],
      invoice: {
        id: '507f1f77bcf86cd799439023',
        referenceNo: 'PH-001',
        totalAmount: '100.00',
        invoiceDate: new Date('2026-12-17T00:00:00.000Z'),
      },
      provider: {
        id: '507f1f77bcf86cd799439024',
        code: 'INS',
        name: 'Insurer',
        requiresPreauthorization: true,
        submissionInstructions: 'Submit through the insurer portal.',
      },
      member: { id: '507f1f77bcf86cd799439025', memberNumber: 'M-1', policyNumber: null },
      patient: { id: '507f1f77bcf86cd799439026', fullName: 'Patient One', patientCode: 'P-1' },
    };
    const prisma = {
      pharmacyInsuranceClaim: { findMany: jest.fn().mockResolvedValue([]) },
      pharmacyInsuranceEligibility: { findMany: jest.fn().mockResolvedValue([recoverable]) },
    };
    dbClient.mockReturnValue(prisma);
    const res = { json: jest.fn() };
    const next = jest.fn();

    await controller.listClaims({
      posAuthContext: {
        company: { id: '507f1f77bcf86cd799439011' },
        register: { id: '507f1f77bcf86cd799439012' },
        user: { id: '507f1f77bcf86cd799439013' },
      },
    }, res, next);

    expect(prisma.pharmacyInsuranceEligibility.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: 'eligible',
        claims: { none: {} },
        invoice: expect.objectContaining({
          posOrigin: true,
          status: { notIn: ['PENDING_PAYMENT', 'draft', 'cancelled'] },
        }),
      }),
    }));
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        claims: [],
        recoverableSales: [{
          invoiceId: '507f1f77bcf86cd799439023',
          eligibilityId: '507f1f77bcf86cd799439021',
          authorizationId: '507f1f77bcf86cd799439022',
          referenceNo: 'PH-001',
          totalAmount: '100.00',
          invoiceDate: new Date('2026-12-17T00:00:00.000Z'),
          coveredAmount: '80.00',
          copayAmount: '20.00',
          provider: recoverable.provider,
          member: recoverable.member,
          patient: recoverable.patient,
        }],
      },
    });
    expect(next).not.toHaveBeenCalled();
  });

  test('creates traceable invoice claim lines whose patient and insurer portions reconcile', async () => {
    const invoiceId = '507f1f77bcf86cd799439031';
    const eligibilityId = '507f1f77bcf86cd799439032';
    const patientId = '507f1f77bcf86cd799439033';
    const providerId = '507f1f77bcf86cd799439034';
    const memberId = '507f1f77bcf86cd799439035';
    const invoiceLines = [
      { id: '507f1f77bcf86cd799439036', lineOrder: 1, lineTotal: '60.00', qty: '1' },
      { id: '507f1f77bcf86cd799439037', lineOrder: 2, lineTotal: '40.00', qty: '2' },
    ];
    const claim = {
      id: '507f1f77bcf86cd799439038',
      claimNumber: 'INS-20261217-001',
      lines: [],
    };
    const tx = {
      invoice: {
        findFirst: jest.fn().mockResolvedValue({
          id: invoiceId,
          companyId: '507f1f77bcf86cd799439011',
          status: 'fully_paid',
          posCheckoutPayload: { pharmacyPatientId: patientId },
          totalAmount: '100.00',
          payments: [
            { paymentMethod: 'insurance', amount: '80.00' },
            { paymentMethod: 'cash', amount: '20.00' },
          ],
          lines: invoiceLines,
        }),
      },
      pharmacyInsuranceEligibility: {
        findFirst: jest.fn().mockResolvedValue({
          id: eligibilityId,
          status: 'eligible',
          providerId,
          memberId,
          patientId,
          coveredAmount: '80.00',
          copayAmount: '20.00',
          validUntil: null,
          provider: { id: providerId, code: 'INS', isActive: true, requiresPreauthorization: false },
          member: { id: memberId, status: 'active' },
        }),
      },
      pharmacyInsuranceClaim: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(async ({ data }) => ({
          ...claim,
          ...data,
          lines: data.lines.create,
        })),
      },
      pharmacyInsuranceAuthorization: { findFirst: jest.fn() },
    };
    dbClient.mockReturnValue({
      $transaction: jest.fn((operation) => operation(tx)),
    });
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();

    await controller.createClaim({
      body: { invoiceId, eligibilityId },
      posAuthContext: {
        company: { id: '507f1f77bcf86cd799439011' },
        register: { id: '507f1f77bcf86cd799439012' },
        user: { id: '507f1f77bcf86cd799439013' },
      },
    }, res, next);

    expect(tx.pharmacyInsuranceClaim.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        invoiceId,
        eligibilityId,
        patientId,
        grossAmount: '100.00',
        copayAmount: '20.00',
        claimAmount: '80.00',
        lines: {
          create: expect.arrayContaining([
            expect.objectContaining({ invoiceLineId: invoiceLines[0].id }),
            expect.objectContaining({ invoiceLineId: invoiceLines[1].id }),
          ]),
        },
      }),
      include: { lines: true },
    }));
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: { claim: expect.objectContaining({ invoiceId, eligibilityId, patientId }) },
    }));
    expect(next).not.toHaveBeenCalled();
  });
});
