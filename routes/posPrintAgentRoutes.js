const express = require('express');
const { protect } = require('../middleware/auth');
const { requirePermissionOrRoles } = require('../middleware/rbacMiddleware');
const { requirePrintAgent } = require('../middleware/posPrintAgentMiddleware');
const printAgentController = require('../controllers/posPrintAgentController');
const printJobController = require('../controllers/posPrintJobController');
const { idempotentHandler } = require('../services/posIdempotencyService');

const router = express.Router();
const { posApiRateLimit, posDevicePairingRateLimit } = require('../middleware/posRouteRateLimits');
router.use(posApiRateLimit);
const canManage = requirePermissionOrRoles('pos.admin', 'printers', ['admin', 'manager', 'store_manager', 'owner']);

router.post('/pair', posDevicePairingRateLimit, printAgentController.pair);
router.post('/refresh', printAgentController.refresh);
router.post('/admin/pairings', protect, canManage, idempotentHandler(printAgentController.createPairing, { namespace: 'pos-print-admin' }));
router.get('/admin/agents', protect, canManage, printJobController.listAgents);
router.post('/admin/agents/:agentId/revoke', protect, canManage, idempotentHandler(printJobController.revokeAgent, { namespace: 'pos-print-admin' }));
router.post('/admin/printers', protect, canManage, idempotentHandler(printJobController.configurePrinter, { namespace: 'pos-print-admin' }));
router.post('/admin/jobs', protect, canManage, idempotentHandler(printJobController.createJob, { namespace: 'pos-print-admin' }));
router.get('/admin/jobs', protect, canManage, printJobController.listJobs);
router.get('/admin/release', protect, printJobController.getRelease);
router.get('/admin/download', protect, printJobController.downloadSetup);

router.get('/agent/jobs/poll', requirePrintAgent, printJobController.poll);
router.post('/agent/jobs/:jobId/lease', requirePrintAgent, printJobController.lease);
router.post('/agent/jobs/:jobId/acknowledge', requirePrintAgent, printJobController.acknowledge);
router.post('/agent/jobs/:jobId/fail', requirePrintAgent, printJobController.fail);

module.exports = router;
