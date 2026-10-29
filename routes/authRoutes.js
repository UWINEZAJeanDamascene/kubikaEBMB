const express = require('express');
const { body } = require('express-validator');
const router = express.Router();
const {
  login,
  verifyLoginTwoFactor,
  register,
  refresh,
  getMe,
  changePassword,
  resetPassword,
  forgotPassword,
  logout,
  logoutAll,
  getMySessions,
  getUserSessions,
  forceLogoutUser,
  getAllSessions,
  checkPlatformAdminStatus,
  setupPlatformAdmin
} = require('../controllers/userAuthController');
const { protect, authorize } = require('../middleware/auth');
const validateRequest = require('../middleware/validateRequest');
const stripUnvalidatedBody = require('../middleware/stripUnvalidatedBody');
const { createRateLimiters } = require('../middleware/redisRateLimiter');
const authRateLimit = createRateLimiters().auth;

const loginValidation = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').notEmpty().withMessage('Password required')
];

const registerValidation = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('name').trim().notEmpty().withMessage('Name required'),
  body('companyId').optional().isMongoId().withMessage('Invalid company id'),
  body('role').optional().isIn([
    'platform_admin', 'admin', 'stock_manager', 'sales', 'viewer',
    'accountant', 'manager', 'purchaser', 'warehouse_manager',
  ]).withMessage('Invalid role'),
];

// Public routes
router.post('/register', registerValidation, validateRequest, stripUnvalidatedBody, register);
router.post('/login', authRateLimit, loginValidation, validateRequest, stripUnvalidatedBody, login);
router.post('/login/2fa', authRateLimit, [
  body('challengeToken').isLength({ min: 40, max: 100 }).withMessage('Invalid sign-in challenge'),
  body('token').matches(/^\d{6}$/).withMessage('Enter the 6-digit authenticator code'),
], validateRequest, stripUnvalidatedBody, verifyLoginTwoFactor);
router.post('/refresh', body('refresh_token').notEmpty().withMessage('Refresh token required'), validateRequest, stripUnvalidatedBody, refresh);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);
router.get('/platform-admin-status', checkPlatformAdminStatus);
router.post('/setup-platform-admin', setupPlatformAdmin);

// Protected routes
router.get('/me', protect, getMe);
router.put('/change-password', protect, changePassword);
router.post('/logout', protect, logout);
router.post('/logout-all', protect, logoutAll);

// Session management routes
router.get('/my-sessions', protect, getMySessions);
router.get('/users/:userId/sessions', protect, authorize('platform_admin'), getUserSessions);
router.post('/users/:userId/force-logout', protect, authorize('platform_admin'), forceLogoutUser);
router.get('/admin/sessions', protect, authorize('platform_admin'), getAllSessions);

module.exports = router;
