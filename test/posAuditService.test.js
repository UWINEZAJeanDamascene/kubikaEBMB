jest.mock('../lib/prisma', () => ({
  prisma: { posAuditLog: { create: jest.fn() } },
}));

const { prisma } = require('../lib/prisma');
const {
  POS_AUDIT_EVENTS,
  sanitizeMetadata,
  writePosAuditLog,
} = require('../services/posAuditService');

describe('POS audit logging', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('writes only allowlisted event fields and strips sensitive metadata keys', async () => {
    prisma.posAuditLog.create.mockResolvedValue({ id: 'audit-id' });
    await writePosAuditLog({
      companyId: '507f1f77bcf86cd799439011',
      registerId: '507f1f77bcf86cd799439012',
      userId: '507f1f77bcf86cd799439013',
      event: 'APPROVAL_GRANTED',
      metadata: {
        action: 'VOID_SALE',
        approvalToken: 'do-not-store',
        nested: { pin: '2580', sessionId: 'session-id' },
      },
      ip: '127.0.0.1',
    });

    expect(prisma.posAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        companyId: '507f1f77bcf86cd799439011',
        registerId: '507f1f77bcf86cd799439012',
        userId: '507f1f77bcf86cd799439013',
        event: 'APPROVAL_GRANTED',
        metadata: { action: 'VOID_SALE', nested: { sessionId: 'session-id' } },
        ip: '127.0.0.1',
      }),
    });
    expect(JSON.stringify(prisma.posAuditLog.create.mock.calls[0][0])).not.toContain('2580');
    expect(JSON.stringify(prisma.posAuditLog.create.mock.calls[0][0])).not.toContain('do-not-store');
  });

  test('rejects unknown events and missing tenant identity', async () => {
    expect(POS_AUDIT_EVENTS.has('PIN_RESET')).toBe(true);
    expect(POS_AUDIT_EVENTS.has('SHIFT_HISTORY_VIEWED')).toBe(true);
    expect(POS_AUDIT_EVENTS.has('PAYMENT_SETTINGS_UPDATED')).toBe(true);
    expect(POS_AUDIT_EVENTS.has('PAYMENT_REMOVED')).toBe(true);
    expect(POS_AUDIT_EVENTS.has('PAYMENT_PROVIDER_REQUESTED')).toBe(true);
    expect(POS_AUDIT_EVENTS.has('PAYMENT_PROVIDER_REQUEST_UNCERTAIN')).toBe(true);
    expect(POS_AUDIT_EVENTS.has('PAYMENT_PROVIDER_REQUEST_FAILED')).toBe(true);
    expect(POS_AUDIT_EVENTS.has('PAYMENT_PROVIDER_STATUS_UPDATED')).toBe(true);
    expect(POS_AUDIT_EVENTS.has('GIFT_CARD_ISSUED')).toBe(true);
    expect(POS_AUDIT_EVENTS.has('GIFT_CARD_LOADED')).toBe(true);
    expect(POS_AUDIT_EVENTS.has('GIFT_CARD_REDEEMED')).toBe(true);
    expect(POS_AUDIT_EVENTS.has('GIFT_CARD_REFUNDED')).toBe(true);
    await expect(writePosAuditLog({ companyId: 'company', event: 'UNKNOWN' })).rejects.toThrow('Unsupported POS audit event');
    await expect(writePosAuditLog({ event: 'SESSION_ENDED' })).rejects.toThrow('A company is required');
    expect(prisma.posAuditLog.create).not.toHaveBeenCalled();
  });

  test('sanitizes token, hash, and credential fields recursively', () => {
    expect(sanitizeMetadata({
      approvalId: 'approval-1',
      tokenHash: 'secret-hash',
      credentials: [{ password: 'secret', safe: true }],
    })).toEqual({
      approvalId: 'approval-1',
    });
  });
});
