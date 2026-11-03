jest.mock('../middleware/authorize', () => ({
  PermissionService: { check: jest.fn() },
  resolveUserRoles: jest.fn(),
}));

jest.mock('../utils/permissionCatalog', () => ({
  registerPermission: jest.fn(),
}));

const { PermissionService, resolveUserRoles } = require('../middleware/authorize');
const { requireAnyPosPermission } = require('../middleware/posAuthorization');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

describe('POS receipt read authorization', () => {
  const authorizeReceipt = requireAnyPosPermission(
    { resource: 'point_of_sale', action: 'read' },
    { resource: 'sales_invoices', action: 'read' },
  );

  beforeEach(() => {
    jest.clearAllMocks();
    PermissionService.check.mockImplementation((role, resource, action) =>
      role.grants?.includes(`${resource}:${action}`) || false,
    );
  });

  test.each([
    ['POS reader', 'point_of_sale:read'],
    ['invoice reader', 'sales_invoices:read'],
  ])('allows %s to read a receipt', async (_label, grant) => {
    resolveUserRoles.mockResolvedValue([{ name: 'custom_role', grants: [grant] }]);
    const res = response();
    const next = jest.fn();

    await authorizeReceipt({ user: {} }, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });

  test('denies users without either receipt or invoice read permission', async () => {
    resolveUserRoles.mockResolvedValue([{ name: 'custom_role', grants: [] }]);
    const res = response();
    const next = jest.fn();

    await authorizeReceipt({ user: {} }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });
});
