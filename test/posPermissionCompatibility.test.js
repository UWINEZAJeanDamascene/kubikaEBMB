const { PermissionService } = require('../middleware/authorize');
const { requirePosPermissions } = require('../middleware/posAuthorization');
const {
  POS_PERMISSION_COMPATIBILITY,
  capabilityName,
  getPosPermissionAliases,
  getPosSessionPermissionCandidates,
} = require('../utils/posPermissionCompatibility');

describe('POS permission compatibility catalog', () => {
  test('maps existing ERP grants to the canonical till and back-office capabilities', () => {
    const role = {
      name: 'sales',
      permissions: [{ resource: 'point_of_sale', actions: ['create'] }],
    };

    expect(PermissionService.check(role, 'pos.till', 'sell')).toBe(true);
    expect(PermissionService.check(role, 'pos.admin', 'printers')).toBe(false);
    expect(PermissionService.check({ name: 'manager', permissions: [{ resource: 'tills', actions: ['create'] }] }, 'pos.admin', 'printers')).toBe(true);
    expect(PermissionService.check(role, 'pos.admin', 'registers')).toBe(false);
    expect(PermissionService.check({
      name: 'viewer', permissions: [{ resource: 'roles', actions: ['read'] }],
    }, 'pos.admin', 'roles')).toBe(false);
  });

  test('recognizes existing POS session grants for matching canonical actions only', () => {
    expect(getPosSessionPermissionCandidates('pos.till.sell')).toEqual([
      'pos.till.sell', 'pos.payment.take',
    ]);
    expect(getPosSessionPermissionCandidates('pos.till.close_shift')).toEqual([
      'pos.till.close_shift', 'pos.shift.close', 'pos.report.x',
    ]);
    expect(getPosSessionPermissionCandidates('pos.till.void')).toEqual(['pos.till.void']);
    expect(getPosSessionPermissionCandidates('pos.till.open_shift')).toEqual([
      'pos.till.open_shift', 'pos.shift.open',
    ]);
    expect(getPosSessionPermissionCandidates('pos.payment.take')).toEqual(['pos.payment.take', 'pos.till.sell']);
    expect(getPosSessionPermissionCandidates('pos.cash.out')).toEqual(['pos.cash.out', 'pos.till.cash_move']);
  });

  test('accepts migrated canonical grants directly while retaining the old grant fallback', () => {
    const migrated = {
      name: 'cashier',
      permissions: [{ resource: 'pos.till', actions: ['sell'] }],
    };
    expect(PermissionService.check(migrated, 'pos.till', 'sell')).toBe(true);
    expect(PermissionService.check(migrated, 'pos.till', 'refund')).toBe(false);
    expect(PermissionService.check({
      name: 'sales', permissions: [{ resource: 'point_of_sale', actions: ['create'] }],
    }, 'pos.till', 'sell')).toBe(true);
  });

  test('canonical route middleware accepts legacy role grants and denies unrelated actions', async () => {
    const req = { user: { role: {
      name: 'sales',
      permissions: [{ resource: 'point_of_sale', actions: ['create'] }],
    } } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();

    await requirePosPermissions({ resource: 'pos.till', action: 'sell' })(req, res, next);
    expect(next).toHaveBeenCalledWith();

    const deniedNext = jest.fn();
    await requirePosPermissions({ resource: 'pos.till', action: 'void' })(req, res, deniedNext);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(deniedNext).not.toHaveBeenCalled();
  });

  test('fails closed for capabilities without a legacy equivalent', () => {
    const oldTillGrant = {
      name: 'manager',
      permissions: [{ resource: 'point_of_sale', actions: ['create'] }],
    };

    expect(getPosPermissionAliases('pos.admin', 'shifts')).toEqual({ rbac: [['tills', 'read']] });
    expect(PermissionService.check(oldTillGrant, 'pos.admin', 'shifts')).toBe(false);
    expect(PermissionService.check({ name: 'manager', permissions: [{ resource: 'tills', actions: ['read'] }] }, 'pos.admin', 'approvals')).toBe(true);
    expect(PermissionService.check({ name: 'viewer', permissions: [{ resource: 'reports', actions: ['read'] }] }, 'pos.admin', 'reports')).toBe(true);
    expect(PermissionService.check(oldTillGrant, 'pos.till', 'void')).toBe(false);
  });

  test('catalog names are normalized and every new permission has a declared migration entry', () => {
    expect(capabilityName(' POS.TILL ', ' SELL ')).toBe('pos.till.sell');
    expect(Object.keys(POS_PERMISSION_COMPATIBILITY)).toEqual(expect.arrayContaining([
      'pos.till.sell',
      'pos.till.refund',
      'pos.till.no_sale',
      'pos.admin.registers',
      'pos.admin.printers',
      'pos.admin.audit',
    ]));
  });

  test('canonical permission checks cover every shared till and back-office capability', () => {
    const expected = [
      'pos.till.sell', 'pos.till.discount', 'pos.till.refund', 'pos.till.void',
      'pos.till.no_sale', 'pos.till.cash_move', 'pos.till.reprint', 'pos.till.credit_sell',
      'pos.till.receive_account_payment', 'pos.till.close_shift',
      'pos.admin.view', 'pos.admin.registers', 'pos.admin.cashiers', 'pos.admin.roles',
      'pos.admin.printers', 'pos.admin.settings', 'pos.admin.shifts', 'pos.admin.approvals',
      'pos.admin.reports', 'pos.admin.audit',
    ];
    for (const capability of expected) {
      const [resource, action] = capability.split('.').slice(0, 2).length === 2
        ? [capability.split('.').slice(0, 2).join('.'), capability.split('.').slice(2).join('.')]
        : ['', ''];
      expect(getPosPermissionAliases(resource, action)).not.toBeNull();
      expect(PermissionService.check({
        name: 'explicit', permissions: [{ resource, actions: [action] }],
      }, resource, action)).toBe(true);
    }
  });
});
