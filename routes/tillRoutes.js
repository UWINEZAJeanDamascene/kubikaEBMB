const express = require('express');
const router = express.Router();
const { posApiRateLimit } = require('../middleware/posRouteRateLimits');
const { posAuditOutcome } = require('../middleware/posAuditOutcome');
const { idempotentHandler } = require('../services/posIdempotencyService');
router.use(posApiRateLimit);
router.use(posAuditOutcome);
const idem = (handler) => idempotentHandler(handler, { namespace: 'tills' });
const { protect } = require('../middleware/auth');
const { requirePermissionOrRoles } = require('../middleware/rbacMiddleware');
const { requirePosPermissions } = require('../middleware/posAuthorization');
const { requirePosSession, requirePermission } = require('../middleware/posAuthMiddleware');
const { openTill, closeTill, recordNoSale, managerCloseTill, getActiveTill, getTillShifts, deleteEmptyTillShift } = require('../controllers/tillController');
const posCheckoutSupportController = require('../controllers/posCheckoutSupportController');
const { getTillZReport } = require('../controllers/tillZReportController');
const { createApproval, listApprovals } = require('../controllers/posManagerApprovalController');
const posRegisterController = require('../controllers/posRegisterController');

const canReadTill = requirePermissionOrRoles('tills', 'read', ['admin', 'accountant', 'manager', 'sales', 'viewer']);
const canResolveAssignedRegister = requirePermissionOrRoles(
  'tills',
  'read',
  ['admin', 'accountant', 'manager', 'sales', 'viewer', 'cashier'],
);
// Register/device administration uses the POS capability consistently with
// the back-office UI; built-in administrator roles retain compatibility.
const canManageRegisters = requirePermissionOrRoles('pos.admin', 'registers', ['admin', 'manager', 'store_manager', 'owner']);
const canReadSecurityDevices = requirePosPermissions({ resource: 'pos.admin.security.sessions', action: 'read' });
const canManageSecurityDevices = requirePosPermissions({ resource: 'pos.admin.security.sessions', action: 'revoke' });
const canCloseTill = requirePermissionOrRoles('tills', 'close', ['admin', 'manager']);

// These older controllers predate POS sessions and read req.user. Bind that
// identity only after the signed device + active cashier session are verified.
function bindSessionIdentity(req, res, next) {
  const context = req.posAuthContext;
  if (!context) return res.status(401).json({ success: false, code: 'POS_SESSION_INVALID', message: 'Sign in to this till again.' });
  const companyId = String(context.company.id);
  req.user = {
    ...context.user,
    id: String(context.session.userId),
    roles: (context.user.roles || []).map((assignment) => assignment.role).filter(Boolean),
    companyId,
    company: { id: companyId, _id: companyId },
  };
  req.company = req.user.company;
  // The register identity is derived from the verified session, never trusted
  // from a caller-supplied register/device query parameter.
  if (req.query) {
    req.query.registerId = String(context.register.code);
    req.query.deviceId = String(context.register.claimedDeviceId || '');
  }
  if (req.body && typeof req.body === 'object') {
    req.body.registerId = String(context.register.code);
    req.body.deviceId = String(context.register.claimedDeviceId || '');
  }
  return next();
}

const posSession = (permission, handler) => [
  requirePosSession(),
  ...(permission ? [requirePermission(permission)] : []),
  bindSessionIdentity,
  idem(handler),
];
// Read-only session routes authenticate and authorize from the cashier session
// without requiring a mutation idempotency key or reserving a write record.
const posSessionRead = (permission, handler) => [
  requirePosSession(),
  ...(permission ? [requirePermission(permission)] : []),
  bindSessionIdentity,
  handler,
];

// Device claims and register administration are ERP manager operations.
router.get('/registers/device/:deviceId', protect, canResolveAssignedRegister, posRegisterController.getDeviceRegister);
router.post('/registers/claim', protect, canManageRegisters, idem(posRegisterController.claimRegister));
router.get('/registers', protect, canManageRegisters, posRegisterController.listRegisters);
router.get('/devices', protect, canReadSecurityDevices, posRegisterController.listDevices);
router.patch('/devices/:deviceId/status', protect, canManageSecurityDevices, idem(posRegisterController.setDeviceStatus));
router.post('/devices/:deviceId/wipe', protect, canManageSecurityDevices, idem(posRegisterController.requestDeviceWipe));
router.post('/registers', protect, canManageRegisters, idem(posRegisterController.createRegister));
router.patch('/registers/:registerId/branch', protect, canManageRegisters, idem(posRegisterController.updateRegisterBranch));
router.patch('/registers/:registerId/training-mode', protect, canManageRegisters, idem(posRegisterController.updateTrainingMode));
router.post('/registers/:registerId/claim-code', protect, canManageRegisters, idem(posRegisterController.issueClaimCode));
router.post('/registers/:registerId/revoke-device', protect, canManageSecurityDevices, idem(posRegisterController.revokeDevice));
router.delete('/registers/:registerId', protect, canManageRegisters, idem(posRegisterController.deleteRegister));

// Till operations require both the paired device token and a live cashier PIN
// session. ERP bearer authentication alone can no longer open or operate a till.
router.post('/open', ...posSession('pos.shift.open', openTill));
router.post('/close', ...posSession('pos.shift.close', closeTill));
router.post('/no-sale', ...posSession('pos.payment.take', recordNoSale));
router.get('/active', ...posSessionRead(null, getActiveTill));
router.get('/shifts', ...posSessionRead('pos.report.x', getTillShifts));
router.get('/shifts/:tillSessionId/z-report', ...posSessionRead('pos.report.x', getTillZReport));
router.get('/checkout-requests/:requestKey', ...posSessionRead('pos.payment.take', posCheckoutSupportController.getCheckoutRequest));
router.post('/checkout-requests/:requestKey/recover', ...posSession('pos.payment.take', posCheckoutSupportController.recoverCheckoutRequest));
router.post('/manager-approvals', ...posSession('pos.payment.take', createApproval));

// Supervisor-only cross-cashier close and empty shift deletion remain ERP
// management actions; these are not cashier till endpoints.
router.post('/manager-close', protect, canCloseTill, idem(managerCloseTill));
router.delete('/shifts/:tillSessionId', protect, canManageRegisters, idem(deleteEmptyTillShift));
router.get('/manager-approvals/history', protect, canReadTill, listApprovals);

module.exports = router;
