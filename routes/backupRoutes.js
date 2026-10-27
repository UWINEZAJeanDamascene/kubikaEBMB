const express = require('express');
const router = express.Router();
const {
  getBackups,
  getBackup,
  createBackup,
  restoreBackup,
  verifyBackup,
  deleteBackup,
  getPointsInTime,
  getSnapshots,
  getBackupSettings,
  updateBackupSettings,
  downloadBackup,
  getBackupStats
} = require('../controllers/backupController');
const { protect, authorize } = require('../middleware/auth');

// All routes require authentication
router.use(protect);

// Get backups list
router.get('/', getBackups);

// Get backup statistics
router.get('/stats', getBackupStats);

// Get available point-in-time recovery points
router.get('/points-in-time', getPointsInTime);
router.get('/snapshots', getSnapshots);

// Get backup settings
router.get('/settings', getBackupSettings);

// Update backup settings
router.put('/settings', authorize('admin', 'superadmin'), updateBackupSettings);

// Get single backup
router.get('/:id', getBackup);

// Create new backup
router.post('/', authorize('admin', 'superadmin'), createBackup);

// Restore from backup
router.post('/:id/restore', authorize('admin', 'superadmin'), restoreBackup);

// Verify backup
router.post('/:id/verify', authorize('admin', 'superadmin'), verifyBackup);

// Download backup file
router.get('/:id/download', authorize('admin', 'superadmin'), downloadBackup);

// Delete backup
router.delete('/:id', authorize('admin', 'superadmin'), deleteBackup);

module.exports = router;
