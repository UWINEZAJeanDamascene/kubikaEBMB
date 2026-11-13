'use strict';

const { dbClient } = require('../lib/prisma');
const { writePosAuditLog, requestIp } = require('../services/posAuditService');
const { generateObjectId } = require('../utils/objectId');

const SAFE_RETRY_CODES = new Set([
  'POS_PAYMENT_V2_SEPARATE_PAYMENT_REQUIRED',
  'POS_OFFLINE_RECEIPT_NUMBER_INVALID',
]);
const ACTIONS = new Set(['AUTHORIZE_RETRY', 'SALE_POSTED', 'REFUND_ISSUED', 'STOCK_ADJUSTMENT_POSTED']);
const companyIdOf = (req) => {
  const company = req.user?.company;
  return String(req.user?.companyId || (typeof company === 'string' ? company : company?.id || company?._id) || '');
};
const userIdOf = (req) => String(req.user?.id || req.user?._id || '');
const json = (value) => value && typeof value === 'object' ? value : {};

function safePayload(payload) {
  const source = json(payload);
  const items = Array.isArray(source.items) ? source.items.slice(0, 100).map((item) => ({
    productId: String(item?.productId || item?.product || '').slice(0, 64) || null,
    name: String(item?.name || item?.productName || item?.description || '').slice(0, 120) || null,
    quantity: Number.isFinite(Number(item?.quantity)) ? Number(item.quantity) : null,
  })) : [];
  return {
    type: String(source.type || '').slice(0, 32) || null,
    displayTotal: Number.isFinite(Number(source.displayTotal)) ? Number(source.displayTotal) : null,
    offlineSaleId: String(source.offlineSaleId || '').slice(0, 100) || null,
    offlineReceiptNumber: String(source.offlineReceiptNumber || '').slice(0, 100) || null,
    customerName: String(source.customerName || '').slice(0, 120) || null,
    itemCount: Array.isArray(source.items) ? source.items.length : 0,
    items,
    itemsTruncated: Array.isArray(source.items) && source.items.length > items.length,
  };
}

exports.list = async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    if (!companyId) return res.status(403).json({ success: false, code: 'COMPANY_REQUIRED', message: 'Select a company to review POS exceptions.' });
    const status = String(req.query.status || 'open').toLowerCase();
    const type = String(req.query.type || '').toUpperCase();
    const registerId = String(req.query.registerId || '').trim();
    const search = String(req.query.search || '').trim().slice(0, 120);
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();
    const limit = Math.max(1, Math.min(200, Number.parseInt(req.query.limit, 10) || 100));
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const allowedStatuses = new Set(['open', 'retry_authorized', 'resolved', 'all']);
    if (!allowedStatuses.has(status)) return res.status(400).json({ success: false, code: 'POS_SYNC_EXCEPTION_FILTER_INVALID', message: 'Choose a valid exception status.' });

    const clauses = ['COALESCE(e.company_id, p.company_id) = $1', '(e.id IS NOT NULL OR p.operation_state <> \'synced\')'];
    const params = [companyId];
    const bind = (value) => { params.push(value); return `$${params.length}`; };
    if (status === 'open') {
      clauses.push(`COALESCE(e.status, CASE WHEN p.operation_state IN ('synced') THEN 'resolved' ELSE 'open' END) IN ('open', 'retry_authorized')`);
    } else if (status !== 'all') {
      const token = bind(status);
      clauses.push(`COALESCE(e.status, CASE WHEN p.operation_state IN ('synced') THEN 'resolved' ELSE 'open' END) = ${token}`);
    }
    if (type) {
      const token = bind(type);
      clauses.push(`UPPER(COALESCE(e.operation_payload->>'type', '')) = ${token}`);
    }
    if (registerId) {
      const token = bind(registerId);
      clauses.push(`(p.register_id = ${token} OR e.operation_payload->>'registerId' = ${token})`);
    }
    if (from && Number.isFinite(Date.parse(from))) clauses.push(`COALESCE(p.received_at, e.created_at) >= ${bind(new Date(from))}::timestamptz`);
    if (to && Number.isFinite(Date.parse(to))) clauses.push(`COALESCE(p.received_at, e.created_at) < (${bind(new Date(to))}::timestamptz + interval '1 day')`);
    if (search) {
      const token = bind(`%${search.replace(/[%_]/g, '\\$&')}%`);
      clauses.push(`(COALESCE(e.operation_id, p.operation_id) ILIKE ${token} OR COALESCE(e.error_code, p.error->>'code', '') ILIKE ${token} OR COALESCE(e.message, p.error->>'message', '') ILIKE ${token} OR COALESCE(r.name, r.code, '') ILIKE ${token} OR COALESCE(e.operation_payload->>'offlineReceiptNumber', '') ILIKE ${token} OR COALESCE(e.operation_payload->>'customerName', '') ILIKE ${token})`);
    }
    const totalRows = await dbClient().$queryRawUnsafe(`
      SELECT COUNT(*)::int AS total
      FROM pos_processed_operations p
      FULL OUTER JOIN pos_sync_exceptions e
        ON e.company_id = p.company_id AND e.device_id = p.device_id AND e.operation_id = p.operation_id
      LEFT JOIN pos_registers r ON r.id = p.register_id AND r.company_id = COALESCE(e.company_id, p.company_id)
      WHERE ${clauses.join(' AND ')}`,
    ...params);
    const total = Number(totalRows[0]?.total || 0);
    const limitToken = bind(limit);
    const offsetToken = bind((page - 1) * limit);
    const rows = await dbClient().$queryRawUnsafe(`
      SELECT
        COALESCE(e.id, p.id) AS id,
        (e.id IS NOT NULL) AS "hasException",
        COALESCE(e.company_id, p.company_id) AS "companyId",
        COALESCE(e.device_id, p.device_id) AS "deviceId",
        COALESCE(e.operation_id, p.operation_id) AS "operationId",
        p.register_id AS "registerId",
        COALESCE(r.name, r.code, e.operation_payload->>'registerId') AS "registerName",
        p.sequence::text AS sequence,
        p.operation_state AS "operationState",
        COALESCE(e.status, CASE WHEN p.operation_state = 'synced' THEN 'resolved' ELSE 'open' END) AS status,
        COALESCE(e.error_code, p.error->>'code') AS "errorCode",
        COALESCE(e.message, p.error->>'message') AS message,
        COALESCE(e.operation_payload, '{}'::jsonb) AS payload,
        p.result AS result,
        COALESCE(e.created_at, p.received_at) AS "createdAt",
        COALESCE(e.updated_at, p.received_at) AS "updatedAt",
        e.resolution AS resolution,
        e.resolution_reason AS "resolutionReason",
        e.resolution_reference_type AS "resolutionReferenceType",
        e.resolution_reference_id AS "resolutionReferenceId",
        e.resolved_by_id AS "resolvedById",
        e.resolved_at AS "resolvedAt",
        e.retry_authorized_by_id AS "retryAuthorizedById",
        e.retry_authorized_at AS "retryAuthorizedAt"
      FROM pos_processed_operations p
      FULL OUTER JOIN pos_sync_exceptions e
        ON e.company_id = p.company_id AND e.device_id = p.device_id AND e.operation_id = p.operation_id
      LEFT JOIN pos_registers r ON r.id = p.register_id AND r.company_id = COALESCE(e.company_id, p.company_id)
      WHERE ${clauses.join(' AND ')}
      ORDER BY COALESCE(e.created_at, p.received_at) DESC
      LIMIT ${limitToken} OFFSET ${offsetToken}`,
    ...params);
    res.status(200).json({ success: true, data: rows.map((row) => ({
      ...row,
      operationType: safePayload(row.payload).type,
      payload: safePayload(row.payload),
      result: row.result && typeof row.result === 'object' ? {
        invoiceId: row.result.invoiceId || row.result.saleId || null,
        invoiceNumber: row.result.invoiceNumber || row.result.referenceNo || null,
      } : null,
      retryAllowed: SAFE_RETRY_CODES.has(String(row.errorCode || '')) && row.status !== 'resolved',
    })), pagination: { page, pageSize: limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) { next(error); }
};

exports.resolve = async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    const userId = userIdOf(req);
    const exceptionId = String(req.params.exceptionId || '');
    const action = String(req.body?.action || '').toUpperCase();
    const reason = String(req.body?.reason || '').trim();
    const referenceId = String(req.body?.referenceId || '').trim();
    if (!companyId || !userId) return res.status(403).json({ success: false, code: 'POS_SYNC_EXCEPTION_AUTH_REQUIRED', message: 'A signed-in company manager is required.' });
    if (!ACTIONS.has(action) || reason.length < 10 || reason.length > 1000) return res.status(400).json({ success: false, code: 'POS_SYNC_EXCEPTION_RESOLUTION_INVALID', message: 'Choose a supported action and enter a reason of 10 to 1000 characters.' });
    if (action !== 'AUTHORIZE_RETRY' && !referenceId) return res.status(400).json({ success: false, code: 'POS_SYNC_EXCEPTION_REFERENCE_REQUIRED', message: 'Enter the ID of the completed sale, refund, or stock adjustment.' });

    const resolved = await dbClient().$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe(`SELECT id, company_id AS "companyId", device_id AS "deviceId", operation_id AS "operationId", error_code AS "errorCode", operation_payload AS payload, status, resolution FROM pos_sync_exceptions WHERE id = $1 AND company_id = $2 FOR UPDATE`, exceptionId, companyId);
      const exception = rows[0];
      if (!exception) throw Object.assign(new Error('POS sync exception was not found.'), { status: 404, code: 'POS_SYNC_EXCEPTION_NOT_FOUND' });
      if (exception.status === 'resolved') throw Object.assign(new Error('This exception has already been resolved.'), { status: 409, code: 'POS_SYNC_EXCEPTION_ALREADY_RESOLVED' });
      const payload = json(exception.payload);
      let referenceType = null;
      let linkedReferenceId = null;
      let result;

      if (action === 'AUTHORIZE_RETRY') {
        if (!SAFE_RETRY_CODES.has(exception.errorCode)) throw Object.assign(new Error('This operation cannot be safely retried. Resolve the underlying sale or payment issue first.'), { status: 409, code: 'POS_SYNC_EXCEPTION_RETRY_UNSAFE' });
        await tx.$executeRawUnsafe(`UPDATE pos_sync_exceptions SET status = 'retry_authorized', retry_authorized_by_id = $1, retry_authorized_at = CURRENT_TIMESTAMP, resolution = 'RETRY_AUTHORIZED', resolution_reason = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 AND company_id = $4`, userId, reason, exceptionId, companyId);
        await writePosAuditLog({ companyId, userId, event: 'POS_OFFLINE_EXCEPTION_RETRY_AUTHORIZED', metadata: { exceptionId, deviceId: exception.deviceId, operationId: exception.operationId, errorCode: exception.errorCode, reason, before: { status: exception.status }, after: { status: 'retry_authorized' } }, ip: requestIp(req) }, tx);
        return { exceptionId, status: 'retry_authorized', action };
      }

      const offlineSaleId = String(payload.offlineSaleId || exception.operationId);
      const offlineSales = await tx.$queryRawUnsafe(`SELECT id, invoice_id AS "invoiceId" FROM pos_offline_sales WHERE company_id = $1 AND offline_sale_id = $2 LIMIT 1`, companyId, offlineSaleId);
      const offlineSale = offlineSales[0];
      if (!offlineSale) throw Object.assign(new Error('No posted sale exists for this offline operation. Keep it open and resolve it from the till; it cannot be marked handled.'), { status: 409, code: 'POS_SYNC_EXCEPTION_SALE_NOT_FOUND' });

      if (action === 'SALE_POSTED') {
        if (referenceId !== offlineSale.invoiceId) throw Object.assign(new Error('The invoice ID does not match the sale recorded for this offline operation.'), { status: 409, code: 'POS_SYNC_EXCEPTION_REFERENCE_MISMATCH' });
        referenceType = 'invoice'; linkedReferenceId = offlineSale.invoiceId;
      } else if (action === 'REFUND_ISSUED') {
        const notes = await tx.creditNote.findMany({ where: { id: referenceId, companyId, invoiceId: offlineSale.invoiceId, status: 'issued' }, select: { id: true } });
        if (!notes.length) throw Object.assign(new Error('No issued credit note for this sale was found in this company.'), { status: 409, code: 'POS_SYNC_EXCEPTION_REFUND_NOT_FOUND' });
        referenceType = 'credit_note'; linkedReferenceId = referenceId;
      } else if (action === 'STOCK_ADJUSTMENT_POSTED') {
        const products = Array.isArray(payload.items) ? payload.items.map((item) => String(item?.productId || '')).filter(Boolean) : [];
        const movements = await tx.stockMovement.findMany({ where: { id: referenceId, companyId, productId: { in: products }, OR: [{ type: 'adjustment' }, { reason: { in: ['correction', 'audit_shortage', 'audit_surplus'] } }] }, select: { id: true } });
        if (!movements.length) throw Object.assign(new Error('No matching inventory adjustment for this sale was found in this company.'), { status: 409, code: 'POS_SYNC_EXCEPTION_ADJUSTMENT_NOT_FOUND' });
        referenceType = 'stock_movement'; linkedReferenceId = referenceId;
      }

      await tx.$executeRawUnsafe(`UPDATE pos_sync_exceptions SET status = 'resolved', resolution = $1, resolution_reason = $2, resolution_reference_type = $3, resolution_reference_id = $4, resolved_by_id = $5, resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $6 AND company_id = $7 AND status <> 'resolved'`, action, reason, referenceType, linkedReferenceId, userId, exceptionId, companyId);
      await writePosAuditLog({ companyId, userId, event: 'POS_OFFLINE_EXCEPTION_RESOLVED', metadata: { exceptionId, deviceId: exception.deviceId, operationId: exception.operationId, errorCode: exception.errorCode, action, reason, referenceType, referenceId: linkedReferenceId, before: { status: exception.status }, after: { status: 'resolved', resolution: action, referenceType, referenceId: linkedReferenceId } }, ip: requestIp(req) }, tx);
      result = { exceptionId, status: 'resolved', action, referenceType, referenceId: linkedReferenceId };
      return result;
    });
    res.status(200).json({ success: true, data: resolved });
  } catch (error) { next(error); }
};
