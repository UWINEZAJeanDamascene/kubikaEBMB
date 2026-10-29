const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const ipWhitelist = require('../middleware/ipWhitelist');
const { 
  createRole, 
  getRoles, 
  getRoleById,
  getPermissionCatalog,
  getRolePermissions,
  updateRole, 
  updateRolePermissionOverride,
  deleteRolePermissionOverride,
  deleteRole 
} = require('../controllers/roleController');
const { 
  setup2FA, verify2FA, disable2FA,
  getSecurityOverview, getLoginHistory, getActiveSessions,
  terminateAllSessions, terminateSession, getPasswordStatus, getLockStatus
} = require('../controllers/securityController');
const IPWhitelist = require('../models/IPWhitelist');
const { prisma } = require('../lib/prisma');
const { toIdString } = require('../utils/objectId');

function ipWhitelistScope(req) {
  if (req.isPlatformAdmin || req.user?.role === 'platform_admin') return { platformWide: true };
  const companyId = req.company?._id || req.company?.id || req.user?.companyId || req.user?.company;
  return companyId ? { companyId: toIdString(companyId) } : null;
}

// All routes require authentication
router.use(protect);

// 2FA endpoints available to authenticated users - place BEFORE IP whitelist so users can set up 2FA
router.post('/2fa/setup', setup2FA);
router.post('/2fa/verify', verify2FA);
router.post('/2fa/disable', disable2FA);

// Security overview & user security endpoints - before IP whitelist
router.get('/security-overview', getSecurityOverview);
router.get('/login-history', getLoginHistory);
router.get('/active-sessions', getActiveSessions);
router.delete('/active-sessions/:sessionId', terminateSession);
router.post('/terminate-sessions', terminateAllSessions);
router.get('/password-status', getPasswordStatus);
router.get('/lock-status', getLockStatus);

// IP whitelist should be enforced for admin-only routes
router.use(ipWhitelist);

/**
 * Role management endpoints
 * 
 * GET    /api/roles              - List system roles + company custom roles
 * POST   /api/roles              - Create custom role for company (admin only)
 * GET    /api/roles/:id          - Get a specific role
 * PUT    /api/roles/:id          - Update custom role (cannot modify system roles)
 * DELETE /api/roles/:id          - Delete custom role (cannot delete system roles)
 * GET    /api/roles/:id/permissions - Get all permissions for a role
 */
router.get('/roles', authorize('platform_admin', 'admin'), getRoles);
router.post('/roles', authorize('platform_admin', 'admin'), createRole);
router.get('/roles/permission-catalog', authorize('platform_admin', 'admin'), getPermissionCatalog);
router.get('/roles/:id', authorize('platform_admin', 'admin'), getRoleById);
router.get('/roles/:id/permissions', authorize('platform_admin', 'admin'), getRolePermissions);
router.put('/roles/:id/override', authorize('platform_admin', 'admin'), updateRolePermissionOverride);
router.delete('/roles/:id/override', authorize('platform_admin', 'admin'), deleteRolePermissionOverride);
router.put('/roles/:id', authorize('platform_admin', 'admin'), updateRole);
router.delete('/roles/:id', authorize('platform_admin', 'admin'), deleteRole);

// IP Whitelist management - admin/platform_admin only
router.get('/ip-whitelist', authorize('platform_admin', 'admin'), async (req, res) => {
  try {
    const scope = ipWhitelistScope(req);
    if (!scope) return res.status(403).json({ success: false, message: 'Company context is required' });
    const query = scope.platformWide ? {} : { company: scope.companyId };
    const entries = await IPWhitelist.find(query);
    res.json({ success: true, data: entries });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch IP whitelist' });
  }
});

router.post('/ip-whitelist', authorize('platform_admin', 'admin'), async (req, res) => {
  try {
    const scope = ipWhitelistScope(req);
    if (!scope) return res.status(403).json({ success: false, message: 'Company context is required' });
    const { ip, description, enabled = true } = req.body;
    const company = scope.platformWide ? null : scope.companyId;
    const entry = await IPWhitelist.create({ ip, description, company, enabled });
    res.status(201).json({ success: true, data: entry });
  } catch (err) {
    if (err && err.code === 'P2002') {
      return res.status(409).json({ success: false, message: 'This IP address is already whitelisted' });
    }
    res.status(500).json({ success: false, message: 'Failed to create IP whitelist entry' });
  }
});

router.put('/ip-whitelist/:id', authorize('platform_admin', 'admin'), async (req, res) => {
  try {
    const scope = ipWhitelistScope(req);
    if (!scope) return res.status(403).json({ success: false, message: 'Company context is required' });
    const data = {};
    if (Object.prototype.hasOwnProperty.call(req.body, 'ip')) data.ip = String(req.body.ip || '').trim();
    if (Object.prototype.hasOwnProperty.call(req.body, 'description')) data.description = req.body.description == null ? null : String(req.body.description).trim();
    if (Object.prototype.hasOwnProperty.call(req.body, 'enabled')) data.enabled = req.body.enabled === true || req.body.enabled === 'true';
    if (!Object.keys(data).length) return res.status(400).json({ success: false, message: 'Provide an IP, description, or enabled value to update' });
    const where = { id: String(req.params.id), ...(scope.platformWide ? {} : { companyId: scope.companyId }) };
    const updated = await prisma.ipWhitelist.updateMany({ where, data });
    if (!updated.count) return res.status(404).json({ success: false, message: 'Entry not found' });
    const entry = await IPWhitelist.findOne({ _id: req.params.id, ...(scope.platformWide ? {} : { company: scope.companyId }) });
    if (!entry) return res.status(404).json({ success: false, message: 'Entry not found' });
    res.json({ success: true, data: entry });
  } catch (err) {
    if (err && err.code === 'P2002') return res.status(409).json({ success: false, message: 'This IP address is already whitelisted' });
    res.status(500).json({ success: false, message: 'Failed to update IP whitelist entry' });
  }
});

router.delete('/ip-whitelist/:id', authorize('platform_admin', 'admin'), async (req, res) => {
  try {
    const scope = ipWhitelistScope(req);
    if (!scope) return res.status(403).json({ success: false, message: 'Company context is required' });
    const where = { id: String(req.params.id), ...(scope.platformWide ? {} : { companyId: scope.companyId }) };
    const deleted = await prisma.ipWhitelist.deleteMany({ where });
    if (!deleted.count) return res.status(404).json({ success: false, message: 'Entry not found' });
    res.json({ success: true, message: 'Entry deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to delete IP whitelist entry' });
  }
});

module.exports = router;
