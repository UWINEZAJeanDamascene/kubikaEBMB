jest.mock('../lib/prisma', () => ({ prisma: {} }));
jest.mock('../services/posAuditIntegrityService', () => ({ verifyPosAuditIntegrity: jest.fn() }));
jest.mock('../services/posAuditService', () => ({ requestIp: jest.fn(), writePosAuditLog: jest.fn() }));

const { _test } = require('../controllers/posSecurityController');

describe('POS denied-attempt report sampling', () => {
  test('weights sampled rows by the latest count per counter window and scope', () => {
    const at = new Date('2026-11-12T10:00:00.000Z');
    const rows = [
      { event: 'POS_ACTION_DENIED', registerId: 'r1', userId: 'u1', createdAt: at,
        metadata: { attemptCountInWindow: 5, attemptWindowStartedAt: '2026-11-12T10:00:00.000Z', attemptScope: 'POST /sales' } },
      { event: 'POS_ACTION_DENIED', registerId: 'r1', userId: 'u1', createdAt: at,
        metadata: { attemptCountInWindow: 8, attemptWindowStartedAt: '2026-11-12T10:00:00.000Z', attemptScope: 'POST /sales' } },
      { event: 'POS_ACTION_DENIED', registerId: 'r1', userId: 'u1', createdAt: at,
        metadata: { attemptCountInWindow: 3, attemptWindowStartedAt: '2026-11-12T10:00:00.000Z', attemptScope: 'POST /refund' } },
    ];
    expect(_test.sampledEventCounts(rows)).toEqual({ POS_ACTION_DENIED: 11 });
  });

  test('reports PIN attempts in a configured review window using sampled counts', () => {
    const labels = { users: new Map([['u1', 'Cashier']]), registers: new Map([['r1', 'Till 1']]) };
    const rows = [
      { event: 'PIN_LOGIN_FAILED', registerId: 'r1', userId: 'u1', createdAt: new Date('2026-11-12T10:00:01.000Z'),
        metadata: { attemptCountInWindow: 5, attemptWindowStartedAt: '2026-11-12T10:00:00.000Z', attemptScope: 'pin_login' } },
      { event: 'PIN_LOGIN_FAILED', registerId: 'r1', userId: 'u1', createdAt: new Date('2026-11-12T10:00:30.000Z'),
        metadata: { attemptCountInWindow: 8, attemptWindowStartedAt: '2026-11-12T10:00:00.000Z', attemptScope: 'pin_login' } },
    ];
    const [group] = _test.groupAttempts(rows, labels, 5, 15 * 60_000);
    expect(group).toEqual(expect.objectContaining({
      cashier: 'Cashier', register: 'Till 1', failedAttempts: 8, duplicateAttempt: true,
    }));
  });
});
