/**
 * Auth data access facade (PostgreSQL / Prisma).
 * Controllers and middleware call this instead of touching the ORM directly.
 * Returned objects match the legacy Mongoose JSON shapes (see utils/authMappers).
 */
const bcrypt = require('bcryptjs');
const { prisma } = require('../lib/prisma');
const { toIdString } = require('../utils/objectId');
const { userToApi, companyToApi, roleToApi } = require('../utils/authMappers');

async function applyCompanyRoleOverrides(user) {
  if (!user) return user;

  const companyId = toIdString(user.companyId || user.company?._id || user.company?.id || user.company || null);
  if (!companyId) return user;

  let roles = Array.isArray(user.roles) ? user.roles : [];
  let roleIds = roles.map((entry) => entry?.role?.id).filter(Boolean);
  if (!roleIds.length && user.role && !['admin', 'platform_admin'].includes(user.role)) {
    const legacyRole = await prisma.role.findFirst({
      where: { name: user.role, isSystemRole: true },
    });
    if (legacyRole) {
      roles = [{ role: legacyRole }];
      roleIds = [legacyRole.id];
    }
  }
  if (!roleIds.length) return user;

  const overrides = await prisma.rolePermissionOverride.findMany({
    where: { companyId, roleId: { in: roleIds } },
    select: { roleId: true, permissions: true },
  });
  if (!overrides.length) return roles === user.roles ? user : { ...user, roles };

  const permissionsByRoleId = new Map(overrides.map((override) => [override.roleId, override.permissions]));
  return {
    ...user,
    roles: roles.map((entry) => {
      const permissions = entry?.role && permissionsByRoleId.get(entry.role.id);
      return permissions
        ? { ...entry, role: { ...entry.role, permissions } }
        : entry;
    }),
  };
}

/**
 * Load a user for login: includes company + roles, and keeps the password
 * hash on the returned object so compareUserPassword can verify it.
 */
async function findUserByEmailForLogin(email) {
  const user = await prisma.user.findFirst({
    where: { email: String(email).toLowerCase() },
    include: {
      company: true,
      roles: { include: { role: true } },
    },
  });
  if (!user) return null;
  const effectiveUser = await applyCompanyRoleOverrides(user);
  return { ...userToApi(effectiveUser), password: user.password };
}

async function findUserById(id, options = {}) {
  const userId = toIdString(id);
  if (!userId) return null;
  const include = {};
  if (options.populateCompany) include.company = true;
  if (options.populateRoles) include.roles = { include: { role: true } };
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: Object.keys(include).length ? include : undefined,
  });
  if (!user) return null;
  const effectiveUser = options.populateRoles ? await applyCompanyRoleOverrides(user) : user;
  const mapped = userToApi(effectiveUser);
  if (options.includePassword) {
    mapped.password = user.password;
  }
  return mapped;
}

async function findCompanyById(id) {
  const companyId = toIdString(id);
  if (!companyId) return null;
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  return companyToApi(company);
}

async function findSystemRoleByName(name) {
  const role = await prisma.role.findFirst({ where: { name, isSystemRole: true } });
  return roleToApi(role);
}

async function compareUserPassword(user, password) {
  let hash = user && user.password;
  if (!hash) {
    const row = await prisma.user.findUnique({
      where: { id: toIdString(user._id || user.id) },
      select: { password: true },
    });
    hash = row && row.password;
  }
  if (!hash) return false;
  return bcrypt.compare(password, hash);
}

async function markUserLoggedIn(user) {
  return prisma.user.update({
    where: { id: toIdString(user._id || user.id) },
    data: { lastLogin: new Date() },
  });
}

async function updateUserPassword(userId, hashedPassword) {
  return prisma.user.update({
    where: { id: toIdString(userId) },
    data: {
      password: hashedPassword,
      passwordChangedAt: new Date(),
      mustChangePassword: false,
      tempPassword: false,
    },
  });
}

/** Strip secrets from a user object before sending it to the client. */
function toPublicUser(user) {
  if (!user) return null;
  const {
    password,
    refresh_token,
    refresh_token_hash,
    refreshToken,
    refreshTokenHash,
    passwordResetToken,
    passwordResetExpires,
    twoFASecret,
    ...safe
  } = user;
  return safe;
}

module.exports = {
  applyCompanyRoleOverrides,
  findUserByEmailForLogin,
  findUserById,
  findCompanyById,
  findSystemRoleByName,
  compareUserPassword,
  markUserLoggedIn,
  updateUserPassword,
  toPublicUser,
};
