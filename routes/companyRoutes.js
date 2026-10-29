const express = require('express');
const { body, param } = require('express-validator');
const router = express.Router();
const companyController = require('../controllers/companyController');
const { uploadFor } = require('../middleware/upload');
const { protect, authorize } = require('../middleware/auth');
const { requirePermissionOrRoles } = require('../middleware/rbacMiddleware');
const { attachCompanyId } = require('../middleware/companyContext');
const validateRequest = require('../middleware/validateRequest');
const stripUnvalidatedBody = require('../middleware/stripUnvalidatedBody');

const registerValidation = [
  body('company').isObject().withMessage('company object required'),
  body('company.name').trim().notEmpty().withMessage('Company name required'),
  body('company.email').isEmail().normalizeEmail().withMessage('Valid company email required'),
  body('company.tin').optional({ nullable: true, checkFalsy: true }).trim().isString(),
  body('company.phone').optional({ nullable: true, checkFalsy: true }).trim().isString(),
  body('company.subscription_plan')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ min: 1, max: 64 })
    .matches(/^[a-z0-9_-]+$/i)
    .withMessage('Invalid subscription plan'),
  body('admin').isObject().withMessage('admin object required'),
  body('admin.name').trim().notEmpty().withMessage('Admin name required'),
  body('admin.email').isEmail().normalizeEmail().withMessage('Valid admin email required'),
  body('admin.password')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters')
];

/**
 * Public — must stay before router.use(protect)
 */
router.post(
  '/register',
  registerValidation,
  validateRequest,
  stripUnvalidatedBody,
  companyController.registerPublic
);

router.get('/subscription-plans/public', companyController.getSubscriptionPlans);

router.use(protect);

/**
 * Current user's company — must be before /:id routes
 */
router.get('/me', companyController.getMyCompany);
router.put(
  '/me',
  requirePermissionOrRoles('settings', 'update', ['admin']),
  companyController.updateMyCompany
);

/**
 * Platform admin — literal paths before /:id
 */
router.get('/pending', authorize('platform_admin'), companyController.getPendingCompanies);
router.get('/rejected', authorize('platform_admin'), companyController.getRejectedCompanies);
router.get('/platform-dashboard', authorize('platform_admin'), companyController.getPlatformDashboard);
router.get('/platform-analytics', authorize('platform_admin'), companyController.getPlatformAnalytics);
router.post('/platform-broadcast', authorize('platform_admin'), companyController.broadcastPlatformUpdate);
router.get('/platform-audit-logs', authorize('platform_admin'), companyController.getPlatformAuditLogs);
router.get('/platform-security-stats', authorize('platform_admin'), companyController.getPlatformSecurityStats);
router.get('/subscription-plans', authorize('platform_admin'), companyController.getSubscriptionPlans);
router.post('/subscription-plans', authorize('platform_admin'), companyController.createSubscriptionPlan);
router.put('/subscription-plans/:key', authorize('platform_admin'), companyController.updateSubscriptionPlan);
router.delete('/subscription-plans/:key', authorize('platform_admin'), companyController.deleteSubscriptionPlan);

router.post('/', companyController.createCompany);
router.get('/', companyController.getAllCompanies);

const approveValidation = [
  param('id').isMongoId().withMessage('Invalid company id')
];

const rejectValidation = [
  param('id').isMongoId().withMessage('Invalid company id'),
  body('reason').optional().isString().trim()
];

router.put(
  '/:id/approve',
  authorize('platform_admin'),
  ...approveValidation,
  validateRequest,
  companyController.approveCompany
);
router.put(
  '/:id/reject',
  authorize('platform_admin'),
  ...rejectValidation,
  validateRequest,
  stripUnvalidatedBody,
  companyController.rejectCompany
);
router.put('/:id/platform-access', authorize('platform_admin'), companyController.updatePlatformAccess);
router.post('/:id/payment-reminder', authorize('platform_admin'), companyController.sendPaymentReminder);
router.get('/:id/users', authorize('platform_admin'), companyController.getCompanyUsers);
router.post('/:id/users/:userId/impersonate', authorize('platform_admin'), companyController.impersonateUser);
router.post('/:id/users/:userId/force-password-reset', authorize('platform_admin'), companyController.forcePasswordReset);

router.post('/:id/logo', uploadFor('companies').single('logo'), companyController.uploadLogo);
router.get('/:id/setup-status', companyController.getSetupStatus);
router.post('/:id/setup/:step', companyController.markSetupStepComplete);

// Capital management
router.post('/capital/share', companyController.recordShareCapital);
router.post('/capital/owner', companyController.recordOwnerCapital);
router.get('/capital/balance', companyController.getCapitalBalance);

router.get('/:id', companyController.getCompany);
router.put('/:id', companyController.updateCompany);
router.delete('/:id', companyController.deleteCompany);

module.exports = router;
