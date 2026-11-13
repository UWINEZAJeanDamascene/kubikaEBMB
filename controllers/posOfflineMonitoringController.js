'use strict';

const { dbClient } = require('../lib/prisma');
const { normalizeOfflinePolicy } = require('../services/posOfflinePolicyService');

const companyIdOf = (req) => {
  const company = req.user?.company;
  return String(req.user?.companyId || (typeof company === 'string' ? company : company?.id || company?._id) || '');
};

function parseDate(value, fallback) {
  if (!value) return fallback;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

exports.getReport = async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    if (!companyId) return res.status(403).json({ success: false, code: 'COMPANY_REQUIRED', message: 'Select a company to view offline POS monitoring.' });

    const to = parseDate(req.query.to, new Date());
    const from = parseDate(req.query.from, new Date((to || new Date()).getTime() - 30 * 24 * 60 * 60 * 1000));
    const registerId = String(req.query.registerId || '').trim();
    if (!from || !to || from > to || to.getTime() - from.getTime() > 366 * 24 * 60 * 60 * 1000) {
      return res.status(400).json({ success: false, code: 'POS_OFFLINE_REPORT_RANGE_INVALID', message: 'Choose a valid date range of no more than one year.' });
    }

    // Every query is tenant-scoped. Device storage numbers are browser estimates
    // reported by the paired device, not a measurement performed by the server.
    const [devices, sales, operations, receiptSummary, receiptGaps, settingRows] = await Promise.all([
      dbClient().$queryRawUnsafe(`
        SELECT d.device_id AS "deviceId", d.register_id AS "registerId",
          r.name AS "registerName", r.code AS "registerCode", d.status,
          d.queue_depth AS "queueDepth", d.last_sync_at AS "lastSyncAt",
          d.storage_usage_bytes::text AS "storageUsageBytes",
          d.storage_quota_bytes::text AS "storageQuotaBytes",
          d.storage_persistent AS "storagePersistent",
          d.storage_checked_at AS "storageCheckedAt"
        FROM pos_devices d
        JOIN pos_registers r ON r.id = d.register_id AND r.company_id = d.company_id
        WHERE d.company_id = $1 AND ($2 = '' OR d.register_id = $2)
        ORDER BY d.storage_checked_at DESC NULLS LAST, r.name, d.device_id`, companyId, registerId),
      dbClient().$queryRawUnsafe(`
        SELECT s.register_id AS "registerId", r.name AS "registerName", r.code AS "registerCode",
          COUNT(*)::int AS "offlineSalesCount", COALESCE(SUM(s.total), 0)::text AS "offlineSalesTotal",
          ROUND(AVG(GREATEST(0, EXTRACT(EPOCH FROM (s.synced_at - s.reported_sale_at))))::numeric, 1)::text AS "averageSyncLagSeconds",
          ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY GREATEST(0, EXTRACT(EPOCH FROM (s.synced_at - s.reported_sale_at))))::numeric, 1)::text AS "p95SyncLagSeconds",
          MAX(s.synced_at) AS "lastOfflineSyncAt"
        FROM pos_offline_sales s
        JOIN pos_registers r ON r.id = s.register_id AND r.company_id = s.company_id
        WHERE s.company_id = $1 AND s.reported_sale_at >= $2 AND s.reported_sale_at < ($3 + interval '1 day')
          AND ($4 = '' OR s.register_id = $4)
        GROUP BY s.register_id, r.name, r.code ORDER BY COUNT(*) DESC`, companyId, from, to, registerId),
      dbClient().$queryRawUnsafe(`
        SELECT operation_state AS status, COUNT(*)::int AS count
        FROM pos_processed_operations
        WHERE company_id = $1 AND received_at >= $2 AND received_at < ($3 + interval '1 day')
          AND ($4 = '' OR register_id = $4)
        GROUP BY operation_state ORDER BY operation_state`, companyId, from, to, registerId),
      dbClient().$queryRawUnsafe(`
        SELECT COUNT(*) FILTER (WHERE used_at IS NULL AND retired_at IS NULL AND expires_at < CURRENT_TIMESTAMP)::int AS "expiredUnusedCount",
          COUNT(*) FILTER (WHERE used_at IS NULL AND retired_at IS NULL AND expires_at >= CURRENT_TIMESTAMP)::int AS "reservedUnusedCount",
          COUNT(*) FILTER (WHERE used_at IS NULL AND retired_at IS NOT NULL)::int AS "retiredUnusedCount",
          COUNT(*) FILTER (WHERE used_at IS NOT NULL)::int AS "usedCount"
        FROM pos_receipt_number_allocations
        WHERE company_id = $1 AND created_at >= $2 AND created_at < ($3 + interval '1 day')
          AND ($4 = '' OR register_id = $4)`, companyId, from, to, registerId),
      dbClient().$queryRawUnsafe(`
        WITH blocks AS (
          SELECT device_id, register_id, block_id, MIN(block_index) AS first_index,
            MAX(block_index) AS last_index, COUNT(*)::int AS allocated_count,
            COUNT(*) FILTER (WHERE used_at IS NULL AND retired_at IS NULL AND expires_at < CURRENT_TIMESTAMP)::int AS expired_unused_count,
            COUNT(*) FILTER (WHERE used_at IS NULL AND retired_at IS NOT NULL)::int AS retired_unused_count,
            MIN(retirement_reason) FILTER (WHERE retired_at IS NOT NULL) AS retirement_reason
          FROM pos_receipt_number_allocations
          WHERE company_id = $1 AND created_at >= $2 AND created_at < ($3 + interval '1 day')
            AND ($4 = '' OR register_id = $4)
          GROUP BY device_id, register_id, block_id
        )
        SELECT b.device_id AS "deviceId", b.register_id AS "registerId", r.name AS "registerName",
          r.code AS "registerCode", b.block_id AS "blockId", b.first_index AS "firstIndex",
          b.last_index AS "lastIndex", b.allocated_count AS "allocatedCount",
          GREATEST(0, b.last_index - b.first_index + 1 - b.allocated_count)::int AS "missingIndexCount",
          b.expired_unused_count AS "expiredUnusedCount", b.retired_unused_count AS "retiredUnusedCount",
          b.retirement_reason AS "retirementReason"
        FROM blocks b JOIN pos_registers r ON r.id = b.register_id AND r.company_id = $1
        WHERE b.last_index - b.first_index + 1 <> b.allocated_count OR b.expired_unused_count > 0 OR b.retired_unused_count > 0
        ORDER BY b.expired_unused_count DESC, b.device_id LIMIT 500`, companyId, from, to, registerId),
      dbClient().$queryRawUnsafe(`
        SELECT pos_offline_enabled AS enabled, pos_offline_max_hours AS "maxHours",
          pos_offline_max_sales AS "maxSales", pos_offline_queue_limit AS "maxTotalValueRwf",
          pos_offline_max_single_sale AS "maxSingleSaleRwf", pos_offline_policy AS policy
        FROM system_settings WHERE company_id = $1 LIMIT 1`, companyId),
    ]);
    const setting = settingRows[0] || {};
    const policy = normalizeOfflinePolicy(setting.policy, setting);

    res.json({ success: true, data: {
      generatedAt: new Date().toISOString(), from: from.toISOString(), to: to.toISOString(), registerId: registerId || null,
      devices: devices.map((row) => ({ ...row, queueDepth: Number(row.queueDepth || 0), storageUsageBytes: row.storageUsageBytes || null, storageQuotaBytes: row.storageQuotaBytes || null,
        storageUsagePercent: row.storageUsageBytes && Number(row.storageQuotaBytes) > 0 ? Math.min(100, Math.round(Number(row.storageUsageBytes) / Number(row.storageQuotaBytes) * 100)) : null })),
      offlinePolicy: policy,
      offlineSales: sales,
      operationStates: operations,
      receiptAllocations: receiptSummary[0] || { expiredUnusedCount: 0, reservedUnusedCount: 0, retiredUnusedCount: 0, usedCount: 0 },
      receiptGaps,
    } });
  } catch (error) { next(error); }
};
