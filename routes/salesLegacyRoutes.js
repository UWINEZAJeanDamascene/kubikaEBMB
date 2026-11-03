const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const logAction = require('../middleware/logAction');
const { requireAnyPosPermission } = require('../middleware/posAuthorization');
const { requirePosSession, requirePermission: requirePosSessionPermission } = require('../middleware/posAuthMiddleware');
const heldSaleController = require('../controllers/posHeldSaleController');
const {
  createDirectSale,
  getCheckoutPaymentFlow,
  getPosProducts,
  getPosAvailableSerialNumbers,
} = require('../controllers/salesLegacyController');
// Canonical printable receipt (shared with the retired /api/pos/sale/:id/receipt alias)
const { getReceipt, reprintReceipt } = require('../controllers/posController');
const posPromotionController = require('../controllers/posPromotionController');
const posOfflineController = require('../controllers/posOfflineController');
const priceListController = require('../controllers/priceListController');
const posStoredValueController = require('../controllers/posStoredValueController');
const posNonPostingDocumentController = require('../controllers/posNonPostingDocumentController');
const posPublicReceiptController = require('../controllers/posPublicReceiptController');
const { requirePermissionOrRoles } = require('../middleware/rbacMiddleware');

// All routes require authentication
router.use(protect);

const canCreateSale = requireAnyPosPermission(
  { resource: 'pos.till', action: 'sell' },
  { resource: 'point_of_sale', action: 'create' },
);
const canReadPosCatalog = requireAnyPosPermission(
  { resource: 'pos.till', action: 'sell' },
  { resource: 'point_of_sale', action: 'read' },
  { resource: 'products', action: 'read' },
);
const canReadStoredValue = requireAnyPosPermission(
  { resource: 'pos.till', action: 'sell' },
  { resource: 'point_of_sale', action: 'read' },
  { resource: 'point_of_sale', action: 'create' },
);
const canReadSale = requireAnyPosPermission(
  { resource: 'pos.till', action: 'sell' },
  { resource: 'point_of_sale', action: 'read' },
  { resource: 'sales_invoices', action: 'read' },
);
const canManageHeldSales = canCreateSale;
const canManagePromotions = requirePermissionOrRoles('sales_invoices', 'approve', ['admin', 'manager']);
const canManagePriceLists = requirePermissionOrRoles('warehouses', 'update', ['admin', 'manager', 'warehouse_manager']);
const requirePosSessionAuth = requirePosSession();
const requirePosPaymentPermission = requirePosSessionPermission('pos.payment.take');
const requireReceiptSharePermission = requirePosSessionPermission('pos.receipt.share');
const requireReceiptManagePermission = requirePosSessionPermission('pos.receipt.manage');
const requireOnlinePosSession = (req, res, next) => req.body?.offlineSnapshotCapability
  ? next()
  : requirePosSessionAuth(req, res, next);
const requireOnlinePosPaymentPermission = (req, res, next) => req.body?.offlineSnapshotCapability
  ? next()
  : requirePosPaymentPermission(req, res, next);

router.route('/held-sales')
  .get(canManageHeldSales, heldSaleController.listHeldSales)
  .post(canManageHeldSales, heldSaleController.createHeldSale);
router.delete('/held-sales/:heldSaleId', canManageHeldSales, heldSaleController.deleteHeldSale);
router.get('/promotions', canReadPosCatalog, posPromotionController.list);
router.get('/promotions/manage', canManagePromotions, posPromotionController.list);
router.post('/promotions', canManagePromotions, posPromotionController.create);
router.patch('/promotions/:promotionId/active', canManagePromotions, posPromotionController.setActive);
router.get('/price-lists/manage', canManagePriceLists, priceListController.listManage);
router.post('/price-lists', canManagePriceLists, priceListController.create);
router.patch('/price-lists/:priceListId', canManagePriceLists, priceListController.update);
router.put('/price-lists/:priceListId/prices', canManagePriceLists, priceListController.replacePrices);
router.put('/warehouses/:warehouseId/price-list', canManagePriceLists, priceListController.assignWarehouse);
router.get('/stored-value/balance', canReadStoredValue, posStoredValueController.lookup);
router.post('/stored-value/issue', canManagePromotions, posStoredValueController.issue);

// Canonical POS checkout (the only supported sale write path)
router.get('/payment-flow', canCreateSale, getCheckoutPaymentFlow);
router.post('/direct-sale', canCreateSale, requireOnlinePosSession, requireOnlinePosPaymentPermission, logAction('sales_legacy_direct_sale'), createDirectSale);
router.post('/offline-snapshot', canCreateSale, posOfflineController.issueSnapshot);
router.get('/offline-conflicts', canManagePromotions, posOfflineController.listConflicts);
router.post('/offline-conflicts/:conflictId/resolve', canManagePromotions, posOfflineController.resolveConflict);

// Get products for POS with stock availability
router.get('/products', canReadPosCatalog, getPosProducts);
router.get('/products/:productId/serial-numbers', canReadPosCatalog, getPosAvailableSerialNumbers);

// Get receipt for printing
router.get('/receipt/:invoiceId', canReadSale, getReceipt);
router.post('/receipt/:invoiceId/reprint', canReadSale, requirePosSessionAuth, requirePosSessionPermission('pos.receipt.reprint'), reprintReceipt);
router.post('/receipt/:invoiceId/public-link', canReadSale, requirePosSessionAuth, requireReceiptSharePermission, posPublicReceiptController.createLink);
router.get('/receipt/:invoiceId/public-links', canReadSale, requirePosSessionAuth, requireReceiptManagePermission, posPublicReceiptController.listLinks);
router.delete('/receipt/:invoiceId/public-links/:linkId', canReadSale, requirePosSessionAuth, requireReceiptManagePermission, posPublicReceiptController.revokeLink);
router.post('/receipt/:invoiceId/share-email', canReadSale, requirePosSessionAuth, requireReceiptSharePermission, posPublicReceiptController.shareEmail);
router.post('/receipt/:invoiceId/share-sms', canReadSale, requirePosSessionAuth, requireReceiptSharePermission, posPublicReceiptController.shareSms);
router.post('/receipt/:invoiceId/share-whatsapp', canReadSale, requirePosSessionAuth, requireReceiptSharePermission, posPublicReceiptController.shareWhatsApp);
// Older callers now receive a public digital receipt link, never a plaintext receipt over SMS.
router.post('/receipt/:invoiceId/send-sms', canReadSale, requirePosSessionAuth, requireReceiptSharePermission, posPublicReceiptController.shareSms);
router.post('/receipt/:invoiceId/send-whatsapp', canReadSale, requirePosSessionAuth, requireReceiptSharePermission, posPublicReceiptController.shareWhatsApp);
router.get('/non-posting-documents', canReadSale, requireOnlinePosSession, requirePosSessionPermission('pos.document.create'), posNonPostingDocumentController.list);
router.post('/training-documents', canCreateSale, requireOnlinePosSession, requirePosSessionPermission('pos.document.create'), posNonPostingDocumentController.createTraining);
router.post('/proformas', canCreateSale, requireOnlinePosSession, requirePosSessionPermission('pos.document.create'), posNonPostingDocumentController.createProforma);
router.post('/proformas/:documentId/convert', canCreateSale, requireOnlinePosSession, requirePosSessionPermission('pos.document.create'), posNonPostingDocumentController.convertProforma);

module.exports = router;
