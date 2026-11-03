/**
 * Permission-based Authorization Middleware
 *
 * This middleware checks if the user's role has the required permission
 * to perform a specific action on a specific resource.
 *
 * Usage:
 * router.post('/invoices', authenticate, authorize('sales_invoices', 'create'), handler)
 */

const { prisma } = require('../lib/prisma');
const { toIdString } = require('../utils/objectId');
const { roleToApi } = require('../utils/authMappers');
const { registerPermission, registerPermissionList } = require('../utils/permissionCatalog');
const { getPosPermissionAliases } = require('../utils/posPermissionCompatibility');

const LEGACY_RESOURCE_ALIASES = {
  payroll: new Set(['payroll_runs']),
};

/**
 * PermissionService - Checks if a role has a specific permission
 */
class PermissionService {
  /**
   * Check if a role has permission to perform an action on a resource
   * @param {Object} role - The role object with permissions array
   * @param {string} resource - The resource to check (e.g., 'products', 'invoices')
   * @param {string} action - The action to perform (e.g., 'read', 'create', 'update', 'delete')
   * @returns {boolean} - True if permission is granted, false otherwise
   */
  static check(role, resource, action) {
    const aliases = getPosPermissionAliases(resource, action)?.rbac;
    if (aliases?.length) {
      // New grants are authoritative after the permission migration. Keep the
      // narrow legacy fallback so deployments can roll out the migration
      // independently without dropping existing role access.
      return this.checkDirect(role, resource, action) || aliases.some(([legacyResource, legacyAction]) =>
        this.checkDirect(role, legacyResource, legacyAction));
    }
    return this.checkDirect(role, resource, action);
  }

  static checkDirect(role, resource, action) {
    if (!role || !role.permissions || !Array.isArray(role.permissions)) {
      return false;
    }

    const isSystemRole = role.is_system_role === true || role.isSystemRole === true;

    for (const permission of role.permissions) {
      // Wildcard resource matches everything
      if (permission.resource === '*') {
        // Tenant-defined roles must never gain access across every resource
        // through a crafted or legacy wildcard grant.
        if (!isSystemRole) continue;

        if (role.name === 'admin') {
          return true;
        }

        if (permission.actions.includes(action) || permission.actions.includes('*')) {
          return true;
        }
      }

      // Exact resource match
      if (permission.resource === resource || LEGACY_RESOURCE_ALIASES[resource]?.has(permission.resource)) {
        if (
          permission.actions.includes(action) ||
          (isSystemRole && permission.actions.includes('*'))
        ) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Check if role has ANY of the specified permissions
   */
  static hasAny(role, permissions) {
    for (const perm of permissions) {
      if (this.check(role, perm.resource, perm.action)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if role has ALL of the specified permissions
   */
  static hasAll(role, permissions) {
    for (const perm of permissions) {
      if (!this.check(role, perm.resource, perm.action)) {
        return false;
      }
    }
    return true;
  }
}

/**
 * Resolve the effective role object for a request user.
 * Handles populated role objects, role id arrays, and the legacy role string.
 */
async function resolveUserRole(user) {
  // Populated role object
  if (user.role && typeof user.role === 'object' && user.role.permissions) {
    return user.role;
  }

  if (user.roles && Array.isArray(user.roles) && user.roles.length > 0) {
    const firstRole = user.roles[0];
    if (typeof firstRole === 'object' && firstRole.permissions) {
      return firstRole;
    }
    const roleId = toIdString(firstRole && firstRole._id ? firstRole._id : firstRole);
    if (roleId) {
      const role = await prisma.role.findUnique({ where: { id: roleId } });
      if (role) return roleToApi(role);
    }
  }

  if (user.role) {
    // Legacy: role is a string name
    const role = await prisma.role.findFirst({ where: { name: user.role } });
    if (role) return roleToApi(role);
  }

  return null;
}

async function resolveUserRoles(user) {
  if (!user) return [];
  const roles = [];
  if (user.role && typeof user.role === 'object' && Array.isArray(user.role.permissions)) roles.push(user.role);
  const roleIds = [];
  for (const item of (Array.isArray(user.roles) ? user.roles : [])) {
    if (item && typeof item === 'object' && Array.isArray(item.permissions)) roles.push(item);
    else {
      const id = toIdString(item && item._id ? item._id : item);
      if (id) roleIds.push(id);
    }
  }
  if (roleIds.length) {
    const rows = await prisma.role.findMany({ where: { id: { in: [...new Set(roleIds)] } } });
    roles.push(...rows.map(roleToApi));
  }
  if (typeof user.role === 'string') {
    const rawCompany = user.company;
    const companyId = toIdString(rawCompany && typeof rawCompany === 'object'
      ? rawCompany._id || rawCompany.id
      : rawCompany);
    const role = await prisma.role.findFirst({
      where: {
        name: user.role,
        ...(companyId
          ? { OR: [{ isSystemRole: true }, { companyId }] }
          : { isSystemRole: true }),
      },
    });
    if (role) roles.push(roleToApi(role));
  }
  const seen = new Set();
  return roles.filter((role) => {
    const key = String(role.id || role._id || role.name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildAuthorizeMiddleware(checkFn, failureMessage) {
  return (resourceOrPermissions, maybeAction) => {
    if (Array.isArray(resourceOrPermissions)) {
      registerPermissionList(resourceOrPermissions);
    } else if (typeof resourceOrPermissions === 'string' && typeof maybeAction === 'string') {
      registerPermission(resourceOrPermissions, maybeAction);
    }
    const middleware = async (req, res, next) => {
      try {
        const user = req.user;

        if (!user) {
          return res.status(401).json({
            success: false,
            error: 'UNAUTHORIZED',
            message: 'Authentication required'
          });
        }

        const roles = await resolveUserRoles(user);

        if (!roles.length) {
          return res.status(403).json({
            success: false,
            error: 'ROLE_NOT_FOUND',
            message: 'User role not found'
          });
        }

        // A user can be assigned more than one role. Evaluate the same
        // effective role set everywhere rather than silently considering only
        // the first role (POS and payroll already evaluate the full set).
        const hasPermission = roles.some((role) =>
          checkFn(role, resourceOrPermissions, maybeAction),
        );

        if (!hasPermission) {
          const roleNames = roles.map((role) => role.name).filter(Boolean).join(', ');
          return res.status(403).json({
            success: false,
            error: 'FORBIDDEN',
            message: failureMessage({ name: roleNames }, resourceOrPermissions, maybeAction)
          });
        }

        // Attach role to request for downstream use
        req.userRole = roles[0];
        req.userRoles = roles;

        next();
      } catch (err) {
        console.error('Authorization error:', err);
        res.status(500).json({
          success: false,
          error: 'AUTHORIZATION_ERROR',
          message: err.message
        });
      }
    };
    middleware.rbacPermissionGuard = true;
    return middleware;
  };
}

/**
 * Create authorization middleware for a specific resource and action
 */
const authorize = buildAuthorizeMiddleware(
  (role, resource, action) => PermissionService.check(role, resource, action),
  (role, resource, action) => `Role '${role.name}' does not have '${action}' permission on '${resource}'`
);

/**
 * Create middleware that checks for ANY of the specified permissions
 */
const authorizeAny = buildAuthorizeMiddleware(
  (role, permissions) => PermissionService.hasAny(role, permissions),
  (role) => `Role '${role.name}' does not have any of the required permissions`
);

/**
 * Create middleware that checks for ALL of the specified permissions
 */
const authorizeAll = buildAuthorizeMiddleware(
  (role, permissions) => PermissionService.hasAll(role, permissions),
  (role) => `Role '${role.name}' does not have all required permissions`
);

module.exports = {
  authorize,
  authorizeAny,
  authorizeAll,
  PermissionService,
  resolveUserRole,
  resolveUserRoles,
};
