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
const { requirePermissionOrRoles } = require('../middleware/rbacMiddleware');

// All routes require authentication
router.use(protect);

// Get backups list
router.get('/', requirePermissionOrRoles('settings', 'read', ['admin']), getBackups);

// Get backup statistics
router.get('/stats', requirePermissionOrRoles('settings', 'read', ['admin']), getBackupStats);

// Get available point-in-time recovery points
router.get('/points-in-time', requirePermissionOrRoles('settings', 'read', ['admin']), getPointsInTime);
router.get('/snapshots', requirePermissionOrRoles('settings', 'read', ['admin']), getSnapshots);

// Get backup settings
router.get('/settings', requirePermissionOrRoles('settings', 'read', ['admin']), getBackupSettings);

// Update backup settings
router.put('/settings', authorize('admin', 'superadmin'), updateBackupSettings);

// Get single backup
router.get('/:id', requirePermissionOrRoles('settings', 'read', ['admin']), getBackup);

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
