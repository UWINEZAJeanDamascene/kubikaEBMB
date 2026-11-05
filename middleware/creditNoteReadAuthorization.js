'use strict';

const { PermissionService, resolveUserRoles } = require('./authorize');

async function authorizeCreditNoteRead(req, res, next) {
  try {
    const roles = await resolveUserRoles(req.user);
    if (roles.some((role) => PermissionService.check(role, 'credit_notes', 'read'))) {
      return next();
    }

    if (roles.some((role) => PermissionService.check(role, 'pos.till', 'sell'))) {
      req.creditNotePosScoped = true;
      return next();
    }

    return res.status(403).json({
      success: false,
      error: 'FORBIDDEN',
      message: 'Your assigned roles do not allow this action.',
      requiredPermissions: [{ resource: 'credit_notes', action: 'read' }],
    });
  } catch (error) {
    console.error('Credit-note read authorization error:', error);
    return res.status(500).json({
      success: false,
      error: 'AUTHORIZATION_ERROR',
      message: 'Could not verify credit-note read permissions.',
    });
  }
}

authorizeCreditNoteRead.rbacPermissionGuard = true;

module.exports = { authorizeCreditNoteRead };
