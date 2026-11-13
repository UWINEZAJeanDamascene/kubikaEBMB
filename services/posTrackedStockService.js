'use strict';

const StockBatch = require('../models/StockBatch');
const InventoryBatch = require('../models/InventoryBatch');
const StockSerialNumber = require('../models/StockSerialNumber');

async function consumeLegacyBatchQuantity(companyId, productId, warehouseId, batchNo, quantity, session) {
  let remaining = quantity;
  const legacyBatches = await InventoryBatch.find({
    company: companyId,
    product: productId,
    warehouse: warehouseId,
    batchNumber: batchNo,
    availableQuantity: { $gt: 0 },
  }).sort({ receivedDate: 1 }).session(session);
  for (const legacy of legacyBatches) {
    if (remaining <= 0) break;
    const taken = Math.min(remaining, Number(legacy.availableQuantity || 0));
    legacy.availableQuantity = Number(legacy.availableQuantity) - taken;
    legacy.quantity = Math.max(0, Number(legacy.quantity || 0) - taken);
    legacy.totalCost = Number(legacy.quantity) * Number(legacy.unitCost || 0);
    legacy.updateStatus?.();
    await legacy.save({ session });
    remaining -= taken;
  }
}

async function consumeTrackedBatches(companyId, productId, warehouseId, quantity, session) {
  const batches = await StockBatch.find({ company: companyId, product: productId, warehouse: warehouseId, qtyOnHand: { $gt: 0 }, isQuarantined: false })
    .sort({ expiryDate: 1, createdAt: 1 }).session(session);
  const eligible = batches.filter((batch) => !batch.expiryDate || new Date(batch.expiryDate) >= new Date());
  const available = eligible.reduce((sum, batch) => sum + Number(batch.qtyOnHand || 0), 0);
  if (available < quantity) {
    const error = new Error(`Insufficient non-quarantined, non-expired batch stock. Available: ${available}, required: ${quantity}`);
    error.code = 'INSUFFICIENT_STOCK';
    throw error;
  }

  let remaining = quantity;
  const allocations = [];
  let totalCost = 0;
  for (const batch of eligible) {
    if (remaining <= 0) break;
    const taken = Math.min(remaining, Number(batch.qtyOnHand || 0));
    if (taken <= 0) continue;
    batch.qtyOnHand = Number(batch.qtyOnHand) - taken;
    await batch.save({ session });
    const unitCost = Number(batch.unitCost || 0);
    allocations.push({ batchNo: batch.batchNo, quantity: taken, unitCost });
    totalCost += taken * unitCost;

    await consumeLegacyBatchQuantity(companyId, productId, warehouseId, batch.batchNo, taken, session);
    remaining -= taken;
  }
  return { allocations, totalCost, quantity };
}

async function consumeOfflineTrackedBatches(
  companyId,
  productId,
  warehouseId,
  requestedAllocations,
  snapshotBatches,
  saleCreatedAt,
  session,
) {
  const snapshotById = new Map((snapshotBatches || []).map((batch) => [String(batch.id), batch]));
  const allocations = [];
  const unavailableBatches = [];
  let totalCost = 0;
  let shortfall = 0;

  for (const request of requestedAllocations) {
    const batchId = String(request.batchId);
    const snapshotBatch = snapshotById.get(batchId);
    if (!snapshotBatch) {
      throw Object.assign(new Error('Offline batch allocation was not present in the signed snapshot.'), {
        code: 'POS_OFFLINE_BATCH_ALLOCATION_INVALID',
      });
    }
    const requested = Number(request.quantity);
    const unitCost = Number(snapshotBatch.unitCost) || 0;
    const batch = await StockBatch.findOne({
      _id: batchId,
      company: companyId,
      product: productId,
      warehouse: warehouseId,
    }).session(session);

    let consumedQuantity = 0;
    let reason = '';
    if (!batch) {
      reason = 'batch_missing';
    } else if (batch.isQuarantined) {
      reason = 'batch_quarantined';
    } else if (batch.batchNo !== snapshotBatch.batchNo) {
      reason = 'batch_identity_changed';
    } else if (batch.expiryDate && new Date(batch.expiryDate).getTime() < saleCreatedAt.getTime()) {
      reason = 'batch_expired_at_sale';
    } else {
      const onHand = Number(batch.qtyOnHand) || 0;
      const reserved = Number(batch.reservedQuantity) || 0;
      consumedQuantity = Math.min(requested, Math.max(0, onHand - reserved));
      if (consumedQuantity < requested) reason = 'batch_quantity_changed';
      if (consumedQuantity > 0) {
        batch.qtyOnHand = Math.max(0, onHand - consumedQuantity);
        await batch.save({ session });
        await consumeLegacyBatchQuantity(
          companyId,
          productId,
          warehouseId,
          snapshotBatch.batchNo,
          consumedQuantity,
          session,
        );
      }
    }

    const missingQuantity = requested - consumedQuantity;
    if (missingQuantity > 0) {
      shortfall += missingQuantity;
      unavailableBatches.push({
        batchId,
        batchNo: String(snapshotBatch.batchNo || ''),
        quantity: requested,
        consumedQuantity,
        reason: reason || 'batch_quantity_changed',
      });
    }
    totalCost += requested * unitCost;
    allocations.push({
      batchId,
      batchNo: String(snapshotBatch.batchNo || ''),
      quantity: requested,
      unitCost,
      consumedQuantity,
      shortfall: missingQuantity,
    });
  }

  return {
    allocations,
    totalCost,
    quantity: requestedAllocations.reduce((sum, allocation) => sum + Number(allocation.quantity), 0),
    shortfall,
    unavailableBatches,
  };
}

async function findAvailableSerialsOutsideQuarantine({ companyId, productId, warehouseId, serialNumbers }) {
  const pageSize = 500;
  const candidates = [];
  for (let offset = 0; offset < serialNumbers.length; offset += pageSize) {
    const serialChunk = serialNumbers.slice(offset, offset + pageSize);
    const rows = await StockSerialNumber.find({ company: companyId, product: productId, warehouse: warehouseId, serialNo: { $in: serialChunk }, status: { $in: ['in_stock', 'returned'] } })
      .select('_id serialNo batch').limit(serialChunk.length).lean();
    candidates.push(...rows);
  }
  const batchIds = [...new Set(candidates.map((serial) => String(serial.batch?._id || serial.batch?.id || serial.batch || '')).filter(Boolean))];
  const quarantinedBatchIds = new Set();
  for (let offset = 0; offset < batchIds.length; offset += pageSize) {
    const batchChunk = batchIds.slice(offset, offset + pageSize);
    const rows = await StockBatch.find({ company: companyId, _id: { $in: batchChunk }, isQuarantined: true, qtyOnHand: { $gt: 0 } })
      .select('_id').limit(batchChunk.length).lean();
    for (const batch of rows) quarantinedBatchIds.add(String(batch._id));
  }
  return candidates.filter((serial) => {
    const batchId = String(serial.batch?._id || serial.batch?.id || serial.batch || '');
    return !batchId || !quarantinedBatchIds.has(batchId);
  });
}

module.exports = {
  consumeTrackedBatches,
  consumeOfflineTrackedBatches,
  findAvailableSerialsOutsideQuarantine,
};
