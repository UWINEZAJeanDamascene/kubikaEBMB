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

const COMPANY_ID = '507f1f77bcf86cd799439011';
const REGISTER_ID = '507f1f77bcf86cd799439012';
const USER_ID = '507f1f77bcf86cd799439013';
const CLAIM_ID = '507f1f77bcf86cd799439014';

function response() {
  return { json: jest.fn() };
}

function request(body = {}) {
  return {
    body,
    params: { claimId: CLAIM_ID },
    posAuthContext: {
      company: { id: COMPANY_ID },
      register: { id: REGISTER_ID },
      user: { id: USER_ID },
    },
  };
}

function useTransaction(tx) {
  dbClient.mockReturnValue({
    $transaction: jest.fn((operation) => operation(tx)),
  });
}

describe('Pharmacy insurance claim resolution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('records an insurer rejection and allows a new submission attempt', async () => {
    const firstAttempt = {
      id: '507f1f77bcf86cd799439015',
      attemptNumber: 1,
      reference: 'SUBMIT-1',
    };
    const submitTx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      pharmacyInsuranceClaim: {
        findFirst: jest.fn().mockResolvedValue({ id: CLAIM_ID, status: 'rejected' }),
        update: jest.fn(({ data }) => Promise.resolve({ id: CLAIM_ID, ...data })),
      },
      pharmacyInsuranceClaimAttempt: {
        count: jest.fn().mockResolvedValue(1),
        create: jest.fn(({ data }) => Promise.resolve(data)),
      },
    };
    useTransaction(submitTx);
    const submitResponse = response();

    await controller.submitClaim(request({ reference: 'SUBMIT-2' }), submitResponse, jest.fn());

    expect(submitTx.pharmacyInsuranceClaimAttempt.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ attemptNumber: 2, status: 'submitted', reference: 'SUBMIT-2' }),
    }));
    expect(submitTx.pharmacyInsuranceClaim.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: CLAIM_ID },
      data: expect.objectContaining({ status: 'submitted', rejectionReason: null }),
    }));
    expect(submitResponse.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({ attempt: expect.objectContaining({ attemptNumber: 2 }) }),
    }));

    const decisionTx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      pharmacyInsuranceClaim: {
        findFirst: jest.fn().mockResolvedValue({ id: CLAIM_ID, status: 'submitted', claimAmount: '80.00' }),
        update: jest.fn(({ data }) => Promise.resolve({ id: CLAIM_ID, ...data })),
      },
      pharmacyInsuranceClaimAttempt: {
        findFirst: jest.fn().mockResolvedValue({ ...firstAttempt, attemptNumber: 2, status: 'submitted' }),
        update: jest.fn(({ data }) => Promise.resolve({ ...firstAttempt, ...data })),
      },
    };
    useTransaction(decisionTx);
    const decisionResponse = response();

    await controller.recordClaimDecision(request({
      status: 'rejected',
      responseAmount: 0,
      responseNote: 'Referral documentation was missing.',
      reference: 'DECISION-2',
    }), decisionResponse, jest.fn());

    expect(decisionTx.pharmacyInsuranceClaim.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: CLAIM_ID },
      data: expect.objectContaining({
        status: 'rejected',
        approvedAmount: '0.00',
        rejectionReason: 'Referral documentation was missing.',
      }),
    }));
    expect(decisionResponse.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({ claim: expect.objectContaining({ status: 'rejected' }) }),
    }));

    const retryTx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      pharmacyInsuranceClaim: {
        findFirst: jest.fn().mockResolvedValue({ id: CLAIM_ID, status: 'rejected' }),
        update: jest.fn(({ data }) => Promise.resolve({ id: CLAIM_ID, ...data })),
      },
      pharmacyInsuranceClaimAttempt: {
        count: jest.fn().mockResolvedValue(2),
        create: jest.fn(({ data }) => Promise.resolve(data)),
      },
    };
    useTransaction(retryTx);
    const retryResponse = response();

    await controller.submitClaim(request({ reference: 'SUBMIT-3' }), retryResponse, jest.fn());

    expect(retryTx.pharmacyInsuranceClaimAttempt.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ attemptNumber: 3, status: 'submitted', reference: 'SUBMIT-3' }),
    }));
    expect(retryResponse.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({ attempt: expect.objectContaining({ attemptNumber: 3 }) }),
    }));
  });
});
