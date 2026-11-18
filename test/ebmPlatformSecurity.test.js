jest.mock('../lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
    },
  },
}));

const UserService = require('../services/UserService');
const { prisma } = require('../lib/prisma');
const requirePlatformAdmin = require('../middleware/requirePlatformAdmin');
const {
  companyInputToPrisma,
  companyToApi,
  userInputToPrisma,
} = require('../utils/authMappers');

describe('platform EBM control security', () => {
  test('public registration cannot create a platform administrator', async () => {
    await expect(UserService.register({
      email: 'platform@example.test',
      password: 'StrongPassword123!',
      name: 'Platform User',
      role: 'PLATFORM_ADMIN',
    })).rejects.toMatchObject({ code: 'PLATFORM_ROLE_ASSIGNMENT_FORBIDDEN' });
  });

  test('tenant company DTOs omit EBM control state and ignore attempted updates', () => {
    const company = companyToApi({
      id: '507f1f77bcf86cd799439011',
      name: 'Example',
      ebmEnabled: true,
      ebmToggleReason: 'secret reason',
      ebmToggleChangedBy: '507f1f77bcf86cd799439012',
    });

    expect(company).not.toHaveProperty('ebm_enabled');
    expect(company).not.toHaveProperty('ebm_toggle_reason');
    expect(company).not.toHaveProperty('ebm_toggle_changed_by');
    expect(companyInputToPrisma({
      ebm_enabled: false,
      ebmToggleReason: 'forged',
      ebmToggleChangedBy: '507f1f77bcf86cd799439012',
    })).toEqual({});
  });

  test('tenant user updates cannot change MFA state', () => {
    expect(userInputToPrisma({
      twoFAEnabled: false,
      twoFAConfirmed: false,
      name: 'Allowed profile field',
    })).toEqual({ name: 'Allowed profile field' });
  });

  test('platform controls require a persisted platform administrator role but not MFA', async () => {
    const response = () => ({
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    });
    const next = jest.fn();

    const tenantResponse = response();
    await requirePlatformAdmin({ user: { id: 'user-1', role: 'admin', twoFAEnabled: true, twoFAConfirmed: true } }, tenantResponse, next);
    expect(tenantResponse.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();

    prisma.user.findUnique.mockResolvedValueOnce({
      role: 'platform_admin',
    });

    await requirePlatformAdmin({ user: { id: 'user-1', role: 'platform_admin' } }, response(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
