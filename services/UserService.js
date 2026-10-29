/**
 * UserService - Business Logic for User Management (PostgreSQL / Prisma)
 *
 * Implements user authentication, registration, and management.
 * Response shapes intentionally match the legacy Mongoose API (see utils/authMappers).
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { prisma } = require('../lib/prisma');
const { generateObjectId, toIdString } = require('../utils/objectId');
const { userToApi } = require('../utils/authMappers');
const passwordUtils = require('../utils/passwordUtils');
const SessionService = require('./sessionService');
const TokenService = require('./tokenService');
const { notifyUserCreated, notifyPasswordChanged } = require('./notificationHelper');
const emailService = require('./emailService');
const { validateConfig: validateEmailConfig } = require('../config/email');
const { getPasswordPolicyError, passwordChangeRequired } = require('../utils/passwordPolicy');
const speakeasy = require('speakeasy');
const { redisClient, isRedisConfigured } = require('../config/redis');

// Import centralized configuration
const env = require('../src/config/environment');
const config = env.getConfig();

// Validate required config - JWT_SECRET MUST be set in environment
if (!config.jwt.secret) {
  throw new Error('FATAL: JWT_SECRET environment variable is required. Please set it in your .env file.');
}
const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_DURATION_MINUTES = 0; // DISABLED: was 30 — re-enable by setting back to 30

const USER_ERRORS = {
  EMAIL_ALREADY_REGISTERED: 'EMAIL_ALREADY_REGISTERED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  INVALID_REFRESH_TOKEN: 'INVALID_REFRESH_TOKEN',
  CURRENT_PASSWORD_INCORRECT: 'CURRENT_PASSWORD_INCORRECT',
  PASSWORD_TOO_SHORT: 'PASSWORD_TOO_SHORT',
  PASSWORD_POLICY_VIOLATION: 'PASSWORD_POLICY_VIOLATION',
  INVALID_OR_EXPIRED_TOKEN: 'INVALID_OR_EXPIRED_TOKEN',
  USER_ALREADY_MEMBER: 'USER_ALREADY_MEMBER',
  TWO_FACTOR_CONFIGURATION_INVALID: 'TWO_FACTOR_CONFIGURATION_INVALID',
  TWO_FACTOR_CHALLENGE_UNAVAILABLE: 'TWO_FACTOR_CHALLENGE_UNAVAILABLE',
  INVALID_TWO_FACTOR_CHALLENGE: 'INVALID_TWO_FACTOR_CHALLENGE',
  INVALID_TWO_FACTOR_CODE: 'INVALID_TWO_FACTOR_CODE',
};

/** Bcrypt work comparable to real logins, so unknown-email failures do not return much faster than wrong-password. */
let loginTimingDummyHash;
function getLoginTimingDummyHash() {
  if (!loginTimingDummyHash) {
    loginTimingDummyHash = bcrypt.hashSync('__login_unknown_user_timing__', 12);
  }
  return loginTimingDummyHash;
}

const generatePasswordResetToken = () => crypto.randomBytes(32).toString('hex');

function serviceError(code, extras = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, extras);
  return error;
}

async function findSystemRole(name) {
  return prisma.role.findFirst({ where: { name, isSystemRole: true } });
}

const ALL_ACTIONS = ['read', 'create', 'update', 'delete', 'approve', 'post', 'pay', 'remit', 'export', 'file', 'admin'];

function collectPermissions(set, permissions) {
  for (const perm of permissions || []) {
    if (!perm || !perm.resource) continue;
    const actions = Array.isArray(perm.actions) ? perm.actions : [];
    if (perm.resource === '*') {
      for (const action of (actions.includes('*') ? ALL_ACTIONS : actions)) {
        set.add(`*:${action}`);
      }
      if (actions.includes('*')) set.add('*');
    } else {
      for (const action of actions) {
        if (action === '*') {
          set.add(`${perm.resource}:*`);
          for (const a of ALL_ACTIONS) set.add(`${perm.resource}:${a}`);
        } else {
          set.add(`${perm.resource}:${action}`);
        }
      }
    }
  }
}

async function permissionsForLoginUser(user) {
  const permissionsSet = new Set();

  if (user.role === 'admin' || user.role === 'platform_admin') {
    permissionsSet.add('*');
  }

  const linkedRoles = (user.roles || []).map((entry) => entry.role).filter(Boolean);
  if (linkedRoles.length > 0) {
    for (const role of linkedRoles) {
      collectPermissions(permissionsSet, role.permissions);
    }
  } else if (user.role && user.role !== 'admin' && user.role !== 'platform_admin') {
    const legacyRole = await findSystemRole(user.role);
    if (legacyRole) collectPermissions(permissionsSet, legacyRole.permissions);
  }

  return Array.from(permissionsSet);
}

class UserService {
  /**
   * Register a new user
   * Creates user with hashed password, email stored in lowercase
   * @throws EMAIL_ALREADY_REGISTERED when email exists
   */
  static async register(userData) {
    const { email, password, name, companyId, role = 'viewer' } = userData;
    const emailLower = String(email).toLowerCase();

    const existingUser = await prisma.user.findFirst({
      where: { email: emailLower, ...(companyId ? { companyId: toIdString(companyId) } : {}) },
    });
    if (existingUser) {
      throw serviceError(USER_ERRORS.EMAIL_ALREADY_REGISTERED);
    }

    const passwordError = getPasswordPolicyError(password);
    if (passwordError) throw serviceError(passwordError.code, { message: passwordError.message });

    const roleDoc = await findSystemRole(role);

    const user = await prisma.user.create({
      data: {
        id: generateObjectId(),
        name,
        email: emailLower,
        password: await passwordUtils.hash(password),
        companyId: companyId ? toIdString(companyId) : null,
        role,
        isActive: true,
        failedLoginAttempts: 0,
        lockedUntil: null,
        roles: roleDoc ? { create: [{ roleId: roleDoc.id }] } : undefined,
      },
      include: { roles: { include: { role: true } } },
    });

    return userToApi(user);
  }

  /**
   * Login user
   * @throws INVALID_CREDENTIALS for wrong password or unknown email
   * @throws ACCOUNT_LOCKED when locked_until is in the future
   * Returns access_token and refresh_token
   */
  static async login(email, password, companyId = null, sessionContext = {}) {
    const user = await prisma.user.findFirst({
      where: {
        email: String(email).toLowerCase(),
        ...(companyId ? { companyId: toIdString(companyId) } : {}),
      },
      include: {
        company: true,
        roles: { include: { role: true } },
      },
    });

    if (!user) {
      await bcrypt.compare(password, getLoginTimingDummyHash());
      throw serviceError(USER_ERRORS.INVALID_CREDENTIALS);
    }

    // Check if account is locked
    if (user.lockedUntil && new Date() < user.lockedUntil) {
      throw serviceError(USER_ERRORS.ACCOUNT_LOCKED, { lockedUntil: user.lockedUntil });
    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      await UserService._recordFailedLoginAttempt(user, sessionContext);
      throw serviceError(USER_ERRORS.INVALID_CREDENTIALS);
    }

    if (!user.isActive) {
      throw serviceError(USER_ERRORS.INVALID_CREDENTIALS);
    }

    // Check company status (for non-platform admins)
    if (user.role !== 'platform_admin' && companyId) {
      const company = await prisma.company.findUnique({ where: { id: toIdString(companyId) } });
      if (!company || !company.isActive || company.approvalStatus !== 'approved') {
        throw serviceError(USER_ERRORS.INVALID_CREDENTIALS);
      }
    }

    if (user.twoFAEnabled) {
      if (!user.twoFAConfirmed || !user.twoFASecret) {
        throw serviceError(USER_ERRORS.TWO_FACTOR_CONFIGURATION_INVALID);
      }
      return UserService._createTwoFactorLoginChallenge(user);
    }

    return UserService._completeLogin(user, sessionContext);
  }

  static async _completeLogin(user, sessionContext = {}) {
    // Persist the login state and refresh-token hash in one database write.
    // The token service accepts the additional fields so a cold Neon connection
    // is not paid for twice on every successful login.
    const lastLogin = new Date();
    const memberships = [{
      companyId: user.companyId ? String(user.companyId) : undefined,
      role: user.role,
    }];
    const { access_token: accessToken, refresh_token: refreshToken } =
      await TokenService.issueTokensForUser(user.id, memberships, {
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLogin,
      });
    await UserService.recordLoginHistory(user, 'login', sessionContext, 'success');

    const companyIdStr = user.companyId ? String(user.companyId) : null;
    try {
      await SessionService.createSession(
        user.id,
        companyIdStr,
        user.role,
        accessToken,
        { email: user.email, name: user.name, ...sessionContext }
      );
    } catch (e) {
      console.error('Session creation on login failed (tokens still issued):', e);
    }

    const loginUser = userToApi({
      ...user,
      lastLogin,
      mustChangePassword: passwordChangeRequired(user),
    });
    loginUser.permissions = await permissionsForLoginUser(user);

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      userId: user.id,
      user: loginUser,
      memberships: [{
        companyId: companyIdStr || undefined,
        role: user.role,
      }],
    };
  }

  /** Keep personal sign-in history useful without allowing audit storage failures to block authentication. */
  static async recordLoginHistory(user, action, context = {}, status = 'success') {
    if (!user?.id) return;
    try {
      const ActionLog = require('../models/ActionLog');
      await ActionLog.create({
        user: String(user.id),
        company: user.companyId ? String(user.companyId) : null,
        action,
        module: 'auth',
        status,
        ipAddress: context.ipAddress || null,
        userAgent: context.userAgent || null,
        details: {},
      });
    } catch (error) {
      console.error('Failed to record login history:', error?.message || error);
    }
  }

  static async _createTwoFactorLoginChallenge(user) {
    if (!isRedisConfigured()) throw serviceError(USER_ERRORS.TWO_FACTOR_CHALLENGE_UNAVAILABLE);
    const challengeToken = crypto.randomBytes(32).toString('base64url');
    const challengeKey = `auth:2fa:login:${crypto.createHash('sha256').update(challengeToken).digest('hex')}`;
    try {
      if (typeof redisClient.status === 'string') {
        await redisClient.set(challengeKey, JSON.stringify({ userId: String(user.id) }), 'EX', 300);
      } else {
        await redisClient.set(challengeKey, JSON.stringify({ userId: String(user.id) }), { ex: 300 });
      }
    } catch {
      throw serviceError(USER_ERRORS.TWO_FACTOR_CHALLENGE_UNAVAILABLE);
    }
    return { requiresTwoFA: true, challengeToken, expiresIn: 300 };
  }

  static async verifyLoginTwoFactor(challengeToken, token, sessionContext = {}) {
    if (!isRedisConfigured()) throw serviceError(USER_ERRORS.TWO_FACTOR_CHALLENGE_UNAVAILABLE);
    const challengeHash = crypto.createHash('sha256').update(String(challengeToken || '')).digest('hex');
    const challengeKey = `auth:2fa:login:${challengeHash}`;
    const attemptsKey = `${challengeKey}:attempts`;
    const lockKey = `${challengeKey}:verify-lock`;
    let challengeRaw;
    try { challengeRaw = await redisClient.get(challengeKey); } catch {
      throw serviceError(USER_ERRORS.TWO_FACTOR_CHALLENGE_UNAVAILABLE);
    }
    if (!challengeRaw) throw serviceError(USER_ERRORS.INVALID_TWO_FACTOR_CHALLENGE);
    let challenge;
    try { challenge = JSON.parse(challengeRaw); } catch {
      throw serviceError(USER_ERRORS.INVALID_TWO_FACTOR_CHALLENGE);
    }

    const user = await prisma.user.findUnique({
      where: { id: challenge.userId },
      include: { company: true, roles: { include: { role: true } } },
    });
    if (!user || !user.isActive || !user.twoFAEnabled || !user.twoFAConfirmed || !user.twoFASecret || (user.lockedUntil && new Date() < user.lockedUntil)) {
      await redisClient.del(challengeKey, attemptsKey);
      throw serviceError(USER_ERRORS.INVALID_TWO_FACTOR_CHALLENGE);
    }
    if (user.role !== 'platform_admin' && user.companyId) {
      const company = await prisma.company.findUnique({ where: { id: toIdString(user.companyId) } });
      if (!company || !company.isActive || company.approvalStatus !== 'approved') {
        await redisClient.del(challengeKey, attemptsKey);
        throw serviceError(USER_ERRORS.INVALID_TWO_FACTOR_CHALLENGE);
      }
    }

    const verified = /^\d{6}$/.test(String(token || '')) && speakeasy.totp.verify({
      secret: user.twoFASecret, encoding: 'base32', token: String(token), window: 1,
    });
    if (!verified) {
      const attempts = await redisClient.incr(attemptsKey);
      if (attempts === 1) await redisClient.expire(attemptsKey, 300);
      if (attempts >= 5) await redisClient.del(challengeKey, attemptsKey);
      throw serviceError(USER_ERRORS.INVALID_TWO_FACTOR_CODE);
    }

    let lockResult;
    try {
      if (typeof redisClient.status === 'string') lockResult = await redisClient.set(lockKey, '1', 'EX', 30, 'NX');
      else lockResult = await redisClient.set(lockKey, '1', { ex: 30, nx: true });
    } catch { throw serviceError(USER_ERRORS.TWO_FACTOR_CHALLENGE_UNAVAILABLE); }
    if (lockResult !== 'OK' && lockResult !== true) throw serviceError(USER_ERRORS.INVALID_TWO_FACTOR_CHALLENGE);
    try {
      const latest = await redisClient.get(challengeKey);
      if (latest !== challengeRaw) throw serviceError(USER_ERRORS.INVALID_TWO_FACTOR_CHALLENGE);
      const replayKey = `auth:2fa:used:${String(user.id)}:${String(token)}`;
      const replayResult = typeof redisClient.status === 'string'
        ? await redisClient.set(replayKey, '1', 'EX', 90, 'NX')
        : await redisClient.set(replayKey, '1', { ex: 90, nx: true });
      if (replayResult !== 'OK' && replayResult !== true) throw serviceError(USER_ERRORS.INVALID_TWO_FACTOR_CODE);
      await redisClient.del(challengeKey, attemptsKey);
      return await UserService._completeLogin(user, sessionContext);
    } finally {
      await redisClient.del(lockKey);
    }
  }

  /** Increment failed attempts and lock the account when the threshold is hit. */
  static async _recordFailedLoginAttempt(user, sessionContext = {}) {
    let attempts = user.failedLoginAttempts || 0;
    let lockedUntil = user.lockedUntil;

    // Lock expired — restart the counter
    if (lockedUntil && new Date() >= lockedUntil) {
      attempts = 0;
      lockedUntil = null;
    }

    attempts += 1;
    if (attempts >= MAX_LOGIN_ATTEMPTS) {
      lockedUntil = new Date(Date.now() + LOCK_DURATION_MINUTES * 60 * 1000);
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: attempts, lockedUntil },
    });
    await UserService.recordLoginHistory(user, 'login_failed', sessionContext, 'failure');
  }

  /**
   * Refresh access token
   * @throws INVALID_REFRESH_TOKEN for expired or tampered token
   */
  static async refresh(refreshToken) {
    return TokenService.refreshWithRotation(refreshToken);
  }

  /**
   * Force logout from all devices — clears refresh token and all sessions for user.
   */
  static async forceLogoutAllSessions(userId) {
    await TokenService.revokeAllForUser(userId);
  }

  /**
   * Invite user to company
   * Creates user if email not registered, links existing user if already registered
   * @throws USER_ALREADY_MEMBER on duplicate invite
   */
  static async inviteUserToCompany(inviterId, inviteData) {
    const { email, companyId, role = 'viewer', name, departmentId = null } = inviteData;
    const emailLower = String(email).trim().toLowerCase();
    const companyIdStr = toIdString(companyId);
    const inviterIdStr = toIdString(inviterId);

    const existingMember = await prisma.user.findFirst({
      where: { email: emailLower, companyId: companyIdStr },
    });
    if (existingMember) {
      throw serviceError(USER_ERRORS.USER_ALREADY_MEMBER);
    }

    let user = await prisma.user.findFirst({
      where: { email: emailLower },
      include: { roles: true },
    });

    const roleDoc = await prisma.role.findFirst({
      where: { name: String(role).trim(), OR: [{ isSystemRole: true }, { companyId: companyIdStr }] },
    });
    if (!roleDoc || (roleDoc.name === 'platform_admin')) {
      throw serviceError('INVALID_ROLE');
    }
    const normalizedDepartmentId = departmentId ? toIdString(departmentId) : null;
    let department = null;
    if (normalizedDepartmentId) {
      department = await prisma.department.findFirst({
        where: { id: normalizedDepartmentId, companyId: companyIdStr, isActive: true },
        select: { id: true, name: true },
      });
      if (!department) throw serviceError('INVALID_DEPARTMENT');
    }

    if (user?.companyId && String(user.companyId) !== companyIdStr) {
      throw serviceError('USER_BELONGS_TO_OTHER_COMPANY');
    }
    if (user) {
      const existingMembership = await prisma.companyUser.findFirst({
        where: { userId: user.id },
        select: { companyId: true },
      });
      if (existingMembership) {
        throw serviceError(existingMembership.companyId === companyIdStr ? USER_ERRORS.USER_ALREADY_MEMBER : 'USER_BELONGS_TO_OTHER_COMPANY');
      }
    }

    let isNewUser = false;
    let setupUrl = null;
    if (!user) {
      // Never send a password by email. The one-time setup link is stored using
      // the existing password-reset fields and is invalidated after use.
      const initialSecret = crypto.randomBytes(48).toString('hex');
      const setupToken = generatePasswordResetToken();
      user = await prisma.user.create({
        data: {
          id: generateObjectId(),
          name: String(name || emailLower.split('@')[0]).trim(),
          email: emailLower,
          password: await passwordUtils.hash(initialSecret),
          companyId: companyIdStr,
          role: roleDoc.name,
          departmentId: normalizedDepartmentId,
          isActive: true,
          mustChangePassword: true,
          tempPassword: true,
          passwordResetToken: setupToken,
          passwordResetExpires: new Date(Date.now() + 24 * 60 * 60 * 1000),
          createdById: inviterIdStr,
          failedLoginAttempts: 0,
          lockedUntil: null,
          roles: roleDoc ? { create: [{ roleId: roleDoc.id }] } : undefined,
        },
        include: { roles: { include: { role: true } } },
      });
      setupUrl = `${config.server.frontendUrl.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(setupToken)}`;
      isNewUser = true;
    } else {
      // Account exists without an organization: attach the role and department
      // to its primary workspace so it can actually authenticate there.
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          companyId: companyIdStr,
          role: roleDoc.name,
          departmentId: normalizedDepartmentId,
          roles: { deleteMany: {}, create: [{ roleId: roleDoc.id }] },
        },
        include: { roles: { include: { role: true } } },
      });
    }

    // Log to audit trail (still Mongo-backed until its own migration phase)
    try {
      const ActionLog = require('../models/ActionLog');
      await ActionLog.create({
        user: inviterIdStr,
        company: companyIdStr,
        action: isNewUser ? 'user_created' : 'user_linked',
        module: 'user',
        details: { invitedEmail: email, role, isNewUser },
      });
    } catch (e) {
      console.error('Failed to log audit trail:', e);
    }

    let inviter = null;
    try {
      inviter = await prisma.user.findUnique({ where: { id: inviterIdStr } });
      await notifyUserCreated(companyIdStr, userToApi(user), inviter ? userToApi(inviter) : null);
    } catch (e) {
      console.error('Failed to send notification:', e);
    }

    // Send invitation email
    try {
      let invitationEmailSent = false;
      if (config.features?.emailNotifications && validateEmailConfig().valid) {
        const company = await prisma.company.findUnique({ where: { id: companyIdStr } });
        invitationEmailSent = await emailService.sendUserInvitationEmail({
          to: user.email,
          name: user.name,
          companyName: company?.name || 'the company',
          inviterName: inviter?.name || 'Admin',
          role: roleDoc.name,
          departmentName: department?.name,
          setupUrl,
        });
        if (!invitationEmailSent) console.error('[UserInvite] Email provider did not accept invitation for user:', user.id);
      } else {
        console.warn('[UserInvite] Email delivery is disabled or misconfigured; user created without a delivered invitation');
      }
      return {
        user: userToApi(user),
        isNewUser,
        invitationEmailSent,
        message: isNewUser ? 'User created' : 'User account assigned to workspace',
      };
    } catch (emailErr) {
      console.error('[UserInvite] Failed to send invitation email:', emailErr.message);
      return {
        user: userToApi(user),
        isNewUser,
        invitationEmailSent: false,
        message: isNewUser ? 'User created' : 'User account assigned to workspace',
      };
    }
  }

  static async resendUserInvitation(inviterId, companyId, userId) {
    const companyIdStr = toIdString(companyId);
    const user = await prisma.user.findFirst({
      where: { id: toIdString(userId), companyId: companyIdStr },
      include: { roles: { include: { role: true } } },
    });
    if (!user) throw serviceError('USER_NOT_FOUND');
    if (!user.mustChangePassword) throw serviceError('INVITATION_NOT_PENDING');

    const role = await prisma.role.findFirst({
      where: { name: user.role, OR: [{ isSystemRole: true }, { companyId: companyIdStr }] },
      select: { name: true },
    });
    const department = user.departmentId
      ? await prisma.department.findFirst({ where: { id: user.departmentId, companyId: companyIdStr }, select: { name: true } })
      : null;
    const emailReady = config.features?.emailNotifications && validateEmailConfig().valid;
    if (!emailReady) return { invitationEmailSent: false };
    const token = generatePasswordResetToken();
    const previousToken = user.passwordResetToken;
    const previousExpiry = user.passwordResetExpires;
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordResetToken: token, passwordResetExpires: new Date(Date.now() + 24 * 60 * 60 * 1000) },
    });

    const [company, inviter] = await Promise.all([
      prisma.company.findUnique({ where: { id: companyIdStr }, select: { name: true } }),
      prisma.user.findUnique({ where: { id: toIdString(inviterId) }, select: { name: true } }),
    ]);
    const setupUrl = `${config.server.frontendUrl.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(token)}`;
    const invitationEmailSent = await emailService.sendUserInvitationEmail({
      to: user.email,
      name: user.name,
      companyName: company?.name || 'your company',
      inviterName: inviter?.name || 'Your administrator',
      role: role?.name || user.role,
      departmentName: department?.name,
      setupUrl,
    });
    if (!invitationEmailSent) {
      await prisma.user.updateMany({
        where: { id: user.id, passwordResetToken: token },
        data: { passwordResetToken: previousToken, passwordResetExpires: previousExpiry },
      });
    }
    return { invitationEmailSent };
  }

  /**
   * Change password
   * @throws CURRENT_PASSWORD_INCORRECT for wrong current password
   * @throws PASSWORD_TOO_SHORT for password under 8 characters
   */
  static async changePassword(userId, currentPassword, newPassword) {
    const passwordError = getPasswordPolicyError(newPassword);
    if (passwordError) throw serviceError(passwordError.code, { message: passwordError.message });

    const user = await prisma.user.findUnique({ where: { id: toIdString(userId) } });
    if (!user) {
      throw serviceError('USER_NOT_FOUND');
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      throw serviceError(USER_ERRORS.CURRENT_PASSWORD_INCORRECT);
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: await passwordUtils.hash(newPassword),
        passwordChangedAt: new Date(),
        mustChangePassword: false,
        tempPassword: false,
      },
    });

    try {
      await notifyPasswordChanged(user.companyId, user.id);
    } catch (e) {
      console.error('Failed to send notification:', e);
    }

    return { success: true, message: 'Password changed successfully' };
  }

  /**
   * Reset password with valid token
   * @throws INVALID_OR_EXPIRED_TOKEN for expired reset token
   */
  static async resetPassword(token, newPassword) {
    const passwordError = getPasswordPolicyError(newPassword);
    if (passwordError) throw serviceError(passwordError.code, { message: passwordError.message });

    const user = await prisma.user.findFirst({
      where: {
        passwordResetToken: token,
        passwordResetExpires: { gt: new Date() },
      },
    });

    if (!user) {
      throw serviceError(USER_ERRORS.INVALID_OR_EXPIRED_TOKEN);
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: await passwordUtils.hash(newPassword),
        passwordChangedAt: new Date(),
        mustChangePassword: false,
        tempPassword: false,
        passwordResetToken: null,
        passwordResetExpires: null,
      },
    });

    return { success: true, message: 'Password reset successfully' };
  }

  /**
   * Request password reset (generate token)
   */
  static async requestPasswordReset(email) {
    const user = await prisma.user.findFirst({ where: { email: String(email).toLowerCase() } });

    if (!user) {
      // Don't reveal if email exists
      return { success: true, message: 'If email exists, reset link will be sent' };
    }

    const emailReady = config.features?.emailNotifications !== false && validateEmailConfig().valid;
    if (!emailReady) throw serviceError('EMAIL_NOT_CONFIGURED');

    const resetToken = generatePasswordResetToken();
    const resetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    const previousToken = user.passwordResetToken;
    const previousExpires = user.passwordResetExpires;

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordResetToken: resetToken, passwordResetExpires: resetExpires },
    });
    const emailSent = await emailService.sendPasswordResetEmail({
      to: user.email,
      name: user.name,
      resetToken,
    });

    if (!emailSent) {
      console.error('[PasswordReset] Email service returned false');
      await prisma.user.updateMany({
        where: { id: user.id, passwordResetToken: resetToken },
        data: { passwordResetToken: previousToken, passwordResetExpires: previousExpires },
      });
      throw serviceError('EMAIL_DELIVERY_FAILED');
    }

    return {
      success: true,
      message: 'Password reset link sent to your email',
    };
  }

  /**
   * Get user by ID (with computed flat permissions array)
   */
  static async getUserById(userId) {
    const user = await prisma.user.findUnique({
      where: { id: toIdString(userId) },
      include: {
        company: true,
        roles: { include: { role: true } },
      },
    });
    if (!user) {
      throw new Error('User not found');
    }

    const userObj = userToApi(user);

    const permissionsSet = new Set();

    // Admin and platform_admin get wildcard permissions
    if (user.role === 'admin' || user.role === 'platform_admin') {
      permissionsSet.add('*');
    }

    const linkedRoles = (user.roles || []).map((entry) => entry.role).filter(Boolean);
    if (linkedRoles.length > 0) {
      for (const role of linkedRoles) {
        collectPermissions(permissionsSet, role.permissions);
      }
    } else if (user.role && user.role !== 'admin' && user.role !== 'platform_admin') {
      // Fallback: look up the Role by the legacy role string name
      const legacyRole = await findSystemRole(user.role);
      if (legacyRole) {
        collectPermissions(permissionsSet, legacyRole.permissions);
      }
    }

    userObj.permissions = Array.from(permissionsSet);
    return userObj;
  }

  /**
   * Update user
   */
  static async updateUser(userId, updateData) {
    const { userInputToPrisma } = require('../utils/authMappers');
    // Don't allow password/lockout updates through this method
    const data = { ...updateData };
    delete data.password;
    delete data.refresh_token;
    delete data.refresh_token_hash;
    delete data.failed_login_attempts;
    delete data.locked_until;

    try {
      const user = await prisma.user.update({
        where: { id: toIdString(userId) },
        data: userInputToPrisma(data),
        include: { roles: { include: { role: true } } },
      });
      return userToApi(user);
    } catch (e) {
      if (e.code === 'P2025') {
        throw new Error('User not found');
      }
      throw e;
    }
  }

  /**
   * Get users for a company
   */
  static async getUsers(companyId, options = {}) {
    const { page = 1, limit = 20, role, isActive, search } = options;

    const where = { companyId: toIdString(companyId) };
    if (role) where.role = role;
    if (isActive !== undefined) where.isActive = isActive === 'true' || isActive === true;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 20;

    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        include: { createdBy: { select: { id: true, name: true, email: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
      }),
    ]);

    return {
      data: users.map(userToApi),
      pagination: {
        total,
        pages: Math.ceil(total / limitNum),
        currentPage: pageNum,
        limit: limitNum,
      },
    };
  }
}

// Export error codes for convenience
UserService.ERRORS = USER_ERRORS;

module.exports = UserService;
