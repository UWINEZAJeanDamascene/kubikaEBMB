'use strict';

jest.mock('../lib/prisma', () => ({ dbClient: jest.fn() }));
jest.mock('../services/posAuditService', () => ({
  requestIp: jest.fn(() => '127.0.0.1'),
  writePosAuditLog: jest.fn().mockResolvedValue({}),
}));

const { dbClient } = require('../lib/prisma');
const { writePosAuditLog } = require('../services/posAuditService');
const controller = require('../controllers/posOfflineExceptionController');

describe('POS offline manager exception queue', () => {
  let db;
  let req;
  let res;
  let next;

  beforeEach(() => {
    jest.clearAllMocks();
    db = {
      $queryRawUnsafe: jest.fn(),
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
      $transaction: jest.fn(async (callback) => callback(db)),
      creditNote: { findMany: jest.fn() },
      stockMovement: { findMany: jest.fn() },
    };
    dbClient.mockReturnValue(db);
    req = { company: { id: 'company-a' }, user: { id: 'manager-a', companyId: 'company-a' }, params: {}, query: {}, body: {}, ip: '127.0.0.1', get: () => 'test' };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    next = jest.fn();
  });

  test('lists company-scoped operations and strips secrets from operation payloads', async () => {
    db.$queryRawUnsafe.mockResolvedValue([{
      id: 'exception-1', companyId: 'company-a', deviceId: 'device-a', operationId: 'op-1',
      operationState: 'needs_review', status: 'open', errorCode: 'POS_OFFLINE_RECEIPT_NUMBER_INVALID',
      message: 'Invalid receipt', payload: { type: 'SALE_COMPLETE', displayTotal: 1200, offlineSnapshotCapability: 'secret', items: [{ productId: 'p1', quantity: 1, name: 'Rice' }] },
      result: null, retryAuthorizedAt: null,
    }]);
    await controller.list(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(db.$queryRawUnsafe.mock.calls[0][0]).toContain('COALESCE(e.company_id, p.company_id) = $1');
    expect(db.$queryRawUnsafe.mock.calls[0][1]).toBe('company-a');
    const row = res.json.mock.calls[0][0].data[0];
    expect(row.retryAllowed).toBe(true);
    expect(row.payload.items[0].name).toBe('Rice');
    expect(row.payload.offlineSnapshotCapability).toBeUndefined();
  });

  test('keeps a business conflict open when there is no actual posted sale to link', async () => {
    req.params.exceptionId = 'exception-1';
    req.body = { action: 'SALE_POSTED', reason: 'Checked the invoice and transaction record', referenceId: 'invoice-1' };
    db.$queryRawUnsafe.mockResolvedValueOnce([{ id: 'exception-1', companyId: 'company-a', deviceId: 'device-a', operationId: 'op-1', errorCode: 'POS_OFFLINE_STOCK_CONFLICT', payload: { offlineSaleId: 'sale-offline-1' }, status: 'open' }]).mockResolvedValueOnce([]);
    await controller.resolve(req, res, next);
    expect(db.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 409, code: 'POS_SYNC_EXCEPTION_SALE_NOT_FOUND' }));
  });

  test('authorizes only safe retry cases and records an audit entry without closing the exception', async () => {
    req.params.exceptionId = 'exception-1';
    req.body = { action: 'AUTHORIZE_RETRY', reason: 'Cashier corrected receipt details' };
    db.$queryRawUnsafe.mockResolvedValueOnce([{ id: 'exception-1', companyId: 'company-a', deviceId: 'device-a', operationId: 'op-1', errorCode: 'POS_OFFLINE_RECEIPT_NUMBER_INVALID', payload: {}, status: 'open' }]);
    await controller.resolve(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(db.$executeRawUnsafe.mock.calls[0][0]).toContain("status = 'retry_authorized'");
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({ event: 'POS_OFFLINE_EXCEPTION_RETRY_AUTHORIZED', userId: 'manager-a' }), db);
    expect(res.json.mock.calls[0][0].data.status).toBe('retry_authorized');
  });

  test('resolves only after validating the matching company sale and writes the before/after audit', async () => {
    req.params.exceptionId = 'exception-1';
    req.body = { action: 'SALE_POSTED', reason: 'Verified existing sale in the register ledger', referenceId: 'invoice-1' };
    db.$queryRawUnsafe.mockResolvedValueOnce([{ id: 'exception-1', companyId: 'company-a', deviceId: 'device-a', operationId: 'op-1', errorCode: 'POS_SYNC_OPERATION_FAILED', payload: { offlineSaleId: 'offline-sale-1' }, status: 'open' }]).mockResolvedValueOnce([{ id: 'offline-record-1', invoiceId: 'invoice-1' }]);
    await controller.resolve(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(db.$executeRawUnsafe.mock.calls[0][0]).toContain("status = 'resolved'");
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({ event: 'POS_OFFLINE_EXCEPTION_RESOLVED', metadata: expect.objectContaining({ before: { status: 'open' }, after: expect.objectContaining({ status: 'resolved' }), referenceId: 'invoice-1' }) }), db);
    expect(res.json.mock.calls[0][0].data.status).toBe('resolved');
  });
});
