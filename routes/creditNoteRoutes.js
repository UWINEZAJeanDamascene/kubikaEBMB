const express = require('express');
const router = express.Router();
const { posApiRateLimit } = require('../middleware/posRouteRateLimits');
const { protect } = require('../middleware/auth');
const requireModule = require('../middleware/requireModule');
const { requireAssignedPermissions: requirePermission } = require('../middleware/posAuthorization');
const { PermissionService, resolveUserRoles } = require('../middleware/authorize');
const { requirePosSession, requirePermission: requirePosPermission } = require('../middleware/posAuthMiddleware');
const { authorizeCreditNoteRead } = require('../middleware/creditNoteReadAuthorization');
const CreditNote = require('../models/CreditNote');
const controller = require('../controllers/creditNoteController');
const { idempotentHandler } = require('../services/posIdempotencyService');
const { posAuditOutcome } = require('../middleware/posAuditOutcome');
const idemCreditNote = (handler) => idempotentHandler(handler, { namespace: 'credit-note' });

router.use(posApiRateLimit);
router.use(protect);

// Module 8 API Endpoints:
// POST /api/credit-notes - Create draft (requires invoice_id)
// PUT /api/credit-notes/:id - Edit (draft only)
// POST /api/credit-notes/:id/confirm - Confirm (triggers dual reversal + stock return)
// GET /api/credit-notes - List with filters
// GET /api/credit-notes/:id - Full credit note with lines and journal entries
// DELETE /api/credit-notes/:id - Delete draft credit notes

const requireSamePosCashier = (req, res, next) => requirePosSession()(req, res, () => {
  const posUser = req.posAuthContext?.user;
  const companyId = String(req.posAuthContext?.company?.id || '');
  if (!posUser?.id || !companyId) {
    return res.status(401).json({ success: false, code: 'POS_SESSION_REQUIRED', message: 'Sign in to this till before continuing.' });
  }

  // POS session identity is authoritative for cashier actions. The ERP token
  // is still checked by `protect` and requirePosSession enforces same-company
  // access, but an administrator's ERP login must not impersonate the cashier
  // selected by PIN on the register. Credit-note controllers use req.user for
  // actor attribution, so bind that actor to the verified POS session here.
  req.user = {
    ...req.user,
    id: String(posUser.id),
    _id: String(posUser.id),
    companyId,
    company: { ...(req.user?.company || {}), id: companyId, _id: companyId },
  };
  return requirePosPermission('pos.till.sell')(req, res, next);
});

function authorizeCreditNoteDraft(req, res, next) {
  // A POS-origin draft does not post a refund, change stock, or reverse the
  // journal. It may be prepared from a signed-in till; confirmation below
  // still requires the one-use manager approval consumed by the controller.
  if (req.body?.posOrigin === true) {
    req.posFinancialOperation = true;
    return requireSamePosCashier(req, res, next);
  }
  return requirePermission('credit_notes', 'create')(req, res, next);
}

function auditPosCreditNoteOutcome(req, res, next) {
  return req.posFinancialOperation ? posAuditOutcome(req, res, next) : next();
}

router.route('/')
  .get(authorizeCreditNoteRead, controller.getCreditNotes)
  .post(authorizeCreditNoteDraft, auditPosCreditNoteOutcome, idemCreditNote(controller.createCreditNote));

router.route('/:id')
  .get(authorizeCreditNoteRead, controller.getCreditNote)
  .put(requirePermission('credit_notes', 'update'), idemCreditNote(controller.updateCreditNote))
  .delete(requirePermission('credit_notes', 'delete'), idemCreditNote(controller.deleteCreditNote));

router.get('/:id/pdf', authorizeCreditNoteRead, controller.generateCreditNotePDF);

// Module 8: Confirm credit note - triggers dual journal reversal + stock return
async function authorizeCreditNoteConfirmation(req, res, next) {
  try {
    const note = await CreditNote.findOne({ _id: req.params.id, company: req.user.company._id }).select('posOrigin').lean();
    if (!note) return next();
    if (note.posOrigin) {
      req.posFinancialOperation = true;
      return requireSamePosCashier(req, res, next);
    }
    const action = 'approve';
    const roles = await resolveUserRoles(req.user);
    if (!roles.some((role) => PermissionService.check(role, 'credit_notes', action))) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN', message: 'Your role cannot request this credit note confirmation.' });
    }
    return next();
  } catch (error) {
    return next(error);
  }
}
router.post('/:id/confirm', authorizeCreditNoteConfirmation, auditPosCreditNoteOutcome, idemCreditNote(controller.confirmCreditNote));
router.post('/:id/submit-ebm', requireModule('fiscal.ebm'), requirePermission('credit_notes', 'approve'), idemCreditNote(controller.submitCreditNoteEbm));

// Legacy endpoints (backwards compatibility)
router.put('/:id/approve', requirePermission('credit_notes', 'approve'), idemCreditNote(controller.confirmCreditNote));
router.post('/:id/apply', requirePermission('credit_notes', 'approve'), idemCreditNote(controller.applyCreditNote)); // Apply to another invoice
router.post('/:id/refund', authorizeCreditNoteConfirmation, auditPosCreditNoteOutcome, idemCreditNote(controller.recordRefund));

module.exports = router;
