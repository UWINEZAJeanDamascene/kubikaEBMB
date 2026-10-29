const jwt = require('jsonwebtoken');
const { notifyPasswordChanged, notifyFailedLogin } = require('../services/notificationHelper');
const sessionService = require('../services/sessionService');
const authData = require('../services/authDataService');
const passwordUtils = require('../utils/passwordUtils');
const { getPasswordPolicyError } = require('../utils/passwordPolicy');
// Centralized config
const env = require('../src/config/environment');
const config = env.getConfig();

// Generate JWT Token with company and role info
const generateToken = (id, companyId, role) => {
  return jwt.sign(
    { id, companyId, role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRE }
  );
};

function entityId(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (value._id) return String(value._id);
  if (value.id) return String(value.id);
  return String(value);
}

// @desc    Login user
// @route   POST /api/auth/login
// @access  Public
exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    // Validate email & password
    if (!email || !password) {
      return res.status(400).json({ 
        success: false, 
        message: 'Please provide email and password' 
      });
    }

     // Check for user (PostgreSQL via authDataService)
     const user = await authData.findUserByEmailForLogin(email);

    if (!user) {
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid credentials' 
      });
    }

    // Check if user is active
    if (!user.isActive) {
      return res.status(401).json({ 
        success: false, 
        message: 'Account is inactive. Please contact administrator.' 
      });
    }

    // Check if user is platform admin - they don't have a company
    if (user.role === 'platform_admin') {
      // Check if password matches for platform admin
      const isMatch = await authData.compareUserPassword(user, password);
      if (!isMatch) {
        return res.status(401).json({
          success: false,
          message: 'Invalid credentials'
        });
      }

      // Generate token without companyId for platform admin
      const token = generateToken(entityId(user), null, user.role);
      
      const userWithoutPassword = authData.toPublicUser(user);

      // Create Redis session
      await sessionService.createSession(
        entityId(user),
        null,
        user.role,
        token,
        { email: user.email, name: user.name }
      );
      // Set httpOnly cookie for token (server-side session)
      res.cookie('token', token, {
        httpOnly: true,
        secure: config.server.env === 'production',
        sameSite: 'lax',
        maxAge: (config.session && config.session.ttl ? config.session.ttl : 24 * 60 * 60) * 1000,
      });

      return res.json({
        success: true,
        token,
        data: userWithoutPassword,
        requirePasswordChange: user.mustChangePassword || false,
        isPlatformAdmin: true
      });
    }

    // Check if company is active
    if (!user.company || !user.company.isActive) {
      return res.status(401).json({ 
        success: false, 
        message: 'Company account is inactive. Please contact support.' 
      });
    }

    // Check if company is approved
    if (user.company.approvalStatus !== 'approved') {
      return res.status(401).json({ 
        success: false, 
        message: 'Company is pending approval. Please wait for platform administrator to approve your registration.',
        approvalStatus: user.company.approvalStatus
      });
    }

    // Check if password matches
    const isMatch = await authData.compareUserPassword(user, password);

    if (!isMatch) {
      // Notify about failed login attempt
      try {
        await notifyFailedLogin(
          entityId(user.company) || user.company,
          entityId(user),
          email,
          req.ip || req.connection?.remoteAddress
        );
      } catch (notifyErr) {
        console.error('Failed to send login notification:', notifyErr);
      }
      
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid credentials' 
      });
    }

    // Check if account requires password change (first login with temp password)
    const requirePasswordChange = user.mustChangePassword;

     // Update last login
     await authData.markUserLoggedIn(user);

     // Generate token with companyId
     const companyId = entityId(user.company);
     const token = generateToken(entityId(user), companyId, user.role);

     // Remove password from user object
     const userWithoutPassword = authData.toPublicUser(user);

     // Compute flat permissions array from populated roles
     // Format: ["products:read", "products:create", "stock:read", ...]
     const permissionsSet = new Set();

     // Admin and platform_admin get wildcard permissions
     if (user.role === 'admin' || user.role === 'platform_admin') {
       permissionsSet.add('*');
     }

     if (user.roles && user.roles.length > 0) {
       for (const role of user.roles) {
         if (role.permissions && role.permissions.length > 0) {
           for (const perm of role.permissions) {
             if (perm.resource === '*') {
               // Wildcard resource - add all common actions
               const allActions = ['read', 'create', 'update', 'delete', 'approve', 'post', 'pay', 'remit', 'export', 'file', 'admin'];
               for (const action of (perm.actions.includes('*') ? allActions : perm.actions)) {
                 permissionsSet.add(`*:${action}`);
               }
               if (perm.actions.includes('*')) {
                 permissionsSet.add('*');
               }
             } else {
               for (const action of perm.actions) {
                 if (action === '*') {
                   // Wildcard action - add all actions for this resource
                   permissionsSet.add(`${perm.resource}:*`);
                   const allActions = ['read', 'create', 'update', 'delete', 'approve', 'post', 'pay', 'remit', 'export', 'file', 'admin'];
                   for (const a of allActions) {
                     permissionsSet.add(`${perm.resource}:${a}`);
                   }
                 } else {
                   permissionsSet.add(`${perm.resource}:${action}`);
                 }
               }
             }
           }
         }
       }
     } else if (user.role && user.role !== 'admin' && user.role !== 'platform_admin') {
       // Fallback: look up the Role document by the legacy role string name
       const legacyRole = await authData.findSystemRoleByName(user.role);
       if (legacyRole && legacyRole.permissions && legacyRole.permissions.length > 0) {
         for (const perm of legacyRole.permissions) {
           if (perm.resource === '*') {
             const allActions = ['read', 'create', 'update', 'delete', 'approve', 'post', 'pay', 'remit', 'export', 'file', 'admin'];
             for (const action of (perm.actions.includes('*') ? allActions : perm.actions)) {
               permissionsSet.add(`*:${action}`);
             }
             if (perm.actions.includes('*')) {
               permissionsSet.add('*');
             }
           } else {
             for (const action of perm.actions) {
               if (action === '*') {
                 permissionsSet.add(`${perm.resource}:*`);
                 const allActions = ['read', 'create', 'update', 'delete', 'approve', 'post', 'pay', 'remit', 'export', 'file', 'admin'];
                 for (const a of allActions) {
                   permissionsSet.add(`${perm.resource}:${a}`);
                 }
               } else {
                 permissionsSet.add(`${perm.resource}:${action}`);
               }
             }
           }
         }
       }
     }

     userWithoutPassword.permissions = Array.from(permissionsSet);

     // Create Redis session
     await sessionService.createSession(
       entityId(user),
       companyId,
       user.role,
       token,
       { email: user.email, name: user.name, companyName: user.company.name }
     );

     // Set httpOnly cookie for token
     res.cookie('token', token, {
       httpOnly: true,
       secure: config.server.env === 'production',
       sameSite: 'lax',
       maxAge: (config.session && config.session.ttl ? config.session.ttl : 24 * 60 * 60) * 1000,
     });

     res.json({
       success: true,
       token,
       data: userWithoutPassword,
       company: user.company,
       requirePasswordChange
     });
  } catch (error) {
    next(error);
  }
};

// @desc    Get current logged in user
// @route   GET /api/auth/me
// @access  Private
exports.getMe = async (req, res, next) => {
  try {
    const user = await authData.findUserById(req.user.id || req.user._id, {
      populateCompany: true,
      populateRoles: true,
      companyFields: 'name email',
    });

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const userObj = authData.toPublicUser(user);

    // Compute flat permissions array from populated roles
    // Format: ["products:read", "products:create", "stock:read", ...]
    const permissionsSet = new Set();

    // Admin and platform_admin get wildcard permissions
    if (user.role === 'admin' || user.role === 'platform_admin') {
      permissionsSet.add('*');
    }

    if (user.roles && user.roles.length > 0) {
      for (const role of user.roles) {
        if (role.permissions && role.permissions.length > 0) {
          for (const perm of role.permissions) {
            if (perm.resource === '*') {
              // Wildcard resource - add all common actions
              const allActions = ['read', 'create', 'update', 'delete', 'approve', 'post', 'pay', 'remit', 'export', 'file', 'admin'];
              for (const action of (perm.actions.includes('*') ? allActions : perm.actions)) {
                permissionsSet.add(`*:${action}`);
              }
              if (perm.actions.includes('*')) {
                permissionsSet.add('*');
              }
            } else {
              for (const action of perm.actions) {
                if (action === '*') {
                  // Wildcard action - add all actions for this resource
                  permissionsSet.add(`${perm.resource}:*`);
                  const allActions = ['read', 'create', 'update', 'delete', 'approve', 'post', 'pay', 'remit', 'export', 'file', 'admin'];
                  for (const a of allActions) {
                    permissionsSet.add(`${perm.resource}:${a}`);
                  }
                } else {
                  permissionsSet.add(`${perm.resource}:${action}`);
                }
              }
            }
          }
        }
      }
    } else if (user.role && user.role !== 'admin' && user.role !== 'platform_admin') {
      // Fallback: look up the Role document by the legacy role string name
      const legacyRole = await authData.findSystemRoleByName(user.role);
      if (legacyRole && legacyRole.permissions && legacyRole.permissions.length > 0) {
        for (const perm of legacyRole.permissions) {
          if (perm.resource === '*') {
            const allActions = ['read', 'create', 'update', 'delete', 'approve', 'post', 'pay', 'remit', 'export', 'file', 'admin'];
            for (const action of (perm.actions.includes('*') ? allActions : perm.actions)) {
              permissionsSet.add(`*:${action}`);
            }
            if (perm.actions.includes('*')) {
              permissionsSet.add('*');
            }
          } else {
            for (const action of perm.actions) {
              if (action === '*') {
                permissionsSet.add(`${perm.resource}:*`);
                const allActions = ['read', 'create', 'update', 'delete', 'approve', 'post', 'pay', 'remit', 'export', 'file', 'admin'];
                for (const a of allActions) {
                  permissionsSet.add(`${perm.resource}:${a}`);
                }
              } else {
                permissionsSet.add(`${perm.resource}:${action}`);
              }
            }
          }
        }
      }
    }

    userObj.permissions = Array.from(permissionsSet);

    res.json({
      success: true,
      data: userObj
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update password
// @route   PUT /api/auth/update-password
// @access  Private
exports.updatePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ 
        success: false, 
        message: 'Please provide current and new password' 
      });
    }

    const passwordError = getPasswordPolicyError(newPassword);
    if (passwordError) {
      return res.status(400).json({
        success: false,
        message: passwordError.message,
        code: passwordError.code,
      });
    }

    const user = await authData.findUserById(req.user.id || req.user._id, {
      includePassword: true,
    });

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Check current password
    const isMatch = await authData.compareUserPassword(user, currentPassword);

    if (!isMatch) {
      return res.status(401).json({ 
        success: false, 
        message: 'Current password is incorrect' 
      });
    }

    const hashed = await passwordUtils.hash(newPassword);
    await authData.updateUserPassword(entityId(user), hashed);

    // Notify about password change
    try {
      await notifyPasswordChanged(entityId(req.user.company), entityId(user));
    } catch (notifyErr) {
      console.error('Failed to send password change notification:', notifyErr);
    }

    const token = generateToken(entityId(user), entityId(req.user.company), user.role);

    res.json({
      success: true,
      message: 'Password updated successfully',
      token
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Logout user
// @route   POST /api/auth/logout
// @access  Private
exports.logout = async (req, res, next) => {
  try {
    // Get token from header or cookie
    const token = req.headers.authorization?.split(' ')[1] || req.cookies?.token;

    // Delete session from Redis
    if (req.user) {
      await sessionService.deleteSession(String(req.user._id || req.user.id), token);
    }

    // Blacklist the token
    if (token) {
      await sessionService.blacklistToken(token);
    }
    // Clear cookie on logout
    res.clearCookie('token');

    res.json({
      success: true,
      message: 'Logged out successfully'
    });
  } catch (error) {
    next(error);
  }
};
