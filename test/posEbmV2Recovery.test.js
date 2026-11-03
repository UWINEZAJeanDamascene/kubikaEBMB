jest.mock('../lib/prisma', () => ({ prisma: {} }));
jest.mock('../services/posAuditService', () => ({ writePosAuditLog: jest.fn().mockResolvedValue({}) }));

const { prisma } = require('../lib/prisma');
const { writePosAuditLog } = require('../services/posAuditService');
const recovery = require('../services/posEbmV2RecoveryService');

function makeTx() {
  return {
    $queryRawUnsafe: jest.fn(),
    $executeRawUnsafe: jest.fn().mockResolvedValue(1),
    ebmSubmissionQueue: {
      findFirst: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    ebmAlert: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({}) },
    posManagerApproval: { findFirst: jest.fn().mockResolvedValue({ managerId: 'second-manager-id' }) },
  };
}

describe('V2 EBM recovery policy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction = jest.fn(async (fn) => fn(makeTx()));
    prisma.ebmSubmissionQueue = { updateMany: jest.fn().mockResolvedValue({ count: 1 }) };
  });

  test.each(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'])('%s proves non-delivery', (code) => {
    expect(recovery.transportProvesNonDelivery({ code })).toBe(true);
  });

  test.each(['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED'])('%s is ambiguous and cannot auto-retry', (code) => {
    expect(recovery.transportProvesNonDelivery({ code, request: { _headerSent: true } })).toBe(false);
  });

  test('does not treat a TLS error as safe after request bytes were written', () => {
    expect(recovery.transportProvesNonDelivery({ code: 'EPROTO', request: { socket: { bytesWritten: 1 } } })).toBe(false);
    expect(recovery.transportProvesNonDelivery({ code: 'EPROTO', request: { socket: { bytesWritten: 0 } } })).toBe(true);
  });

  test('lease duration exceeds the configured VSDC HTTP timeout plus margin', () => {
    expect(recovery.LEASE_MARGIN_MS).toBeGreaterThan(0);
    expect(recovery.HTTP_TIMEOUT_MS + recovery.LEASE_MARGIN_MS).toBeGreaterThan(recovery.HTTP_TIMEOUT_MS);
  });

  test('commits request_sent_at and consumes a resend authorization together immediately before send', async () => {
    const tx = makeTx();
    prisma.$transaction.mockImplementation(async (fn) => fn(tx));
    tx.ebmSubmissionQueue.updateMany.mockResolvedValue({ count: 1 });
    await expect(recovery.markRequestSent('company-id', 'queue-id', 'lease-token')).resolves.toBe(true);
    expect(tx.ebmSubmissionQueue.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'queue-id', companyId: 'company-id', requestSentAt: null }),
      data: expect.objectContaining({ requestSentAt: expect.any(Date), leaseExpiresAt: expect.any(Date) }),
    }));
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(expect.stringContaining('resend_consumed_at = CURRENT_TIMESTAMP'), 'queue-id', 'company-id');
  });

  test('accepts a late signed response when no manager decision exists and audits it', async () => {
    const tx = makeTx();
    const unresolved = { id: 'queue-id', ebmStatus: 'failed', requestSentAt: new Date(), resolution: null, signedAt: null, registerId: 'register-id', cashierId: 'cashier-id' };
    tx.ebmSubmissionQueue.findFirst.mockResolvedValueOnce(unresolved).mockResolvedValueOnce({ ...unresolved, ebmStatus: 'submitted', signedAt: new Date(), fiscalDataSource: 'VSDC_RESPONSE' });
    prisma.$transaction.mockImplementation(async (fn) => fn(tx));
    const result = await recovery.acceptSignedResponse('company-id', 'queue-id', 'stale-lease', { resultCd: '000', data: { rcptSign: 'sig' } });
    expect(result.accepted).toBe(true);
    expect(tx.ebmSubmissionQueue.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'queue-id', signedAt: null, OR: expect.arrayContaining([{ resolution: null }]) }),
      data: expect.objectContaining({ ebmStatus: 'submitted', fiscalDataSource: 'VSDC_RESPONSE' }),
    }));
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({ event: 'EBM_V2_LATE_SIGNED_RESPONSE' }), tx);
  });

  test('never overwrites a manager resolution with a late signed response', async () => {
    const tx = makeTx();
    tx.ebmSubmissionQueue.findFirst.mockResolvedValue({
      id: 'queue-id', ebmStatus: 'pending', resolution: 'CONFIRMED_NOT_RECEIVED', signedAt: null,
    });
    prisma.$transaction.mockImplementation(async (fn) => fn(tx));
    await expect(recovery.acceptSignedResponse('company-id', 'queue-id', 'lease', { resultCd: '000' }))
      .resolves.toMatchObject({ accepted: false, reason: 'already_resolved' });
    expect(tx.ebmSubmissionQueue.updateMany).not.toHaveBeenCalled();
  });

  test('leases expired before request_sent_at return to pending; sent leases go to review', async () => {
    const tx = makeTx();
    tx.$queryRawUnsafe.mockResolvedValue([
      { id: 'safe-row', company_id: 'company-id', request_sent_at: null },
      { id: 'ambiguous-row', company_id: 'company-id', request_sent_at: new Date(), register_id: 'register-id', cashier_id: 'cashier-id', document_id: 'invoice-id' },
    ]);
    tx.ebmAlert.findFirst.mockResolvedValue(null);
    prisma.$transaction.mockImplementation(async (fn) => fn(tx));
    const changed = await recovery.sweepExpiredLeases();
    expect(changed).toHaveLength(2);
    expect(tx.$queryRawUnsafe.mock.calls[0][0]).toContain('FOR UPDATE SKIP LOCKED');
    expect(tx.$queryRawUnsafe.mock.calls[0][0]).toContain("request_sent_at IS NULL THEN 'pending' ELSE 'failed'");
    expect(tx.ebmAlert.create).toHaveBeenCalledTimes(1);
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({ event: 'EBM_V2_NEEDS_REVIEW' }), tx);
  });

  test('uses bounded exponential backoff', () => {
    expect(recovery.delayFor(1)).toBe(5000);
    expect(recovery.delayFor(5)).toBe(80000);
    expect(recovery.delayFor(30)).toBe(60 * 60 * 1000);
  });

  test('permanent V2 validation rejections create an alert and audit without retrying', async () => {
    const tx = makeTx();
    tx.ebmSubmissionQueue.findFirst.mockResolvedValue({
      id: 'queue-id', companyId: 'company-id', documentId: 'invoice-id', documentType: 'pos',
      endpoint: '/transactions/saveSales', operationKey: 'default', payload: { sale: true },
      ebmStatus: 'submitting', requestSentAt: new Date(), retryCount: 0, registerId: 'register-id', cashierId: 'cashier-id',
    });
    prisma.$transaction.mockImplementation(async (fn) => fn(tx));
    await expect(recovery.markPermanentFailure('company-id', 'queue-id', 'lease', {
      resultCd: '881', resultMsg: 'Invalid invoice data',
    })).resolves.toBe(true);
    expect(tx.ebmSubmissionQueue.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ ebmStatus: 'failed', isRetryable: false, lastError: expect.objectContaining({ code: 'EBM_V2_PERMANENT_REJECTION', resultCode: '881' }) }),
    }));
    expect(tx.ebmAlert.create).toHaveBeenCalledTimes(1);
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({ event: 'EBM_V2_PERMANENT_REJECTION' }), tx);
  });

  test('the PostgreSQL sweeper rediscovers committed due rows after dispatch process loss', async () => {
    const submitInvoice = jest.fn().mockResolvedValue({});
    const sweep = jest.spyOn(recovery, 'sweepExpiredLeases').mockResolvedValue([]);
    const due = jest.spyOn(recovery, 'claimDueIds').mockResolvedValue([{ id: 'committed-outbox', documentId: 'committed-invoice', companyId: 'company-id' }]);
    jest.doMock('../services/ebmSalesService', () => ({ submitInvoice }));
    const sweeper = require('../services/posEbmV2RetryJob');
    const result = await sweeper.runOnce();
    expect(result.due).toBe(1);
    expect(submitInvoice).toHaveBeenCalledTimes(1);
    expect(submitInvoice).toHaveBeenCalledWith('committed-invoice', { companyId: 'company-id', outboxId: 'committed-outbox' });
    sweep.mockRestore();
    due.mockRestore();
    jest.dontMock('../services/ebmSalesService');
  });
});
