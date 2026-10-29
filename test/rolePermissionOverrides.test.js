jest.mock('../lib/prisma', () => ({
  prisma: {
    role: {
      count: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    rolePermissionOverride: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      upsert: jest.fn(),
      deleteMany: jest.fn(),
    },
    user: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
    },
  },
}));

const { prisma } = require('../lib/prisma');
const roleController = require('../controllers/roleController');
const authData = require('../services/authDataService');

function makeResponse() {
  const res = {
    status: jest.fn(),
    json: jest.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
}

describe('company-scoped system role permission overrides', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('saves a tenant administrator override against their company, not the system role', async () => {
    prisma.role.findFirst.mockResolvedValue({
      id: 'system-role-1',
      name: 'stock_manager',
      companyId: null,
      isSystemRole: true,
      permissions: [{ resource: 'products', actions: ['read', 'update'] }],
    });
    prisma.rolePermissionOverride.upsert.mockResolvedValue({});

    const req = {
      params: { id: 'system-role-1' },
      body: { company_id: 'attacker-company', permissions: ['products:read'] },
      user: { role: 'admin' },
      company: { id: 'company-a' },
    };
    const res = makeResponse();

    await roleController.updateRolePermissionOverride(req, res, jest.fn());

    expect(prisma.rolePermissionOverride.upsert).toHaveBeenCalledWith({
      where: { companyId_roleId: { companyId: 'company-a', roleId: 'system-role-1' } },
      create: {
        companyId: 'company-a',
        roleId: 'system-role-1',
        permissions: [{ resource: 'products', actions: ['read'] }],
      },
      update: { permissions: [{ resource: 'products', actions: ['read'] }] },
    });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({ has_company_override: true }),
    }));
    expect(prisma.role.update).not.toHaveBeenCalled();
  });

  test('returns effective permissions for the requested company only', async () => {
    prisma.role.count.mockResolvedValue(1);
    prisma.role.findMany.mockResolvedValue([{
      id: 'system-role-1',
      name: 'stock_manager',
      companyId: null,
      isSystemRole: true,
      permissions: [{ resource: 'products', actions: ['read', 'update'] }],
    }]);
    prisma.rolePermissionOverride.findMany.mockResolvedValue([{
      roleId: 'system-role-1',
      permissions: [{ resource: 'products', actions: ['read'] }],
    }]);

    const req = { query: {}, user: { role: 'admin' }, company: { id: 'company-a' } };
    const res = makeResponse();

    await roleController.getRoles(req, res, jest.fn());

    expect(prisma.rolePermissionOverride.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { companyId: 'company-a', roleId: { in: ['system-role-1'] } },
    }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: [expect.objectContaining({
        is_system_role: true,
        has_company_override: true,
        permissions: [{ resource: 'products', actions: ['read'] }],
      })],
    }));
  });

  test('uses the company override while hydrating a user role', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      companyId: 'company-a',
      role: 'stock_manager',
      roles: [{
        role: {
          id: 'system-role-1',
          name: 'stock_manager',
          companyId: null,
          isSystemRole: true,
          permissions: [{ resource: 'products', actions: ['read', 'update'] }],
        },
      }],
    });
    prisma.rolePermissionOverride.findMany.mockResolvedValue([{
      roleId: 'system-role-1',
      permissions: [{ resource: 'products', actions: ['read'] }],
    }]);

    const user = await authData.findUserById('user-1', { populateRoles: true });

    expect(user.roles[0].permissions).toEqual([{ resource: 'products', actions: ['read'] }]);
  });

  test('applies the override to legacy users without a linked role row', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'legacy-user',
      companyId: 'company-a',
      role: 'stock_manager',
    });
    prisma.role.findFirst.mockResolvedValue({
      id: 'system-role-1',
      name: 'stock_manager',
      isSystemRole: true,
      permissions: [{ resource: 'products', actions: ['read', 'update'] }],
    });
    prisma.rolePermissionOverride.findMany.mockResolvedValue([{
      roleId: 'system-role-1',
      permissions: [{ resource: 'products', actions: ['read'] }],
    }]);

    const user = await authData.findUserById('legacy-user', { populateRoles: true });

    expect(user.roles[0].permissions).toEqual([{ resource: 'products', actions: ['read'] }]);
  });

  test('restores system defaults by deleting only the active company override', async () => {
    prisma.role.findFirst.mockResolvedValue({ id: 'system-role-1' });
    prisma.rolePermissionOverride.deleteMany.mockResolvedValue({ count: 1 });
    const req = {
      params: { id: 'system-role-1' },
      body: {},
      user: { role: 'admin' },
      company: { id: 'company-a' },
    };
    const res = makeResponse();

    await roleController.deleteRolePermissionOverride(req, res, jest.fn());

    expect(prisma.rolePermissionOverride.deleteMany).toHaveBeenCalledWith({
      where: { companyId: 'company-a', roleId: 'system-role-1' },
    });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });
});
