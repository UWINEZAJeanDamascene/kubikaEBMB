'use strict';

jest.mock('../middleware/authorize', () => ({
  PermissionService: {
    check: jest.fn((role, resource, action) =>
      role.permissions?.some((permission) =>
        permission.resource === resource && permission.actions.includes(action),
      ) || false),
  },
  resolveUserRoles: jest.fn(),
}));

const { PermissionService, resolveUserRoles } = require('../middleware/authorize');
const { authorizeCreditNoteRead } = require('../middleware/creditNoteReadAuthorization');

function response() {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
  return res;
}

describe('authorizeCreditNoteRead', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('marks its route guard so automatic module permission fallback does not override it', () => {
    expect(authorizeCreditNoteRead.rbacPermissionGuard).toBe(true);
  });

  test('allows credit-note readers to use the normal unscoped list', async () => {
    resolveUserRoles.mockResolvedValue([{
      permissions: [{ resource: 'credit_notes', actions: ['read'] }],
    }]);
    const req = {};
    const res = response();
    const next = jest.fn();

    await authorizeCreditNoteRead(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.creditNotePosScoped).toBeUndefined();
  });

  test('allows POS sales users to read only POS-origin credit notes', async () => {
    resolveUserRoles.mockResolvedValue([{
      permissions: [{ resource: 'pos.till', actions: ['sell'] }],
    }]);
    const req = {};
    const res = response();
    const next = jest.fn();

    await authorizeCreditNoteRead(req, res, next);

    expect(PermissionService.check).toHaveBeenCalledWith(expect.any(Object), 'pos.till', 'sell');
    expect(req.creditNotePosScoped).toBe(true);
    expect(next).toHaveBeenCalledWith();
  });

  test('denies users without either read or POS sales access', async () => {
    resolveUserRoles.mockResolvedValue([{ permissions: [] }]);
    const res = response();
    const next = jest.fn();

    await authorizeCreditNoteRead({}, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'FORBIDDEN' }));
    expect(next).not.toHaveBeenCalled();
  });
});
