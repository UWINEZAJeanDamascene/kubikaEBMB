jest.mock('../services/posAuditService', () => ({
  requestIp: jest.fn(() => '127.0.0.1'),
  writePosAuditLog: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/posPrintAgentService', () => ({
  createPairing: jest.fn(),
  pairAgent: jest.fn(),
  refreshAgentToken: jest.fn(),
  rebindAgent: jest.fn(),
  issueDrawerAuthorization: jest.fn(),
  consumeDrawerAuthorization: jest.fn(),
}));

const { writePosAuditLog } = require('../services/posAuditService');
const {
  pairAgent,
  rebindAgent,
  issueDrawerAuthorization,
  consumeDrawerAuthorization,
} = require('../services/posPrintAgentService');
const controller = require('../controllers/posPrintAgentController');

function response() {
  const res = {
    status: jest.fn(),
    json: jest.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

describe('POS print-agent administration', () => {
  beforeEach(() => jest.clearAllMocks());

  test('audits and refuses an attempted pairing across register bindings', async () => {
    pairAgent.mockRejectedValue(Object.assign(new Error('bound elsewhere'), {
      code: 'PRINT_PAIRING_REGISTER_MISMATCH',
      companyId: 'a'.repeat(24),
      registerId: 'b'.repeat(24),
      deviceId: 'device-1',
    }));
    const req = {
      body: { pairingCode: 'KUBIKA-12345678', deviceId: 'device-1' },
      user: {},
    };
    const res = response();

    await controller.pair(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      code: 'PRINT_PAIRING_REGISTER_MISMATCH',
    }));
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      companyId: 'a'.repeat(24),
      registerId: 'b'.repeat(24),
      event: 'PRINT_AGENT_PAIRING_REBIND_DENIED',
      metadata: expect.objectContaining({ deviceId: 'device-1' }),
    }));
  });

  test('audits successful administrator rebinds with the reason and credential rotation', async () => {
    rebindAgent.mockResolvedValue({
      previousRegisterId: 'b'.repeat(24),
      agent: { id: 'd'.repeat(24), registerId: 'e'.repeat(24), status: 'active' },
    });
    const req = {
      params: { agentId: 'd'.repeat(24) },
      body: { registerId: 'e'.repeat(24), reason: 'Moving the till to the new counter' },
      user: { companyId: 'a'.repeat(24), id: 'f'.repeat(24) },
    };
    const res = response();

    await controller.rebind(req, res, jest.fn());

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { id: 'd'.repeat(24), registerId: 'e'.repeat(24), status: 'active' },
    });
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'PRINT_AGENT_REBOUND',
      metadata: expect.objectContaining({
        previousRegisterId: 'b'.repeat(24),
        registerId: 'e'.repeat(24),
        reason: 'Moving the till to the new counter',
        credentialsRotated: true,
      }),
    }));
  });

  test('issues drawer credentials bound to the manager, action, register, and approval', async () => {
    issueDrawerAuthorization.mockResolvedValue({
      token: 'one-time-drawer-token',
      authorization: {
        id: 'g'.repeat(24),
        registerId: 'e'.repeat(24),
        actionType: 'no-sale',
        actionId: 'till-session',
        shiftId: 'h'.repeat(24),
        approvalId: 'i'.repeat(24),
        expiresAt: new Date(),
      },
    });
    const req = {
      body: {
        registerId: 'e'.repeat(24),
        actionType: 'no-sale',
        actionId: 'till-session',
        shiftId: 'h'.repeat(24),
        approvalId: 'i'.repeat(24),
        reason: 'Manager-approved no-sale',
      },
      user: { companyId: 'a'.repeat(24), id: 'f'.repeat(24) },
    };
    const res = response();

    await controller.issueDrawerAuthorization(req, res, jest.fn());

    expect(issueDrawerAuthorization).toHaveBeenCalledWith(expect.objectContaining({
      companyId: 'a'.repeat(24),
      registerId: 'e'.repeat(24),
      requesterId: 'f'.repeat(24),
      approvalId: 'i'.repeat(24),
    }));
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'PRINT_DRAWER_AUTHORIZATION_ISSUED',
      metadata: expect.objectContaining({ actionType: 'no-sale', approvalId: 'i'.repeat(24) }),
    }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ token: 'one-time-drawer-token' }),
    }));
  });

  test.each([
    ['PRINT_DRAWER_AUTHORIZATION_INVALID', 403, ''],
    ['PRINT_DRAWER_AUTHORIZATION_EXPIRED', 410, 'expired-token'],
    ['PRINT_DRAWER_AUTHORIZATION_REUSED', 409, 'reused-token'],
  ])('refuses and audits drawer authorization failure %s', async (code, status, token) => {
    consumeDrawerAuthorization.mockResolvedValue({
      code,
      authorization: { id: 'g'.repeat(24), actionId: 'sale-1' },
    });
    const req = { body: { token }, printAgent: { companyId: 'a'.repeat(24), registerId: 'b'.repeat(24) } };
    const res = response();

    await controller.consumeDrawerAuthorization(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(status);
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'PRINT_DRAWER_KICK_DENIED',
      metadata: expect.objectContaining({
        authorizationId: 'g'.repeat(24),
        actionId: 'sale-1',
        denialCode: code,
      }),
    }));
  });
});
