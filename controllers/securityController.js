const { prisma } = require('../lib/prisma');
const { toIdString } = require('../utils/objectId');
const ActionLog = require('../models/ActionLog');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const sessionService = require('../services/sessionService');
const { PASSWORD_POLICY, MAX_PASSWORD_AGE_DAYS, isPasswordExpired } = require('../utils/passwordPolicy');

// Generate TOTP secret and QR for user to scan
exports.setup2FA = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: toIdString(req.user._id) } });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const secret = speakeasy.generateSecret({ name: `StockApp (${user.email})` });
    await prisma.user.update({
      where: { id: user.id },
      data: { twoFASecret: secret.base32, twoFAConfirmed: false },
    });

    const otpAuthUrl = secret.otpauth_url;
    const qr = await qrcode.toDataURL(otpAuthUrl);

    res.status(200).json({ success: true, data: { qr, secret: secret.base32 } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Could not set up 2FA' });
  }
};

exports.verify2FA = async (req, res) => {
  try {
    const { token } = req.body;
    const user = await prisma.user.findUnique({ where: { id: toIdString(req.user._id) } });
    if (!user || !user.twoFASecret) return res.status(400).json({ success: false, message: '2FA not configured' });

    const verified = speakeasy.totp.verify({ secret: user.twoFASecret, encoding: 'base32', token, window: 1 });
    if (!verified) return res.status(400).json({ success: false, message: 'Invalid token' });

    await prisma.user.update({
      where: { id: user.id },
      data: { twoFAEnabled: true, twoFAConfirmed: true },
    });

    res.status(200).json({ success: true, message: '2FA verified and enabled' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '2FA verification failed' });
  }
};

exports.disable2FA = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: toIdString(req.user._id) } });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    await prisma.user.update({
      where: { id: user.id },
      data: { twoFAEnabled: false, twoFASecret: null, twoFAConfirmed: false },
    });
    res.status(200).json({ success: true, message: '2FA disabled' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Could not disable 2FA' });
  }
};

// @desc    Get security overview for current user
// @route   GET /api/access/security-overview
// @access  Private
exports.getSecurityOverview = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: toIdString(req.user.id) } });

    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    // Use passwordChangedAt if set, otherwise fall back to account creation date
    const passwordDate = user.passwordChangedAt || user.createdAt;

    // Get current session info
    const sessionInfo = await sessionService.getUserSessions(user.id);

    // Count login history entries
    const loginHistoryCount = await ActionLog.countDocuments({
      user: user.id,
      action: { $in: ['login', 'login_failed', 'logout', 'password_changed'] }
    });

    const overview = {
      // Account security
      twoFAEnabled: user.twoFAEnabled || false,
      twoFAConfirmed: user.twoFAConfirmed || false,
      isLocked: Boolean(user.lockedUntil && new Date() < user.lockedUntil),
      lockedUntil: user.lockedUntil || null,
      failedLoginAttempts: user.failedLoginAttempts || 0,
      mustChangePassword: user.mustChangePassword || false,
      passwordChangedAt: passwordDate,

      // Session info
      activeSessions: (sessionInfo.activeSessions || []).length,
      sessionLastActivity: sessionInfo.lastActivity || null,
      sessionCreatedAt: sessionInfo.createdAt || null,
      sessionTTLSeconds: sessionInfo.ttlSeconds || 0,

      // Stats
      loginHistoryCount,

      // Password policy
      passwordPolicy: PASSWORD_POLICY
    };

    res.json({ success: true, data: overview });
  } catch (err) {
    console.error('Security overview error:', err);
    res.status(500).json({ success: false, message: 'Failed to load security overview' });
  }
};

// @desc    Get login history for current user
// @route   GET /api/access/login-history
// @access  Private
exports.getLoginHistory = async (req, res) => {
  try {
    const userId = req.user.id;
    const { page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const query = {
      user: userId,
      action: { $in: ['login', 'login_failed', 'logout', 'password_changed', 'password_reset'] }
    };

    const total = await ActionLog.countDocuments(query);
    const logs = await ActionLog.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    // Format the logs for the frontend
    const formattedLogs = logs.map(log => ({
      _id: log._id,
      action: log.action,
      status: log.status || 'success',
      ipAddress: log.ipAddress || 'Unknown',
      userAgent: log.userAgent || 'Unknown',
      details: log.details || {},
      createdAt: log.createdAt
    }));

    res.json({
      success: true,
      data: formattedLogs,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (err) {
    console.error('Login history error:', err);
    res.status(500).json({ success: false, message: 'Failed to load login history' });
  }
};

// @desc    Get active sessions for current user
// @route   GET /api/access/active-sessions
// @access  Private
exports.getActiveSessions = async (req, res) => {
  try {
    const userId = req.user.id;
    const sessionInfo = await sessionService.getUserSessions(userId);
    const currentToken = req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7).trim()
      : req.cookies?.token || '';
    const currentSessionId = currentToken
      ? (jwt.decode(currentToken)?.sid || crypto.createHash('sha256').update(currentToken).digest('hex'))
      : null;
    const sessions = (sessionInfo.activeSessions || []).map((entry) => ({
      ...entry,
      type: entry.id === currentSessionId ? 'current' : 'device',
      isCurrent: entry.id === currentSessionId,
    }));

    res.json({
      success: true,
      data: {
        sessions,
        totalActive: sessions.length,
        maxConcurrent: sessionInfo.maxConcurrent ?? null
      }
    });
  } catch (err) {
    console.error('Active sessions error:', err);
    res.status(500).json({ success: false, message: 'Failed to load active sessions' });
  }
};

// @desc    Terminate one other device session for the current user
// @route   DELETE /api/access/active-sessions/:sessionId
// @access  Private
exports.terminateSession = async (req, res) => {
  try {
    const sessionId = String(req.params.sessionId || '');
    if (!/^(?:[a-f0-9]{32}|[a-f0-9]{64})$/i.test(sessionId)) {
      return res.status(400).json({ success: false, message: 'Invalid session identifier' });
    }
    const removed = await sessionService.revokeUserSession(req.user.id, sessionId);
    if (!removed) return res.status(404).json({ success: false, message: 'Session not found or already terminated' });
    return res.json({ success: true, message: 'Session terminated' });
  } catch (err) {
    console.error('Terminate individual session error:', err);
    return res.status(500).json({ success: false, message: 'Failed to terminate session' });
  }
};

// @desc    Terminate all other sessions for current user
// @route   POST /api/access/terminate-sessions
// @access  Private
exports.terminateAllSessions = async (req, res) => {
  try {
    const userId = req.user.id;
    const token = req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7).trim()
      : req.cookies?.token || '';
    await sessionService.deleteOtherSessions(userId, token);

    res.json({ success: true, message: 'All other sessions terminated' });
  } catch (err) {
    console.error('Terminate sessions error:', err);
    res.status(500).json({ success: false, message: 'Failed to terminate sessions' });
  }
};

// @desc    Check if password needs to be changed (based on age policy)
// @route   GET /api/access/password-status
// @access  Private
exports.getPasswordStatus = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: toIdString(req.user.id) } });

    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    let passwordAgeDays = null;

    // Use passwordChangedAt if set, otherwise fall back to account creation date
    const passwordDate = user.passwordChangedAt || user.createdAt;
    if (passwordDate) {
      passwordAgeDays = Math.floor((Date.now() - passwordDate.getTime()) / (1000 * 60 * 60 * 24));
    }
    const isExpired = isPasswordExpired(user);

    res.json({
      success: true,
      data: {
        mustChangePassword: user.mustChangePassword || false,
        passwordChangedAt: passwordDate,
        passwordAgeDays,
        isExpired,
        maxAgeDays: MAX_PASSWORD_AGE_DAYS
      }
    });
  } catch (err) {
    console.error('Password status error:', err);
    res.status(500).json({ success: false, message: 'Failed to check password status' });
  }
};

// @desc    Get account lock status
// @route   GET /api/access/lock-status
// @access  Private
exports.getLockStatus = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: toIdString(req.user.id) } });

    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const isLocked = Boolean(user.lockedUntil && new Date() < user.lockedUntil);
    let minutesRemaining = 0;

    if (isLocked && user.lockedUntil) {
      minutesRemaining = Math.max(0, Math.ceil((user.lockedUntil.getTime() - Date.now()) / (1000 * 60)));
    }

    res.json({
      success: true,
      data: {
        isLocked,
        lockedUntil: user.lockedUntil,
        minutesRemaining,
        failedLoginAttempts: user.failedLoginAttempts || 0
      }
    });
  } catch (err) {
    console.error('Lock status error:', err);
    res.status(500).json({ success: false, message: 'Failed to check lock status' });
  }
};
