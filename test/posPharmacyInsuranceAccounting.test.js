'use strict';

jest.mock('../lib/prisma', () => ({ dbClient: jest.fn() }));
jest.mock('../services/posAuditService', () => ({
  writePosAuditLog: jest.fn().mockResolvedValue(undefined),
  requestIp: jest.fn().mockReturnValue('127.0.0.1'),
}));
jest.mock('../services/journalService', () => ({
  getMappedAccountCode: jest.fn(async (_companyId, _module, _key, fallback) => fallback),
  createDebitLine: jest.fn((accountCode, debit, description) => ({ accountCode, debit, credit: 0, description })),
  createCreditLine: jest.fn((accountCode, credit, description) => ({ accountCode, debit: 0, credit, description })),
}));
jest.mock('../services/posAccountingProfileService', () => ({
  getProfile: jest.fn().mockResolvedValue({}),
  resolveAccount: jest.fn((_profile, key) => (key === 'cashAtBank' ? '1100' : key === 'accountsReceivable' ? '1300' : null)),
}));
jest.mock('../services/posAccountingPostingService', () => ({
  postOrQueue: jest.fn().mockResolvedValue({ status: 'posted', journalEntryIds: ['journal-entry-1'] }),
}));

const { dbClient } = require('../lib/prisma');
const posAccountingPostingService = require('../services/posAccountingPostingService');
const controller = require('../controllers/posPharmacyInsuranceController');

const COMPANY_ID = '507f1f77bcf86cd799439011';
const REGISTER_ID = '507f1f77bcf86cd799439012';
const USER_ID = '507f1f77bcf86cd799439013';
const CLAIM_ID = '507f1f77bcf86cd799439014';

function response() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function setup(claim) {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    pharmacyInsuranceSettlement: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(({ data }) => Promise.resolve(data)),
      update: jest.fn(({ where, data }) => Promise.resolve({ id: where.id, ...data })),
    },
    pharmacyInsuranceClaimAdjustment: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(({ data }) => Promise.resolve(data)),
      update: jest.fn(({ where, data }) => Promise.resolve({ id: where.id, ...data })),
    },
    pharmacyInsuranceClaim: {
      findFirst: jest.fn().mockResolvedValue(claim),
      update: jest.fn(({ where, data }) => Promise.resolve({ id: where.id, ...data })),
    },
  };
  dbClient.mockReturnValue({
    $transaction: jest.fn((operation) => operation(tx)),
  });
  return tx;
}

function request(body) {
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

describe('Pharmacy insurance accounting postings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('posts an insurer settlement against the Pharmacy receivable and stores its journal link', async () => {
    const tx = setup({
      id: CLAIM_ID,
      claimNumber: 'IC-001',
      status: 'accepted',
      approvedAmount: '100.00',
      settledAmount: '0.00',
      adjustedAmount: '0.00',
    });
    const res = response();

    await controller.recordSettlement(request({
      idempotencyKey: 'settlement-001',
      amount: 40,
      settlementDate: '2026-12-17',
      reference: 'BANK-001',
    }), res, jest.fn());

    expect(posAccountingPostingService.postOrQueue).toHaveBeenCalledWith(expect.objectContaining({
      tx,
      sourceType: 'pos_pharmacy_insurance_settlement',
      entries: [expect.objectContaining({
        lines: expect.arrayContaining([
          expect.objectContaining({ accountCode: '1100', debit: '40.00' }),
          expect.objectContaining({ accountCode: '1300', credit: '40.00' }),
        ]),
      })],
    }));
    expect(tx.pharmacyInsuranceSettlement.update).toHaveBeenCalledWith({
      where: { id: expect.any(String) },
      data: { journalEntryId: 'journal-entry-1', postingStatus: 'posted' },
    });
    expect(res.status).toHaveBeenCalledWith(201);
  });

  test('posts a receivable write-off to bad-debt expense with its traceable journal link', async () => {
    const tx = setup({
      id: CLAIM_ID,
      claimNumber: 'IC-001',
      status: 'partially_settled',
      approvedAmount: '100.00',
      settledAmount: '25.00',
      adjustedAmount: '0.00',
    });
    const res = response();

    await controller.recordAdjustment(request({
      idempotencyKey: 'adjustment-001',
      amount: 30,
      reason: 'Insurer confirmed contractual write-off.',
      reference: 'ADJ-001',
    }), res, jest.fn());

    expect(posAccountingPostingService.postOrQueue).toHaveBeenCalledWith(expect.objectContaining({
      tx,
      sourceType: 'pos_pharmacy_insurance_adjustment',
      entries: [expect.objectContaining({
        lines: expect.arrayContaining([
          expect.objectContaining({ accountCode: '5250', debit: '30.00' }),
          expect.objectContaining({ accountCode: '1300', credit: '30.00' }),
        ]),
      })],
    }));
    expect(tx.pharmacyInsuranceClaimAdjustment.update).toHaveBeenCalledWith({
      where: { id: expect.any(String) },
      data: { journalEntryId: 'journal-entry-1', postingStatus: 'posted' },
    });
    expect(res.status).toHaveBeenCalledWith(201);
  });
});
