jest.mock('../lib/prisma', () => ({ prisma: { $transaction: jest.fn() } }));
jest.mock('../utils/objectId', () => ({ generateObjectId: jest.fn(() => 'generated-reprint-id') }));
jest.mock('../services/posAuditService', () => ({
  requestIp: jest.fn(),
  writePosAuditLog: jest.fn().mockResolvedValue({ id: 'audit-id' }),
}));
jest.mock('../services/posEbmTenantGuard', () => ({
  assertPosEbmReceiptReprintContext: jest.fn().mockResolvedValue({}),
}));

const { prisma } = require('../lib/prisma');
const { writePosAuditLog } = require('../services/posAuditService');
const { createReceiptCopy } = require('../services/posReceiptReprintService');

describe('POS signed receipt reprint audit', () => {
  const submission = {
    id: 'submission-a', companyId: 'company-a', documentType: 'pos', documentId: 'invoice-a',
    salesTyCd: 'N', rcptTyCd: 'S', ebmStatus: 'submitted', signedAt: new Date('2026-11-02T08:00:00Z'),
    fiscalDataSource: 'VSDC_RESPONSE', registerId: 'register-a',
    fiscalResponse: { data: { receipt: { curRcptNo: 12345 } } },
  };
  let tx;

  beforeEach(() => {
    jest.clearAllMocks();
    const storedReprint = {
      id: 'reprint-a', companyId: 'company-a', invoiceId: 'invoice-a', submissionId: 'submission-a',
      registerId: 'register-a', actorUserId: 'cashier-a', copyNumber: 1,
      idempotencyKey: 'receipt-copy-0001', reason: 'Customer copy requested', createdAt: new Date('2026-11-02T08:05:00Z'),
    };
    tx = {
      posEbmReceiptReprint: {
        findFirst: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(storedReprint),
        aggregate: jest.fn().mockResolvedValue({ _max: { copyNumber: null } }),
        create: jest.fn().mockResolvedValue(storedReprint),
      },
      ebmSubmissionQueue: { findFirst: jest.fn().mockResolvedValue(submission) },
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'invoice-a' }]),
    };
    prisma.$transaction.mockImplementation((callback) => callback(tx));
  });

  test('writes POS_RECEIPT_REPRINTED with actor, reason, copy number, fiscal source, and transaction client', async () => {
    const request = {
      companyId: 'company-a', invoiceId: 'invoice-a', registerId: 'register-a', actorUserId: 'cashier-a',
      idempotencyKey: 'receipt-copy-0001', reason: 'Customer copy requested', reqIp: '192.0.2.10',
    };

    const result = await createReceiptCopy(request);
    expect(result.replayed).toBe(false);
    expect(result.reprint.copyNumber).toBe(1);
    expect(writePosAuditLog).toHaveBeenCalledTimes(1);
    expect(writePosAuditLog).toHaveBeenCalledWith({
      companyId: 'company-a', registerId: 'register-a', userId: 'cashier-a', ip: '192.0.2.10',
      event: 'POS_RECEIPT_REPRINTED',
      metadata: {
        invoiceId: 'invoice-a', submissionId: 'submission-a', reprintId: 'reprint-a', copyNumber: 1,
        copiedAt: result.reprint.createdAt, reason: 'Customer copy requested', fiscalDataSource: 'VSDC_RESPONSE',
        receiptNumber: 12345,
      },
    }, tx);

    const replay = await createReceiptCopy(request);
    expect(replay.replayed).toBe(true);
    expect(writePosAuditLog).toHaveBeenCalledTimes(1);
  });

  test('rejects an unsigned fiscal submission before creating a copy or audit entry', async () => {
    tx.ebmSubmissionQueue.findFirst.mockResolvedValue({
      ...submission,
      ebmStatus: 'pending',
      signedAt: null,
      fiscalResponse: null,
    });

    await expect(createReceiptCopy({
      companyId: 'company-a', invoiceId: 'invoice-a', registerId: 'register-a', actorUserId: 'cashier-a',
      idempotencyKey: 'receipt-copy-0002', reason: 'Customer needs a copy',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'POS_EBM_REPRINT_UNSIGNED',
      message: 'Only a signed fiscal receipt can be reprinted as a copy.',
    });

    expect(tx.posEbmReceiptReprint.create).not.toHaveBeenCalled();
    expect(writePosAuditLog).not.toHaveBeenCalled();
  });
});
