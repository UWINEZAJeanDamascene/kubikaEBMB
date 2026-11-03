const express = require('express');
const { protect } = require('../middleware/auth');
const { requirePermissionOrRoles } = require('../middleware/rbacMiddleware');
const { requirePrintAgent } = require('../middleware/posPrintAgentMiddleware');
const printAgentController = require('../controllers/posPrintAgentController');
const printJobController = require('../controllers/posPrintJobController');

const router = express.Router();
const canManage = requirePermissionOrRoles('pos.admin', 'printers', ['admin', 'manager', 'store_manager', 'owner']);

router.post('/pair', printAgentController.pair);
router.post('/refresh', printAgentController.refresh);
router.post('/admin/pairings', protect, canManage, printAgentController.createPairing);
router.get('/admin/agents', protect, canManage, printJobController.listAgents);
router.post('/admin/agents/:agentId/revoke', protect, canManage, printJobController.revokeAgent);
router.post('/admin/printers', protect, canManage, printJobController.configurePrinter);
router.post('/admin/jobs', protect, canManage, printJobController.createJob);
router.get('/admin/jobs', protect, canManage, printJobController.listJobs);
router.get('/admin/release', protect, printJobController.getRelease);
router.get('/admin/download', protect, printJobController.downloadSetup);

router.get('/agent/jobs/poll', requirePrintAgent, printJobController.poll);
router.post('/agent/jobs/:jobId/lease', requirePrintAgent, printJobController.lease);
router.post('/agent/jobs/:jobId/acknowledge', requirePrintAgent, printJobController.acknowledge);
router.post('/agent/jobs/:jobId/fail', requirePrintAgent, printJobController.fail);

module.exports = router;
