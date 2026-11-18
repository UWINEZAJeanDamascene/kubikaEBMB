const express = require('express');
const router = express.Router();
const {
  getProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  archiveProduct,
  restoreProduct,
  getProductHistory,
  getProductLifecycle,
  getLowStockProducts,
  checkLowStockAndNotify,
  analyzeReorder,
  triggerAutoReorder,
  registerProductWithEBM,
  registerAllProductsWithEBM,
  backfillProductWarehouses
} = require('../controllers/productController');
const { protect } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbacMiddleware');
const requireModule = require('../middleware/requireModule');
const logAction = require('../middleware/logAction');
const { cacheMiddleware, cacheInvalidationMiddleware } = require('../middleware/cacheMiddleware');

// All routes require authentication
router.use(protect);

router.route('/')
  .get(
    requirePermission('products', 'read'),
    cacheMiddleware({
      type: 'product',
      ttl: 120,
      skipCache: (req) => req.query.refresh === '1' || req.query.forPicker === '1',
    }),
    getProducts,
  )
  .post(requirePermission('products', 'create'), logAction('product'), createProduct);

router.get('/low-stock', requirePermission('products', 'read'), cacheMiddleware({ type: 'product', ttl: 120, skipCache: (req) => req.query.refresh === '1' }), getLowStockProducts);

// Check low stock and send notifications
router.post('/check-low-stock', requirePermission('products', 'read'), checkLowStockAndNotify);

router.route('/:id')
  .get(requirePermission('products', 'read'), cacheMiddleware({ type: 'product', ttl: 120, keyGenerator: (req) => cacheMiddlewareKey(req) }), getProduct)
  .put(requirePermission('products', 'update'), logAction('product'), updateProduct)
  .delete(requirePermission('products', 'delete'), logAction('product'), deleteProduct);

router.put('/:id/archive', requirePermission('products', 'delete'), logAction('product'), archiveProduct);
router.put('/:id/restore', requirePermission('products', 'update'), logAction('product'), restoreProduct);
router.post('/ebm/register-all', requireModule('fiscal.ebm', { allowSandboxWhenOff: true }), requirePermission('products', 'update'), logAction('product'), cacheInvalidationMiddleware({ type: 'product', invalidateAll: true }), registerAllProductsWithEBM);
router.post('/import/backfill-default-warehouses', requirePermission('products', 'update'), logAction('product'), cacheInvalidationMiddleware({ type: 'product', invalidateAll: true }), backfillProductWarehouses);
router.post('/:id/ebm/register', requireModule('fiscal.ebm', { allowSandboxWhenOff: true }), requirePermission('products', 'update'), logAction('product'), registerProductWithEBM);
router.get('/:id/reorder-analysis', requirePermission('products', 'read'), cacheMiddleware({ type: 'product', ttl: 180, keyGenerator: (req) => cacheMiddlewareKey(req) }), analyzeReorder);
router.post('/:id/auto-reorder', requirePermission('products', 'update'), logAction('product'), triggerAutoReorder);
router.get('/:id/history', requirePermission('products', 'read'), cacheMiddleware({ type: 'product', ttl: 300, keyGenerator: (req) => cacheMiddlewareKey(req) }), getProductHistory);
router.get('/:id/lifecycle', requirePermission('products', 'read'), cacheMiddleware({ type: 'product', ttl: 180, keyGenerator: (req) => cacheMiddlewareKey(req) }), getProductLifecycle);
// Barcode and QR code endpoints
router.get('/:id/barcode', requirePermission('products', 'read'), require('../controllers/productController').getProductBarcode);
router.get('/:id/qrcode', requirePermission('products', 'read'), require('../controllers/productController').getProductQRCode);

module.exports = router;

// Helper to generate cache key for single product routes
function cacheMiddlewareKey(req) {
  const params = { path: req.path, query: req.query, companyId: req.company?._id?.toString() || req.query.companyId };
  const cacheService = require('../services/cacheService');
  return cacheService.generateKey('product', params);
}
