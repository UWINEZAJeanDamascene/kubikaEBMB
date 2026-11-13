'use strict';

const { randomBytes } = require('crypto');
const {
  evaluateOfflineActionCap,
  defaultOfflineActionCaps,
  normalizeOfflineActionCaps,
  resolveOfflineActionCap,
} = require('./posOfflineActionCapsService');

async function reserveOfflineActionUsage({
  tx,
  companyId,
  snapshotId,
  operationId,
  deviceId,
  registerId,
  action,
  managerApproved = false,
  amount,
  occurredAt,
}) {
  const usageAction = managerApproved ? `manager_${action}` : action;
  const snapshots = await tx.$queryRawUnsafe(
    `SELECT register.id AS "resolvedRegisterId",
            register.system_till_type AS "tillType",
            settings.pos_offline_action_caps AS "actionCaps",
            snapshot.snapshot_data AS "snapshotData"
       FROM pos_offline_snapshots snapshot
       JOIN pos_registers register
         ON register.company_id = snapshot.company_id
        AND register.code = snapshot.register_id
       LEFT JOIN system_settings settings ON settings.company_id = snapshot.company_id
      WHERE snapshot.id = $1 AND snapshot.company_id = $2
        AND snapshot.device_id = $3 AND snapshot.register_id = $4
      FOR UPDATE OF snapshot`,
    snapshotId,
    companyId,
    deviceId,
    registerId,
  );
  const snapshot = snapshots[0];
  if (!snapshot) {
    throw Object.assign(new Error('The signed offline policy snapshot is unavailable for this device and register.'), {
      code: 'POS_OFFLINE_SNAPSHOT_UNAVAILABLE',
      statusCode: 403,
    });
  }
  const policyAction = action.startsWith('manager_') ? action.slice('manager_'.length) : action;
  const actionKey = policyAction === 'card' ? 'manual_card'
    : policyAction === 'mobile_money' ? 'manual_mobile_money'
      : policyAction === 'paid_in' ? 'cash_paid_in'
        : policyAction === 'paid_out' ? 'cash_paid_out' : null;
  if (actionKey && snapshot.snapshotData?.offlinePolicy?.actions?.[actionKey] !== true) {
    throw Object.assign(new Error(`Offline ${action.replaceAll('_', ' ')} is disabled for this register.`), {
      code: 'POS_OFFLINE_ACTION_BLOCKED', statusCode: 409,
    });
  }
  const prior = await tx.$queryRawUnsafe(
    `SELECT id,
            device_id AS "deviceId",
            register_id AS "registerId",
            amount::text AS amount,
            occurred_at AS "occurredAt"
       FROM pos_offline_action_usage
      WHERE company_id = $1 AND snapshot_id = $2 AND operation_id = $3 AND action = $4
      LIMIT 1`,
    companyId,
    snapshotId,
    operationId,
    usageAction,
  );
  if (prior.length) {
    const existing = prior[0];
    const existingTime = new Date(existing.occurredAt).getTime();
    const requestedTime = new Date(occurredAt).getTime();
    const conflictFields = [];
    if (Number(existing.amount) !== Number(amount)) conflictFields.push('amount');
    if (String(existing.deviceId) !== String(deviceId)) conflictFields.push('deviceId');
    if (String(existing.registerId) !== String(snapshot.resolvedRegisterId)) conflictFields.push('registerId');
    if (!Number.isFinite(existingTime) || existingTime !== requestedTime) conflictFields.push('occurredAt');
    if (conflictFields.length) {
      const error = new Error(
        'This operation already has an offline cap reservation with different amount or details; the operation requires review.',
      );
      error.code = 'POS_OFFLINE_ACTION_USAGE_IDEMPOTENCY_CONFLICT';
      error.statusCode = 409;
      error.auditDetails = {
        snapshotId,
        operationId,
        deviceId,
        action,
        usageAction,
        conflictFields,
        existingAmount: String(existing.amount),
        requestedAmount: String(amount),
        existingDeviceId: String(existing.deviceId),
        existingRegisterId: String(existing.registerId),
        requestedRegisterId: String(snapshot.resolvedRegisterId),
        existingOccurredAt: Number.isFinite(existingTime)
          ? new Date(existingTime).toISOString()
          : String(existing.occurredAt),
        requestedOccurredAt: Number.isFinite(requestedTime)
          ? new Date(requestedTime).toISOString()
          : String(occurredAt),
      };
      throw error;
    }
    return { reserved: true, replayed: true };
  }

  const usageRows = await tx.$queryRawUnsafe(
    `SELECT COALESCE(SUM(amount), 0)::text AS total, COUNT(*)::int AS count
       FROM pos_offline_action_usage
      WHERE company_id = $1 AND snapshot_id = $2 AND action = $3`,
    companyId,
    snapshotId,
    usageAction,
  );
  const usage = usageRows[0] || {};
  const config = snapshot.actionCaps
    ? normalizeOfflineActionCaps(snapshot.actionCaps)
    : defaultOfflineActionCaps();
  if (managerApproved && !config.offlineManagerApproval.enabled) {
    throw Object.assign(new Error('Offline manager approval is disabled for this company.'), {
      code: 'POS_OFFLINE_MANAGER_APPROVAL_DISABLED',
      statusCode: 409,
    });
  }
  const cap = resolveOfflineActionCap(config, {
    action: usageAction,
    registerId: String(snapshot.resolvedRegisterId),
    tillType: String(snapshot.tillType || ''),
  });
  const result = evaluateOfflineActionCap({
    action,
    amount,
    currentTotal: Number(usage.total) || 0,
    currentCount: Number(usage.count) || 0,
    cap,
  });
  if (!result.allowed) {
    throw Object.assign(new Error(result.message), {
      code: result.code,
      statusCode: 409,
      details: { action: result.action, cap: result.cap, limit: result.limit, current: result.current },
    });
  }

  await tx.$executeRawUnsafe(
    `INSERT INTO pos_offline_action_usage
      (id, company_id, snapshot_id, operation_id, device_id, register_id, action, amount, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9::timestamptz)
     ON CONFLICT (company_id, snapshot_id, operation_id, action) DO NOTHING`,
    randomBytes(12).toString('hex'),
    companyId,
    snapshotId,
    operationId,
    deviceId,
    snapshot.resolvedRegisterId,
    usageAction,
    amount,
    occurredAt,
  );
  return { reserved: true, replayed: false };
}

async function releaseOfflineActionUsage({
  tx,
  companyId,
  snapshotId,
  operationId,
  action,
}) {
  await tx.$executeRawUnsafe(
    `DELETE FROM pos_offline_action_usage
      WHERE company_id = $1 AND snapshot_id = $2 AND operation_id = $3 AND action = $4`,
    companyId,
    snapshotId,
    operationId,
    action,
  );
}

async function reserveOfflineSaleUsage({ tx, companyId, snapshotId, operationId, deviceId, registerId, amount, occurredAt }) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT snapshot_data AS "snapshotData" FROM pos_offline_snapshots
      WHERE id = $1 AND company_id = $2 AND device_id = $3 AND register_id = $4
      FOR UPDATE`, snapshotId, companyId, deviceId, registerId,
  );
  const policy = rows[0]?.snapshotData?.offlinePolicy;
  const value = Number(amount);
  if (!policy || !Number.isSafeInteger(value) || value <= 0) {
    throw Object.assign(new Error('The offline sale amount or policy could not be verified.'), { code: 'POS_OFFLINE_POLICY_INVALID', statusCode: 409 });
  }
  if (policy.enabled !== true || policy.actions?.cash_sales !== true) {
    throw Object.assign(new Error('Offline sales are disabled for this register.'), { code: 'POS_OFFLINE_ACTION_BLOCKED', statusCode: 409 });
  }
  const prior = await tx.$queryRawUnsafe(
    `SELECT amount::text AS amount, device_id AS "deviceId", register_id AS "registerId", occurred_at AS "occurredAt"
       FROM pos_offline_action_usage WHERE company_id = $1 AND snapshot_id = $2 AND operation_id = $3 AND action = 'sale' LIMIT 1`,
    companyId, snapshotId, operationId,
  );
  if (prior.length) {
    const old = prior[0];
    if (Number(old.amount) !== value || String(old.deviceId) !== String(deviceId)
      || String(old.registerId) !== String(registerId)
      || new Date(old.occurredAt).getTime() !== new Date(occurredAt).getTime()) {
      throw Object.assign(new Error('This offline sale already reserved different limit details and needs review.'), { code: 'POS_OFFLINE_ACTION_USAGE_IDEMPOTENCY_CONFLICT', statusCode: 409 });
    }
    return { reserved: true, replayed: true };
  }
  const usageRows = await tx.$queryRawUnsafe(
    `SELECT COALESCE(SUM(amount), 0)::text AS total, COUNT(*)::int AS count
       FROM pos_offline_action_usage WHERE company_id = $1 AND snapshot_id = $2 AND action = 'sale'`,
    companyId, snapshotId,
  );
  const used = usageRows[0] || {};
  const total = Number(used.total) || 0;
  const count = Number(used.count) || 0;
  const singleLimit = Number(policy.maxSingleSaleRwf);
  const salesLimit = Number(policy.maxSales);
  const totalLimit = Number(policy.maxTotalValueRwf);
  if (![singleLimit, salesLimit, totalLimit].every(Number.isSafeInteger) || singleLimit < 1 || salesLimit < 1 || totalLimit < 1) {
    throw Object.assign(new Error('The signed offline sale limits are invalid.'), { code: 'POS_OFFLINE_POLICY_INVALID', statusCode: 409 });
  }
  if (value > singleLimit) throw Object.assign(new Error(`This sale exceeds the offline single-sale limit of RWF ${singleLimit}.`), { code: 'POS_OFFLINE_SINGLE_SALE_LIMIT', statusCode: 409 });
  if (count + 1 > salesLimit) throw Object.assign(new Error(`This register has reached its ${salesLimit}-sale offline limit.`), { code: 'POS_OFFLINE_SALES_LIMIT', statusCode: 409 });
  if (total + value > totalLimit) throw Object.assign(new Error(`This register has reached its offline total-value limit of RWF ${totalLimit}.`), { code: 'POS_OFFLINE_VALUE_LIMIT', statusCode: 409 });
  await tx.$executeRawUnsafe(
    `INSERT INTO pos_offline_action_usage (id, company_id, snapshot_id, operation_id, device_id, register_id, action, amount, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'sale', $7::numeric, $8::timestamptz)
     ON CONFLICT (company_id, snapshot_id, operation_id, action) DO NOTHING`,
    randomBytes(12).toString('hex'), companyId, snapshotId, operationId, deviceId, registerId, value, occurredAt,
  );
  return { reserved: true, replayed: false };
}

module.exports = { reserveOfflineActionUsage, releaseOfflineActionUsage, reserveOfflineSaleUsage };
