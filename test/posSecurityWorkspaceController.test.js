'use strict';

jest.mock('../lib/prisma', () => ({ prisma: {
  systemSettings: { findUnique: jest.fn(), upsert: jest.fn() },
  posSession: { findMany: jest.fn(), findFirst: jest.fn(), updateMany: jest.fn() },
  $transaction: jest.fn(),
} }));
jest.mock('../services/posAuditIntegrityService', () => ({ verifyPosAuditIntegrity: jest.fn() }));
jest.mock('../services/posAuditService', () => ({ requestIp: jest.fn(() => '192.0.2.1'), writePosAuditLog: jest.fn() }));

const { prisma } = require('../lib/prisma');
const { writePosAuditLog } = require('../services/posAuditService');
const controller = require('../controllers/posSecurityController');

function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

describe('POS security workspace controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation((callback) => callback(prisma));
    prisma.systemSettings.findUnique.mockResolvedValue({
      posSecuritySettings: { duplicateAttemptWindowMinutes: 20, duplicateAttemptThreshold: 7, riskReportLookbackDays: 45, pinFailureLimit: 6, pinLockoutMinutes: 8 },
      posIdleLockMinutes: 4,
      posSingleRegisterSession: false,
    });
  });

  test('reads and persists the enforced PIN, idle-lock, and single-register policies', async () => {
    const read = response();
    await controller.getSettings({ user: { companyId: 'company-a' } }, read);
    expect(read.body.data).toEqual({
      duplicateAttemptWindowMinutes: 20, duplicateAttemptThreshold: 7, riskReportLookbackDays: 45,
      pinFailureLimit: 6, pinLockoutMinutes: 8, idleLockMinutes: 4, singleRegisterSession: false,
    });

    const tx = { systemSettings: { upsert: jest.fn().mockResolvedValue({}) } };
    prisma.$transaction.mockImplementationOnce((callback) => callback(tx));
    const save = response();
    const settings = { ...read.body.data, idleLockMinutes: 12, singleRegisterSession: true, pinFailureLimit: 4 };
    await controller.updateSettings({ user: { companyId: 'company-a', id: 'manager-a' }, body: settings }, save);
    expect(save.body).toEqual({ success: true, data: settings });
    expect(tx.systemSettings.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { companyId: 'company-a' },
      update: expect.objectContaining({ posIdleLockMinutes: 12, posSingleRegisterSession: true,
        posSecuritySettings: expect.objectContaining({ pinFailureLimit: 4, pinLockoutMinutes: 8 }) }),
    }));
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({ event: 'POS_SECURITY_SETTINGS_UPDATED' }), tx);
  });

  test('lists only tenant active sessions and revokes one session with a transactional audit event', async () => {
    prisma.posSession.findMany.mockResolvedValue([{
      id: '507f1f77bcf86cd799439011', status: 'active', startedAt: new Date(), lastActivityAt: new Date(), lockedAt: null,
      user: { name: 'Aline', email: 'aline@example.test' },
      register: { name: 'Front till', code: 'REG-A', claimedDeviceId: 'device-123456' },
    }]);
    const listed = response();
    await controller.activeSessions({ user: { companyId: 'company-a' } }, listed);
    expect(prisma.posSession.findMany.mock.calls[0][0].where).toEqual({ companyId: 'company-a', status: { in: ['active', 'locked'] } });
    expect(listed.body.data[0]).toMatchObject({ cashier: 'Aline', register: 'Front till', device: 'Device 123456' });
    expect(JSON.stringify(listed.body)).not.toContain('aline@example.test');

    const session = { id: '507f1f77bcf86cd799439011', registerId: 'register-a', userId: 'cashier-a', status: 'active' };
    const tx = {
      posSession: {
        findFirst: jest.fn().mockResolvedValue(session),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    prisma.$transaction.mockImplementationOnce((callback) => callback(tx));
    const revoked = response();
    await controller.revokeSession({
      user: { companyId: 'company-a', id: 'manager-a' }, params: { sessionId: session.id }, ip: '192.0.2.1',
    }, revoked);
    expect(tx.posSession.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: session.id, companyId: 'company-a', status: { in: ['active', 'locked'] } } }));
    expect(tx.posSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'ended', endReason: 'REVOKED' }) }));
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({ event: 'SESSION_ENDED', outcome: 'COMMITTED' }), tx);
    expect(revoked.body.data).toEqual({ sessionId: session.id, status: 'ended' });
  });
});
