'use strict';

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbacMiddleware');
const controller = require('../controllers/customerMasterController');

router.use(protect);

router.get('/walk-in', requirePermission('clients', 'read'), controller.walkIn);
router.get('/duplicates', requirePermission('clients', 'read'), controller.duplicates);
router.get('/', requirePermission('clients', 'read'), controller.search);
router.post('/quick-add', requirePermission('clients', 'create'), controller.quickAdd);
router.post('/', requirePermission('clients', 'create'), controller.create);
router.get('/:id/ledgers', requirePermission('clients', 'read'), controller.ledgers);
router.post('/:id/loyalty-adjustments', requirePermission('clients', 'update'), controller.adjustLoyalty);
router.post('/:id/marketing-message', requirePermission('clients', 'update'), controller.sendMarketingMessage);
router.get('/:id', requirePermission('clients', 'read'), controller.get);
router.put('/:id', requirePermission('clients', 'update'), controller.update);
router.post('/:id/deactivate', requirePermission('clients', 'update'), controller.deactivate);
router.post('/:id/merge', requirePermission('clients', 'update'), controller.merge);

module.exports = router;
