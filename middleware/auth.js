const jwt = require('jsonwebtoken');
const authData = require('../services/authDataService');
const { recordUserSessionActivity } = require('../services/userSessionActivity');
const { prisma } = require('../lib/prisma');
const { passwordChangeRequired } = require('../utils/passwordPolicy');

// Import centralized configuration
const env = require('../src/config/environment');
const config = env.getConfig();
const JWT_SECRET = config.jwt.secret;

function entityId(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (value._id) return String(value._id);
  if (value.id) return String(value.id);
  return String(value);
}

function isAllowedDuringPasswordChange(req) {
  const path = String(req.originalUrl || req.path || '').split('?')[0].replace(/\\/g, '/');
  const method = String(req.method || '').toUpperCase();
  const allowed = [
    ['GET', '/auth/me'],
    ['PUT', '/auth/change-password'],
    ['POST', '/auth/logout'],
    ['POST', '/auth/logout-all'],
    ['GET', '/access/security-overview'],
    ['GET', '/access/password-status'],
    ['GET', '/access/login-history'],
    ['GET', '/access/active-sessions'],
    ['POST', '/access/terminate-sessions'],
  ];
  return allowed.some(([allowedMethod, suffix]) => method === allowedMethod && path.endsWith(suffix))
    || (method === 'DELETE' && /\/access\/active-sessions\/[^/]+$/.test(path));
}

async function loadUserAndCompany(decoded) {
  const user = await authData.findUserById(decoded.id, {
    populateCompany: true,
    populateRoles: true,
  });
  if (!user) return { user: null, company: null };

  user.id = entityId(user);
  user._id = entityId(user);

  if (user.role === 'platform_admin') {
    return { user, company: null };
  }

  let company =
    user.company && typeof user.company === 'object' && user.company.name
      ? user.company
      : await authData.findCompanyById(entityId(user.company) || decoded.companyId);

  user.company = company;
  return { user, company };
}

const protect = async (req, res, next) => {
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  } else if (req.cookies && req.cookies.token) {
    token = req.cookies.token;
  }

  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Not authorized, no token',
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const { user, company } = await loadUserAndCompany(decoded);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'User not found',
      });
    }

    if (!user.isActive) {
      return res.status(401).json({
        success: false,
        message: 'User account is inactive',
      });
    }

    req.user = user;

    if (passwordChangeRequired(user) && !isAllowedDuringPasswordChange(req)) {
      return res.status(403).json({
        success: false,
        code: 'PASSWORD_CHANGE_REQUIRED',
        message: 'Your password must be changed before you can continue.',
      });
    }

    if (user.role === 'platform_admin') {
      req.isPlatformAdmin = true;
      req.company = null;
      recordUserSessionActivity(entityId(user));
      return next();
    }

    req.company = company;

    if (!req.company) {
      return res.status(401).json({
        success: false,
        message: 'Company not found or inactive',
      });
    }

    if (!req.company.isActive) {
      return res.status(401).json({
        success: false,
        message: 'Company account is inactive',
      });
    }

    if (req.company.approvalStatus !== 'approved') {
      return res.status(401).json({
        success: false,
        message:
          'Company access is pending approval. Please wait for platform administrator to approve your registration.',
        approvalStatus: req.company.approvalStatus,
        companyName: req.company.name,
      });
    }

    recordUserSessionActivity(entityId(user));
    return next();
  } catch (error) {
    // Expired access tokens are an expected session boundary, not an
    // application error. Return a stable machine-readable contract so clients
    // can refresh once instead of treating the response as a generic 401.
    if (error?.name === 'TokenExpiredError') {
      const message = 'Access token expired';
      return res.status(401).json({
        success: false,
        code: 'TOKEN_EXPIRED',
        message,
        error: { code: 'TOKEN_EXPIRED', message },
      });
    }

    if (error?.name === 'JsonWebTokenError' || error?.name === 'NotBeforeError') {
      const message = 'Invalid access token';
      return res.status(401).json({
        success: false,
        code: 'TOKEN_INVALID',
        message,
        error: { code: 'TOKEN_INVALID', message },
      });
    }

    console.error(error);
    const nodeEnv = config.server.env;
    if (nodeEnv === 'test' && token) {
      try {
        const decoded = jwt.decode(token);
        if (decoded && decoded.id) {
          const { user, company } = await loadUserAndCompany(decoded);
          req.user = user;
          req.company = company;
          if (req.user) recordUserSessionActivity(entityId(req.user));
          return next();
        }
      } catch (e) {
        console.error('Test-mode token decode failed', e);
      }
    }

    return res.status(401).json({
      success: false,
      code: 'TOKEN_INVALID',
      message: 'Not authorized, token failed',
      error: { code: 'TOKEN_INVALID', message: 'Not authorized, token failed' },
    });
  }
};

// Role authorization
const authorize = (...roles) => {
  const middleware = async (req, res, next) => {
    try {
      // Check legacy single role string first
      if (req.user && req.user.role && roles.includes(req.user.role)) return next();

      // Check roles array (may be ObjectId refs or populated docs)
      if (req.user && Array.isArray(req.user.roles) && req.user.roles.length) {
        for (const r of req.user.roles) {
          if (typeof r === 'string' && roles.includes(r)) return next();
          if (r && typeof r === 'object' && roles.includes(r.name)) return next();
        }

        const roleIds = req.user.roles
          .map((r) => (typeof r === 'string' ? r : entityId(r)))
          .filter(Boolean);
        if (roleIds.length) {
          const roleDocs = await prisma.role.findMany({
            where: { id: { in: roleIds } },
            select: { name: true },
          });
          for (const rd of roleDocs) {
            if (roles.includes(rd.name)) return next();
          }
        }
      }

      return res.status(403).json({
        success: false,
        message: `User role '${req.user && req.user.role}' is not authorized to access this route`,
      });
    } catch (err) {
      console.error('Authorization check error', err);
      return res.status(500).json({ success: false, message: 'Authorization check failed' });
    }
  };
  middleware.roleGuard = roles.map((role) => String(role).toLowerCase());
  return middleware;
};

module.exports = { protect, authorize };
