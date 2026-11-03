'use strict';

/**
 * Transition map from the POS capability names used by the new route layout to
 * permissions already stored on Kubika roles and POS role matrices.
 *
 * Entries are deliberately one-way and narrowly scoped: an old grant may
 * satisfy its matching new capability during the route migration, while a new
 * capability never implies unrelated legacy permissions. Missing aliases
 * fail closed and can be granted explicitly once the role UI exposes them.
 */
const POS_PERMISSION_COMPATIBILITY = Object.freeze({
  'pos.till.enter': { rbac: [['point_of_sale', 'read']] },
  'pos.till.sell': { rbac: [['point_of_sale', 'create']], session: ['pos.payment.take'] },
  'pos.till.discount': {},
  'pos.till.refund': { session: ['pos.payment.refund'] },
  'pos.till.void': {},
  'pos.till.no_sale': { rbac: [['point_of_sale', 'open']] },
  'pos.till.cash_move': { session: ['pos.cash.in', 'pos.cash.out', 'pos.cash.safe_drop'] },
  'pos.till.reprint': { rbac: [['point_of_sale', 'read']], session: ['pos.receipt.reprint'] },
  'pos.till.share_receipt': { rbac: [['point_of_sale', 'read']], session: ['pos.receipt.share'] },
  'pos.till.credit_sell': { session: ['pos.credit.sell'] },
  'pos.till.receive_account_payment': { session: ['pos.credit.account_payment'] },
  'pos.till.close_shift': { session: ['pos.shift.close', 'pos.report.x'] },
  'pos.till.open_shift': { session: ['pos.shift.open'] },

  'pos.admin.view': { rbac: [['tills', 'read'], ['tills', 'create']] },
  'pos.admin.registers': { rbac: [['tills', 'create']] },
  'pos.admin.cashiers': { rbac: [['tills', 'create']] },
  'pos.admin.roles': { rbac: [['roles', 'update']] },
  'pos.admin.printers': { rbac: [['tills', 'create']] },
  'pos.admin.settings': { rbac: [['tills', 'create']] },
  // These capabilities have no equivalent ERP RBAC grant today. The existing
  // POS-session permissions are not interchangeable with ERP-user grants.
  'pos.admin.shifts': { rbac: [['tills', 'read']] },
  'pos.admin.approvals': { rbac: [['tills', 'read']] },
  'pos.admin.reports': { rbac: [['reports', 'read']] },
  'pos.admin.audit': { rbac: [['audit_trail', 'read']] },
});

function capabilityName(resource, action) {
  const normalizedResource = String(resource || '').trim().toLowerCase();
  const normalizedAction = String(action || '').trim().toLowerCase();
  if (!normalizedResource || !normalizedAction) return '';
  return `${normalizedResource}.${normalizedAction}`;
}

function getPosPermissionAliases(resource, action) {
  return POS_PERMISSION_COMPATIBILITY[capabilityName(resource, action)] || null;
}

function getPosSessionPermissionCandidates(permission) {
  const normalized = String(permission || '').trim();
  if (!normalized) return [];
  const aliases = POS_PERMISSION_COMPATIBILITY[normalized]?.session || [];
  const reverseAliases = Object.entries(POS_PERMISSION_COMPATIBILITY)
    .filter(([, entry]) => (entry.session || []).includes(normalized))
    .map(([canonical]) => canonical);
  return [...new Set([normalized, ...aliases, ...reverseAliases])];
}

module.exports = {
  POS_PERMISSION_COMPATIBILITY,
  capabilityName,
  getPosPermissionAliases,
  getPosSessionPermissionCandidates,
};
