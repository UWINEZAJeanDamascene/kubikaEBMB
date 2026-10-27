const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { requirePermissionOrRoles } = require('../middleware/rbacMiddleware');
const stockBatchController = require('../controllers/stockBatchController');
const { cacheInvalidationMiddleware } = require('../middleware/cacheMiddleware');

// @route   GET /api/stock-batches
// @desc    Get all stock batches
// @access  Private
router.get('/', protect, requirePermissionOrRoles('stock', 'read', ['admin', 'stock_manager', 'warehouse_manager']), stockBatchController.getStockBatches);

// @route   GET /api/stock-batches/expiring
// @desc    Get expiring batches
// @access  Private
router.get('/expiring', protect, requirePermissionOrRoles('stock', 'read', ['admin', 'stock_manager', 'warehouse_manager']), stockBatchController.getExpiringBatches);

// @route   GET /api/stock-batches/:id
// @desc    Get single stock batch
// @access  Private
router.get('/:id', protect, requirePermissionOrRoles('stock', 'read', ['admin', 'stock_manager', 'warehouse_manager']), stockBatchController.getStockBatch);

// @route   POST /api/stock-batches
// @desc    Create a new stock batch
// @access  Private (admin, stock_manager)
router.post('/', protect, requirePermissionOrRoles('stock', 'create', ['admin', 'stock_manager', 'warehouse_manager']), stockBatchController.createStockBatch);

// @route   PUT /api/stock-batches/:id
// @desc    Update a stock batch
// @access  Private (admin, stock_manager)
router.put('/:id', protect, requirePermissionOrRoles('stock', 'update', ['admin', 'stock_manager', 'warehouse_manager']), stockBatchController.updateStockBatch);

// @route   PUT /api/stock-batches/:id/quarantine
// @desc    Quarantine/unquarantine a stock batch
// @access  Private (admin, stock_manager)
router.put(
  '/:id/quarantine',
  protect,
  requirePermissionOrRoles('stock', 'update', ['admin', 'stock_manager', 'warehouse_manager']),
  cacheInvalidationMiddleware({ types: ['product', 'stock', 'pos'] }),
  stockBatchController.quarantineStockBatch,
);

// @route   DELETE /api/stock-batches/:id
// @desc    Delete a stock batch
// @access  Private (admin, stock_manager)
router.delete('/:id', protect, requirePermissionOrRoles('stock', 'delete', ['admin', 'stock_manager']), stockBatchController.deleteStockBatch);

module.exports = router;
