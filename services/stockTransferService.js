const StockTransfer = require('../models/StockTransfer');
const StockTransferLine = require('../models/StockTransferLine');
const InventoryLayer = require('../models/InventoryLayer');
const Product = require('../models/Product');
const { dbClient } = require('../lib/prisma');
const { loadLineProducts, getLineProduct } = require('../utils/lineProducts');
const StockMovement = require('../models/StockMovement');
const { runInTransaction } = require('./transactionService');

async function _ensureActiveAndStockable(productIds, companyId) {
  const products = await loadLineProducts(Product, productIds.map((product) => ({ product })), companyId);
  for (const productId of productIds) {
    const product = products.get(String(productId));
    if (!product) throw { code: 'PRODUCT_NOT_FOUND', product: productId };
    if (!product.isActive) throw { code: 'PRODUCT_INACTIVE', product: product._id };
    if (!product.isStockable) throw { code: 'PRODUCT_NOT_STOCKABLE', product: product._id };
  }
}

async function _checkAvailability(companyId, fromWarehouse, lines) {
  // Resolve products once and aggregate all source batches in one indexed query.
  const availabilityProducts = await loadLineProducts(Product, lines, companyId);
  const productIds = [...new Set(lines.map((line) => String(line.product?._id || line.product)).filter(Boolean))];
  const batchGroups = productIds.length
    ? await dbClient().inventoryBatch.groupBy({
      by: ['productId'],
      where: { companyId: String(companyId), warehouseId: String(fromWarehouse), productId: { in: productIds } },
      _sum: { reservedQuantity: true, quantity: true },
    })
    : [];
  const quarantinedGroups = productIds.length
    ? await dbClient().stockBatch.groupBy({
      by: ['productId'],
      where: {
        companyId: String(companyId),
        warehouseId: String(fromWarehouse),
        productId: { in: productIds },
        isQuarantined: true,
        qtyOnHand: { gt: 0 },
      },
      _sum: { qtyOnHand: true },
    })
    : [];
  const quarantinedByProduct = new Map(quarantinedGroups.map((group) => [String(group.productId), Number(group._sum?.qtyOnHand || 0)]));
  const availabilityByProduct = new Map(batchGroups.map((group) => [
    String(group.productId),
    {
      reserved: Number(group._sum?.reservedQuantity || 0),
      onHand: group._sum?.quantity == null ? null : Number(group._sum.quantity),
    },
  ]));
  const requestedByProduct = new Map();
  for (const line of lines) {
    const prod = getLineProduct(availabilityProducts, line);
    if (!prod) throw { code: 'PRODUCT_NOT_FOUND', product: line.product };
    requestedByProduct.set(
      String(prod._id),
      (requestedByProduct.get(String(prod._id)) || 0) + Number(line.qty?.toString?.() ?? line.qty ?? 0),
    );
  }
  for (const [productId, qty] of requestedByProduct) {
    const prod = availabilityProducts.get(productId);
    const grouped = availabilityByProduct.get(String(prod._id));
    const onHand = grouped?.onHand == null ? Number(prod.currentStock || 0) : grouped.onHand;
    const available = onHand - (grouped?.reserved || 0) - (quarantinedByProduct.get(productId) || 0);
    if (available < qty) throw { code: 'INSUFFICIENT_STOCK', product: prod._id };
  }
}

async function _resolveCostsAndConsumeLots(session, companyId, fromWarehouse, lines) {
  // For each line determine unitCost and, for FIFO, consume lots and produce consumedLots array
  const results = [];
  const costingProducts = await loadLineProducts(Product, lines, companyId);
  const productIds = [...new Set(lines.map((line) => String(line.product?._id || line.product)).filter(Boolean))];
  const [costRows, layerRows] = await Promise.all([
    dbClient().warehouseInventoryCost.findMany({
      where: { companyId: String(companyId), warehouseId: String(fromWarehouse), productId: { in: productIds } },
      select: { productId: true, totalQty: true, totalValue: true },
      take: productIds.length || 1,
    }),
    InventoryLayer.find({
      company: companyId,
      warehouse: fromWarehouse,
      product: { $in: productIds },
      qtyRemaining: { $gt: 0 },
    }).sort({ receiptDate: 1, _id: 1 }).limit(500).session(session),
  ]);
  const costsByProduct = new Map(costRows.map((row) => [String(row.productId), row]));
  const layersByProduct = new Map();
  for (const layer of layerRows) {
    const key = String(layer.productId);
    const rows = layersByProduct.get(key) || [];
    rows.push(layer);
    layersByProduct.set(key, rows);
  }
  for (const line of lines) {
    const product = getLineProduct(costingProducts, line);
    const qty = Number(line.qty.toString());
    if (product.costingMethod === 'wac' || product.costingMethod === 'avg' || !product.costingMethod) {
      // Prefer per-warehouse ledger for accurate WAC; fall back to product averageCost
      const ledger = costsByProduct.get(String(product._id));
      const unitCost = ledger
        ? Number(ledger.totalQty || 0) > 0 ? Number(ledger.totalValue || 0) / Number(ledger.totalQty) : 0
        : Number(product.averageCost || 0);
      results.push({ lineId: line._id, product: product._id, qty, unitCost, consumedLots: [] });
    } else {
      // FIFO layers are loaded once for the whole transfer and consumed in order.
      const layers = layersByProduct.get(String(product._id)) || [];
      let remaining = qty;
      const consumedLots = [];
      let totalCost = 0;
      let totalQty = 0;
      for (const l of layers) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, Number(l.qtyRemaining.toString()));
        // decrement
        l.qtyRemaining = Number(l.qtyRemaining) - take;
        await l.save({ session });
        consumedLots.push({ layerId: l._id, qty: take, unitCost: Number(l.unitCost ? l.unitCost.toString() : 0), receiptDate: l.receiptDate });
        totalCost += take * (Number(l.unitCost ? l.unitCost.toString() : 0));
        totalQty += take;
        remaining -= take;
      }
      if (remaining > 0) throw { code: 'INSUFFICIENT_STOCK', product: product._id };
      const blended = totalQty > 0 ? totalCost / totalQty : 0;
      results.push({ lineId: line._id, product: product._id, qty, unitCost: blended, consumedLots });
    }
  }
  return results;
}

async function legacyConfirmTransfer(transferId, opts = {}) {
  return runInTransaction(async (session) => {
    const transfer = await StockTransfer.findById(transferId).populate('-lines').session(session);
    if (!transfer) throw { code: 'NOT_FOUND' };
    if (transfer.status !== 'draft') throw { code: 'INVALID_STATUS' };
    // load lines
    const lines = await StockTransferLine.find({ transfer: transfer._id }).session(session);
    if (transfer.fromWarehouse.toString() === transfer.toWarehouse.toString()) throw { code: 'SAME_WAREHOUSE' };
    // validations
    await _ensureActiveAndStockable(lines.map(l => l.product), transfer.company);
    await _checkAvailability(transfer.company, transfer.fromWarehouse, lines);

    // resolve costs and consume lots (mutates layers)
    const resolved = await _resolveCostsAndConsumeLots(session, transfer.company, transfer.fromWarehouse, lines);
    const productsById = await loadLineProducts(Product, lines, transfer.company);

    // create stock movements and update stock levels
    let transferValue = 0;
    for (const r of resolved) {
      const line = lines.find(x => String(x._id) === String(r.lineId));
      // update line unitCost
      line.unitCost = Number(r.unitCost) || 0;
      await line.save({ session });

      const qty = r.qty;
      const unitCost = Number(r.unitCost);
      const totalCost = qty * unitCost;
      transferValue += totalCost;

      // transfer out movement (source)
      await StockMovement.create([{ company: transfer.company, product: r.product, warehouse: transfer.fromWarehouse, type: 'out', reason: 'transfer_out', referenceType: 'other', referenceModel: 'StockTransfer', referenceDocument: transfer._id, quantity: qty, unitCost, totalCost }], { session });
      // transfer in movement (destination)
      await StockMovement.create([{ company: transfer.company, product: r.product, warehouse: transfer.toWarehouse, type: 'in', reason: 'transfer_in', referenceType: 'other', referenceModel: 'StockTransfer', referenceDocument: transfer._id, quantity: qty, unitCost, totalCost }], { session });

      // update product currentStock and warehouse-level onHand via InventoryBatch/Layer adjustments
      // Decrement source onHand (assume Product.currentStock represents company-wide; warehouse-specific handled by layers/batches already)
      const prod = productsById.get(String(r.product));
      if (!prod) throw { code: 'PRODUCT_NOT_FOUND', product: r.product };
      prod.currentStock = Number(prod.currentStock || 0) - qty;
      await prod.save({ session });

      // For destination WAC/FIFO handling: create new layers for FIFO or update averages
      if (prod.costingMethod === 'wac' || prod.costingMethod === 'avg' || !prod.costingMethod) {
        // existing value = avg_cost * existing_qty (approx)
        const existingQty = Number(prod.currentStock || 0) + qty; // note: prod.currentStock already decreased, but we'll compute destination's existing via InventoryLayer sum
        // Simple approach: skip adjusting avg here; a full implementation would track per-warehouse avg. For now, set product.averageCost to blended if necessary
        // Update: compute new average if possible
        const prevAvg = Number(prod.averageCost || 0);
        const prevQty = existingQty - qty;
        const newQty = prevQty + qty;
        const newAvg = newQty > 0 ? ((prevAvg * prevQty) + totalCost) / newQty : prevAvg;
        prod.averageCost = newAvg;
        await prod.save({ session });
      } else {
          // FIFO: create InventoryLayer entries to mirror consumed lots
          for (const lot of r.consumedLots) {
            await InventoryLayer.create([{ company: transfer.company, product: r.product, qtyReceived: lot.qty, qtyRemaining: lot.qty, originTransfer: transfer._id, originQty: lot.qty, unitCost: Number(lot.unitCost) || 0, receiptDate: new Date() , warehouse: transfer.toWarehouse }], { session });
          }
        }
    }

    // post journal if accounts differ
    // resolve accounts per product/warehouse - if multiple products, we sum values and compare predominant accounts; for simplicity use warehouse-level account first
    const fromAccount = transfer.fromWarehouse.inventory_account_id || null;
    const toAccount = transfer.toWarehouse.inventory_account_id || null;
    let journalEntry = null;
    if (fromAccount && toAccount && String(fromAccount) !== String(toAccount)) {
      journalEntry = await JournalService.postJournal(transfer.company, {
        narration: `Stock Transfer - ${transfer.fromWarehouse} to ${transfer.toWarehouse} - TRF#${transfer.transferNumber}`,
        lines: [ { account: toAccount, dr: transferValue }, { account: fromAccount, cr: transferValue } ],
      }, { session });
      transfer.journalEntry = journalEntry._id;
    } else {
      transfer.journalEntry = null;
    }

    transfer.status = 'confirmed';
    transfer.confirmedAt = new Date();
    await transfer.save({ session });

    return transfer;
  });
}

async function legacyCancelTransfer(transferId, opts = {}) {
  return runInTransaction(async (session) => {
    const transfer = await StockTransfer.findById(transferId).session(session);
    if (!transfer) throw { code: 'NOT_FOUND' };
    if (transfer.status !== 'confirmed') throw { code: 'INVALID_STATUS' };
    // Check for downstream usage: ensure destination layers created for this transfer are untouched
    // If any destination layer created with originTransfer has been partially or fully consumed
    // or there are any subsequent 'out' movements at destination after confirmation, block cancellation.
    if (!transfer.confirmedAt) throw { code: 'INVALID_TRANSFER_STATE' };
    const destLayers = await InventoryLayer.find({ originTransfer: transfer._id, warehouse: transfer.toWarehouse }).session(session);
    for (const dl of destLayers) {
      const originQty = dl.originQty !== undefined && dl.originQty !== null ? Number(dl.originQty.toString()) : null;
      const remaining = dl.qtyRemaining !== undefined && dl.qtyRemaining !== null ? Number(dl.qtyRemaining.toString()) : null;
      if (originQty === null || remaining === null) {
        // defensive: if shape unexpected, treat as used
        throw { code: 'DOWNSTREAM_USAGE', product: dl.product };
      }
      if (remaining !== originQty) {
        throw { code: 'DOWNSTREAM_USAGE', product: dl.product };
      }
      // also check for any subsequent out movements at destination for this product after confirmedAt
      const laterOuts = await StockMovement.countDocuments({ company: transfer.company, product: dl.product, warehouse: transfer.toWarehouse, type: 'out', movementDate: { $gt: transfer.confirmedAt } }).session(session);
      if (laterOuts > 0) throw { code: 'DOWNSTREAM_USAGE', product: dl.product };
    }

    // Create reverse movements
    const lines = await StockTransferLine.find({ transfer: transfer._id }).session(session);
    for (const line of lines) {
      const qty = Number(line.qty.toString());
      const unitCost = line.unitCost ? Number(line.unitCost.toString()) : 0;
      const totalCost = qty * unitCost;
      await StockMovement.create([{ company: transfer.company, product: line.product, warehouse: transfer.toWarehouse, type: 'out', reason: 'transfer_out', referenceType: 'other', referenceModel: 'StockTransfer', referenceDocument: transfer._id, quantity: qty, unitCost, totalCost }], { session });
      await StockMovement.create([{ company: transfer.company, product: line.product, warehouse: transfer.fromWarehouse, type: 'in', reason: 'transfer_in', referenceType: 'other', referenceModel: 'StockTransfer', referenceDocument: transfer._id, quantity: qty, unitCost, totalCost }], { session });
      // restore product currentStock
      const prod = await Product.findById(line.product).session(session);
      prod.currentStock = Number(prod.currentStock || 0) + qty;
      await prod.save({ session });
    }

    // reverse journal if present
    if (transfer.journalEntry) {
      await JournalService.reverse(transfer.journalEntry, { session });
    }

    transfer.status = 'cancelled';
    await transfer.save({ session });
    return transfer;
  });
}

const DEFAULT_ACCOUNTS = require('../constants/chartOfAccounts').DEFAULT_ACCOUNTS;
const { generateObjectId } = require('../utils/objectId');
const { buildReceiptPlan, normalizeSerials } = require('../utils/stockTransferLifecycle');

function transferId(value) {
  return String(value && typeof value === 'object' ? (value._id || value.id) : value);
}

function qtyNumber(value) {
  return Number(value && typeof value.toString === 'function' ? value.toString() : value || 0);
}

function transferEvent(transfer, action, actorId, at, notes) {
  transfer.signatures = [
    ...(Array.isArray(transfer.signatures) ? transfer.signatures : []),
    { action, signedBy: actorId, signedAt: at, notes: notes || null },
  ];
}

function batchIdentityKey(batch) {
  return `${String(batch.batchNumber || '').trim().toUpperCase()}|${String(batch.lotNumber || '').trim().toUpperCase()}`;
}

async function readTransfer(transferIdValue, session) {
  const transfer = await StockTransfer.findById(transferIdValue).session(session);
  if (!transfer) throw { code: 'NOT_FOUND' };
  return transfer;
}

async function allocateTransferIdentity(db, line, product, transfer, session) {
  const productId = transferId(line.product);
  const qty = qtyNumber(line.qty);
  const currentIdentity = line.inventoryIdentity && typeof line.inventoryIdentity === 'object'
    ? line.inventoryIdentity : {};
  const requestedBatchNumbers = Array.isArray(currentIdentity.batches)
    ? currentIdentity.batches.map((batch) => String(batch.batchNumber || '').trim()).filter(Boolean)
    : currentIdentity.batchNumber ? [String(currentIdentity.batchNumber).trim()] : [];
  const quarantinedBatches = await db.stockBatch.findMany({
    where: {
      companyId: transferId(transfer.company),
      productId,
      warehouseId: transferId(transfer.fromWarehouse),
      isQuarantined: true,
      qtyOnHand: { gt: 0 },
    },
    select: { id: true, batchNo: true },
    take: 1000,
  });
  const quarantinedBatchNumbers = quarantinedBatches.map((batch) => String(batch.batchNo || '').trim()).filter(Boolean);
  const quarantinedBatchIds = quarantinedBatches.map((batch) => batch.id);
  const batches = await db.inventoryBatch.findMany({
    where: {
      companyId: transferId(transfer.company),
      productId,
      warehouseId: transferId(transfer.fromWarehouse),
      status: { in: ['active', 'partially_used'] },
      availableQuantity: { gt: 0 },
      ...(quarantinedBatchNumbers.length ? { batchNumber: { notIn: quarantinedBatchNumbers } } : {}),
      ...(requestedBatchNumbers.length ? { batchNumber: { in: requestedBatchNumbers } } : {}),
    },
    orderBy: [{ receivedDate: 'asc' }, { id: 'asc' }],
    take: 500,
  });
  const batchAllocations = [];
  let remaining = qty;
  for (const batch of batches) {
    if (remaining <= 0) break;
    const available = qtyNumber(batch.availableQuantity);
    const take = Math.min(available, remaining);
    if (take <= 0) continue;
    await db.inventoryBatch.update({
      where: { id: batch.id },
      data: {
        quantity: { decrement: take },
        availableQuantity: { decrement: take },
        totalCost: { decrement: Math.round(take * qtyNumber(batch.unitCost) * 100) / 100 },
        status: available === take ? 'exhausted' : 'partially_used',
      },
    });
    batchAllocations.push({
      sourceBatchId: batch.id,
      batchNumber: batch.batchNumber,
      lotNumber: batch.lotNumber,
      expiryDate: batch.expiryDate,
      quantity: take,
      unitCost: qtyNumber(batch.unitCost),
    });
    remaining -= take;
  }
  if (remaining > 0 && quarantinedBatchNumbers.length) {
    // With quarantined units present, an unlabelled/unmatched inventory lot
    // cannot safely be assumed to represent non-quarantined stock.
    throw { code: product.trackBatch ? 'INSUFFICIENT_BATCH_STOCK' : 'INSUFFICIENT_STOCK', product: productId };
  }
  if (product.trackBatch && remaining > 0) {
    throw { code: 'INSUFFICIENT_BATCH_STOCK', product: productId };
  }

  let serials = [];
  if (product.trackSerialNumbers) {
    if (!Number.isInteger(qty)) throw { code: 'INVALID_SERIAL_QUANTITY', product: productId };
    const requestedSerials = normalizeSerials(currentIdentity.serialNumbers);
    const availableSerials = await db.stockSerialNumber.findMany({
      where: {
        companyId: transferId(transfer.company),
        productId,
        warehouseId: transferId(transfer.fromWarehouse),
        status: 'in_stock',
        ...(quarantinedBatchIds.length ? { OR: [{ batchId: null }, { batchId: { notIn: quarantinedBatchIds } }] } : {}),
        ...(requestedSerials.length ? { serialNo: { in: requestedSerials } } : {}),
      },
      orderBy: [{ serialNo: 'asc' }, { id: 'asc' }],
      take: qty,
    });
    serials = availableSerials.map((serial) => String(serial.serialNo).trim().toUpperCase());
    if (serials.length !== qty || (requestedSerials.length && serials.length !== requestedSerials.length)) {
      throw { code: 'INSUFFICIENT_SERIAL_STOCK', product: productId };
    }
    const serialUpdate = await db.stockSerialNumber.updateMany({
      where: {
        companyId: transferId(transfer.company),
        productId,
        warehouseId: transferId(transfer.fromWarehouse),
        serialNo: { in: serials },
        status: 'in_stock',
      },
      data: { status: 'in_transit', dispatchedVia: transferId(transfer._id), dispatchedAt: new Date() },
    });
    if (serialUpdate.count !== serials.length) throw { code: 'INSUFFICIENT_SERIAL_STOCK', product: productId };
  }
  return { batches: batchAllocations, serialNumbers: serials };
}

async function updateWarehousePosition(db, companyId, productId, warehouseId, qtyDelta, valueDelta, actorId, at) {
  const key = { companyId, productId, warehouseId };
  const [stockLevel, costRow] = await Promise.all([
    db.stockLevel.findUnique({ where: { companyId_productId_warehouseId: key } }),
    db.warehouseInventoryCost.findUnique({ where: { companyId_warehouseId_productId: key } }),
  ]);
  if (qtyDelta < 0 && (!stockLevel || !costRow)) {
    throw { code: 'INSUFFICIENT_STOCK', product: productId };
  }
  if (stockLevel) {
    const nextQty = qtyNumber(stockLevel.qtyOnHand) + qtyDelta;
    if (nextQty < -0.0001) throw { code: 'INSUFFICIENT_STOCK', product: productId };
    const nextValue = Math.max(0, qtyNumber(stockLevel.totalValue) + valueDelta);
    await db.stockLevel.update({
      where: { id: stockLevel.id },
      data: {
        qtyOnHand: nextQty,
        totalValue: nextValue,
        avgCost: nextQty > 0 ? nextValue / nextQty : qtyNumber(stockLevel.avgCost),
        lastMovementAt: at,
        lastMovementType: qtyDelta < 0 ? 'transfer_out' : 'transfer_in',
      },
    });
  } else {
    if (qtyDelta < 0) throw { code: 'INSUFFICIENT_STOCK', product: productId };
    if (qtyDelta > 0) {
      await db.stockLevel.create({
        data: {
          id: generateObjectId(),
          ...key,
          qtyOnHand: qtyDelta,
          totalValue: Math.max(0, valueDelta),
          avgCost: qtyDelta > 0 ? Math.max(0, valueDelta) / qtyDelta : 0,
          lastMovementAt: at,
          lastMovementType: 'transfer_in',
        },
      });
    }
  }

  if (costRow) {
    await db.warehouseInventoryCost.update({
      where: { id: costRow.id },
      data: {
        totalQty: Math.max(0, qtyNumber(costRow.totalQty) + qtyDelta),
        totalValue: Math.max(0, qtyNumber(costRow.totalValue) + valueDelta),
      },
    });
  } else {
    if (qtyDelta > 0) {
      await db.warehouseInventoryCost.create({
        data: {
          id: generateObjectId(),
          ...key,
          totalQty: qtyDelta,
          totalValue: Math.max(0, valueDelta),
        },
      });
    }
  }
  return actorId;
}

async function createTransitLayers(db, transfer, line, resolved, unitCost, session) {
  if (resolved.consumedLots && resolved.consumedLots.length) {
    for (const lot of resolved.consumedLots) {
      await db.inventoryLayer.create({
        data: {
          id: generateObjectId(),
          companyId: transferId(transfer.company),
          productId: transferId(line.product),
          warehouseId: null,
          qtyReceived: lot.qty,
          qtyRemaining: lot.qty,
          unitCost: lot.unitCost,
          receiptDate: new Date(),
          sourceType: 'stock_transfer_in_transit',
          sourceId: transferId(line._id),
          originTransferId: transferId(transfer._id),
          originQty: lot.qty,
        },
      });
    }
  } else {
    await db.inventoryLayer.create({
      data: {
        id: generateObjectId(),
        companyId: transferId(transfer.company),
        productId: transferId(line.product),
        warehouseId: null,
        qtyReceived: qtyNumber(line.qty),
        qtyRemaining: qtyNumber(line.qty),
        unitCost,
        receiptDate: new Date(),
        sourceType: 'stock_transfer_in_transit',
        sourceId: transferId(line._id),
        originTransferId: transferId(transfer._id),
        originQty: qtyNumber(line.qty),
      },
    });
  }
  return session;
}

async function dispatchTransfer(transferIdValue, opts = {}) {
  if (!opts.actorId) throw { code: 'ACTOR_REQUIRED' };
  return runInTransaction(async (session) => {
    const transfer = await readTransfer(transferIdValue, session);
    if (!['draft', 'pending'].includes(transfer.status)) throw { code: 'INVALID_STATUS' };
    if (transferId(transfer.fromWarehouse) === transferId(transfer.toWarehouse)) throw { code: 'SAME_WAREHOUSE' };
    const lines = await StockTransferLine.find({ transfer: transfer._id }).session(session);
    if (!lines.length) throw { code: 'EMPTY_TRANSFER' };
    await _ensureActiveAndStockable(lines.map((line) => line.product), transfer.company);
    await _checkAvailability(transfer.company, transfer.fromWarehouse, lines);
    const resolved = await _resolveCostsAndConsumeLots(session, transfer.company, transfer.fromWarehouse, lines);
    const db = dbClient();
    const byLineId = new Map(resolved.map((row) => [String(row.lineId), row]));
    const products = await loadLineProducts(Product, lines, transfer.company);
    const at = new Date();
    let totalTransitValue = 0;

    for (const line of lines) {
      const product = getLineProduct(products, line);
      const valuation = byLineId.get(String(line._id));
      if (!product || !valuation) throw { code: 'PRODUCT_NOT_FOUND', product: line.product };
      const qty = qtyNumber(line.qty);
      const unitCost = qtyNumber(valuation.unitCost);
      const value = Math.round(qty * unitCost * 100) / 100;
      const identity = await allocateTransferIdentity(db, line, product, transfer, session);
      const priorIdentity = line.inventoryIdentity && typeof line.inventoryIdentity === 'object'
        ? line.inventoryIdentity : {};
      const fullIdentity = { ...priorIdentity, ...identity };

      line.unitCost = unitCost;
      line.inventoryIdentity = fullIdentity;
      line.inTransitQty = qty;
      line.inTransitValue = value;
      await line.save({ session });
      await createTransitLayers(db, transfer, line, valuation, unitCost, session);
      await updateWarehousePosition(
        db, transferId(transfer.company), transferId(line.product),
        transferId(transfer.fromWarehouse), -qty, -value, opts.actorId, at,
      );
      await db.product.update({
        where: { id: transferId(line.product) },
        data: { currentStock: { decrement: qty } },
      });
      await StockMovement.create([{
        company: transfer.company,
        product: line.product,
        warehouse: transfer.fromWarehouse,
        type: 'out',
        reason: 'transfer_out',
        referenceType: 'other',
        referenceModel: 'StockTransfer',
        referenceDocument: transfer._id,
        quantity: qty,
        unitCost,
        totalCost: value,
        serialNumbers: identity.serialNumbers,
        performedBy: opts.actorId,
        movementDate: at,
      }], { session });
      totalTransitValue += value;
    }

    transfer.status = 'in_transit';
    transfer.confirmedBy = opts.actorId;
    transfer.confirmedAt = at;
    transfer.inTransitValue = totalTransitValue;
    transferEvent(transfer, 'dispatched', opts.actorId, at, opts.notes);
    await transfer.save({ session });
    return transfer;
  });
}

async function receiveTransfer(transferIdValue, opts = {}) {
  if (!opts.actorId) throw { code: 'ACTOR_REQUIRED' };
  return runInTransaction(async (session) => {
    const transfer = await readTransfer(transferIdValue, session);
    if (transfer.status !== 'in_transit') throw { code: 'INVALID_STATUS' };
    const lines = await StockTransferLine.find({ transfer: transfer._id }).session(session);
    const products = await loadLineProducts(Product, lines, transfer.company);
    const receiptLines = (opts.lines || []).map((receipt) => ({
      ...receipt,
      lineId: receipt.lineId || receipt.transferLineId || receipt.id,
    }));
    const plans = buildReceiptPlan(lines.map((line) => {
      const product = getLineProduct(products, line);
      return {
        ...line,
        trackBatch: Boolean(product?.trackBatch || line.inventoryIdentity?.batches?.length),
        trackSerialNumbers: Boolean(product?.trackSerialNumbers || line.inventoryIdentity?.serialNumbers?.length),
      };
    }), receiptLines);
    const db = dbClient();
    const at = new Date();
    let discrepancyCount = 0;
    for (const plan of plans) {
      const { line, expectedQty, receivedQty, varianceQty, receivedIdentity } = plan;
      const product = getLineProduct(products, line);
      const productId = transferId(line.product);
      const unitCost = qtyNumber(line.unitCost);
      const value = Math.round(receivedQty * unitCost * 100) / 100;
      const shippedIdentity = line.inventoryIdentity || {};
      const batchesToReceive = plan.batches.length
        ? plan.batches
        : (shippedIdentity.batches || []).map((batch) => ({ ...batch }));
      let remainingBatchQty = receivedQty;
      for (const shippedBatch of batchesToReceive) {
        if (remainingBatchQty <= 0) break;
        const quantity = Math.min(Number(shippedBatch.quantity || 0), remainingBatchQty);
        if (quantity <= 0) continue;
        const batchNumber = shippedBatch.batchNumber || null;
        const lotNumber = shippedBatch.lotNumber || null;
        const existing = await db.inventoryBatch.findFirst({
          where: {
            companyId: transferId(transfer.company),
            productId,
            warehouseId: transferId(transfer.toWarehouse),
            batchNumber,
            lotNumber,
            status: { in: ['active', 'partially_used'] },
          },
        });
        if (existing) {
          await db.inventoryBatch.update({
            where: { id: existing.id },
            data: {
              quantity: { increment: quantity },
              availableQuantity: { increment: quantity },
              totalCost: { increment: Math.round(quantity * unitCost * 100) / 100 },
            },
          });
        } else {
          await db.inventoryBatch.create({
            data: {
              id: generateObjectId(),
              companyId: transferId(transfer.company),
              productId,
              warehouseId: transferId(transfer.toWarehouse),
              batchNumber,
              lotNumber,
              expiryDate: shippedBatch.expiryDate || null,
              quantity,
              availableQuantity: quantity,
              reservedQuantity: 0,
              unitCost: qtyNumber(shippedBatch.unitCost) || unitCost,
              totalCost: Math.round(quantity * unitCost * 100) / 100,
              status: 'active',
              receivedDate: at,
            },
          });
        }
        remainingBatchQty -= quantity;
      }
      if (remainingBatchQty > 0 && product?.trackBatch) {
        const extraBatches = plan.batches.filter((batch) => !(shippedIdentity.batches || []).some(
          (sent) => batchIdentityKey(sent) === batchIdentityKey(batch),
        ));
        for (const extra of extraBatches) {
          if (remainingBatchQty <= 0) break;
          const quantity = Math.min(extra.quantity, remainingBatchQty);
          await db.inventoryBatch.create({
            data: {
              id: generateObjectId(),
              companyId: transferId(transfer.company),
              productId,
              warehouseId: transferId(transfer.toWarehouse),
              batchNumber: extra.batchNumber || null,
              lotNumber: extra.lotNumber || null,
              quantity,
              availableQuantity: quantity,
              reservedQuantity: 0,
              unitCost,
              totalCost: Math.round(quantity * unitCost * 100) / 100,
              status: 'active',
              receivedDate: at,
            },
          });
          remainingBatchQty -= quantity;
        }
      }

      const receivedSerials = plan.serialNumbers;
      const sentSerials = normalizeSerials(shippedIdentity.serialNumbers);
      const sentReceived = receivedSerials.filter((serial) => sentSerials.includes(serial));
      if (sentReceived.length) {
        const serialUpdate = await db.stockSerialNumber.updateMany({
          where: {
            companyId: transferId(transfer.company),
            productId,
            serialNo: { in: sentReceived },
            status: 'in_transit',
            dispatchedVia: transferId(transfer._id),
          },
          data: { warehouseId: transferId(transfer.toWarehouse), status: 'in_stock' },
        });
        if (serialUpdate.count !== sentReceived.length) throw { code: 'INVALID_RECEIPT_IDENTITY' };
      }
      for (const serialNo of receivedSerials.filter((serial) => !sentSerials.includes(serial))) {
        await db.stockSerialNumber.create({
          data: {
            id: generateObjectId(),
            companyId: transferId(transfer.company),
            productId,
            serialNo,
            warehouseId: transferId(transfer.toWarehouse),
            unitCost,
            status: 'in_stock',
            dispatchedVia: transferId(transfer._id),
          },
        });
      }

      const unresolvedQty = Math.max(0, expectedQty - receivedQty);
      let toRelieveTransit = Math.min(receivedQty, expectedQty);
      const transitLayers = await db.inventoryLayer.findMany({
        where: {
          companyId: transferId(transfer.company),
          productId,
          sourceType: 'stock_transfer_in_transit',
          sourceId: transferId(line._id),
          qtyRemaining: { gt: 0 },
        },
        orderBy: [{ receiptDate: 'asc' }, { id: 'asc' }],
        take: 500,
      });
      for (const layer of transitLayers) {
        if (toRelieveTransit <= 0) break;
        const layerQty = qtyNumber(layer.qtyRemaining);
        const take = Math.min(layerQty, toRelieveTransit);
        await db.inventoryLayer.update({
          where: { id: layer.id },
          data: { qtyRemaining: { decrement: take } },
        });
        toRelieveTransit -= take;
      }
      const remainingValue = Math.round(unresolvedQty * unitCost * 100) / 100;
      line.qtyReceived = receivedQty;
      line.receivedIdentity = receivedIdentity;
      line.inTransitQty = unresolvedQty;
      line.inTransitValue = remainingValue;
      await line.save({ session });

      await updateWarehousePosition(
        db, transferId(transfer.company), productId,
        transferId(transfer.toWarehouse), receivedQty, value, opts.actorId, at,
      );
      if (receivedQty > 0) {
        await db.product.update({
          where: { id: productId },
          data: { currentStock: { increment: receivedQty } },
        });
        await StockMovement.create([{
          company: transfer.company,
          product: line.product,
          warehouse: transfer.toWarehouse,
          type: 'in',
          reason: 'transfer_in',
          referenceType: 'other',
          referenceModel: 'StockTransfer',
          referenceDocument: transfer._id,
          quantity: receivedQty,
          unitCost,
          totalCost: value,
          serialNumbers: receivedSerials,
          performedBy: opts.actorId,
          movementDate: at,
        }], { session });
      }
      if (Math.abs(varianceQty) > 0.0001) {
        discrepancyCount += 1;
        await db.stockTransferDiscrepancy.create({
          data: {
            id: generateObjectId(),
            companyId: transferId(transfer.company),
            transferId: transferId(transfer._id),
            transferLineId: transferId(line._id),
            expectedQty,
            receivedQty,
            varianceQty,
            notes: plan.receipt.discrepancyNotes || opts.notes || null,
            recordedById: opts.actorId,
            recordedAt: at,
          },
        });
      }
    }
    transfer.status = 'completed';
    transfer.receivedBy = opts.actorId;
    transfer.receivedDate = at;
    transfer.completedDate = at;
    transfer.receivedNotes = opts.notes || null;
    transfer.inTransitValue = plans.reduce((sum, plan) => sum + Math.round(
      Math.max(0, plan.expectedQty - plan.receivedQty) * qtyNumber(plan.line.unitCost) * 100,
    ) / 100, 0);
    if (discrepancyCount) {
      transfer.discrepancyBy = opts.actorId;
      transfer.discrepancyAt = at;
    }
    transferEvent(transfer, 'received', opts.actorId, at, opts.notes);
    if (discrepancyCount) transferEvent(transfer, 'discrepancy_recorded', opts.actorId, at, opts.notes);
    await transfer.save({ session });
    return transfer;
  });
}

async function confirmTransfer(transferIdValue, opts = {}) {
  return dispatchTransfer(transferIdValue, opts);
}

async function cancelTransfer(transferIdValue, opts = {}) {
  if (!opts.actorId) throw { code: 'ACTOR_REQUIRED' };
  return runInTransaction(async (session) => {
    const transfer = await readTransfer(transferIdValue, session);
    if (!['draft', 'pending'].includes(transfer.status)) {
      throw { code: 'POST_DISPATCH_CANCELLATION_FORBIDDEN' };
    }
    const at = new Date();
    transfer.status = 'cancelled';
    transfer.cancelledBy = opts.actorId;
    transfer.cancelledAt = at;
    transferEvent(transfer, 'cancelled', opts.actorId, at, opts.notes);
    await transfer.save({ session });
    return transfer;
  });
}

// Dependencies (can be injected in tests)
let JournalService = require('./journalService');
let InventoryService = require('./inventoryService');

function __setDependencies(deps = {}) {
  if (deps.JournalService) JournalService = deps.JournalService;
  if (deps.InventoryService) InventoryService = deps.InventoryService;
}

async function createStockTransfer(tx, opts = {}) {
  // tx: { _id, company, fromWarehouse, toWarehouse, lines: [{ product, qty, unitCost }] }
  if (!tx || !tx.lines) throw new Error('invalid payload');
  if (String(tx.fromWarehouse) === String(tx.toWarehouse)) throw new Error('source and destination must differ');

  const createdMovements = [];
  try {
    // Create an 'out' movement and an 'in' movement per line
    for (const line of tx.lines) {
      // decrease from-warehouse
      if (InventoryService && InventoryService.createMovement) {
        const out = await InventoryService.createMovement({ company: tx.company, product: line.product, warehouse: tx.fromWarehouse, type: 'out', reason: 'transfer', quantity: line.qty, unitCost: line.unitCost, reference: tx._id });
        createdMovements.push(out);
      }
      // increase to-warehouse
      if (InventoryService && InventoryService.createMovement) {
        const inp = await InventoryService.createMovement({ company: tx.company, product: line.product, warehouse: tx.toWarehouse, type: 'in', reason: 'transfer', quantity: line.qty, unitCost: line.unitCost, reference: tx._id });
        createdMovements.push(inp);
      }
    }

    // Post journal only if accounts differ (e.g., inter-warehouse COGS mapping)
    const fromAcct = await (JournalService.getMappedAccountCode ? JournalService.getMappedAccountCode(tx.company, 'inventory', 'transferFrom', DEFAULT_ACCOUNTS.inventory) : DEFAULT_ACCOUNTS.inventory);
    const toAcct = await (JournalService.getMappedAccountCode ? JournalService.getMappedAccountCode(tx.company, 'inventory', 'transferTo', DEFAULT_ACCOUNTS.inventory) : DEFAULT_ACCOUNTS.inventory);

    if (String(fromAcct) !== String(toAcct)) {
      // compute total value
      const total = tx.lines.reduce((s, l) => s + (Number(l.unitCost || 0) * Number(l.qty || 0)), 0);
      const entryOptions = {
        date: new Date(),
        description: `Stock Transfer ${tx._id}`,
        sourceType: 'stock_transfer',
        sourceId: tx._id,
        sourceReference: tx._id,
        lines: [ JournalService.createDebitLine ? JournalService.createDebitLine(toAcct, total) : { accountCode: toAcct, debit: total }, JournalService.createCreditLine ? JournalService.createCreditLine(fromAcct, total) : { accountCode: fromAcct, credit: total } ],
        isAutoGenerated: true
      };

      // Prefer atomic multi-entry API when available; otherwise fall back to single-entry create
      if (JournalService.createEntriesAtomic) {
        const created = await JournalService.createEntriesAtomic(tx.company, (opts.user && opts.user.id) || null, [entryOptions], { session: opts.session || null });
        const je = created && created.length ? created[0] : null;
        tx.journalEntryId = je && (je._id || je.id) ? (je._id || je.id) : null;
      } else {
        const je = await JournalService.createEntry(tx.company, (opts.user && opts.user.id) || null, entryOptions, opts.session ? { session: opts.session } : undefined);
        tx.journalEntryId = je && (je._id || je.id) ? (je._id || je.id) : null;
      }
    }

    tx.status = 'completed';
    return tx;
  } catch (err) {
    // Attempt rollback of createdMovements if inventory service supports reversal
    if (InventoryService && InventoryService.reverseMovements && createdMovements.length) {
      try { await InventoryService.reverseMovements(createdMovements); } catch (e) { /* swallow */ }
    }
    throw err;
  }
}

module.exports = {
  confirmTransfer,
  dispatchTransfer,
  receiveTransfer,
  cancelTransfer,
  createStockTransfer,
  __setDependencies,
};
