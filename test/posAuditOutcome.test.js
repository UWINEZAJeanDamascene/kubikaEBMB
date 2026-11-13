jest.mock('../services/posAuditService', () => ({
  writePosAuditLog: jest.fn().mockResolvedValue({ id: 'audit-id' }),
  writePosDenialAudit: jest.fn().mockResolvedValue({ id: 'audit-id' }),
  requestIp: jest.fn(() => '127.0.0.1'),
}));

const { writePosAuditLog, writePosDenialAudit } = require('../services/posAuditService');
const { posAuditOutcome } = require('../middleware/posAuditOutcome');

function setup({ method = 'POST', companyId = 'company-1', routePath = '/sales', status = 403 } = {}) {
  const req = {
    method,
    baseUrl: '/api/pos',
    route: { path: routePath },
    user: companyId ? { id: 'user-1', companyId } : null,
    posAuthContext: { register: { id: 'register-1' } },
  };
  const writes = [];
  const res = {
    statusCode: status,
    end: jest.fn((chunk, _encoding, callback) => {
      writes.push(chunk);
      if (typeof callback === 'function') callback();
      return res;
    }),
  };
  const originalEnd = res.end;
  const next = jest.fn();
  posAuditOutcome(req, res, next);
  return { req, res, next, writes, originalEnd };
}

describe('POS route outcome audit', () => {
  beforeEach(() => { writePosAuditLog.mockClear(); writePosDenialAudit.mockClear(); });

  test('records one denied event and waits for it before sending the response', async () => {
    let releaseAudit;
    writePosDenialAudit.mockImplementationOnce(() => new Promise((resolve) => { releaseAudit = resolve; }));
    const { req, res, next, originalEnd } = setup({ status: 403 });
    expect(next).toHaveBeenCalledTimes(1);

    res.end(JSON.stringify({ success: false, code: 'POS_PERMISSION_REQUIRED', password: 'must-not-log' }));
    expect(originalEnd).not.toHaveBeenCalled();
    expect(writePosDenialAudit).toHaveBeenCalledTimes(1);
    expect(writePosDenialAudit).toHaveBeenCalledWith(expect.objectContaining({
      companyId: 'company-1', registerId: 'register-1', userId: 'user-1', event: 'POS_ACTION_DENIED',
      metadata: expect.objectContaining({ operation: 'POST /api/pos/sales', statusCode: 403, errorCode: 'POS_PERMISSION_REQUIRED' }),
    }));
    releaseAudit({ id: 'audit-id' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(originalEnd).toHaveBeenCalledTimes(1);
  });

  test('avoids duplicating a domain-specific denial event', async () => {
    const { req, res, originalEnd } = setup({ status: 400 });
    req.posDomainDenialAudited = true;
    res.end('{"code":"POS_VOUCHER_INVALID"}');
    expect(writePosAuditLog).not.toHaveBeenCalled();
    expect(writePosDenialAudit).not.toHaveBeenCalled();
    expect(originalEnd).toHaveBeenCalledTimes(1);
  });

  test('records failed server writes once, and leaves successful writes alone', async () => {
    const failed = setup({ status: 500, routePath: '/settings/:id' });
    failed.res.end('{"message":"failure"}');
    await new Promise((resolve) => setImmediate(resolve));
    expect(writePosAuditLog).toHaveBeenCalledTimes(1);
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'POS_ACTION_FAILED',
      metadata: { operation: 'POST /api/pos/settings/:id', statusCode: 500 },
    }));

    writePosAuditLog.mockClear();
    const successful = setup({ status: 200 });
    successful.res.end('{"success":true}');
    expect(writePosAuditLog).not.toHaveBeenCalled();
  });

  test('does not invent an actor for unauthenticated writes', () => {
    const { res, originalEnd } = setup({ companyId: null, status: 401 });
    res.end('{"code":"UNAUTHENTICATED"}');
    expect(writePosAuditLog).not.toHaveBeenCalled();
    expect(originalEnd).toHaveBeenCalledTimes(1);
  });

  test('does not audit read requests', () => {
    const { res, next } = setup({ method: 'GET', status: 500 });
    expect(next).toHaveBeenCalledTimes(1);
    res.end('error');
    expect(writePosAuditLog).not.toHaveBeenCalled();
  });
});
