const SYSTEM_ROLE_NAMES = new Set([
  'admin', 'platform_admin', 'owner', 'manager', 'stock_manager', 'sales', 'cashier', 'supervisor', 'store_manager', 'accountant',
  'purchaser', 'viewer', 'warehouse_manager', 'warehouse', 'staff', 'super_admin',
]);

const permissionsByResource = new Map();

function registerPermission(resourceValue, actionValue) {
  const resource = String(resourceValue || '').trim().toLowerCase();
  const action = String(actionValue || '').trim().toLowerCase();
  if (!resource || !action || resource === '*' || action === '*') return;
  // Role gates use the role name as the first argument, e.g.
  // `authorize('admin', 'stock_manager')`. Filter that resource position only:
  // `admin` can also be a legitimate action on a business resource such as
  // payroll, and must remain in the catalog for role creation.
  if (SYSTEM_ROLE_NAMES.has(resource)) return;

  const actions = permissionsByResource.get(resource) || new Set();
  actions.add(action);
  permissionsByResource.set(resource, actions);
}

function registerPermissionList(permissions) {
  if (!Array.isArray(permissions)) return;
  for (const permission of permissions) {
    if (permission && typeof permission === 'object') {
      registerPermission(permission.resource, permission.action);
    }
  }
}

function getPermissionCatalog() {
  return Array.from(permissionsByResource.entries())
    .map(([resource, actions]) => ({
      resource,
      label: resource.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()),
      actions: Array.from(actions).sort(),
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

module.exports = { registerPermission, registerPermissionList, getPermissionCatalog };
