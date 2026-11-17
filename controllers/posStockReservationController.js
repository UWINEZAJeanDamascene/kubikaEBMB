'use strict';

const { randomBytes } = require('crypto');
const { dbClient } = require('../lib/prisma');
const { normalizeWholesaleConfig } = require('../utils/posWholesalePricing');
const { writePosAuditLog } = require('../services/posAuditService');

const objectId = (value) => /^[0-9a-f]{24}$/i.test(String(value || ''));
const number = (value) => Number(value || 0);
const context = (req) => ({
  companyId: String(req.posAuthContext?.session?.companyId || ''),
  registerId: String(req.posAuthContext?.register?.id || req.posAuthContext?.session?.registerId || ''),
  cashierId: String(req.posAuthContext?.session?.userId || ''),
});

async function reserveLines(tx, { companyId, warehouseId, lines }) {
  const reserved = [];
  const backorder = [];
  for (const line of lines) {
    const requested = number(line.remainingBaseQuantity ?? line.baseQuantity);
    if (requested <= 0) continue;
    const rows = await tx.$queryRawUnsafe(
      `WITH quarantine AS (
         SELECT COALESCE(SUM(sb.qty_on_hand), 0) AS qty FROM stock_batches sb
         WHERE sb.company_id = $1 AND sb.product_id = $2 AND sb.warehouse_id = $3 AND sb.is_quarantined = TRUE AND sb.qty_on_hand > 0
       )
       UPDATE stock_levels sl
       SET qty_reserved = sl.qty_reserved + LEAST($4::numeric, GREATEST(0, sl.qty_on_hand - sl.qty_reserved - quarantine.qty)), updated_at = CURRENT_TIMESTAMP
       FROM quarantine
       WHERE sl.company_id = $1 AND sl.product_id = $2 AND sl.warehouse_id = $3
         AND sl.qty_on_hand - sl.qty_reserved - quarantine.qty > 0
       RETURNING LEAST($4::numeric, GREATEST(0, sl.qty_on_hand - (sl.qty_reserved - LEAST($4::numeric, GREATEST(0, sl.qty_on_hand - sl.qty_reserved - quarantine.qty))) - quarantine.qty)) AS "reservedNow"`,
      companyId, line.productId, warehouseId, requested,
    );
    const quantity = number(rows[0]?.reservedNow);
    const totalReserved = number(line.reservedQuantity) + quantity;
    if (quantity > 0) reserved.push({ ...line, reservedQuantity: totalReserved, allocatedQuantity: quantity, remainingBaseQuantity: requested - quantity });
    if (requested - quantity > 0.00005) backorder.push({ ...line, reservedQuantity: totalReserved, remainingBaseQuantity: requested - quantity });
  }
  return { reserved, backorder };
}

async function adjustProductReserved(tx, companyId, productId, quantity, direction) {
  if (number(quantity) <= 0) return;
  const sql = direction > 0
    ? 'UPDATE products SET reserved_quantity=reserved_quantity+$1::numeric, updated_at=CURRENT_TIMESTAMP WHERE company_id=$2 AND id=$3'
    : 'UPDATE products SET reserved_quantity=reserved_quantity-$1::numeric, updated_at=CURRENT_TIMESTAMP WHERE company_id=$2 AND id=$3 AND reserved_quantity >= $1::numeric';
  const changed = await tx.$executeRawUnsafe(sql, number(quantity), companyId, productId);
  if (changed !== 1) throw Object.assign(new Error('The product reservation total changed. Refresh inventory and retry.'), { statusCode: 409, code: 'POS_RESERVATION_PRODUCT_STOCK_CHANGED' });
}

exports.create = async (req, res, next) => {
  const { companyId, registerId, cashierId } = context(req);
  try {
    const warehouseId = String(req.body?.warehouseId || '');
    const clientId = String(req.body?.clientId || '');
    const inputItems = req.body?.items;
    if (!companyId || !registerId || !cashierId || !objectId(warehouseId) || !objectId(clientId)
      || !Array.isArray(inputItems) || inputItems.length < 1 || inputItems.length > 100) {
      return res.status(400).json({ success: false, code: 'POS_RESERVATION_INPUT_INVALID', message: 'Choose a named customer, store, and one to 100 sale lines.' });
    }
    const id = randomBytes(12).toString('hex');
    const referenceNo = `RSV-${Date.now().toString(36).toUpperCase()}-${id.slice(-6).toUpperCase()}`;
    const result = await dbClient().$transaction(async (tx) => {
      const [warehouse, client, shift] = await Promise.all([
        tx.warehouse.findFirst({ where: { id: warehouseId, companyId, isActive: true }, select: { id: true, name: true } }),
        tx.client.findFirst({ where: { id: clientId, companyId, isActive: true }, select: { id: true, name: true, code: true, phoneNormalized: true } }),
        tx.posShift.findFirst({ where: { companyId, registerId, status: 'open' }, orderBy: { openedAt: 'desc' }, select: { id: true } }),
      ]);
      if (!warehouse) throw Object.assign(new Error('The selected store is unavailable.'), { statusCode: 404, code: 'POS_RESERVATION_WAREHOUSE_NOT_FOUND' });
      if (!client) throw Object.assign(new Error('Select an active, named wholesale customer.'), { statusCode: 422, code: 'POS_RESERVATION_CUSTOMER_REQUIRED' });
      if (!shift) throw Object.assign(new Error('Open a register shift before reserving wholesale stock.'), { statusCode: 409, code: 'POS_SHIFT_REQUIRED' });
      const productIds = [...new Set(inputItems.map((item) => String(item?.productId || '')))];
      if (productIds.some((productId) => !objectId(productId))) throw Object.assign(new Error('One or more products are invalid.'), { statusCode: 400, code: 'POS_RESERVATION_PRODUCT_INVALID' });
      const products = await tx.product.findMany({ where: { id: { in: productIds }, companyId, isActive: true }, select: { id: true, name: true, sku: true, unit: true, isStockable: true, customFields: true, trackingType: true } });
      const productMap = new Map(products.map((product) => [String(product.id), product]));
      if (products.length !== productIds.length) throw Object.assign(new Error('A product is unavailable. Refresh the till and try again.'), { statusCode: 409, code: 'POS_RESERVATION_PRODUCT_UNAVAILABLE' });
      const normalized = [];
      for (const item of inputItems) {
        const product = productMap.get(String(item.productId));
        const quantity = Number(item.quantity);
        if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1000000) throw Object.assign(new Error(`Enter a valid quantity for ${product.name}.`), { statusCode: 422, code: 'POS_RESERVATION_QUANTITY_INVALID' });
        const unitCode = String(item.salesUnitCode || '').trim().toLowerCase();
        const unit = unitCode ? normalizeWholesaleConfig(product).units.find((entry) => entry.code === unitCode) : null;
        if (unitCode && !unit) throw Object.assign(new Error(`${product.name} selling unit changed. Refresh the till.`), { statusCode: 409, code: 'POS_WHOLESALE_UNIT_CHANGED' });
        const multiplier = unit?.baseQuantity || 1;
        const baseQuantity = quantity * multiplier;
      normalized.push({ lineId: String(normalized.length), productId: product.id, productName: product.name, sku: product.sku, quantity, salesUnitCode: unit?.code || null, salesUnitLabel: unit?.label || product.unit, baseUnitsPerSale: multiplier, baseUnit: product.unit, baseQuantity, reservedQuantity: 0, remainingBaseQuantity: baseQuantity });
      }
      const stockLines = normalized.filter((line) => productMap.get(line.productId).isStockable !== false);
      const allocation = await reserveLines(tx, { companyId, warehouseId, lines: stockLines });
      const reservedByProduct = new Map();
      for (const line of allocation.reserved) reservedByProduct.set(line.productId, (reservedByProduct.get(line.productId) || 0) + number(line.allocatedQuantity));
      for (const [productId, quantity] of reservedByProduct) await adjustProductReserved(tx, companyId, productId, quantity, 1);
      const savedLines = normalized.map((line) => {
        const stockLine = allocation.reserved.find((entry) => entry.lineId === line.lineId);
        const pendingLine = allocation.backorder.find((entry) => entry.lineId === line.lineId);
        return stockLine || pendingLine ? { ...line, reservedQuantity: number(stockLine?.reservedQuantity), remainingBaseQuantity: number(pendingLine?.remainingBaseQuantity) }
          : { ...line, reservedQuantity: line.baseQuantity, remainingBaseQuantity: 0, nonStock: true };
      });
      const pendingLines = savedLines.filter((line) => line.remainingBaseQuantity > 0);
      const status = pendingLines.length === 0 ? 'reserved' : savedLines.some((line) => line.reservedQuantity > 0) ? 'partial' : 'backorder';
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO pos_stock_reservations (id, company_id, register_id, shift_id, cashier_id, warehouse_id, client_id, reference_no, status, lines, backorder_lines, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12) RETURNING id, reference_no AS "referenceNo", status, created_at AS "createdAt"`,
        id, companyId, registerId, shift.id, cashierId, warehouseId, clientId, referenceNo, status,
        JSON.stringify(savedLines), JSON.stringify(pendingLines), String(req.body?.notes || '').slice(0, 500),
      );
      return { ...rows[0], warehouseId, warehouseName: warehouse.name, clientId, clientName: client.name, clientCode: client.code, clientPhone: client.phoneNormalized, lines: savedLines, backorderLines: pendingLines };
    });
    await writePosAuditLog({ companyId, registerId, userId: cashierId, event: 'POS_WHOLESALE_STOCK_RESERVED', metadata: { reservationId: id, referenceNo, warehouseId, clientId, status: result.status, lineCount: result.lines.length } }, dbClient());
    return res.status(201).json({ success: true, data: result });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, code: error.code, message: error.message });
    return next(error);
  }
};

exports.list = async (req, res, next) => {
  try {
    const { companyId, registerId } = context(req);
    const rows = await dbClient().$queryRawUnsafe(
      `SELECT r.id, r.reference_no AS "referenceNo", r.status, r.warehouse_id AS "warehouseId", w.name AS "warehouseName", r.client_id AS "clientId", c.name AS "clientName", c.code AS "clientCode", c.phone_normalized AS "clientPhone", r.lines, r.backorder_lines AS "backorderLines", r.notes, r.created_at AS "createdAt"
       FROM pos_stock_reservations r JOIN warehouses w ON w.id = r.warehouse_id JOIN clients c ON c.id = r.client_id
       WHERE r.company_id = $1 AND r.register_id = $2 AND r.status IN ('reserved','partial','backorder')
       ORDER BY r.created_at DESC LIMIT 100`, companyId, registerId,
    );
    return res.json({ success: true, data: rows.map((row) => ({ ...row, lines: row.lines || [], backorderLines: row.backorderLines || [] })) });
  } catch (error) { return next(error); }
};

exports.allocateBackorder = async (req, res, next) => {
  const { companyId, registerId, cashierId } = context(req);
  const reservationId = String(req.params.reservationId || '');
  if (!objectId(reservationId)) return res.status(400).json({ success: false, code: 'POS_RESERVATION_ID_INVALID', message: 'Reservation id is invalid.' });
  try {
    const result = await dbClient().$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe(`SELECT id, warehouse_id AS "warehouseId", lines, backorder_lines AS "backorderLines" FROM pos_stock_reservations WHERE id=$1 AND company_id=$2 AND register_id=$3 AND status IN ('partial','backorder') FOR UPDATE`, reservationId, companyId, registerId);
      const reservation = rows[0];
      if (!reservation) throw Object.assign(new Error('No open backorder reservation was found for this register.'), { statusCode: 404, code: 'POS_RESERVATION_NOT_FOUND' });
      const lines = reservation.lines || [];
      const pending = reservation.backorderLines || [];
      const allocation = await reserveLines(tx, { companyId, warehouseId: reservation.warehouseId, lines: pending });
      const lineById = new Map(lines.map((line) => [line.lineId, line]));
      const allocatedByProduct = new Map();
      for (const alloc of allocation.reserved) {
        const line = lineById.get(alloc.lineId);
        if (!line) continue;
        line.reservedQuantity = number(alloc.reservedQuantity);
        line.remainingBaseQuantity = number(alloc.remainingBaseQuantity);
        allocatedByProduct.set(alloc.productId, (allocatedByProduct.get(alloc.productId) || 0) + number(alloc.allocatedQuantity));
      }
      for (const [productId, quantity] of allocatedByProduct) await adjustProductReserved(tx, companyId, productId, quantity, 1);
      const nextPending = allocation.backorder;
      const status = nextPending.length === 0 ? 'reserved' : allocation.reserved.length || lines.some((line) => number(line.reservedQuantity) > 0) ? 'partial' : 'backorder';
      await tx.$executeRawUnsafe('UPDATE pos_stock_reservations SET lines=$1::jsonb, backorder_lines=$2::jsonb, status=$3, updated_at=CURRENT_TIMESTAMP WHERE id=$4 AND company_id=$5', JSON.stringify(lines), JSON.stringify(nextPending), status, reservationId, companyId);
      return { id: reservationId, status, lines, backorderLines: nextPending };
    });
    await writePosAuditLog({ companyId, registerId, userId: cashierId, event: 'POS_WHOLESALE_BACKORDER_RETRIED', metadata: { reservationId, status: result.status } }, dbClient());
    return res.json({ success: true, data: result });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, code: error.code, message: error.message });
    return next(error);
  }
};

exports.cancel = async (req, res, next) => {
  const { companyId, registerId, cashierId } = context(req);
  const reservationId = String(req.params.reservationId || '');
  if (!objectId(reservationId)) return res.status(400).json({ success: false, code: 'POS_RESERVATION_ID_INVALID', message: 'Reservation id is invalid.' });
  try {
    await dbClient().$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe(`SELECT id, warehouse_id AS "warehouseId", lines FROM pos_stock_reservations WHERE id=$1 AND company_id=$2 AND register_id=$3 AND status IN ('reserved','partial','backorder') FOR UPDATE`, reservationId, companyId, registerId);
      const reservation = rows[0];
      if (!reservation) throw Object.assign(new Error('Open reservation not found for this register.'), { statusCode: 404, code: 'POS_RESERVATION_NOT_FOUND' });
      for (const line of reservation.lines || []) {
        const quantity = number(line.reservedQuantity);
        if (quantity <= 0 || line.nonStock) continue;
        const changed = await tx.$executeRawUnsafe('UPDATE stock_levels SET qty_reserved=qty_reserved-$1::numeric, updated_at=CURRENT_TIMESTAMP WHERE company_id=$2 AND product_id=$3 AND warehouse_id=$4 AND qty_reserved >= $1::numeric', quantity, companyId, line.productId, reservation.warehouseId);
        if (changed !== 1) throw Object.assign(new Error(`Reserved stock changed for ${line.productName}; refresh inventory before cancelling.`), { statusCode: 409, code: 'POS_RESERVATION_STOCK_CHANGED' });
        await adjustProductReserved(tx, companyId, line.productId, quantity, -1);
      }
      await tx.$executeRawUnsafe(`UPDATE pos_stock_reservations SET status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND company_id=$2`, reservationId, companyId);
    });
    await writePosAuditLog({ companyId, registerId, userId: cashierId, event: 'POS_WHOLESALE_RESERVATION_CANCELLED', metadata: { reservationId } }, dbClient());
    return res.json({ success: true, message: 'Reservation cancelled and stock released.' });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, code: error.code, message: error.message });
    return next(error);
  }
};
