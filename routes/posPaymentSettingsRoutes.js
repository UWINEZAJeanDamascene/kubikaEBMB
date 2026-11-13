'use strict';

const express = require('express');
const {
  requirePosSession,
  requirePermission,
} = require('../middleware/posAuthMiddleware');
const controller = require('../controllers/posPaymentSettingsController');
const { idempotentHandler } = require('../services/posIdempotencyService');

const router = express.Router();
const { posApiRateLimit } = require('../middleware/posRouteRateLimits');

router.use(posApiRateLimit);
router.get('/methods', requirePosSession(), requirePermission('pos.payment.take'), controller.getMethods);
router.get('/', requirePosSession(), requirePermission('pos.payment.settings'), controller.getSettings);
router.put('/', requirePosSession(), requirePermission('pos.payment.settings'), idempotentHandler(controller.updateSettings, { namespace: 'pos-payment-settings' }));

module.exports = router;
