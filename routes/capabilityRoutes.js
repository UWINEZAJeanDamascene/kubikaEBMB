const express = require('express');
const { protect } = require('../middleware/auth');
const { attachCompanyId } = require('../middleware/companyContext');
const capabilitiesController = require('../controllers/capabilitiesController');

const router = express.Router();

router.get('/', protect, attachCompanyId, capabilitiesController.getEffectiveCapabilities);

module.exports = router;
