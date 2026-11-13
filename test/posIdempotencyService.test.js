'use strict';

const mockTx = {
  posIdempotencyRecord: { updateMany: jest.fn() },
  posIdempotencyResult: { create: jest.fn() },
};

jest.mock('../lib/prisma', () => ({
  prisma: {
    posIdempotencyRecord: { create: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn() },
    posIdempotencyResult: { findUnique: jest.fn() },
  },
}));
jest.mock('../services/transactionService', () => ({
  runInPrismaTransaction: jest.fn((work) => work(mockTx)),
}));
jest.mock('../services/posAuditService', () => ({
  writePosAuditLog: jest.fn().mockResolvedValue({ id: 'audit' }),
  requestIp: jest.fn(() => null),
}));

const { prisma } = require('../lib/prisma');
const { runInPrismaTransaction } = require('../services/transactionService');
const { writePosAuditLog } = require('../services/posAuditService');
const { idempotentHandler, payloadHash, decryptResult } = require('../services/posIdempotencyService');

function request(overrides = {}) {
  return {
    method: 'POST',
    path: '/api/pos/refund',
    route: { path: '/refund' },
    params: {}, query: {}, body: { invoiceId: 'invoice-a', amount: 100 },
    headers: { 'idempotency-key': 'refund-once-0001' },
    posAuthContext: {
      company: { id: '507f1f77bcf86cd799439011' },
      session: { userId: '507f1f77bcf86cd799439012' },
      register: { id: '507f1f77bcf86cd799439013' },
    },
    ...overrides,
  };
}

function response() {
  const listeners = {};
  return {
    statusCode: 200, headers: {}, body: undefined,
    set(name, value) { this.headers[name] = value; return this; },
    setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
    end(body) { this.body = body; return this; },
    on(name, callback) { listeners[name] = callback; return this; },
  };
}

describe('POS request idempotency boundary', () => {
  beforeAll(() => { process.env.POS_IDEMPOTENCY_ENCRYPTION_KEY = 'test-only-shared-key'; });
  beforeEach(() => {
    jest.clearAllMocks();
    mockTx.posIdempotencyRecord.updateMany.mockResolvedValue({ count: 1 });
    mockTx.posIdempotencyResult.create.mockResolvedValue({ id: 'result-a' });
    prisma.posIdempotencyRecord.updateMany.mockResolvedValue({ count: 1 });
  });

  test('commits the business handler and a referenced replay result in the same transaction', async () => {
    const req = request();
    const record = {
      id: 'record-a', companyId: '507f1f77bcf86cd799439011', scope: 'api:POST:/refund',
      idempotencyKey: 'refund-once-0001', payloadHash: payloadHash({ params: req.params, query: req.query, body: req.body }),
      actorId: '507f1f77bcf86cd799439012', registerId: '507f1f77bcf86cd799439013', status: 'PROCESSING',
    };
    prisma.posIdempotencyRecord.create.mockResolvedValue(record);
    let effects = 0;
    const handler = jest.fn((_req, res) => { effects += 1; return res.status(201).json({ success: true, refundId: 'credit-note-a' }); });
    const res = response();

    await idempotentHandler(handler)(req, res, jest.fn());

    expect(runInPrismaTransaction).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(effects).toBe(1);
    expect(mockTx.posIdempotencyResult.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ idempotencyRecordId: 'record-a', payloadCiphertext: expect.any(String) }) }));
    const persistedOutcome = decryptResult(mockTx.posIdempotencyResult.create.mock.calls[0][0].data.payloadCiphertext);
    expect(persistedOutcome).toEqual({ status: 201, body: { success: true, refundId: 'credit-note-a' }, contentType: 'application/json; charset=utf-8', headers: {} });
    expect(mockTx.posIdempotencyRecord.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'record-a', companyId: '507f1f77bcf86cd799439011', status: 'PROCESSING' },
      data: expect.objectContaining({ status: 'COMPLETED', responseStatus: 201, resultReferenceId: expect.any(String) }),
    }));
    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ success: true, refundId: 'credit-note-a' });
  });

  test('replays the original result through its reference without invoking the handler', async () => {
    const req = request();
    const record = {
      id: 'record-b', companyId: '507f1f77bcf86cd799439011', scope: 'api:POST:/refund',
      idempotencyKey: 'refund-once-0001', payloadHash: payloadHash({ params: req.params, query: req.query, body: req.body }),
      actorId: '507f1f77bcf86cd799439012', status: 'COMPLETED', responseStatus: 200, resultReferenceId: 'result-b',
    };
    prisma.posIdempotencyRecord.create.mockRejectedValue({ code: 'P2002' });
    prisma.posIdempotencyRecord.findUnique.mockResolvedValue(record);
    prisma.posIdempotencyResult.findUnique.mockResolvedValue({
      id: 'result-b', companyId: record.companyId, idempotencyRecordId: record.id,
      payloadCiphertext: require('../services/posIdempotencyService').encryptResult({ status: 200, body: { success: true, token: 'same-original-result' }, contentType: 'application/json; charset=utf-8' }),
    });
    const handler = jest.fn();
    const res = response();

    await idempotentHandler(handler)(req, res, jest.fn());

    expect(handler).not.toHaveBeenCalled();
    expect(res.headers['Idempotent-Replay']).toBe('true');
    expect(res.body).toEqual({ success: true, token: 'same-original-result' });
  });

  test('rolls the business work back if writing the result reference fails', async () => {
    const req = request();
    prisma.posIdempotencyRecord.create.mockResolvedValue({ id: 'record-c', companyId: req.posAuthContext.company.id });
    mockTx.posIdempotencyResult.create.mockRejectedValue(new Error('result write failed'));
    const next = jest.fn();
    const res = response();
    const handler = jest.fn((_req, responseObject) => responseObject.json({ success: true, saleId: 'sale-a' }));

    await idempotentHandler(handler)(req, res, next);

    expect(runInPrismaTransaction).toHaveBeenCalledTimes(1);
    expect(mockTx.posIdempotencyRecord.updateMany).not.toHaveBeenCalled();
    expect(prisma.posIdempotencyRecord.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED_SAFE' }) }));
    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe('POS_IDEMPOTENCY_RETRY_SAFE');
  });

  test('quarantines an uncertain commit acknowledgement instead of asking the cashier to repeat it', async () => {
    const req = request();
    prisma.posIdempotencyRecord.create.mockResolvedValue({ id: 'record-commit', companyId: req.posAuthContext.company.id });
    runInPrismaTransaction.mockImplementationOnce(async (work) => {
      await work(mockTx);
      throw new Error('connection lost during commit acknowledgement');
    });
    const res = response();
    const handler = jest.fn((_req, responseObject) => responseObject.json({ success: true, saleId: 'sale-committed' }));

    await idempotentHandler(handler)(req, res, jest.fn());

    expect(prisma.posIdempotencyRecord.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'NEEDS_REVIEW' }),
    }));
    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe('POS_IDEMPOTENCY_NEEDS_REVIEW');
  });

  test('quarantines an in-flight duplicate instead of running it concurrently', async () => {
    const req = request();
    prisma.posIdempotencyRecord.create.mockRejectedValue({ code: 'P2002' });
    prisma.posIdempotencyRecord.findUnique.mockResolvedValue({
      id: 'record-d', companyId: req.posAuthContext.company.id, scope: 'api:POST:/refund',
      idempotencyKey: 'refund-once-0001', payloadHash: payloadHash({ params: req.params, query: req.query, body: req.body }),
      actorId: req.posAuthContext.session.userId, status: 'PROCESSING', leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    const handler = jest.fn();
    const res = response();
    await idempotentHandler(handler)(req, res, jest.fn());
    expect(handler).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('POS_IDEMPOTENCY_IN_PROGRESS');
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({ event: 'POS_DUPLICATE_REQUEST_ATTEMPT' }));
  });
});
