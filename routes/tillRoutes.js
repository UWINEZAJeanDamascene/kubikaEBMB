const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { requirePermissionOrRoles } = require('../middleware/rbacMiddleware');
const { requirePosSession, requirePermission } = require('../middleware/posAuthMiddleware');
const { openTill, closeTill, recordNoSale, managerCloseTill, getActiveTill, getTillShifts, deleteEmptyTillShift } = require('../controllers/tillController');
const posCheckoutSupportController = require('../controllers/posCheckoutSupportController');
const { getTillZReport } = require('../controllers/tillZReportController');
const { createApproval, listApprovals } = require('../controllers/posManagerApprovalController');
const posRegisterController = require('../controllers/posRegisterController');

const canReadTill = requirePermissionOrRoles('tills', 'read', ['admin', 'accountant', 'manager', 'sales', 'viewer']);
const canManageRegisters = requirePermissionOrRoles('tills', 'create', ['admin', 'manager']);
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
  handler,
];

// Device claims and register administration are ERP manager operations.
router.get('/registers/device/:deviceId', protect, canReadTill, posRegisterController.getDeviceRegister);
router.post('/registers/claim', protect, canManageRegisters, posRegisterController.claimRegister);
router.get('/registers', protect, canManageRegisters, posRegisterController.listRegisters);
router.post('/registers', protect, canManageRegisters, posRegisterController.createRegister);
router.patch('/registers/:registerId/branch', protect, canManageRegisters, posRegisterController.updateRegisterBranch);
router.patch('/registers/:registerId/training-mode', protect, canManageRegisters, posRegisterController.updateTrainingMode);
router.post('/registers/:registerId/claim-code', protect, canManageRegisters, posRegisterController.issueClaimCode);
router.post('/registers/:registerId/revoke-device', protect, canManageRegisters, posRegisterController.revokeDevice);
router.delete('/registers/:registerId', protect, canManageRegisters, posRegisterController.deleteRegister);

// Till operations require both the paired device token and a live cashier PIN
// session. ERP bearer authentication alone can no longer open or operate a till.
router.post('/open', ...posSession('pos.shift.open', openTill));
router.post('/close', ...posSession('pos.shift.close', closeTill));
router.post('/no-sale', ...posSession('pos.payment.take', recordNoSale));
router.get('/active', ...posSession(null, getActiveTill));
router.get('/shifts', ...posSession('pos.report.x', getTillShifts));
router.get('/shifts/:tillSessionId/z-report', ...posSession('pos.report.x', getTillZReport));
router.get('/checkout-requests/:requestKey', ...posSession('pos.payment.take', posCheckoutSupportController.getCheckoutRequest));
router.post('/checkout-requests/:requestKey/recover', ...posSession('pos.payment.take', posCheckoutSupportController.recoverCheckoutRequest));
router.post('/manager-approvals', ...posSession('pos.payment.take', createApproval));

// Supervisor-only cross-cashier close and empty shift deletion remain ERP
// management actions; these are not cashier till endpoints.
router.post('/manager-close', protect, canCloseTill, managerCloseTill);
router.delete('/shifts/:tillSessionId', protect, canManageRegisters, deleteEmptyTillShift);
router.get('/manager-approvals/history', protect, canReadTill, listApprovals);

module.exports = router;
