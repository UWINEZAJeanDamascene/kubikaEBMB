const express = require('express');
const router = express.Router();
const {
  getInvoices,
  getInvoice,
  createInvoice,
  updateInvoice,
  deleteInvoice,
  confirmInvoice,
  correctInvoiceTaxFromDeliveryNote,
  recordPayment,
  writeOffInvoiceBadDebt,
  cancelInvoice,
  saveReceiptMetadata,
  verifyInvoiceCustomerTin,
  submitInvoiceEbm,
  getClientInvoices,
  getProductInvoices,
  generateInvoicePDF,
  sendInvoiceEmail
} = require('../controllers/invoiceController');
const { protect } = require('../middleware/auth');
const requireModule = require('../middleware/requireModule');
const { requirePermission } = require('../middleware/rbacMiddleware');
const { PermissionService, resolveUserRoles } = require('../middleware/authorize');
const Invoice = require('../models/Invoice');
const logAction = require('../middleware/logAction');
const { cacheMiddleware, cacheInvalidationMiddleware } = require('../middleware/cacheMiddleware');

const cacheInvoiceReads = cacheMiddleware({
  type: 'invoice',
  ttl: 60,
  skipCache: (req) => req.path.endsWith('/pdf') || req.query.refresh === '1' || req.query.refresh === 'true',
});
const invalidateInvoiceReads = cacheInvalidationMiddleware({
  types: ['invoice', 'pos', 'stock', 'report'],
  invalidateDashboards: true,
});

router.use(protect);
router.use(invalidateInvoiceReads);

router.route('/')
  .get(requirePermission('sales_invoices', 'read'), cacheInvoiceReads, getInvoices)
  .post(requirePermission('sales_invoices', 'create'), logAction('invoice'), createInvoice);

router.route('/:id')
  .get(requirePermission('sales_invoices', 'read'), cacheInvoiceReads, getInvoice)
  .put(requirePermission('sales_invoices', 'update'), logAction('invoice'), updateInvoice)
  .delete(requirePermission('sales_invoices', 'delete'), logAction('invoice'), deleteInvoice);

// Confirm invoice (deducts stock)
router.put('/:id/confirm', requirePermission('sales_invoices', 'approve'), logAction('invoice'), confirmInvoice);
router.put('/:id/correct-tax-from-delivery-note', requirePermission('sales_invoices', 'update'), logAction('invoice'), correctInvoiceTaxFromDeliveryNote);

router.post('/:id/ebm/verify-tin', requireModule('fiscal.ebm'), requirePermission('sales_invoices', 'update'), verifyInvoiceCustomerTin);
router.post('/:id/ebm/submit', requireModule('fiscal.ebm', {
  allowSandboxWhenOff: (req) => req.body?.sandboxTest === true,
}), requirePermission('sales_invoices', 'update'), logAction('invoice'), submitInvoiceEbm);
// Record payment
router.post('/:id/payment', requirePermission('ar_receipts', 'create'), logAction('invoice'), recordPayment);

// Write off as bad debt (AR decreases)
router.post('/:id/write-off', requirePermission('ar_receipts', 'reverse'), logAction('invoice'), writeOffInvoiceBadDebt);

// Cancel invoice (reverses stock)
async function authorizeInvoiceCancellation(req, res, next) {
  try {
    const invoice = await Invoice.findOne({ _id: req.params.id, company: req.user.company._id }).select('posOrigin').lean();
    if (!invoice) return next();
    const action = invoice.posOrigin ? 'create' : 'delete';
    const roles = await resolveUserRoles(req.user);
    if (!roles.some((role) => PermissionService.check(role, 'sales_invoices', action))) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN', message: 'Your role cannot request this invoice cancellation.' });
    }
    return next();
  } catch (error) {
    return next(error);
  }
}
router.put('/:id/cancel', authorizeInvoiceCancellation, logAction('invoice'), cancelInvoice);

// Save receipt metadata (SDC/Receipt info)
router.post('/:id/receipt-metadata', requirePermission('sales_invoices', 'update'), saveReceiptMetadata);

// PDF generation
router.get('/:id/pdf', requirePermission('sales_invoices', 'read'), generateInvoicePDF);

// Send invoice via email
router.post('/:id/send-email', requirePermission('sales_invoices', 'send'), logAction('invoice'), sendInvoiceEmail);

// Client and product specific routes
router.get('/client/:clientId', requirePermission('sales_invoices', 'read'), cacheInvoiceReads, getClientInvoices);
router.get('/product/:productId', requirePermission('sales_invoices', 'read'), cacheInvoiceReads, getProductInvoices);

module.exports = router;
