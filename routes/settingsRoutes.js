const express = require('express')
const router = express.Router()
const systemSettingsController = require('../controllers/systemSettingsController')
const laborCostingSettingsController = require('../controllers/laborCostingSettingsController')
const { protect } = require('../middleware/auth')
const { attachCompanyId } = require('../middleware/companyContext')
const { requireLaborCostingAccess } = require('../middleware/laborCostingAccess')
const { authorize } = require('../middleware/authorize')

// All routes require authentication and company context
router.use(protect)
router.use(attachCompanyId)

// GET /api/settings - Get all settings for company
router.get('/', systemSettingsController.getSettings)

// PUT /api/settings - Update settings (admin only)
router.put('/', authorize('settings', 'update'), systemSettingsController.updateSettings)

router.get(
  '/labor-costing/audit',
  requireLaborCostingAccess,
  laborCostingSettingsController.getLaborCostingAudit,
)
router.get(
  '/labor-costing',
  requireLaborCostingAccess,
  laborCostingSettingsController.getLaborCostingSettings,
)
router.put(
  '/labor-costing',
  requireLaborCostingAccess,
  laborCostingSettingsController.updateLaborCostingSettings,
)
module.exports = router
