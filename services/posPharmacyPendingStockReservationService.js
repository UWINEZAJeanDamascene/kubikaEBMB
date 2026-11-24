'use strict';

const { randomBytes } = require('crypto');
const { consumeLegacyBatchQuantity } = require('./posTrackedStockService');

function reservationError(message, code) {
  return Object.assign(new Error(message), { code });
}

function parseReservationLines(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      throw reservationError('The Pharmacy stock reservation record is malformed.', 'POS_PHARMACY_RESERVATION_INVALID');
    }
    return parsed;
  }
  throw reservationError('The Pharmacy stock reservation record is malformed.', 'POS_PHARMACY_RESERVATION_INVALID');
}

async function reservePharmacyPendingSale(tx, {
  companyId,
  invoiceId,
  registerId,
  stockUpdates,
}) {
  const lines = [];
  for (const stockUpdate of stockUpdates) {
    const productId = String(stockUpdate.product._id);
    const warehouseId = String(stockUpdate.warehouseId);
    const quantity = Number(stockUpdate.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw reservationError('A Pharmacy stock reservation quantity is invalid.', 'POS_PHARMACY_RESERVATION_INVALID');
    }

    const levels = await tx.$queryRawUnsafe(
      'SELECT qty_on_hand AS "qtyOnHand", qty_reserved AS "qtyReserved" FROM stock_levels WHERE company_id = $1 AND product_id = $2 AND warehouse_id = $3 FOR UPDATE',
      companyId,
      productId,
      warehouseId,
    );
    if (!levels.length) {
      throw reservationError(`No stock record exists for ${stockUpdate.product.name}.`, 'WAREHOUSE_STOCK_CHANGED');
    }
    const quarantinedRows = await tx.$queryRawUnsafe(
      'SELECT COALESCE(SUM(qty_on_hand), 0)::text AS quantity FROM stock_batches WHERE company_id = $1 AND product_id = $2 AND warehouse_id = $3 AND is_quarantined = TRUE',
      companyId,
      productId,
      warehouseId,
    );
    const available = Number(levels[0].qtyOnHand)
      - Number(levels[0].qtyReserved)
      - Number(quarantinedRows[0]?.quantity || 0);
    if (available + 0.0000001 < quantity) {
      throw reservationError(`Insufficient available Pharmacy stock for ${stockUpdate.product.name}.`, 'WAREHOUSE_STOCK_CHANGED');
    }

    const allocations = [];
    if ((stockUpdate.trackingType || stockUpdate.product.trackingType) === 'batch') {
      const requested = Array.isArray(stockUpdate.lineData.batchAllocations)
        ? stockUpdate.lineData.batchAllocations
        : [];
      let candidates;
      if (requested.length) {
        const ids = requested.map((allocation) => String(allocation.batchId || ''));
        if (ids.some((id) => !id)) {
          throw reservationError('The selected Pharmacy batch allocation is invalid.', 'POS_PHARMACY_BATCH_RESERVATION_INVALID');
        }
        candidates = await tx.$queryRawUnsafe(
          `SELECT id, batch_no AS "batchNo", qty_on_hand AS "qtyOnHand",
                  reserved_quantity AS "reservedQuantity", unit_cost AS "unitCost"
             FROM stock_batches
            WHERE company_id = $1 AND product_id = $2 AND warehouse_id = $3
              AND id = ANY($4::char(24)[]) AND is_quarantined = FALSE
              AND recall_status = 'active'
              AND (expiry_date IS NULL OR expiry_date >= CURRENT_TIMESTAMP)
            FOR UPDATE`,
          companyId,
          productId,
          warehouseId,
          ids,
        );
        const byId = new Map(candidates.map((batch) => [String(batch.id).trim(), batch]));
        for (const allocation of requested) {
          const batch = byId.get(String(allocation.batchId));
          const allocationQuantity = Number(allocation.quantity);
          if (!batch || !Number.isFinite(allocationQuantity) || allocationQuantity <= 0) {
            throw reservationError('A selected Pharmacy batch is unavailable or invalid.', 'POS_PHARMACY_BATCH_RESERVATION_INVALID');
          }
          allocations.push({ batch, quantity: allocationQuantity });
        }
      } else {
        candidates = await tx.$queryRawUnsafe(
          `SELECT id, batch_no AS "batchNo", qty_on_hand AS "qtyOnHand",
                  reserved_quantity AS "reservedQuantity", unit_cost AS "unitCost"
             FROM stock_batches
            WHERE company_id = $1 AND product_id = $2 AND warehouse_id = $3
              AND is_quarantined = FALSE AND recall_status = 'active'
              AND (expiry_date IS NULL OR expiry_date >= CURRENT_TIMESTAMP)
              AND qty_on_hand > reserved_quantity
            ORDER BY expiry_date ASC NULLS LAST, created_at ASC, id ASC
            FOR UPDATE`,
          companyId,
          productId,
          warehouseId,
        );
        let remaining = quantity;
        for (const batch of candidates) {
          if (remaining <= 0) break;
          const take = Math.min(remaining, Number(batch.qtyOnHand) - Number(batch.reservedQuantity));
          if (take > 0) {
            allocations.push({ batch, quantity: take });
            remaining -= take;
          }
        }
      }

      const allocationTotal = allocations.reduce((sum, allocation) => sum + allocation.quantity, 0);
      if (Math.abs(allocationTotal - quantity) > 0.0000001) {
        throw reservationError(`Insufficient unexpired batch stock for ${stockUpdate.product.name}.`, 'WAREHOUSE_STOCK_CHANGED');
      }
      for (const allocation of allocations) {
        const updated = await tx.$executeRawUnsafe(
          'UPDATE stock_batches SET reserved_quantity = reserved_quantity + $1::numeric, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND company_id = $3 AND product_id = $4 AND warehouse_id = $5 AND qty_on_hand - reserved_quantity >= $1::numeric AND is_quarantined = FALSE AND recall_status = $6 AND (expiry_date IS NULL OR expiry_date >= CURRENT_TIMESTAMP)',
          allocation.quantity,
          String(allocation.batch.id).trim(),
          companyId,
          productId,
          warehouseId,
          'active',
        );
        if (updated !== 1) {
          throw reservationError(`A Pharmacy batch changed while reserving ${stockUpdate.product.name}.`, 'WAREHOUSE_STOCK_CHANGED');
        }
      }
    }

    const updatedLevel = await tx.$executeRawUnsafe(
      'UPDATE stock_levels SET qty_reserved = qty_reserved + $1::numeric, updated_at = CURRENT_TIMESTAMP WHERE company_id = $2 AND product_id = $3 AND warehouse_id = $4 AND qty_on_hand - qty_reserved >= $1::numeric',
      quantity,
      companyId,
      productId,
      warehouseId,
    );
    if (updatedLevel !== 1) {
      throw reservationError(`Stock changed while reserving ${stockUpdate.product.name}.`, 'WAREHOUSE_STOCK_CHANGED');
    }
    lines.push({
      lineOrder: Number(stockUpdate.lineData.lineOrder),
      productId,
      warehouseId,
      quantity,
      trackingType: stockUpdate.trackingType || stockUpdate.product.trackingType || 'none',
      allocations: allocations.map(({ batch, quantity: allocatedQuantity }) => ({
        batchId: String(batch.id).trim(),
        batchNo: String(batch.batchNo || ''),
        quantity: allocatedQuantity,
      })),
    });
  }

  await tx.$executeRawUnsafe(
    `INSERT INTO pos_pharmacy_pending_stock_reservations
      (id, company_id, invoice_id, register_id, status, lines, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'reserved', $5::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    randomBytes(12).toString('hex'),
    companyId,
    invoiceId,
    registerId,
    JSON.stringify(lines),
  );
  return { status: 'reserved', lines };
}

async function lockPharmacyPendingSaleReservation(tx, companyId, invoiceId) {
  const rows = await tx.$queryRawUnsafe(
    'SELECT id, status, lines FROM pos_pharmacy_pending_stock_reservations WHERE company_id = $1 AND invoice_id = $2 FOR UPDATE',
    companyId,
    invoiceId,
  );
  if (!rows.length) {
    throw reservationError('The Pharmacy stock reservation is missing. Do not complete this pending sale; ask a manager to review it.', 'POS_PHARMACY_RESERVATION_MISSING');
  }
  return { ...rows[0], lines: parseReservationLines(rows[0].lines) };
}

async function consumeReservedPharmacyBatches(tx, {
  companyId,
  productId,
  warehouseId,
  reservationLine,
  session,
}) {
  let totalCost = 0;
  const allocations = [];
  for (const requested of reservationLine.allocations || []) {
    const quantity = Number(requested.quantity);
    const rows = await tx.$queryRawUnsafe(
      `SELECT batch_no AS "batchNo", unit_cost AS "unitCost", qty_on_hand AS "qtyOnHand",
              reserved_quantity AS "reservedQuantity", recall_status AS "recallStatus",
              is_quarantined AS "isQuarantined", expiry_date AS "expiryDate"
         FROM stock_batches
        WHERE id = $1 AND company_id = $2 AND product_id = $3 AND warehouse_id = $4
        FOR UPDATE`,
      requested.batchId,
      companyId,
      productId,
      warehouseId,
    );
    const batch = rows[0];
    if (!batch || batch.isQuarantined || batch.recallStatus !== 'active'
      || (batch.expiryDate && new Date(batch.expiryDate).getTime() < Date.now())
      || Number(batch.qtyOnHand) < quantity || Number(batch.reservedQuantity) < quantity
      || String(batch.batchNo || '') !== String(requested.batchNo || '')) {
      throw reservationError('A reserved Pharmacy batch is no longer safe or available. Cancel the pending sale or ask a manager to review it.', 'POS_PHARMACY_RESERVED_BATCH_INVALID');
    }
    const changed = await tx.$executeRawUnsafe(
      'UPDATE stock_batches SET qty_on_hand = qty_on_hand - $1::numeric, reserved_quantity = reserved_quantity - $1::numeric, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND qty_on_hand >= $1::numeric AND reserved_quantity >= $1::numeric',
      quantity,
      requested.batchId,
    );
    if (changed !== 1) {
      throw reservationError('A reserved Pharmacy batch changed before payment completion.', 'POS_PHARMACY_RESERVED_BATCH_INVALID');
    }
    await consumeLegacyBatchQuantity(companyId, productId, warehouseId, batch.batchNo, quantity, session);
    const unitCost = Number(batch.unitCost) || 0;
    totalCost += quantity * unitCost;
    allocations.push({ batchNo: batch.batchNo, quantity, unitCost });
  }
  return { allocations, totalCost, quantity: Number(reservationLine.quantity) };
}

async function markPharmacyPendingSaleReservationConsumed(tx, companyId, invoiceId) {
  const changed = await tx.$executeRawUnsafe(
    `UPDATE pos_pharmacy_pending_stock_reservations
        SET status = 'consumed', updated_at = CURRENT_TIMESTAMP
      WHERE company_id = $1 AND invoice_id = $2 AND status = 'reserved'`,
    companyId,
    invoiceId,
  );
  if (changed !== 1) {
    throw reservationError('The Pharmacy stock reservation could not be consumed exactly once.', 'POS_PHARMACY_RESERVATION_STATE_INVALID');
  }
}

async function releasePharmacyPendingSaleReservation(tx, companyId, invoiceId) {
  const reservation = await lockPharmacyPendingSaleReservation(tx, companyId, invoiceId);
  if (reservation.status === 'released') return { released: false, replayed: true };
  if (reservation.status !== 'reserved') {
    throw reservationError('The Pharmacy stock reservation has already been consumed and cannot be released.', 'POS_PHARMACY_RESERVATION_STATE_INVALID');
  }
  for (const line of reservation.lines) {
    const updatedLevel = await tx.$executeRawUnsafe(
      'UPDATE stock_levels SET qty_reserved = qty_reserved - $1::numeric, updated_at = CURRENT_TIMESTAMP WHERE company_id = $2 AND product_id = $3 AND warehouse_id = $4 AND qty_reserved >= $1::numeric',
      Number(line.quantity),
      companyId,
      line.productId,
      line.warehouseId,
    );
    if (updatedLevel !== 1) {
      throw reservationError('The reserved Pharmacy stock could not be released safely.', 'POS_PHARMACY_RESERVATION_RELEASE_FAILED');
    }
    for (const allocation of line.allocations || []) {
      const changed = await tx.$executeRawUnsafe(
        'UPDATE stock_batches SET reserved_quantity = reserved_quantity - $1::numeric, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND company_id = $3 AND product_id = $4 AND warehouse_id = $5 AND reserved_quantity >= $1::numeric',
        Number(allocation.quantity),
        allocation.batchId,
        companyId,
        line.productId,
        line.warehouseId,
      );
      if (changed !== 1) {
        throw reservationError('A reserved Pharmacy batch could not be released safely.', 'POS_PHARMACY_RESERVATION_RELEASE_FAILED');
      }
    }
  }
  await tx.$executeRawUnsafe(
    `UPDATE pos_pharmacy_pending_stock_reservations
        SET status = 'released', updated_at = CURRENT_TIMESTAMP
      WHERE company_id = $1 AND invoice_id = $2 AND status = 'reserved'`,
    companyId,
    invoiceId,
  );
  return { released: true, replayed: false };
}

module.exports = {
  reservePharmacyPendingSale,
  lockPharmacyPendingSaleReservation,
  consumeReservedPharmacyBatches,
  markPharmacyPendingSaleReservationConsumed,
  releasePharmacyPendingSaleReservation,
};
