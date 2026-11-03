const { PermissionService, resolveUserRoles } = require('./authorize');
const { registerPermission } = require('../utils/permissionCatalog');
const { getPosPermissionAliases, POS_PERMISSION_COMPATIBILITY } = require('../utils/posPermissionCompatibility');

// Make canonical POS permissions available in the back-office role editor,
// even if a legacy route has not registered that capability yet.
for (const permission of Object.keys(POS_PERMISSION_COMPATIBILITY)) {
  const separator = permission.lastIndexOf('.');
  registerPermission(permission.slice(0, separator), permission.slice(separator + 1));
}

const SYSTEM_ROLE_POS_ACTIONS = {
  read: new Set(['admin', 'accountant', 'manager', 'sales', 'viewer']),
  // Legacy POS sale access stays usable, but its broad create grant must not
  // imply cash movement, credit selling, discounts, or account payments.
  create: new Set(['admin', 'manager', 'sales']),
  pay: new Set(['admin', 'accountant', 'sales']),
  open: new Set(['admin', 'manager', 'sales']),
  close: new Set(['admin', 'manager', 'sales']),
};

/** Require each requested permission from at least one of the user's roles. */
function requirePosPermissions(...permissions) {
  for (const permission of permissions) {
    if (permission && typeof permission === 'object') {
      registerPermission(permission.resource, permission.action);
    }
  }

  const middleware = async (req, res, next) => {
    try {
      const roles = await resolveUserRoles(req.user);
      const roleHasPermission = (role, resource, action) => {
        const isSystemRole = role.is_system_role === true || role.isSystemRole === true;
        const name = String(role.name || '').toLowerCase();
        const aliases = getPosPermissionAliases(resource, action)?.rbac || [[resource, action]];
        const canonicalGranted = PermissionService.checkDirect(role, resource, action);
        return canonicalGranted || aliases.some(([legacyResource, legacyAction]) => {
          const establishedPosAccess = legacyResource === 'point_of_sale' && isSystemRole &&
            SYSTEM_ROLE_POS_ACTIONS[legacyAction]?.has(name);
          return establishedPosAccess || PermissionService.check(role, legacyResource, legacyAction);
        });
      };
      const missing = permissions.filter(({ resource, action }) =>
        !roles.some((role) => {
          return roleHasPermission(role, resource, action);
        }),
      );

      if (missing.length) {
        return res.status(403).json({
          success: false,
          error: 'FORBIDDEN',
          message: 'Your assigned roles do not allow this action.',
          requiredPermissions: missing,
        });
      }

      return next();
    } catch (error) {
      console.error('POS authorization error:', error);
      return res.status(500).json({
        success: false,
        error: 'AUTHORIZATION_ERROR',
        message: 'Could not verify POS permissions.',
      });
    }
  };
  middleware.rbacPermissionGuard = true;
  return middleware;
}

function requireAnyPosPermission(...permissions) {
  for (const permission of permissions) {
    if (permission && typeof permission === 'object') {
      registerPermission(permission.resource, permission.action);
    }
  }

  const middleware = async (req, res, next) => {
    try {
      const roles = await resolveUserRoles(req.user);
      const allowed = permissions.some(({ resource, action }) => {
        const aliases = getPosPermissionAliases(resource, action)?.rbac || [[resource, action]];
        return roles.some((role) => PermissionService.checkDirect(role, resource, action)) ||
          aliases.some(([legacyResource, legacyAction]) => roles.some((role) => {
          const isSystemRole = role.is_system_role === true || role.isSystemRole === true;
          const name = String(role.name || '').toLowerCase();
          return (legacyResource === 'point_of_sale' && isSystemRole && SYSTEM_ROLE_POS_ACTIONS[legacyAction]?.has(name)) ||
            PermissionService.check(role, legacyResource, legacyAction);
          }));
      });

      if (!allowed) {
        return res.status(403).json({
          success: false,
          error: 'FORBIDDEN',
          message: 'Your assigned roles do not allow this action.',
          requiredPermissions: permissions,
        });
      }
      return next();
    } catch (error) {
      console.error('POS authorization error:', error);
      return res.status(500).json({
        success: false,
        error: 'AUTHORIZATION_ERROR',
        message: 'Could not verify POS permissions.',
      });
    }
  };
  middleware.rbacPermissionGuard = true;
  return middleware;
}

module.exports = {
  requirePosPermissions,
  requireAnyPosPermission,
  requireAssignedPermissions: requirePosPermissions,
};
