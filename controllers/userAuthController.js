/**
 * UserAuthController - Authentication endpoints
 * 
 * Implements authentication endpoints for the acceptance tests
 */

const UserService = require('../services/UserService');
const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
const passwordUtils = require('../utils/passwordUtils');
const sessionService = require('../services/sessionService');
const env = require('../src/config/environment');
const config = env.getConfig();
const Warehouse = require('../models/Warehouse');
const EBMBranchService = require('../services/ebmBranchService');
const { toIdString } = require('../utils/objectId');
const { userToApi } = require('../utils/authMappers');

// Generate JWT Token
const generateToken = (id, companyId, role) => {
  const jwt = require('jsonwebtoken');
  return jwt.sign(
    { id, companyId, role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRE }
  );
};

/**
 * Register new user
 * POST /api/auth/register
 */
exports.register = async (req, res, next) => {
  try {
    const { email, password, name, companyId, role } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({
        success: false,
        message: 'Please provide email, password, and name'
      });
    }

    const user = await UserService.register({
      email,
      password,
      name,
      companyId,
      role
    });

    res.status(201).json({
      success: true,
      data: user
    });
  } catch (error) {
    if (error.code === 'EMAIL_ALREADY_REGISTERED') {
      return res.status(409).json({
        success: false,
        message: 'Email already registered',
        code: 'EMAIL_ALREADY_REGISTERED'
      });
    }
    if (error.code === 'PASSWORD_TOO_SHORT') {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 8 characters',
        code: 'PASSWORD_TOO_SHORT'
      });
    }
    next(error);
  }
};

/**
 * Login user
 * POST /api/auth/login
 */
exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide email and password'
      });
    }

    const result = await UserService.login(email, password, req.body.companyId);

    // Keep cookie-based clients aligned with the new access token too. The
    // bearer token remains the primary frontend contract, but an old cookie
    // must never survive a successful login and win on the next request.
    res.cookie('token', result.access_token, {
      httpOnly: true,
      secure: config.server.env === 'production',
      sameSite: 'lax',
      maxAge: config.session.ttl * 1000,
    });

    res.json({
      success: true,
      token: result.access_token,
      access_token: result.access_token,
      refresh_token: result.refresh_token,
      userId: result.userId,
      user: result.user,
      memberships: result.memberships
    });
  } catch (error) {
    if (error.code === 'INVALID_CREDENTIALS') {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials',
        code: 'INVALID_CREDENTIALS'
      });
    }
    if (error.code === 'ACCOUNT_LOCKED') {
      return res.status(423).json({
        success: false,
        message: 'Account is locked',
        code: 'ACCOUNT_LOCKED',
        lockedUntil: error.lockedUntil
      });
    }
    next(error);
  }
};

/**
 * Refresh access token (refresh token rotation)
 * POST /api/auth/refresh
 * Returns new access_token and new refresh_token; previous refresh_token is invalidated server-side.
 */
exports.refresh = async (req, res, next) => {
  try {
    const { refresh_token } = req.body;

    if (!refresh_token) {
      return res.status(400).json({
        success: false,
        message: 'Please provide refresh token'
      });
    }

    const result = await UserService.refresh(refresh_token);

    res.cookie('token', result.access_token, {
      httpOnly: true,
      secure: config.server.env === 'production',
      sameSite: 'lax',
      maxAge: config.session.ttl * 1000,
    });

    res.json({
      success: true,
      access_token: result.access_token,
      refresh_token: result.refresh_token,
    });
  } catch (error) {
    if (error.code === 'REFRESH_TOKEN_EXPIRED') {
      return res.status(401).json({
        success: false,
        message: 'Refresh token expired',
        code: 'REFRESH_TOKEN_EXPIRED',
      });
    }
    if (error.code === 'INVALID_REFRESH_TOKEN') {
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired refresh token',
        code: 'INVALID_REFRESH_TOKEN',
      });
    }
    next(error);
  }
};

/**
 * Invite user to company
 * POST /api/users/invite
 */
exports.inviteUser = async (req, res, next) => {
  try {
    const { email, role, name, departmentId } = req.body;
    const authenticatedCompany = req.company || req.user.company;
    const companyId = authenticatedCompany?._id || authenticatedCompany?.id || req.user.companyId || authenticatedCompany;

    if (!email || !companyId) {
      return res.status(400).json({
        success: false,
        message: 'A valid email and authenticated company are required'
      });
    }

    const assignedBranch = Object.prototype.hasOwnProperty.call(req.body, 'branch')
      ? req.body.branch
      : req.body.defaultWarehouse;
    const branch = assignedBranch
      ? await Warehouse.findOne({ _id: assignedBranch, company: companyId })
      : null;
    if (assignedBranch && !branch) {
      return res.status(400).json({ success: false, code: 'INVALID_BRANCH', message: 'Select a branch in this company' });
    }

    const result = await UserService.inviteUserToCompany(req.user.id, {
      email,
      companyId,
      role,
      name,
      departmentId,
    });

    if (assignedBranch) {
      await prisma.user.update({
        where: { id: result.user._id, companyId: toIdString(companyId) },
        data: { branchId: toIdString(assignedBranch) },
      });
      result.user.branch = toIdString(assignedBranch);
      if (branch.rraBranchId) {
        result.branchUserSubmission = await EBMBranchService.submitBranchUsers(companyId, branch.rraBranchId, req.user);
        result.user = await prisma.user.findFirst({
          where: { id: result.user._id, companyId: toIdString(companyId) },
          include: { roles: { include: { role: true } } },
        });
        result.user = userToApi(result.user);
      }
    }

    res.status(201).json({
      success: true,
      data: result.user,
      isNewUser: result.isNewUser,
      invitationEmailSent: result.invitationEmailSent,
      message: result.message,
      ...(result.branchUserSubmission ? { branchUserSubmission: result.branchUserSubmission } : {}),
    });
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(409).json({ success: false, message: 'An account with this email is already present in the workspace', code: 'USER_ALREADY_MEMBER' });
    }
    if (error.code === 'USER_ALREADY_MEMBER') {
      return res.status(409).json({
        success: false,
        message: 'User is already a member of this company',
        code: 'USER_ALREADY_MEMBER'
      });
    }
    if (['INVALID_ROLE', 'INVALID_DEPARTMENT', 'USER_BELONGS_TO_OTHER_COMPANY'].includes(error.code)) {
      const messages = {
        INVALID_ROLE: 'The selected role is not available in this company.',
        INVALID_DEPARTMENT: 'The selected department is not active in this company.',
        USER_BELONGS_TO_OTHER_COMPANY: 'This email already belongs to another company. Multi-company account invitations are not supported yet.',
      };
      return res.status(409).json({ success: false, code: error.code, message: messages[error.code] });
    }
    next(error);
  }
};

/**
 * Change password
 * PUT /api/auth/change-password
 */
exports.changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Please provide current and new password'
      });
    }

    const result = await UserService.changePassword(
      req.user.id,
      currentPassword,
      newPassword
    );

    res.json({
      success: true,
      message: result.message
    });
  } catch (error) {
    if (error.code === 'CURRENT_PASSWORD_INCORRECT') {
      return res.status(401).json({
        success: false,
        message: 'Current password is incorrect',
        code: 'CURRENT_PASSWORD_INCORRECT'
      });
    }
    if (error.code === 'PASSWORD_TOO_SHORT') {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 8 characters',
        code: 'PASSWORD_TOO_SHORT'
      });
    }
    next(error);
  }
};

/**
 * Reset password
 * POST /api/auth/reset-password
 */
exports.resetPassword = async (req, res, next) => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide token and new password'
      });
    }

    const result = await UserService.resetPassword(token, password);

    res.json({
      success: true,
      message: result.message
    });
  } catch (error) {
    if (error.code === 'INVALID_OR_EXPIRED_TOKEN') {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired reset token',
        code: 'INVALID_OR_EXPIRED_TOKEN'
      });
    }
    if (error.code === 'PASSWORD_TOO_SHORT') {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 8 characters',
        code: 'PASSWORD_TOO_SHORT'
      });
    }
    next(error);
  }
};

/**
 * Request password reset
 * POST /api/auth/forgot-password
 */
exports.forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Please provide email'
      });
    }

    const result = await UserService.requestPasswordReset(email);

    res.json({
      success: true,
      message: result.message
    });
  } catch (error) {
    if (error.code === 'EMAIL_NOT_CONFIGURED') {
      return res.status(503).json({
        success: false,
        message: 'Password reset email is not configured. Please contact support.',
        code: 'EMAIL_NOT_CONFIGURED'
      });
    }
    if (error.code === 'EMAIL_DELIVERY_FAILED') {
      return res.status(502).json({
        success: false,
        message: 'Could not send the password reset email. Please try again later.',
        code: 'EMAIL_DELIVERY_FAILED'
      });
    }
    next(error);
  }
};

/**
 * Get current user
 * GET /api/auth/me
 */
exports.getMe = async (req, res, next) => {
  try {
    const user = await UserService.getUserById(req.user.id);

    res.json({
      success: true,
      data: user
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Logout
 * POST /api/auth/logout
 */
exports.logout = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];

    if (req.user) {
      await sessionService.deleteSession(req.user.id, token);
      if (token) {
        await sessionService.blacklistToken(token);
      }
    }

    res.json({
      success: true,
      message: 'Logged out successfully'
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Force logout from all devices
 * POST /api/auth/logout-all
 */
exports.logoutAll = async (req, res, next) => {
  try {
    await UserService.forceLogoutAllSessions(req.user.id);

    res.json({
      success: true,
      message: 'Logged out from all devices'
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get current user's sessions
 * GET /api/auth/my-sessions
 */
exports.getMySessions = async (req, res, next) => {
  try {
    const sessions = await sessionService.getUserSessions(req.user.id);
    
    res.json({
      success: true,
      data: sessions
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get user's sessions (admin only)
 * GET /api/auth/users/:userId/sessions
 */
exports.getUserSessions = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const sessions = await sessionService.getUserSessions(userId);
    
    res.json({
      success: true,
      data: sessions
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Force logout a specific user (admin only)
 * POST /api/auth/users/:userId/force-logout
 */
exports.forceLogoutUser = async (req, res, next) => {
  try {
    const { userId } = req.params;
    
    await sessionService.deleteAllSessions(userId);
    
    res.json({
      success: true,
      message: `All sessions for user ${userId} have been terminated`
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Check if platform admin setup is needed
 * GET /api/auth/platform-admin-status
 * Public - returns whether a platform admin exists
 */
exports.checkPlatformAdminStatus = async (req, res, next) => {
  try {
    const existingAdmin = await prisma.user.findFirst({ where: { role: 'platform_admin' } });
    res.json({
      success: true,
      needsSetup: !existingAdmin
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Setup the first platform admin
 * POST /api/auth/setup-platform-admin
 * Public - requires PLATFORM_ADMIN_SETUP_KEY env var
 * Can only be used once when no platform admin exists
 */
exports.setupPlatformAdmin = async (req, res, next) => {
  try {
    const { setupKey, email, password, name } = req.body;

    // Verify setup key is configured and matches
    const expectedKey = process.env.PLATFORM_ADMIN_SETUP_KEY;
    if (!expectedKey) {
      return res.status(503).json({
        success: false,
        message: 'Platform admin setup is not configured on this server.',
        code: 'SETUP_NOT_CONFIGURED'
      });
    }

    if (!setupKey || setupKey !== expectedKey) {
      return res.status(403).json({
        success: false,
        message: 'Invalid setup key.',
        code: 'INVALID_SETUP_KEY'
      });
    }

    // Validate required fields
    if (!email || !password || !name) {
      return res.status(400).json({
        success: false,
        message: 'Please provide name, email, and password'
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 8 characters',
        code: 'PASSWORD_TOO_SHORT'
      });
    }

    // Check if any platform admin already exists
    const existingAdmin = await prisma.user.findFirst({ where: { role: 'platform_admin' } });
    if (existingAdmin) {
      return res.status(409).json({
        success: false,
        message: 'A platform administrator already exists. Setup can only be performed once.',
        code: 'PLATFORM_ADMIN_ALREADY_EXISTS'
      });
    }

    // Look up the Role by name to link it to the user
    const roleDoc = await prisma.role.findFirst({
      where: { name: 'platform_admin', isSystemRole: true },
    });

    // Create the platform admin user
    const user = await prisma.user.create({
      data: {
        id: generateObjectId(),
        name: name.trim(),
        email: email.toLowerCase().trim(),
        password: await passwordUtils.hash(password),
        role: 'platform_admin',
        isActive: true,
        failedLoginAttempts: 0,
        lockedUntil: null,
        roles: roleDoc ? { create: [{ roleId: roleDoc.id }] } : undefined,
      },
    });

    res.status(201).json({
      success: true,
      message: 'Platform administrator created successfully.',
      data: {
        _id: user.id,
        name: user.name,
        email: user.email,
        role: user.role
      }
    });
  } catch (error) {
    if (error.code === 'EMAIL_ALREADY_REGISTERED' || error.code === 'P2002') {
      return res.status(409).json({
        success: false,
        message: 'Email already registered',
        code: 'EMAIL_ALREADY_REGISTERED'
      });
    }
    next(error);
  }
};

/**
 * Get all active sessions (admin only - platform admin)
 * GET /api/auth/admin/sessions
 */
exports.getAllSessions = async (req, res, next) => {
  try {
    const { limit = 100 } = req.query;
    const sessions = await sessionService.getAllSessionsDetailed(parseInt(limit));
    const count = await sessionService.getActiveSessionsCount();
    
    res.json({
      success: true,
      data: {
        sessions,
        totalActive: count
      }
    });
  } catch (error) {
    next(error);
  }
};
