/**
 * RoleController - API endpoints for role management (PostgreSQL / Prisma)
 *
 * Endpoints:
 * GET    /api/roles              - List system roles + company custom roles
 * POST   /api/roles              - Create custom role for company (admin only)
 * PUT    /api/roles/:id          - Update custom role (cannot modify system roles)
 * DELETE /api/roles/:id          - Delete custom role (cannot delete system roles)
 * GET    /api/roles/:id/permissions - Get all permissions for a role
 */

const { prisma } = require('../lib/prisma');
const { generateObjectId, toIdString } = require('../utils/objectId');
const { roleToApi } = require('../utils/authMappers');
const { parsePagination, paginationMeta } = require('../utils/pagination');
const { getPermissionCatalog: getRegisteredPermissionCatalog } = require('../utils/permissionCatalog');
const RESERVED_ROLE_NAMES = new Set(['admin', 'platform_admin', 'super_admin']);

function requestCompanyId(req) {
  const company = req.company || req.user?.company;
  return toIdString(company?._id || company?.id || company || null);
}

function effectiveCompanyId(req, requestedCompanyId) {
  if (isPlatformAdmin(req)) {
    return toIdString(requestedCompanyId || req.get?.('x-company-id') || req.headers?.['x-company-id'] || null);
  }
  return requestCompanyId(req);
}

function isPlatformAdmin(req) {
  return req.user?.role === 'platform_admin';
}

async function roleWithCompanyOverride(role, companyId) {
  if (!role || !role.isSystemRole || !companyId) return role;
  const override = await prisma.rolePermissionOverride.findUnique({
    where: { companyId_roleId: { companyId, roleId: role.id } },
    select: { permissions: true },
  });
  return override
    ? { ...role, permissions: override.permissions, hasCompanyOverride: true }
    : { ...role, hasCompanyOverride: false };
}

async function rolesWithCompanyOverrides(roles, companyId) {
  if (!companyId) return roles.map((role) => ({ ...role, hasCompanyOverride: false }));
  const systemRoleIds = roles.filter((role) => role.isSystemRole).map((role) => role.id);
  if (!systemRoleIds.length) return roles.map((role) => ({ ...role, hasCompanyOverride: false }));

  const overrides = await prisma.rolePermissionOverride.findMany({
    where: { companyId, roleId: { in: systemRoleIds } },
    select: { roleId: true, permissions: true },
  });
  const overrideByRoleId = new Map(overrides.map((override) => [override.roleId, override.permissions]));
  return roles.map((role) => {
    const permissions = role.isSystemRole ? overrideByRoleId.get(role.id) : undefined;
    return permissions
      ? { ...role, permissions, hasCompanyOverride: true }
      : { ...role, hasCompanyOverride: false };
  });
}

function visibleRoleWhere(req, id) {
  const companyId = requestCompanyId(req);
  return {
    id,
    OR: companyId ? [{ isSystemRole: true }, { companyId }] : [{ isSystemRole: true }],
  };
}

exports.getPermissionCatalog = async (req, res) => {
  res.json({ success: true, data: getRegisteredPermissionCatalog() });
};

const normalizePermissions = (permissions = []) => {
  if (!Array.isArray(permissions)) return [];

  const grouped = new Map();

  for (const permission of permissions) {
    if (!permission) continue;

    if (typeof permission === 'string') {
      const [resource, action] = permission.split(':').map(part => part && part.trim()).filter(Boolean);
      if (!resource || !action) continue;
      if (!grouped.has(resource)) grouped.set(resource, new Set());
      grouped.get(resource).add(action);
      continue;
    }

    if (typeof permission === 'object' && permission.resource) {
      const resource = String(permission.resource).trim();
      const actions = Array.isArray(permission.actions) ? permission.actions : [];
      if (!resource || actions.length === 0) continue;
      if (!grouped.has(resource)) grouped.set(resource, new Set());
      for (const action of actions) {
        if (action) grouped.get(resource).add(String(action).trim());
      }
    }
  }

  return Array.from(grouped.entries()).map(([resource, actions]) => ({
    resource,
    actions: Array.from(actions).filter(Boolean)
  })).filter(permission => permission.actions.length > 0);
};

function hasWildcardGrant(permissions) {
  return permissions.some((permission) =>
    permission.resource === '*' || permission.actions.includes('*'),
  );
}

function unregisteredPermissionPairs(permissions, previouslyAssigned = []) {
  const catalogPairs = new Set(
    getRegisteredPermissionCatalog().flatMap(({ resource, actions }) =>
      actions.map((action) => `${String(resource).toLowerCase()}:${String(action).toLowerCase()}`),
    ),
  );
  const priorPairs = new Set(
    previouslyAssigned.flatMap(({ resource, actions = [] }) =>
      actions.map((action) => `${String(resource).toLowerCase()}:${String(action).toLowerCase()}`),
    ),
  );

  return permissions.flatMap(({ resource, actions }) =>
    actions
      .filter((action) => {
        const key = `${String(resource).toLowerCase()}:${String(action).toLowerCase()}`;
        return !catalogPairs.has(key) && !priorPairs.has(key);
      })
      .map((action) => ({ resource, action })),
  );
}

/**
 * List all roles (system roles + company custom roles)
 * GET /api/roles
 */
exports.getRoles = async (req, res, next) => {
  try {
    // Tenant admins may only list their own roles and the shared system roles.
    // Only a platform admin may choose a tenant through the query string.
    const companyId = effectiveCompanyId(req, req.query.company_id);

    // System roles have companyId null; include the company's custom roles when known
    const where = companyId
      ? { OR: [{ isSystemRole: true }, { companyId }] }
      : { isSystemRole: true };

    const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 200 });
    const [total, roles] = await Promise.all([
      prisma.role.count({ where }),
      prisma.role.findMany({
        where,
        orderBy: [{ isSystemRole: 'desc' }, { name: 'asc' }],
        skip,
        take: limit,
      }),
    ]);

    const effectiveRoles = await rolesWithCompanyOverrides(roles, companyId);
    res.json({
      success: true,
      data: effectiveRoles.map((role) => ({
        ...roleToApi(role),
        has_company_override: Boolean(role.hasCompanyOverride),
      })),
      count: roles.length,
      pagination: paginationMeta(page, limit, total),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get a single role by ID
 * GET /api/roles/:id
 */
exports.getRoleById = async (req, res, next) => {
  try {
    const role = await prisma.role.findFirst({ where: visibleRoleWhere(req, toIdString(req.params.id)) });

    if (!role) {
      return res.status(404).json({
        success: false,
        error: 'ROLE_NOT_FOUND',
        message: 'Role not found'
      });
    }

    const effectiveRole = await roleWithCompanyOverride(role, effectiveCompanyId(req));
    res.json({
      success: true,
      data: { ...roleToApi(effectiveRole), has_company_override: Boolean(effectiveRole.hasCompanyOverride) }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get permissions for a specific role
 * GET /api/roles/:id/permissions
 */
exports.getRolePermissions = async (req, res, next) => {
  try {
    const role = await prisma.role.findFirst({
      where: visibleRoleWhere(req, toIdString(req.params.id)),
      select: { id: true, name: true, isSystemRole: true, permissions: true },
    });

    if (!role) {
      return res.status(404).json({
        success: false,
        error: 'ROLE_NOT_FOUND',
        message: 'Role not found'
      });
    }

    const effectiveRole = await roleWithCompanyOverride(role, effectiveCompanyId(req));
    res.json({
      success: true,
      data: {
        role_id: effectiveRole.id,
        role_name: effectiveRole.name,
        is_system_role: effectiveRole.isSystemRole,
        has_company_override: Boolean(effectiveRole.hasCompanyOverride),
        permissions: effectiveRole.permissions
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Create a new custom role
 * POST /api/roles
 *
 * Only admins can create custom roles for their company
 */
exports.createRole = async (req, res, next) => {
  try {
    const { name, description, permissions, company_id } = req.body;
    const effectiveCompanyId = isPlatformAdmin(req)
      ? toIdString(company_id || null)
      : requestCompanyId(req);

    // Validate required fields
    if (!String(name || '').trim()) {
      return res.status(400).json({
        success: false,
        error: 'VALIDATION_ERROR',
        message: 'Role name is required'
      });
    }
    if (RESERVED_ROLE_NAMES.has(String(name).trim().toLowerCase())) {
      return res.status(400).json({ success: false, error: 'RESERVED_ROLE_NAME', message: 'This role name is reserved for system access' });
    }

    if (!effectiveCompanyId) {
      return res.status(400).json({ success: false, error: 'COMPANY_REQUIRED', message: 'A company is required to create a role' });
    }

    // Check if role already exists for this company (or clashes with a system role)
    const existingRole = await prisma.role.findFirst({
      where: {
        name: String(name).trim(),
        OR: [{ companyId: effectiveCompanyId }, { isSystemRole: true }],
      },
    });

    if (existingRole) {
      return res.status(409).json({
        success: false,
        error: 'ROLE_EXISTS',
        message: 'A role with this name already exists'
      });
    }

    const normalizedPermissions = normalizePermissions(permissions);
    if (!isPlatformAdmin(req) && hasWildcardGrant(normalizedPermissions)) {
      return res.status(400).json({
        success: false,
        error: 'WILDCARD_PERMISSION_FORBIDDEN',
        message: 'Company roles must use the specific resource and actions listed in the permission catalog.',
      });
    }
    if (!isPlatformAdmin(req)) {
      const unknownPermissions = unregisteredPermissionPairs(normalizedPermissions);
      if (unknownPermissions.length) {
        return res.status(400).json({
          success: false,
          error: 'PERMISSION_NOT_IN_CATALOG',
          message: 'Choose permissions from the current system permission catalog.',
          details: unknownPermissions,
        });
      }
    }

    // Create the role (custom roles cannot be system roles)
    const role = await prisma.role.create({
      data: {
        id: generateObjectId(),
        name: String(name).trim(),
        description: description || null,
        permissions: normalizedPermissions,
        companyId: effectiveCompanyId,
        isSystemRole: false,
      },
    });

    res.status(201).json({
      success: true,
      data: roleToApi(role),
      message: 'Role created successfully'
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Update an existing role
 * PUT /api/roles/:id
 *
 * Cannot modify system roles
 */
exports.updateRole = async (req, res, next) => {
  try {
    const id = toIdString(req.params.id);
    const { name, description, permissions } = req.body;

    const role = await prisma.role.findFirst({ where: visibleRoleWhere(req, id) });

    if (!role) {
      return res.status(404).json({
        success: false,
        error: 'ROLE_NOT_FOUND',
        message: 'Role not found'
      });
    }

    if (role.isSystemRole) {
      return res.status(403).json({ success: false, error: 'SYSTEM_ROLE_IMMUTABLE', message: 'System roles cannot be modified' });
    }
    if (!isPlatformAdmin(req) && role.companyId !== requestCompanyId(req)) {
      return res.status(404).json({ success: false, error: 'ROLE_NOT_FOUND', message: 'Role not found' });
    }

    // Check if trying to change name to an existing role
    if (name && name.trim() !== role.name) {
      if (RESERVED_ROLE_NAMES.has(String(name).trim().toLowerCase())) {
        return res.status(400).json({ success: false, error: 'RESERVED_ROLE_NAME', message: 'This role name is reserved for system access' });
      }
      const existingRole = await prisma.role.findFirst({
        where: {
          name: name.trim(),
          OR: [{ companyId: role.companyId }, { isSystemRole: true }],
          NOT: { id },
        },
      });

      if (existingRole) {
        return res.status(409).json({
          success: false,
          error: 'ROLE_EXISTS',
          message: 'A role with this name already exists'
        });
      }
    }

    const data = {};
    if (name) data.name = String(name).trim();
    if (description !== undefined) data.description = description;
    if (permissions) {
      const normalizedPermissions = normalizePermissions(permissions);
      if (!isPlatformAdmin(req) && hasWildcardGrant(normalizedPermissions)) {
        return res.status(400).json({
          success: false,
          error: 'WILDCARD_PERMISSION_FORBIDDEN',
          message: 'Company roles must use the specific resource and actions listed in the permission catalog.',
        });
      }
      if (!isPlatformAdmin(req)) {
        const unknownPermissions = unregisteredPermissionPairs(normalizedPermissions, role.permissions || []);
        if (unknownPermissions.length) {
          return res.status(400).json({
            success: false,
            error: 'PERMISSION_NOT_IN_CATALOG',
            message: 'Choose permissions from the current system permission catalog.',
            details: unknownPermissions,
          });
        }
      }
      data.permissions = normalizedPermissions;
    }

    const updated = await prisma.role.update({ where: { id }, data });

    res.json({
      success: true,
      data: roleToApi(updated),
      message: 'Role updated successfully'
    });
  } catch (error) {
    next(error);
  }
};

exports.updateRolePermissionOverride = async (req, res, next) => {
  try {
    const roleId = toIdString(req.params.id);
    const companyId = effectiveCompanyId(req, req.body.company_id);
    if (!companyId) {
      return res.status(400).json({
        success: false,
        error: 'COMPANY_REQUIRED',
        message: 'A company context is required to customize a system role',
      });
    }

    const role = await prisma.role.findFirst({
      where: { id: roleId, isSystemRole: true },
    });
    if (!role) {
      return res.status(404).json({
        success: false,
        error: 'SYSTEM_ROLE_NOT_FOUND',
        message: 'System role not found',
      });
    }

    if (!Array.isArray(req.body.permissions)) {
      return res.status(400).json({
        success: false,
        error: 'VALIDATION_ERROR',
        message: 'Permissions must be an array',
      });
    }

    const normalizedPermissions = normalizePermissions(req.body.permissions);
    if (!isPlatformAdmin(req) && hasWildcardGrant(normalizedPermissions)) {
      return res.status(400).json({
        success: false,
        error: 'WILDCARD_PERMISSION_FORBIDDEN',
        message: 'Company role overrides must use specific resource permissions.',
      });
    }
    if (!isPlatformAdmin(req)) {
      const unknownPermissions = unregisteredPermissionPairs(normalizedPermissions, role.permissions || []);
      if (unknownPermissions.length) {
        return res.status(400).json({
          success: false,
          error: 'PERMISSION_NOT_IN_CATALOG',
          message: 'Choose permissions from the current system permission catalog.',
          details: unknownPermissions,
        });
      }
    }

    await prisma.rolePermissionOverride.upsert({
      where: { companyId_roleId: { companyId, roleId } },
      create: { companyId, roleId, permissions: normalizedPermissions },
      update: { permissions: normalizedPermissions },
    });

    res.json({
      success: true,
      data: {
        ...roleToApi({ ...role, permissions: normalizedPermissions }),
        has_company_override: true,
      },
      message: 'Company role permissions updated successfully',
    });
  } catch (error) {
    next(error);
  }
};

exports.deleteRolePermissionOverride = async (req, res, next) => {
  try {
    const roleId = toIdString(req.params.id);
    const companyId = effectiveCompanyId(req, req.body?.company_id);
    if (!companyId) {
      return res.status(400).json({
        success: false,
        error: 'COMPANY_REQUIRED',
        message: 'A company context is required to restore system role permissions',
      });
    }

    const role = await prisma.role.findFirst({
      where: { id: roleId, isSystemRole: true },
      select: { id: true },
    });
    if (!role) {
      return res.status(404).json({
        success: false,
        error: 'SYSTEM_ROLE_NOT_FOUND',
        message: 'System role not found',
      });
    }

    await prisma.rolePermissionOverride.deleteMany({ where: { companyId, roleId } });
    res.json({ success: true, message: 'Company role permissions restored to system defaults' });
  } catch (error) {
    next(error);
  }
};

/**
 * Delete a role
 * DELETE /api/roles/:id
 *
 * Cannot delete system roles
 */
exports.deleteRole = async (req, res, next) => {
  try {
    const id = toIdString(req.params.id);

    const role = await prisma.role.findFirst({ where: visibleRoleWhere(req, id) });

    if (!role) {
      return res.status(404).json({
        success: false,
        error: 'ROLE_NOT_FOUND',
        message: 'Role not found'
      });
    }

    if (!isPlatformAdmin(req) && role.companyId !== requestCompanyId(req)) {
      return res.status(404).json({ success: false, error: 'ROLE_NOT_FOUND', message: 'Role not found' });
    }

    // Cannot delete system roles
    if (role.isSystemRole) {
      return res.status(403).json({
        success: false,
        error: 'CANNOT_DELETE_SYSTEM_ROLE',
        message: 'System roles cannot be deleted'
      });
    }

    await prisma.role.delete({ where: { id } });

    res.json({
      success: true,
      message: 'Role deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};
