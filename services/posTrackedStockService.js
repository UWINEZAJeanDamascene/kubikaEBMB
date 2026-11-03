'use strict';

const StockBatch = require('../models/StockBatch');
const InventoryBatch = require('../models/InventoryBatch');
const StockSerialNumber = require('../models/StockSerialNumber');

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

    let batchRemaining = taken;
    const legacyBatches = await InventoryBatch.find({ company: companyId, product: productId, warehouse: warehouseId, batchNumber: batch.batchNo, availableQuantity: { $gt: 0 } })
      .sort({ receivedDate: 1 }).session(session);
    for (const legacy of legacyBatches) {
      if (batchRemaining <= 0) break;
      const legacyTake = Math.min(batchRemaining, Number(legacy.availableQuantity || 0));
      legacy.availableQuantity = Number(legacy.availableQuantity) - legacyTake;
      legacy.quantity = Math.max(0, Number(legacy.quantity || 0) - legacyTake);
      legacy.totalCost = Number(legacy.quantity) * Number(legacy.unitCost || 0);
      legacy.updateStatus?.();
      await legacy.save({ session });
      batchRemaining -= legacyTake;
    }
    remaining -= taken;
  }
  return { allocations, totalCost, quantity };
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

module.exports = { consumeTrackedBatches, findAvailableSerialsOutsideQuarantine };
