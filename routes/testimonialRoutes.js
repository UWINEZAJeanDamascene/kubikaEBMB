const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const {
  getTestimonials,
  getAllTestimonialsForAdmin,
  getTestimonial,
  createTestimonial,
  updateTestimonial,
  deleteTestimonial,
  toggleTestimonial,
  reorderTestimonials
} = require('../controllers/testimonialController');

// Public routes (for landing page)
router.get('/', getTestimonials);
router.get('/admin', protect, authorize('platform_admin'), getAllTestimonialsForAdmin);
router.get('/:id', getTestimonial);

// Protected routes (admin only - would need auth middleware for full protection)
router.post('/', protect, authorize('platform_admin'), createTestimonial);
router.put('/:id', protect, authorize('platform_admin'), updateTestimonial);
router.delete('/:id', protect, authorize('platform_admin'), deleteTestimonial);
router.patch('/:id/toggle', protect, authorize('platform_admin'), toggleTestimonial);
router.post('/reorder', protect, authorize('platform_admin'), reorderTestimonials);

module.exports = router;
