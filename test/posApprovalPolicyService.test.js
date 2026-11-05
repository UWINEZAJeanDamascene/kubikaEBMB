const {
  defaultApprovalPolicy,
  getApprovalPolicy,
  validatePolicyDuration,
} = require('../services/posApprovalPolicyService');

describe('POS approval policies', () => {
  test('provides conservative, action-specific expiry defaults', () => {
    expect(defaultApprovalPolicy('VOID_SALE')).toMatchObject({
      enabled: true,
      requestTtlSeconds: 600,
      pinApprovalTtlSeconds: 60,
      managerApprovalTtlSeconds: 300,
    });
    expect(defaultApprovalPolicy('discount').managerApprovalTtlSeconds).toBe(600);
  });

  test('loads company/action policy and uses defaults only when no policy is stored', async () => {
    const stored = { action: 'VOID_SALE', enabled: false, pinApprovalTtlSeconds: 90 };
    const client = { posApprovalPolicy: { findUnique: jest.fn().mockResolvedValue(stored) } };
    await expect(getApprovalPolicy(client, 'company-1', 'VOID_SALE')).resolves.toBe(stored);
    expect(client.posApprovalPolicy.findUnique).toHaveBeenCalledWith({
      where: { companyId_action: { companyId: 'company-1', action: 'VOID_SALE' } },
    });

    client.posApprovalPolicy.findUnique.mockResolvedValue(null);
    await expect(getApprovalPolicy(client, 'company-1', 'VOID_SALE')).resolves.toEqual(defaultApprovalPolicy('VOID_SALE'));
  });

  test('accepts only bounded whole-second TTL values', () => {
    expect(validatePolicyDuration(60, 60, 3600)).toBe(true);
    expect(validatePolicyDuration(59, 60, 3600)).toBe(false);
    expect(validatePolicyDuration(60.5, 60, 3600)).toBe(false);
    expect(validatePolicyDuration(3601, 60, 3600)).toBe(false);
  });
});
