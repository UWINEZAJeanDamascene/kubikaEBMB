const express = require('express');
const router = express.Router();
const { posApiRateLimit } = require('../middleware/posRouteRateLimits');
const { posAuditOutcome } = require('../middleware/posAuditOutcome');
const { idempotentHandler } = require('../services/posIdempotencyService');
router.use(posApiRateLimit);
router.use(posAuditOutcome);
const idem = (handler) => idempotentHandler(handler, { namespace: 'sales-legacy' });
const { protect } = require('../middleware/auth');
const logAction = require('../middleware/logAction');
const { requireAnyPosPermission } = require('../middleware/posAuthorization');
const {
  requirePosDeviceContact,
  requirePosSession,
  requirePermission: requirePosSessionPermission,
} = require('../middleware/posAuthMiddleware');
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
const posOfflineSyncController = require('../controllers/posOfflineSyncController');
const priceListController = require('../controllers/priceListController');
const posStoredValueController = require('../controllers/posStoredValueController');
const posNonPostingDocumentController = require('../controllers/posNonPostingDocumentController');
const posPublicReceiptController = require('../controllers/posPublicReceiptController');
const posDiscountApplicationController = require('../controllers/posDiscountApplicationController');
const posVoucherController = require('../controllers/posVoucherController');
const posScannerSettingsController = require('../controllers/posScannerSettingsController');
const posStockReservationController = require('../controllers/posStockReservationController');
const posTillCustomerController = require('../controllers/posTillCustomerController');
const { requirePermissionOrRoles } = require('../middleware/rbacMiddleware');

const requirePosSessionAuth = requirePosSession();
const requirePosSellPermission = requirePosSessionPermission('pos.till.sell');
const requirePosPaymentPermission = requirePosSessionPermission('pos.payment.take');

function offlineSyncDeviceAccess(req, res, next) {
  if (req.posDevice?.status === 'revoked') return next();
  if (req.posDevice?.status !== 'active' || !req.posDevice.publicKey) {
    return res.status(403).json({
      success: false,
      code: 'POS_DEVICE_DISABLED',
      message: 'This POS device is not active for offline synchronization.',
    });
  }
  return requirePosSessionAuth(req, res, (sessionError) => {
    if (sessionError) return next(sessionError);
    if (req.posAuthContext?.posDevice?.id !== req.posDevice.id) {
      return res.status(403).json({
        success: false,
        code: 'POS_DEVICE_SESSION_MISMATCH',
        message: 'The POS session does not match this enrolled device.',
      });
    }
    return requirePosSellPermission(req, res, (sellError) => {
      if (sellError) return next(sellError);
      return requirePosPaymentPermission(req, res, next);
    });
  });
}

// These routes are authenticated by the cashier's POS session, not the ERP bearer token.
router.post(
  '/offline-sync/push',
  requirePosDeviceContact(),
  offlineSyncDeviceAccess,
  (req, res, next) => req.posDevice.status === 'revoked'
    ? posOfflineSyncController.quarantineRevokedPush(req, res, next)
    : posOfflineSyncController.push(req, res, next),
);
router.get('/offline-sync/device-state', requirePosDeviceContact(), posOfflineSyncController.deviceState);
router.post('/offline-sync/device-state/wipe-ack', requirePosDeviceContact(), idem(posOfflineSyncController.acknowledgeDeviceWipe));
router.get(
  '/offline-sync/pull',
  requirePosSessionAuth,
  requirePosSellPermission,
  requirePosPaymentPermission,
  posOfflineSyncController.pull,
);
router.get(
  '/scanner-offline-index',
  requirePosSessionAuth,
  requirePosSellPermission,
  posScannerSettingsController.getOfflineIndex,
);

// All remaining routes require ERP authentication.
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
const canIssueBackOfficeGiftCards = requirePermissionOrRoles('pos_gift_cards', 'issue_backoffice', ['admin', 'owner', 'accountant']);
const canReadVouchers = requirePermissionOrRoles('pos_vouchers', 'read', ['admin', 'manager']);
const canCreateVouchers = requirePermissionOrRoles('pos_vouchers', 'create', ['admin', 'manager']);
const canEditVouchers = requirePermissionOrRoles('pos_vouchers', 'edit', ['admin', 'manager']);
const canGenerateVouchers = requirePermissionOrRoles('pos_vouchers', 'generate', ['admin', 'manager']);
const canPauseVouchers = requirePermissionOrRoles('pos_vouchers', 'pause', ['admin', 'manager']);
const canCancelVouchers = requirePermissionOrRoles('pos_vouchers', 'cancel', ['admin', 'manager']);
const canRestoreVouchers = requirePermissionOrRoles('pos_vouchers', 'restore', ['admin', 'manager']);
const canApproveVoucherRestore = requirePermissionOrRoles('pos_vouchers', 'approve_restore', ['admin', 'manager']);
const canReadVoucherHistory = requirePermissionOrRoles('pos_vouchers', 'history', ['admin', 'manager']);
const canManageVoucherSettings = requirePermissionOrRoles('pos_vouchers', 'settings', ['admin', 'manager']);
const canManagePriceLists = requirePermissionOrRoles('warehouses', 'update', ['admin', 'manager', 'warehouse_manager']);
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
  .post(canManageHeldSales, idem(heldSaleController.createHeldSale));
router.delete('/held-sales/:heldSaleId', canManageHeldSales, idem(heldSaleController.deleteHeldSale));
router.get('/salespeople', canReadSale, requirePosSessionAuth, posTillCustomerController.salespeople);
router.get('/customers/:clientId/repeat-order', canReadSale, requirePosSessionAuth, posTillCustomerController.repeatLastOrder);
router.get('/customers/:clientId/statement', canReadSale, requirePosSessionAuth, posTillCustomerController.customerStatement);
router.get('/promotions', canReadPosCatalog, posPromotionController.list);
router.get('/promotions/manage', canManagePromotions, posPromotionController.list);
router.post('/promotions', canManagePromotions, idem(posPromotionController.create));
router.patch('/promotions/:promotionId/active', canManagePromotions, idem(posPromotionController.setActive));
router.get('/vouchers', canReadVouchers, posVoucherController.list);
router.get('/vouchers/settings', canReadVouchers, posVoucherController.getSettings);
router.put('/vouchers/settings', canManageVoucherSettings, idem(posVoucherController.updateSettings));
router.post('/vouchers', canCreateVouchers, idem(posVoucherController.create));
router.post('/vouchers/bulk-generate', canGenerateVouchers, idem(posVoucherController.bulkGenerate));
router.put('/vouchers/:voucherId', canEditVouchers, idem(posVoucherController.update));
router.patch('/vouchers/:voucherId/pause', canPauseVouchers, idem((req, res, next) => {
  req.body.status = 'PAUSED';
  return posVoucherController.setStatus(req, res, next);
}));
router.patch('/vouchers/:voucherId/activate', canEditVouchers, idem((req, res, next) => {
  req.body.status = 'ACTIVE';
  return posVoucherController.setStatus(req, res, next);
}));
router.patch('/vouchers/:voucherId/cancel', canCancelVouchers, idem((req, res, next) => {
  req.body.status = 'CANCELLED';
  return posVoucherController.setStatus(req, res, next);
}));
router.get('/vouchers/:voucherId/redemptions', canReadVoucherHistory, posVoucherController.history);
router.post('/vouchers/redemptions/:redemptionId/restore', canRestoreVouchers, canApproveVoucherRestore, idem(posVoucherController.restore));
router.post('/vouchers/reserve', canCreateSale, requirePosSessionAuth, requirePosSessionPermission('pos.voucher.redeem'), idem(posVoucherController.reserve));
router.post('/vouchers/release', canCreateSale, requirePosSessionAuth, requirePosSessionPermission('pos.voucher.redeem'), idem(posVoucherController.release));
router.get('/price-lists/manage', canManagePriceLists, priceListController.listManage);
router.post('/price-lists', canManagePriceLists, idem(priceListController.create));
router.patch('/price-lists/:priceListId', canManagePriceLists, idem(priceListController.update));
router.put('/price-lists/:priceListId/prices', canManagePriceLists, idem(priceListController.replacePrices));
router.put('/warehouses/:warehouseId/price-list', canManagePriceLists, idem(priceListController.assignWarehouse));
router.get('/stored-value/balance', canReadStoredValue, posStoredValueController.lookup);
router.post('/stored-value/issue', (req, res, next) => {
  const requiredPermission = String(req.body?.kind || '').toLowerCase() === 'gift_card'
    ? canIssueBackOfficeGiftCards
    : canManagePromotions;
  return requiredPermission(req, res, next);
}, idem(posStoredValueController.issue));

// Canonical POS checkout (the only supported sale write path)
router.get(
  '/payment-flow',
  canCreateSale,
  requirePosSessionAuth,
  requirePosPaymentPermission,
  getCheckoutPaymentFlow,
);
router.post('/discounts/apply', canCreateSale, requirePosSessionAuth, requirePosSessionPermission('pos.till.discount'), idem(posDiscountApplicationController.apply));
router.post('/direct-sale', canCreateSale, requireOnlinePosSession, requireOnlinePosPaymentPermission, logAction('sales_legacy_direct_sale'), idem(createDirectSale));
router.post(
  '/offline-snapshot',
  canCreateSale,
  requirePosSessionAuth,
  requirePosSessionPermission('pos.payment.take'),
  // Snapshot responses contain a one-use capability. They retain their
  // snapshot-specific nonce/expiry contract and must never be cached by the
  // generic response ledger.
  posOfflineController.issueSnapshot,
);
router.get('/offline-conflicts', canManagePromotions, posOfflineController.listConflicts);
router.post('/offline-conflicts/:conflictId/resolve', canManagePromotions, idem(posOfflineController.resolveConflict));

// Get products for POS with stock availability
router.get('/products', canReadPosCatalog, getPosProducts);
router.get('/products/:productId/serial-numbers', canReadPosCatalog, getPosAvailableSerialNumbers);
router.get('/stock-reservations', canReadSale, requirePosSessionAuth, posStockReservationController.list);
router.post('/stock-reservations', canCreateSale, requirePosSessionAuth, idem(posStockReservationController.create));
router.post('/stock-reservations/:reservationId/allocate-backorder', canCreateSale, requirePosSessionAuth, idem(posStockReservationController.allocateBackorder));
router.post('/stock-reservations/:reservationId/cancel', canCreateSale, requirePosSessionAuth, idem(posStockReservationController.cancel));

// Get receipt for printing
router.get('/receipt/:invoiceId', canReadSale, getReceipt);
router.post('/receipt/:invoiceId/reprint', canReadSale, requirePosSessionAuth, requirePosSessionPermission('pos.receipt.reprint'), idem(reprintReceipt));
router.post('/receipt/:invoiceId/public-link', canReadSale, requirePosSessionAuth, requireReceiptSharePermission, idem(posPublicReceiptController.createLink));
router.get('/receipt/:invoiceId/public-links', canReadSale, requirePosSessionAuth, requireReceiptManagePermission, posPublicReceiptController.listLinks);
router.delete('/receipt/:invoiceId/public-links/:linkId', canReadSale, requirePosSessionAuth, requireReceiptManagePermission, idem(posPublicReceiptController.revokeLink));
router.post('/receipt/:invoiceId/share-email', canReadSale, requirePosSessionAuth, requireReceiptSharePermission, idem(posPublicReceiptController.shareEmail));
router.post('/receipt/:invoiceId/share-sms', canReadSale, requirePosSessionAuth, requireReceiptSharePermission, idem(posPublicReceiptController.shareSms));
router.post('/receipt/:invoiceId/share-whatsapp', canReadSale, requirePosSessionAuth, requireReceiptSharePermission, idem(posPublicReceiptController.shareWhatsApp));
// Older callers now receive a public digital receipt link, never a plaintext receipt over SMS.
router.post('/receipt/:invoiceId/send-sms', canReadSale, requirePosSessionAuth, requireReceiptSharePermission, idem(posPublicReceiptController.shareSms));
router.post('/receipt/:invoiceId/send-whatsapp', canReadSale, requirePosSessionAuth, requireReceiptSharePermission, idem(posPublicReceiptController.shareWhatsApp));
router.get('/non-posting-documents', canReadSale, requireOnlinePosSession, posNonPostingDocumentController.list);
router.post('/training-documents', canCreateSale, requireOnlinePosSession, idem(posNonPostingDocumentController.createTraining));
router.post('/proformas', canCreateSale, requireOnlinePosSession, idem(posNonPostingDocumentController.createProforma));
router.post('/proformas/:documentId/convert', canCreateSale, requireOnlinePosSession, idem(posNonPostingDocumentController.convertProforma));
router.post('/quotes', canCreateSale, requireOnlinePosSession, idem(posNonPostingDocumentController.createQuote));
router.post('/delivery-notes/draft', canCreateSale, requireOnlinePosSession, idem(posNonPostingDocumentController.createDeliveryNote));

module.exports = router;
