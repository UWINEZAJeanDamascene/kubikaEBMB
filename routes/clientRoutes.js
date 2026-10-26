const express = require('express');
const { body } = require('express-validator');
const router = express.Router();
const {
  getClients,
  getClient,
  createClient,
  updateClient,
  deleteClient,
  getClientPurchaseHistory,
  getClientOutstandingInvoices,
  toggleClientStatus,
  getClientsWithStats,
  exportClientsToPDF,
  getClientInvoices,
  getClientReceipts,
  getClientCreditNotes,
  getClientStatementPDF,
  verifyClientTin,
  saveClientBranchCustomer,
  getClientBranchCustomerStatus,
} = require('../controllers/clientController');
const { protect } = require('../middleware/auth');
const { requirePermission, requirePermissionOrRoles } = require('../middleware/rbacMiddleware');
const logAction = require('../middleware/logAction');
const validateRequest = require('../middleware/validateRequest');
const stripUnvalidatedBody = require('../middleware/stripUnvalidatedBody');
const { cacheMiddleware, cacheInvalidationMiddleware } = require('../middleware/cacheMiddleware');

const cacheClients = cacheMiddleware({ type: 'client', ttl: 300 });
const invalidateClients = cacheInvalidationMiddleware({ type: 'client' });
const requireEbmBranchCustomerUpdate = requirePermissionOrRoles('ebm', 'update', ['admin', 'stock_manager']);

function requireEbmUpdateWhenBranchSubmissionRequested(req, res, next) {
  const requested = [req.body?.registerWithEbmBranch, req.body?.autoSaveEbmBranchCustomer]
    .some((value) => value === true || value === 'true')
    || process.env.EBM_AUTO_SAVE_BRANCH_CUSTOMERS === 'true';
  if (!requested) return next();
  return requireEbmBranchCustomerUpdate(req, res, next);
}

requireEbmUpdateWhenBranchSubmissionRequested.conditionalPermission = {
  resource: 'ebm',
  action: 'update',
  allowedRoles: ['admin', 'stock_manager'],
};

router.use(protect);

router.route('/')
  .get(requirePermission('clients', 'read'), cacheClients, getClients)
  .post(requirePermission('clients', 'create'), requireEbmUpdateWhenBranchSubmissionRequested, invalidateClients, logAction('client'), createClient);

// New route for clients with stats (for list view with outstanding invoice counts)
router.get('/with-stats', requirePermission('clients', 'read'), getClientsWithStats);

// Export route
router.get('/export/pdf', requirePermission('clients', 'read'), exportClientsToPDF);

router.route('/:id')
  .get(requirePermission('clients', 'read'), cacheClients, getClient)
  .put(requirePermission('clients', 'update'), requireEbmUpdateWhenBranchSubmissionRequested, invalidateClients, logAction('client'), updateClient)
  .delete(requirePermission('clients', 'delete'), invalidateClients, logAction('client'), deleteClient);

// Toggle status
router.put('/:id/toggle-status', requirePermission('clients', 'update'), invalidateClients, toggleClientStatus);
router.post(
  '/:id/ebm/verify-tin',
  requirePermission('clients', 'update'),
  body('branchId').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 1, max: 2 }),
  body('bhfId').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 1, max: 2 }),
  validateRequest,
  stripUnvalidatedBody,
  invalidateClients,
  verifyClientTin,
);
router.post(
  '/:id/ebm/branch-customer',
  requirePermission('clients', 'update'),
  requireEbmBranchCustomerUpdate,
  body('branchId').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 1, max: 2 }),
  body('bhfId').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ min: 1, max: 2 }),
  validateRequest,
  stripUnvalidatedBody,
  invalidateClients,
  saveClientBranchCustomer,
);
router.get(
  '/:id/ebm/branch-customer/status',
  requireEbmBranchCustomerUpdate,
  getClientBranchCustomerStatus,
);

router.get('/:id/purchase-history', requirePermission('clients', 'read'), getClientPurchaseHistory);
router.get('/:id/outstanding-invoices', requirePermission('clients', 'read'), getClientOutstandingInvoices);

// Client detail endpoints
router.get('/:id/invoices', requirePermission('clients', 'read'), getClientInvoices);
router.get('/:id/receipts', requirePermission('clients', 'read'), getClientReceipts);
router.get('/:id/credit-notes', requirePermission('clients', 'read'), getClientCreditNotes);
router.get('/:id/statement', requirePermission('clients', 'read'), getClientStatementPDF);

module.exports = router;
