'use strict';

const express = require('express');
const {
  requirePosSession,
  requirePermission,
} = require('../middleware/posAuthMiddleware');
const controller = require('../controllers/posPaymentSettingsController');

const router = express.Router();

router.get('/methods', requirePosSession(), requirePermission('pos.payment.take'), controller.getMethods);
router.get('/', requirePosSession(), requirePermission('pos.payment.settings'), controller.getSettings);
router.put('/', requirePosSession(), requirePermission('pos.payment.settings'), controller.updateSettings);

module.exports = router;
