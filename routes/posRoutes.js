const express = require('express');
const router = express.Router();
const { posApiRateLimit, posCredentialRateLimit } = require('../middleware/posRouteRateLimits');
const { protect } = require('../middleware/auth');
const logAction = require('../middleware/logAction');
const { requirePermissionOrRoles } = require('../middleware/rbacMiddleware');
const { requirePosPermissions } = require('../middleware/posAuthorization');
const { cacheMiddleware, cacheInvalidationMiddleware } = require('../middleware/cacheMiddleware');
const { posAuditOutcome } = require('../middleware/posAuditOutcome');
const { idempotentHandler } = require('../services/posIdempotencyService');

// Capture denied/failed writes across both session-authenticated till routes
// and ERP-authenticated POS management routes. Success events remain in the
// state-changing service transaction.
router.use(posApiRateLimit);
router.use(posAuditOutcome);
const idem = (handler) => idempotentHandler(handler, { namespace: 'pos' });

const cachePosReads = cacheMiddleware({
  type: 'pos',
  ttl: 60,
  skipCache: (req) => req.query.refresh === '1' || req.query.refresh === 'true',
});
const invalidatePosReads = cacheInvalidationMiddleware({
  types: ['pos', 'invoice', 'stock', 'report'],
  invalidateDashboards: true,
});
const {
  createSale,
  addPayment,
  openDrawer,
  closeDrawer,
  getDrawer,
  getReceipt,
} = require('../controllers/posController');
const posRegisterController = require('../controllers/posRegisterController');
const posAuthController = require('../controllers/posAuthController');
const posApprovalController = require('../controllers/posApprovalController');
const posPinController = require('../controllers/posPinController');
const {
  requireDevice,
  requirePosSession,
  requirePermission,
  requireCashMovementPermission,
} = require('../middleware/posAuthMiddleware');
const posShiftController = require('../controllers/posShiftController');
const posCashMovementController = require('../controllers/posCashMovementController');
const posShiftCloseController = require('../controllers/posShiftCloseController');
const posAccountingPostingController = require('../controllers/posAccountingPostingController');
const posShiftLifecycleController = require('../controllers/posShiftLifecycleController');
const posPaymentSettingsRoutes = require('./posPaymentSettingsRoutes');
const posPaymentSettingsController = require('../controllers/posPaymentSettingsController');
const posTillSettingsController = require('../controllers/posTillSettingsController');
const posDiscountSettingsController = require('../controllers/posDiscountSettingsController');
const posAccountingProfileController = require('../controllers/posAccountingProfileController');
const posBackOfficeController = require('../controllers/posBackOfficeController');
const posOfflineExceptionController = require('../controllers/posOfflineExceptionController');
const posOfflineMonitoringController = require('../controllers/posOfflineMonitoringController');
const posRemoteApprovalController = require('../controllers/posRemoteApprovalController');
const posDiscountReportsController = require('../controllers/posDiscountReportsController');
const posAccountingReportsController = require('../controllers/posAccountingReportsController');
const posIdempotencyController = require('../controllers/posIdempotencyController');
const posSecurityController = require('../controllers/posSecurityController');
const posPaymentsV2Controller = require('../controllers/posPaymentsV2Controller');
const posGiftCardController = require('../controllers/posGiftCardController');
const posCreditAccountController = require('../controllers/posCreditAccountController');
const posChequeController = require('../controllers/posChequeController');
const canManagePosRegisters = requirePermissionOrRoles('pos.admin', 'registers', ['admin', 'manager', 'store_manager']);
const posPrintAgentRoutes = require('./posPrintAgentRoutes');

router.use('/print-agent', posPrintAgentRoutes);

router.use('/payment-settings', posPaymentSettingsRoutes);
const canManagePosSettings = requirePermissionOrRoles('pos.admin', 'settings', ['admin', 'manager', 'store_manager', 'owner']);
router.get('/register-settings/payment-methods', protect, canManagePosSettings, posPaymentSettingsController.getAdminSettings);
router.put('/register-settings/payment-methods', protect, canManagePosSettings, idem(posPaymentSettingsController.updateAdminSettings));
router.get('/register-settings', protect, canManagePosSettings, posTillSettingsController.getSettings);
router.put('/register-settings', protect, canManagePosSettings, idem(posTillSettingsController.updateSettings));
router.get('/admin/discount-settings', protect, canManagePosSettings, posDiscountSettingsController.getSettings);
router.get('/admin/accounting-profile', protect, canManagePosSettings, posAccountingProfileController.getProfile);
router.put('/admin/accounting-profile', protect, canManagePosSettings, idem(posAccountingProfileController.updateProfile));
router.get('/admin/discount-settings/roles', protect, canManagePosSettings, posDiscountSettingsController.getRoles);
router.put('/admin/discount-settings', protect, canManagePosSettings, idem(posDiscountSettingsController.updateSettings));
router.patch('/admin/registers/:registerId/discount-settings', protect, canManagePosRegisters, idem(posDiscountSettingsController.updateRegisterSettings));
router.post('/register-settings/receipt-branch/:branchId/reset', protect, canManagePosSettings, idem(posTillSettingsController.clearBranchReceiptSettings));
router.post('/payments-v2/provider-webhooks/:provider/:companyId', posPaymentsV2Controller.providerWebhook);
router.post('/payments/sales/:saleId/payments', requirePosSession(), requirePermission('pos.payment.take'), idem(posPaymentsV2Controller.recordPayment));
router.get('/payments/sales/:saleId/payments', requirePosSession(), requirePermission('pos.payment.take'), posPaymentsV2Controller.listSalePayments);
router.get('/payments/pending', requirePosSession(), requirePermission('pos.shift.close'), posPaymentsV2Controller.listPendingPayments);
router.get('/payments/unmatched', requirePosSession(), requirePermission('pos.payment.reconcile'), posPaymentsV2Controller.listUnmatchedProviderEvents);
router.post('/payments/refunds', requirePosSession(), requirePermission('pos.payment.take'), idem(posPaymentsV2Controller.createRefund));
router.get('/payments/reports/by-method', requirePosSession(), requirePermission('pos.payment.take'), posPaymentsV2Controller.reportPaymentsByMethod);
router.get('/payments/reports/reconciliation', requirePosSession(), requirePermission('pos.payment.reconcile'), posPaymentsV2Controller.reportPaymentReconciliation);
router.get('/payments/:paymentId', requirePosSession(), requirePermission('pos.payment.take'), posPaymentsV2Controller.getPaymentStatus);
router.post('/payments/:paymentId/resend', requirePosSession(), requirePermission('pos.payment.take'), idem(posPaymentsV2Controller.resendPayment));
router.post('/payments/:paymentId/cancel', requirePosSession(), requirePermission('pos.payment.take'), idem(posPaymentsV2Controller.cancelPayment));
router.post('/payments/:paymentId/manual-confirm', requirePosSession(), requirePermission('pos.payment.manual_confirm'), idem(posPaymentsV2Controller.confirmManualMobileMoneyPayment));
router.post('/payments-v2/direct-sale', requirePosSession(), requirePermission('pos.payment.take'), idem(posPaymentsV2Controller.createPendingSale));
router.post('/payments-v2/sales/:saleId/payments', requirePosSession(), requirePermission('pos.payment.take'), idem(posPaymentsV2Controller.recordCashPayment));
router.post('/payments-v2/sales/:saleId/manual-mobile-money', requirePosSession(), requirePermission('pos.payment.take'), idem(posPaymentsV2Controller.recordManualMobileMoneyPayment));
router.post('/payments-v2/sales/:saleId/mobile-money', requirePosSession(), requirePermission('pos.payment.take'), idem(posPaymentsV2Controller.requestMtnMomoPayment));
router.get('/payments-v2/payments/:paymentId', requirePosSession(), requirePermission('pos.payment.take'), posPaymentsV2Controller.getMtnMomoPaymentStatus);
router.post('/payments-v2/payments/:paymentId/manual-confirm', requirePosSession(), requirePermission('pos.payment.manual_confirm'), idem(posPaymentsV2Controller.confirmManualMobileMoneyPayment));
router.get('/payments-v2/manual-mobile-money/reconciliation', requirePosSession(), requirePermission('pos.payment.manual_confirm'), posPaymentsV2Controller.listManualMobileMoneyPayments);
router.post('/payments-v2/manual-mobile-money/:paymentId/reconcile', requirePosSession(), requirePermission('pos.payment.manual_confirm'), idem(posPaymentsV2Controller.reconcileManualMobileMoneyPayment));
router.get('/payments-v2/manual-mobile-money/report', requirePosSession(), requirePermission('pos.payment.manual_confirm'), posPaymentsV2Controller.manualMobileMoneyReport);
router.get('/cheques', requirePosSession(), requirePermission('pos.payment.reconcile'), posChequeController.list);
router.post('/cheques/deposits', requirePosSession(), requirePermission('pos.payment.reconcile'), idem(posChequeController.deposit));
router.post('/cheques/:chequeId/bounce', requirePosSession(), requirePermission('pos.payment.reconcile'), idem(posChequeController.bounce));
// Cashiers may request removal; the controller requires a one-use manager
// approval before performing any refund unless the active role may refund.
router.post('/payments-v2/sales/:saleId/payments/:paymentId/remove', requirePosSession(), requirePermission('pos.payment.take'), idem(posPaymentsV2Controller.removePayment));
router.post('/payments-v2/sales/:saleId/complete', requirePosSession(), requirePermission('pos.payment.take'), idem(posPaymentsV2Controller.completeSale));
router.get('/credit-accounts/:clientId', requirePosSession(), requirePermission('pos.till.receive_account_payment'), posCreditAccountController.getAccount);
router.put('/credit-accounts/:clientId', requirePosSession(), requirePermission('pos.payment.settings'), idem(posCreditAccountController.updateAccount));
router.post('/credit-accounts/:clientId/payments', requirePosSession(), requirePermission('pos.till.receive_account_payment'), idem(posCreditAccountController.takePayment));
router.post('/credit-accounts/payments/:receiptId/refund', requirePosSession(), requirePermission('pos.payment.settings'), idem(posCreditAccountController.refundPayment));
router.post('/credit-accounts/:clientId/adjustments', requirePosSession(), requirePermission('pos.payment.settings'), idem(posCreditAccountController.adjust));
router.post('/credit-accounts/:clientId/write-offs', requirePosSession(), requirePermission('pos.payment.settings'), idem(posCreditAccountController.writeOff));
router.get('/payments/gift-cards/:code/balance', requirePosSession(), requirePermission('pos.giftcard.redeem'), posGiftCardController.balance);
router.post('/payments/gift-cards/issue', requirePosSession(), requirePermission('pos.giftcard.issue'), idem(posGiftCardController.issueCashier));
router.post('/payments/gift-cards/deliver', requirePosSession(), requirePermission('pos.giftcard.issue'), idem(posGiftCardController.deliver));
router.post('/payments/gift-cards/reissue', requirePosSession(), requirePermission('pos.giftcard.manage'), idem(posGiftCardController.reissue));
router.post('/payments/gift-cards', requirePosSession(), requirePermission('pos.giftcard.manage'), idem(posGiftCardController.issueOrLoad));
router.get('/payments-v2/shifts/:shiftId/pending-sales', requirePosSession(), requirePermission('pos.shift.close'), posPaymentsV2Controller.listPendingShiftSales);
router.post('/payments-v2/sales/:saleId/refund-and-cancel', requirePosSession(), requirePermission('pos.payment.take'), idem(posPaymentsV2Controller.refundAndCancel));
router.get('/payments-v2/refunds/manual-due', requirePosSession(), requirePermission('pos.payment.settings'), posPaymentsV2Controller.listManualRefunds);
router.post('/payments-v2/refunds/:refundId/resolve', requirePosSession(), requirePermission('pos.payment.settings'), idem(posPaymentsV2Controller.resolveManualRefund));
router.get('/payments-v2/provider-events/unmatched', requirePosSession(), requirePermission('pos.payment.settings'), posPaymentsV2Controller.listUnmatchedProviderEvents);

router.get('/registers', protect, canManagePosRegisters, posRegisterController.listRegisters);
router.post('/registers/:registerId/activate', protect, canManagePosRegisters, idem(posRegisterController.activateRegister));
router.get('/registers/:registerId/cashier-access', protect, canManagePosRegisters, posRegisterController.getCashierAccess);
router.put('/registers/:registerId/cashier-access', protect, canManagePosRegisters, idem(posRegisterController.updateCashierAccess));
router.get('/registers/:registerId/cashiers', requireDevice(), posRegisterController.listCashiers);
router.post('/auth/pin-login', posCredentialRateLimit, posAuthController.pinLogin);
router.post('/auth/refresh', posCredentialRateLimit, requireDevice(), idem(posAuthController.refreshSessionToken));
router.post('/auth/offline-attempts', posCredentialRateLimit, requireDevice(), posAuthController.reportOfflinePinAttempts);
router.post('/approvals', requirePosSession(), idem(posApprovalController.create));
router.get('/approval-managers', requirePosSession(), posRemoteApprovalController.eligibleManagers);
router.post('/approval-requests', requirePosSession(), idem(posRemoteApprovalController.create));
router.get('/approval-requests/:requestId', requirePosSession(), posRemoteApprovalController.status);
router.post('/users/:id/pin/setup', protect, canManagePosRegisters, idem(posPinController.setByManager));
router.post('/users/:id/pin', requirePosSession(), idem(posPinController.setOrReset));
router.post('/auth/lock', requirePosSession(), idem(posAuthController.lock));
router.post('/auth/unlock', posCredentialRateLimit, requirePosSession({ allowedStatuses: ['locked'] }), idem(posAuthController.unlock));
router.post('/auth/switch', posCredentialRateLimit, requirePosSession({ allowedStatuses: ['active', 'locked'] }), idem(posAuthController.switchCashier));
router.post('/auth/logout', requirePosSession({ allowedStatuses: ['active', 'locked'] }), idem(posAuthController.logout));
router.get('/auth/me', requirePosSession({ allowedStatuses: ['active', 'locked'] }), posAuthController.me);
router.get('/shifts/current', requirePosSession(), requirePermission('pos.report.x'), posShiftController.current);
router.get('/shifts/x-report', requirePosSession(), requirePermission('pos.report.x'), posShiftController.xReport);
router.post('/shifts/open', requirePosSession(), requirePermission('pos.shift.open'), idem(posShiftController.open));
router.post('/shifts/:shiftId/close', requirePosSession(), requirePermission('pos.shift.close'), idem(posShiftCloseController.close));
router.delete('/shifts/:shiftId', requirePosSession(), requirePermission('pos.shift.close.any'), idem(posShiftController.remove));
router.post('/shifts/:shiftId/reopen', requirePosSession(), requirePermission('pos.shift.reopen'), idem(posShiftLifecycleController.reopen));
router.post('/shifts/:shiftId/handover', requirePosSession(), requirePermission('pos.shift.close'), idem(posShiftLifecycleController.handover));
router.get('/shifts/history', requirePosSession(), requirePermission('pos.report.history'), posShiftController.history);
router.get('/accounting-postings/:sourceType/:sourceId', requirePosSession(), requirePermission('pos.report.x'), posAccountingPostingController.get);
router.get('/shifts/:shiftId/z-report', requirePosSession(), requirePermission('pos.report.z'), posShiftCloseController.zReport);
router.get('/shifts/:shiftId/corrections', requirePosSession(), requirePermission('pos.report.x'), posShiftLifecycleController.corrections);
router.get('/shifts/:shiftId/cash-movements', requirePosSession(), requirePermission('pos.report.x'), posCashMovementController.list);
router.post('/shifts/:shiftId/cash-movements', requirePosSession(), requireCashMovementPermission(), idem(posCashMovementController.create));
router.put('/shifts/:shiftId/cash-movements/:movementId/bank-slip-reference', requirePosSession(), requirePermission('pos.cash.out'), idem(posCashMovementController.recordBankSlipReference));

// Legacy POS routes still use normal application authentication.
// Checkout and cash-drawer writes are retired; sales-legacy + tills are canonical.
router.use(protect);
router.use(invalidatePosReads);

// ERP-authenticated POS management endpoints. They deliberately do not accept
// till-session tokens; the company scope comes only from the signed-in ERP user.
router.get('/admin/overview', requirePermissionOrRoles('pos.admin', 'view', ['admin', 'manager', 'store_manager']), posBackOfficeController.overview);
router.get('/admin/shifts', requirePermissionOrRoles('pos.admin', 'shifts', ['admin', 'manager', 'store_manager']), posBackOfficeController.shifts);
router.delete('/admin/shifts/:shiftId', requirePermissionOrRoles('pos.admin', 'shifts', ['admin', 'manager', 'store_manager']), idem(posBackOfficeController.deleteEmptyClosedShift));
const canReadPosAudit = requirePosPermissions({ resource: 'pos.admin.audit', action: 'read' });
const canExportPosAudit = requirePosPermissions({ resource: 'pos.admin.audit', action: 'export' });
const canVerifyPosAudit = requirePosPermissions({ resource: 'pos.admin.audit', action: 'verify' });
router.get('/admin/audit/export.csv', canExportPosAudit, posBackOfficeController.exportAuditCsv);
router.get('/admin/audit', canReadPosAudit, posBackOfficeController.audit);
const canReadPosSecurity = requirePosPermissions({ resource: 'pos.admin.security', action: 'read' });
const canUpdatePosSecurity = requirePosPermissions({ resource: 'pos.admin.security', action: 'update' });
const canReadPosSecuritySessions = requirePosPermissions({ resource: 'pos.admin.security.sessions', action: 'read' });
const canRevokePosSecuritySessions = requirePosPermissions({ resource: 'pos.admin.security.sessions', action: 'revoke' });
router.get('/admin/security/settings', canReadPosSecurity, posSecurityController.getSettings);
router.put('/admin/security/settings', canUpdatePosSecurity, idem(posSecurityController.updateSettings));
router.get('/admin/security/sessions', canReadPosSecuritySessions, posSecurityController.activeSessions);
router.post('/admin/security/sessions/:sessionId/revoke', canRevokePosSecuritySessions, idem(posSecurityController.revokeSession));
router.get('/admin/security/audit-integrity', canVerifyPosAudit, posSecurityController.verifyAuditIntegrity);
router.get('/admin/security/duplicate-attempts', canReadPosSecurity, posSecurityController.duplicateAttempts);
router.get('/admin/security/risk-report', canReadPosSecurity, posSecurityController.riskReport);
router.get('/admin/approval-requests', requirePermissionOrRoles('pos.admin', 'approvals', ['admin', 'manager', 'store_manager']), posRemoteApprovalController.list);
router.get('/admin/offline-exceptions', requirePermissionOrRoles('pos.admin', 'approvals', ['admin', 'manager', 'store_manager']), posOfflineExceptionController.list);
router.get('/admin/idempotency-review', requirePermissionOrRoles('pos.admin', 'approvals', ['admin', 'manager', 'store_manager']), posIdempotencyController.listNeedsReview);
router.post('/admin/idempotency-review/:recordId/resolve', requirePermissionOrRoles('pos.admin', 'approvals', ['admin', 'manager', 'store_manager']), idem(posIdempotencyController.resolveNeedsReview));
router.post('/admin/offline-exceptions/:exceptionId/resolve', requirePermissionOrRoles('pos.admin', 'approvals', ['admin', 'manager', 'store_manager']), idem(posOfflineExceptionController.resolve));
router.get('/admin/offline-monitoring', requirePermissionOrRoles('pos.admin', 'reports', ['admin', 'manager', 'store_manager']), posOfflineMonitoringController.getReport);
router.post('/admin/approval-requests/:requestId/decision', requirePermissionOrRoles('pos.admin', 'approvals', ['admin', 'manager', 'store_manager']), idem(posRemoteApprovalController.decide));
router.get('/admin/approval-policies', requirePermissionOrRoles('pos.admin', 'approvals', ['admin', 'manager', 'store_manager']), posRemoteApprovalController.listPolicies);
router.put('/admin/approval-policies/:action', requirePermissionOrRoles('pos.admin', 'approvals', ['admin', 'manager', 'store_manager']), idem(posRemoteApprovalController.updatePolicy));
router.get('/admin/discount-reports', requirePermissionOrRoles('pos.admin', 'reports', ['admin', 'manager', 'store_manager']), posDiscountReportsController.getReports);
router.get('/admin/accounting-postings', requirePermissionOrRoles('pos.admin', 'reports', ['admin', 'manager', 'store_manager']), posAccountingReportsController.listPostings);
router.post('/admin/accounting-postings/:postingId/retry', requirePermissionOrRoles('pos.admin', 'reports', ['admin', 'manager', 'store_manager']), idem(posAccountingReportsController.retryPosting));
router.get('/admin/accounting-reports', requirePermissionOrRoles('pos.admin', 'reports', ['admin', 'manager', 'store_manager']), posAccountingReportsController.getReport);

router.post('/sale', requirePermissionOrRoles('point_of_sale', 'create', ['admin', 'manager', 'sales']), logAction('pos_sale_retired'), idem(createSale));
router.post('/sale/:id/pay', requirePermissionOrRoles('point_of_sale', 'pay', ['admin', 'accountant', 'sales']), logAction('pos_payment_retired'), idem(addPayment));
// Receipt alias for older clients — prefer GET /api/sales-legacy/receipt/:invoiceId
router.get('/sale/:id/receipt', requirePermissionOrRoles('point_of_sale', 'read', ['admin', 'accountant', 'manager', 'sales', 'viewer']), cachePosReads, getReceipt);

router.post('/drawer/open', requirePermissionOrRoles('point_of_sale', 'open', ['admin', 'manager', 'sales']), logAction('drawer_open_retired'), idem(openDrawer));
router.post('/drawer/close', requirePermissionOrRoles('point_of_sale', 'close', ['admin', 'manager', 'sales']), logAction('drawer_close_retired'), idem(closeDrawer));
router.get('/drawer/:drawerId', requirePermissionOrRoles('point_of_sale', 'read', ['admin', 'accountant', 'manager', 'sales', 'viewer']), cachePosReads, getDrawer);

module.exports = router;
