/**
 * openingStockService
 * Creates one-time opening stock entries per product per warehouse.
 * Flow: validate -> persist movement + batch + inventory layer -> journal -> EBM.
 */

const Product = require('../models/Product');
const Warehouse = require('../models/Warehouse');
const StockMovement = require('../models/StockMovement');
const StockLevel = require('../models/StockLevel');
const InventoryBatch = require('../models/InventoryBatch');
const StockBatch = require('../models/StockBatch');
const StockSerialNumber = require('../models/StockSerialNumber');
const { createLayer } = require('./inventoryService');
const JournalService = require('./journalService');
const EBMStockService = require('./ebmStockService');
const { runInTransaction } = require('./transactionService');
const { DEFAULT_ACCOUNTS } = require('../constants/chartOfAccounts');
const ChartOfAccount = require('../models/ChartOfAccount');

function toNumber(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function badRequest(message, status = 400, code = 'INVALID_OPENING_STOCK') {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

async function ensureNoDuplicateOpening(companyId, productId, warehouseId, session) {
  const existing = await StockMovement.findOne({
    company: companyId,
    product: productId,
    warehouse: warehouseId,
    reason: 'initial_stock'
  }).session(session || null);
  if (existing) {
    throw badRequest('Opening stock already captured for this product and warehouse.', 409, 'OPENING_STOCK_EXISTS');
  }
}

async function ensureNoStockExists(companyId, productId, warehouseId, session) {
  const existingAny = await StockMovement.findOne({
    company: companyId,
    product: productId,
    warehouse: warehouseId
  }).session(session || null).select('_id');
  if (existingAny) {
    throw badRequest(
      'Stock already exists for this product in this warehouse. If you entered opening stock incorrectly via stock adjustment, you must reverse those entries first through a manual journal entry before importing opening stock here.',
      409,
      'STOCK_ALREADY_EXISTS'
    );
  }
}

async function ensureOpeningBalanceEquityAccount(companyId, userId, session) {
  try {
    const code = DEFAULT_ACCOUNTS.openingBalanceEquity || '3500';
    const account = await ChartOfAccount.findOneAndUpdate(
      { company: companyId, code },
      {
        $setOnInsert: {
          name: 'Opening Balance Equity',
          type: 'equity',
          is_postable: true,
          createdBy: userId
        }
      },
      { new: true, upsert: true, session: session || null }
    );
    return account;
  } catch (err) {
    console.error('[OpeningStock] ensureOpeningBalanceEquityAccount failed:', err.message);
    // continue; JournalService may still resolve mapping/defaults
    return null;
  }
}

async function createOpeningStock({
  companyId,
  userId,
  productId,
  warehouseId,
  quantity,
  unitCost,
  movementDate = new Date(),
  notes,
  branchId = null,
  referenceNumber = null,
  batchNumber = null,
  lotNumber = null,
  manufactureDate = null,
  expiryDate = null,
  serialNumbers = [],
  requireTrackingIdentifiers = false
}) {
  const qty = toNumber(quantity);
  const cost = toNumber(unitCost);
  if (!productId) throw badRequest('Product is required');
  if (!warehouseId) throw badRequest('Warehouse is required');
  if (!qty || qty <= 0) throw badRequest('Quantity must be greater than zero');
  if (cost < 0) throw badRequest('Unit cost cannot be negative');

  const { movement } = await runInTransaction(async (trx) => {
    const session = trx || null;
    const opts = session ? { session } : {};

    const productQuery = Product.findOne({ _id: productId, company: companyId });
    const warehouseQuery = Warehouse.findOne({ _id: warehouseId, company: companyId });
    const [product, warehouse] = await Promise.all([
      session ? productQuery.session(session) : productQuery,
      session ? warehouseQuery.session(session) : warehouseQuery
    ]);

    if (!product) throw badRequest('Product not found', 404);
    if (!warehouse) throw badRequest('Warehouse not found', 404);

    const trackingType = String(product.trackingType || 'none').toLowerCase();
    const normalizedSerials = (serialNumbers || []).map((serial) => String(serial).trim().toUpperCase()).filter(Boolean);
    if (requireTrackingIdentifiers && trackingType === 'batch' && !batchNumber) throw badRequest('Batch number is required for batch-tracked opening stock.');
    if (requireTrackingIdentifiers && trackingType === 'serial' && normalizedSerials.length !== qty) throw badRequest(`Exactly ${qty} serial numbers are required for this product.`);
    if (trackingType === 'serial' && normalizedSerials.length && normalizedSerials.length !== qty) throw badRequest(`Exactly ${qty} serial numbers are required for this product.`);
    if (trackingType === 'serial' && new Set(normalizedSerials).size !== normalizedSerials.length) throw badRequest('Serial numbers must be unique.');

    await ensureNoDuplicateOpening(companyId, productId, warehouseId, session);
    await ensureNoStockExists(companyId, productId, warehouseId, session);

    const previousStock = toNumber(product.currentStock || 0);
    const newStock = previousStock + qty;
    const totalCost = qty * cost;

    const [movementDoc] = await StockMovement.create([
      {
        company: companyId,
        product: productId,
        warehouse: warehouseId,
        type: 'in',
        reason: 'initial_stock',
        quantity: qty,
        previousStock,
        newStock,
        unitCost: cost,
        totalCost,
        batchNumber: batchNumber || null,
        lotNumber: lotNumber || null,
        serialNumbers: trackingType === 'serial' ? normalizedSerials : [],
        expiryDate: expiryDate || null,
        referenceType: 'opening_stock',
        referenceNumber: referenceNumber || `OPEN-${Date.now()}`,
        notes: notes || 'Opening Stock',
        performedBy: userId,
        movementDate
      }
    ], opts);

    // Update product totals & costing
    const currentValue = previousStock * toNumber(product.averageCost || product.costPrice || 0);
    const newAverage = newStock > 0 ? (currentValue + totalCost) / newStock : cost;
    product.currentStock = newStock;
    product.averageCost = newAverage || 0;
    product.costPrice = cost;
    product.lastSupplyDate = movementDate;
    await product.save(opts);

    // Keep the warehouse-scoped quantity used by POS in sync with the product
    // aggregate. Without this row, imported/opening stock appears in inventory
    // totals but the POS correctly reads zero for the selected warehouse.
    const stockLevel = await StockLevel.getOrCreate(companyId, productId, warehouseId);
    const previousWarehouseQty = toNumber(stockLevel.qty_on_hand);
    const previousWarehouseValue = previousWarehouseQty * toNumber(stockLevel.avg_cost);
    const nextWarehouseQty = previousWarehouseQty + qty;
    stockLevel.qty_on_hand = nextWarehouseQty;
    stockLevel.avg_cost = nextWarehouseQty > 0
      ? (previousWarehouseValue + totalCost) / nextWarehouseQty
      : cost;
    stockLevel.total_value = nextWarehouseQty * stockLevel.avg_cost;
    stockLevel.last_movement_at = movementDate;
    stockLevel.last_movement_type = 'initial_stock';
    await stockLevel.save(opts);

    // Create per-warehouse batch for visibility in stock levels
    await InventoryBatch.create([
      {
        company: companyId,
        product: productId,
        warehouse: warehouseId,
        quantity: qty,
        availableQuantity: qty,
        unitCost: cost,
        totalCost,
        status: 'active',
        batchNumber: batchNumber || null,
        lotNumber: lotNumber || null,
        expiryDate: expiryDate || null,
        manufacturingDate: manufactureDate || null,
        stockMovement: movementDoc._id,
        receivedDate: movementDate,
        notes: notes || 'Opening Stock',
        createdBy: userId
      }
    ], opts);

    let trackedBatch = null;
    if (trackingType === 'batch' || batchNumber) {
      trackedBatch = await StockBatch.create({
        company: companyId,
        product: productId,
        warehouse: warehouseId,
        batchNo: String(batchNumber || `OPEN-${movementDoc._id}`).trim().toUpperCase(),
        qtyReceived: qty,
        qtyOnHand: qty,
        unitCost: cost,
        manufactureDate: manufactureDate || null,
        expiryDate: expiryDate || null,
        notes: notes || 'Imported opening stock batch',
      }, opts);
    }
    if (trackingType === 'serial') {
      const existingSerials = await StockSerialNumber.find({
        company: companyId,
        product: productId,
        serialNo: { $in: normalizedSerials },
      }).select('serialNo').lean();
      if (existingSerials.length) throw badRequest(`Serial number already exists for this product: ${existingSerials[0].serialNo}`, 409, 'DUPLICATE_SERIAL_NUMBER');
      await StockSerialNumber.create(normalizedSerials.map((serialNo) => ({
        company: companyId,
        serialNo,
        product: productId,
        warehouse: warehouseId,
        batch: trackedBatch?._id || null,
        unitCost: cost,
        status: 'in_stock',
        notes: notes || 'Imported opening stock serial number',
      })), opts);
    }

    // Create inventory layer for costing (FIFO/avg consumers)
    await createLayer(
      companyId,
      productId,
      qty,
      cost,
      { sourceType: 'opening_stock', sourceId: movementDoc._id },
      { session, userId, warehouse: warehouseId },
    );

    // Journal entry: DR Inventory, CR Opening Balance Equity
    await ensureOpeningBalanceEquityAccount(companyId, userId, session);
    let inventoryAcct = DEFAULT_ACCOUNTS.inventory;
    const context = { productId, warehouseId };
    try {
      inventoryAcct = await JournalService.getMappedAccountCode(
        companyId,
        'purchases',
        'inventory',
        DEFAULT_ACCOUNTS.inventory,
        context
      );
    } catch (err) {
      inventoryAcct = DEFAULT_ACCOUNTS.inventory;
    }
    const equityAcct = DEFAULT_ACCOUNTS.openingBalanceEquity || '3500';
    const description = `Opening Stock - ${product.name}${warehouse?.name ? ` (${warehouse.name})` : ''}`;

    const lines = [
      JournalService.createDebitLine(inventoryAcct, totalCost, description),
      JournalService.createCreditLine(equityAcct, totalCost, description)
    ];

    await JournalService.createEntry(companyId, userId, {
      date: movementDate,
      description,
      sourceType: 'opening_stock',
      sourceId: movementDoc._id,
      lines,
      isAutoGenerated: true
    }, opts);

    return { movement: movementDoc };
  });

  // Submit to VSDC/EBM outside transaction
  if (movement) {
    EBMStockService.submitStockAdjustment(movement._id, { companyId, branchId }).catch((err) => {
      console.error('EBM opening stock submission failed:', err.message);
    });
  }

  return movement;
}

async function ensureImportedTrackingRecords({
  companyId,
  userId,
  productId,
  warehouseId,
  quantity,
  unitCost,
  batchNumber = null,
  lotNumber = null,
  manufactureDate = null,
  expiryDate = null,
  serialNumbers = [],
}) {
  const serials = (serialNumbers || []).map((serial) => String(serial).trim().toUpperCase()).filter(Boolean);
  if (!batchNumber && !lotNumber && !manufactureDate && !expiryDate && !serials.length) return;

  await runInTransaction(async (trx) => {
    const session = trx || null;
    const opts = session ? { session } : {};
    const product = await Product.findOne({ _id: productId, company: companyId });
    const warehouse = await Warehouse.findOne({ _id: warehouseId, company: companyId });
    if (!product || !warehouse) throw badRequest('Product or warehouse not found while attaching imported tracking identifiers.', 404);
    const trackingType = String(product.trackingType || 'none').toLowerCase();
    const qty = toNumber(quantity);
    let trackedBatch = null;

    if (trackingType === 'batch' || batchNumber) {
      const batchNo = String(batchNumber || `OPEN-${productId}-${warehouseId}`).trim().toUpperCase();
      trackedBatch = await StockBatch.findOne({ company: companyId, product: productId, warehouse: warehouseId, batchNo });
      if (!trackedBatch) {
        trackedBatch = await StockBatch.create({
          company: companyId,
          product: productId,
          warehouse: warehouseId,
          batchNo,
          qtyReceived: qty,
          qtyOnHand: qty,
          unitCost: toNumber(unitCost),
          manufactureDate: manufactureDate || null,
          expiryDate: expiryDate || null,
          notes: 'Imported opening stock batch',
        }, opts);
      } else {
        const batchUpdates = {};
        if (manufactureDate) batchUpdates.manufactureDate = manufactureDate;
        if (expiryDate) batchUpdates.expiryDate = expiryDate;
        if (Object.keys(batchUpdates).length) {
          await StockBatch.updateOne({ _id: trackedBatch._id, company: companyId }, { $set: batchUpdates }, opts);
        }
      }
    }

    if (serials.length) {
      if (trackingType !== 'serial') throw badRequest('Serial identifiers require a serial-tracked product.');
      const existing = await StockSerialNumber.find({ company: companyId, product: productId, serialNo: { $in: serials } }).select('serialNo').lean();
      const existingSet = new Set(existing.map((row) => String(row.serialNo).toUpperCase()));
      const missing = serials.filter((serial) => !existingSet.has(serial));
      if (missing.length) {
        await StockSerialNumber.create(missing.map((serialNo) => ({
          company: companyId,
          serialNo,
          product: productId,
          warehouse: warehouseId,
          batch: trackedBatch?._id || null,
          unitCost: toNumber(unitCost),
          status: 'in_stock',
          notes: 'Imported opening stock serial number',
        })), opts);
      }
      if (trackedBatch) {
        await StockSerialNumber.updateMany({
          company: companyId,
          product: productId,
          serialNo: { $in: serials },
          batch: null,
        }, { $set: { batch: trackedBatch._id } }, opts);
      }
    }

    // Backfill the InventoryBatch record made by an earlier import run so both
    // the standard batch view and tracked-batch view retain the identifiers.
    let existingOpeningQuery = StockMovement.findOne({ company: companyId, product: productId, warehouse: warehouseId, reason: 'initial_stock' }).select('_id');
    if (session) existingOpeningQuery = existingOpeningQuery.session(session);
    const existingOpening = await existingOpeningQuery.lean();
    if (existingOpening) {
      const movementTrackingUpdates = {};
      if (batchNumber) movementTrackingUpdates.batchNumber = String(batchNumber).trim().toUpperCase();
      if (lotNumber) movementTrackingUpdates.lotNumber = String(lotNumber).trim().toUpperCase();
      if (expiryDate) movementTrackingUpdates.expiryDate = expiryDate;
      if (serials.length) movementTrackingUpdates.serialNumbers = serials;
      if (Object.keys(movementTrackingUpdates).length) {
        await StockMovement.updateOne(
          { _id: existingOpening._id, company: companyId },
          { $set: movementTrackingUpdates },
          opts,
        );
      }

      const { dbClient } = require('../lib/prisma');
      const inventoryBatch = await dbClient().inventoryBatch.findFirst({
        where: { companyId: String(companyId), productId: String(productId), warehouseId: String(warehouseId), stockMovementId: String(existingOpening._id) },
        select: { id: true },
      });
      if (inventoryBatch) {
        await dbClient().inventoryBatch.update({
          where: { id: inventoryBatch.id },
          data: {
            ...(batchNumber ? { batchNumber } : {}),
            ...(lotNumber ? { lotNumber } : {}),
            ...(manufactureDate ? { manufacturingDate: manufactureDate } : {}),
            ...(expiryDate ? { expiryDate } : {}),
          },
        });
      }
    }
  });
}

module.exports = {
  createOpeningStock,
  ensureImportedTrackingRecords,
};
