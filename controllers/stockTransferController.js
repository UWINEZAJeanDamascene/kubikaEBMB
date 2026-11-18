const { parsePagination, paginationMeta } = require("../utils/pagination");
const StockTransfer = require("../models/StockTransfer");
const StockTransferLine = require("../models/StockTransferLine");
const stockTransferService = require("../services/stockTransferService");
const StockLevel = require("../models/StockLevel");
const FiscalService = require("../services/fiscalService");
const { emitDataChanged } = require("../lib/realtimeEvents");
const crypto = require("crypto");

function transferSignature(action, req, notes = "") {
  const userId = req.user?.id || req.user?._id;
  const raw = [
    action,
    userId,
    req.params?.id || "",
    req.ip || "",
    req.get?.("user-agent") || "",
    new Date().toISOString(),
  ].join("|");
  return {
    action,
    signedBy: userId,
    signedAt: new Date(),
    signatureHash: crypto.createHash("sha256").update(raw).digest("hex"),
    ipAddress: req.ip,
    userAgent: req.get?.("user-agent"),
    notes,
  };
}

exports.create = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const items = Array.isArray(req.body.items) ? req.body.items : (Array.isArray(req.body.lines) ? req.body.lines : []);
    const payload = { ...req.body, company: companyId, createdBy: req.user.id || req.user._id };
    delete payload.items;
    delete payload.lines;
    payload.signatures = [transferSignature("created", req, req.body.notes || "")];
    const transfer = await StockTransfer.create(payload);
    for (const item of items) {
      await StockTransferLine.create({
        company: companyId,
        transfer: transfer._id,
        product: item.product?._id || item.product,
        qty: item.qty ?? item.quantity,
        unitCost: item.unitCost,
        notes: item.notes || null,
        createdBy: req.user.id || req.user._id,
        inventoryIdentity: {
          ...(item.inventoryIdentity || {}),
          ...(Array.isArray(item.serialNumbers) ? { serialNumbers: item.serialNumbers } : {}),
          ...(Array.isArray(item.batches) ? { batches: item.batches } : {}),
          ...(item.batchNumber ? { batchNumber: item.batchNumber } : {}),
        },
      });
    }
    res.status(201).json({ success: true, data: transfer });
  } catch (err) {
    next(err);
  }
};

exports.update = async (req, res, next) => {
  try {
    const transfer = await StockTransfer.findOne({
      _id: req.params.id,
      company: req.user.company._id,
    });
    if (!transfer) return res.status(404).json({ success: false });
    if (transfer.status !== "draft")
      return res
        .status(400)
        .json({
          success: false,
          message: "Only draft transfers can be edited",
        });
    Object.assign(transfer, req.body);
    await transfer.save();
    res.json({ success: true, data: transfer });
  } catch (err) {
    next(err);
  }
};

exports.confirm = async (req, res, next) => {
  try {
    const transfer = await stockTransferService.confirmTransfer(
      req.params.id,
      { actorId: req.user.id || req.user._id, notes: req.body?.notes },
    );
    transfer.signatures = [
      ...(transfer.signatures || []),
      transferSignature("dispatched", req, req.body?.notes || "Transfer dispatched"),
    ];
    await transfer.save();
    FiscalService.submitBranchTransfer(transfer._id, {
      companyId: transfer.company || req.user.company._id,
    }).catch((ebmErr) => {
      console.error("EBM branch transfer submission failed:", ebmErr.message);
    });
    res.json({ success: true, data: transfer });
  } catch (err) {
    if (err.code === "SAME_WAREHOUSE")
      return res.status(422).json({ success: false, code: "SAME_WAREHOUSE" });
    if (err.code === "INSUFFICIENT_STOCK")
      return res
        .status(409)
        .json({
          success: false,
          code: "INSUFFICIENT_STOCK",
          product: err.product,
        });
    if (["INVALID_STATUS", "SAME_WAREHOUSE", "ACTOR_REQUIRED", "EMPTY_TRANSFER"].includes(err.code)) {
      return res.status(err.code === "SAME_WAREHOUSE" ? 422 : 400).json({ success: false, code: err.code });
    }
    next(err);
  }
};

exports.dispatch = exports.confirm;

exports.receive = async (req, res, next) => {
  try {
    const transfer = await stockTransferService.receiveTransfer(req.params.id, {
      actorId: req.user.id || req.user._id,
      notes: req.body?.receivedNotes || req.body?.notes,
      lines: req.body?.lines || req.body?.items,
    });
    res.json({ success: true, data: transfer });
  } catch (err) {
    if (["INVALID_STATUS", "INVALID_RECEIPT", "INVALID_RECEIPT_IDENTITY", "ACTOR_REQUIRED"].includes(err.code)) {
      return res.status(err.code === "INVALID_STATUS" ? 400 : 422).json({ success: false, code: err.code, message: err.message });
    }
    next(err);
  }
};

exports.cancel = async (req, res, next) => {
  try {
    const transfer = await stockTransferService.cancelTransfer(
      req.params.id,
      { actorId: req.user.id || req.user._id, notes: req.body?.notes || req.body?.reason },
    );
    transfer.signatures = [
      ...(transfer.signatures || []),
      transferSignature("cancelled", req, req.body?.notes || "Transfer cancelled"),
    ];
    await transfer.save();
    res.json({ success: true, data: transfer });
  } catch (err) {
    if (["INVALID_STATUS", "POST_DISPATCH_CANCELLATION_FORBIDDEN", "ACTOR_REQUIRED"].includes(err.code)) {
      return res.status(err.code === "POST_DISPATCH_CANCELLATION_FORBIDDEN" ? 409 : 400).json({ success: false, code: err.code });
    }
    next(err);
  }
};

exports.list = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const q = { company: companyId };
    if (req.query.from_warehouse_id)
      q.fromWarehouse = req.query.from_warehouse_id;
    if (req.query.to_warehouse_id) q.toWarehouse = req.query.to_warehouse_id;
    if (req.query.status) q.status = req.query.status;
    if (req.query.date_from || req.query.date_to) q.transferDate = {};
    if (req.query.date_from)
      q.transferDate.$gte = new Date(req.query.date_from);
    if (req.query.date_to) q.transferDate.$lte = new Date(req.query.date_to);
    const { page, limit, skip } = parsePagination(req.query);
    const total = await StockTransfer.countDocuments(q);
    const transfers = await StockTransfer.find(q)
      .populate("-items")
      .sort({ transferDate: -1, _id: -1 })
      .skip(skip)
      .limit(limit);
    res.json({
      success: true,
      count: transfers.length,
      data: transfers,
      pagination: paginationMeta(page, limit, total),
    });
  } catch (err) {
    next(err);
  }
};

exports.get = async (req, res, next) => {
  try {
    const transfer = await StockTransfer.findOne({
      _id: req.params.id,
      company: req.user.company._id,
    })
      .populate("items")
      .populate("journalEntry");
    if (!transfer) return res.status(404).json({ success: false });
    res.json({ success: true, data: transfer });
  } catch (err) {
    next(err);
  }
};
const InventoryBatch = require("../models/InventoryBatch");
const SerialNumber = require("../models/SerialNumber");
const StockMovement = require("../models/StockMovement");
const Product = require("../models/Product");
const { loadLineProducts, getLineProduct } = require("../utils/lineProducts");
const Warehouse = require("../models/Warehouse");
const JournalService = require("../services/journalService");
const journalController = require("./journalController");
const { runInTransaction } = require("../services/transactionService");

// @desc    Get all stock transfers
// @route   GET /api/stock/transfers
// @access  Private
exports.getStockTransfers = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { status, fromWarehouse, toWarehouse, search } = req.query;

    const query = { company: companyId };

    if (status) query.status = status;
    if (fromWarehouse) query.fromWarehouse = fromWarehouse;
    if (toWarehouse) query.toWarehouse = toWarehouse;

    const { page, limit, skip } = parsePagination(req.query, {
      defaultLimit: 20,
    });
    const total = await StockTransfer.countDocuments(query);
    const transfers = await StockTransfer.find(query)
      .populate("fromWarehouse", "name code")
      .populate("toWarehouse", "name code")
      .populate("createdBy", "name")
      .populate("confirmedBy", "name")
      .populate("receivedBy", "name")
      .populate("-items")
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit);

    res.json({
      success: true,
      count: transfers.length,
      total,
      pagination: paginationMeta(page, limit, total),
      pages: Math.ceil(total / limit) || 0,
      currentPage: page,
      data: transfers,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single stock transfer
// @route   GET /api/stock/transfers/:id
// @access  Private
exports.getStockTransfer = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const transfer = await StockTransfer.findOne({
      _id: req.params.id,
      company: companyId,
    })
      .populate("fromWarehouse", "name code")
      .populate("toWarehouse", "name code")
      .populate("items.product", "name sku")
      .populate("createdBy", "name")
      .populate("confirmedBy", "name")
      .populate("receivedBy", "name");

    if (!transfer) {
      return res.status(404).json({
        success: false,
        message: "Stock transfer not found",
      });
    }

    res.json({
      success: true,
      data: transfer,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create stock transfer
// @route   POST /api/stock/transfers
// @access  Private (admin, stock_manager)
exports.createStockTransfer = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const {
      fromWarehouse: fromWarehouseId,
      toWarehouse: toWarehouseId,
      items,
      reason,
      transferDate,
      notes,
      referenceNumber,
    } = req.body;

    // Validate warehouses exist
    const [fromWarehouse, toWarehouse] = await Promise.all([
      Warehouse.findOne({ _id: fromWarehouseId, company: companyId }),
      Warehouse.findOne({ _id: toWarehouseId, company: companyId }),
    ]);

    if (!fromWarehouse || !toWarehouse) {
      return res.status(404).json({
        success: false,
        message: "One or both warehouses not found",
      });
    }

    if (fromWarehouseId === toWarehouseId) {
      return res.status(422).json({
        success: false,
        message: "Source and destination warehouses must be different",
        code: "SAME_WAREHOUSE",
      });
    }

    // Validate items and check stock availability.
    // Products for every line are loaded together; the loop still validates in
    // order so the first failure and its message are unchanged.
    const transferLineProducts = await loadLineProducts(Product, items, companyId);
    // Load all source batches in one query as well. This validation used to
    // issue one InventoryBatch query per transfer line; a multi-line transfer
    // now performs a single indexed read and retains the same per-line error
    // ordering below.
    const transferProductIds = [...new Set(
      items.map((item) => item.product?._id || item.product).filter(Boolean).map(String),
    )];
    const sourceBatches = transferProductIds.length
      ? await InventoryBatch.find({
        company: companyId,
        product: { $in: transferProductIds },
        warehouse: fromWarehouseId,
        status: { $nin: ["exhausted"] },
        availableQuantity: { $gt: 0 },
      })
      : [];
    const sourceBatchesByProduct = new Map();
    for (const batch of sourceBatches) {
      const key = String(batch.product?._id || batch.product);
      const rows = sourceBatchesByProduct.get(key) || [];
      rows.push(batch);
      sourceBatchesByProduct.set(key, rows);
    }
    for (const item of items) {
      const product = getLineProduct(transferLineProducts, item);
      if (!product) {
        return res.status(404).json({
          success: false,
          message: `Product ${item.product} not found`,
        });
      }

      // Check available stock in source warehouse - first try InventoryBatch, then fall back to Product
      let availableQty = 0;

      // Check if there are inventory batches in the source warehouse
      const batches = sourceBatchesByProduct.get(String(item.product?._id || item.product)) || [];

      if (batches.length > 0) {
        // Use batch-based inventory
        availableQty = batches.reduce((sum, b) => sum + b.availableQuantity, 0);
      } else {
        // Fall back to Product.currentStock (legacy system)
        // Assume all stock is in the source warehouse
        availableQty = product.currentStock || 0;
      }

      if (availableQty < item.quantity) {
        return res.status(409).json({
          success: false,
          message: `Insufficient available stock for product ${product.name}. Available: ${availableQty}, Requested: ${item.quantity}`,
          code: "INSUFFICIENT_STOCK",
        });
      }
    }

    // Create transfer
    // Create transfer header (items stored in StockTransferLine)
    const transfer = await StockTransfer.create({
      company: companyId,
      fromWarehouse: fromWarehouseId,
      toWarehouse: toWarehouseId,
      reason: reason || "rebalance",
      transferDate: transferDate || new Date(),
      notes,
      referenceNumber,
      status: "pending",
      createdBy: req.user.id,
    });

    // Create line records and attach to transfer
    const createdLineIds = [];
    for (const item of items) {
      const qty = Number(item.quantity || item.qty || 0);
      const unitCost = item.unitCost != null ? Number(item.unitCost) : null;
      const line = await StockTransferLine.create({
        company: companyId,
        transfer: transfer._id,
        product: item.product,
        qty,
        unitCost,
        inventoryIdentity: {
          ...(item.inventoryIdentity || {}),
          ...(Array.isArray(item.serialNumbers) ? { serialNumbers: item.serialNumbers } : {}),
          ...(Array.isArray(item.batches) ? { batches: item.batches } : {}),
          ...(item.batchNumber ? { batchNumber: item.batchNumber } : {}),
        },
        notes: item.notes || null,
        createdBy: req.user.id,
      });
      createdLineIds.push(line._id);
    }

    transfer.items = createdLineIds;
    await transfer.save();

    await transfer.populate([
      { path: "fromWarehouse", select: "name code" },
      { path: "toWarehouse", select: "name code" },
      { path: "items.product", select: "name sku" },
    ]);

    res
      .status(201)
      .json({
        success: true,
        message: "Stock transfer created successfully",
        data: transfer,
      });
  } catch (error) {
    next(error);
  }
};

// @desc    Approve stock transfer
// @route   POST /api/stock/transfers/:id/approve
// @access  Private (admin)
exports.approveStockTransfer = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    const transfer = await StockTransfer.findOne({
      _id: req.params.id,
      company: companyId,
    });
    if (!transfer)
      return res
        .status(404)
        .json({ success: false, message: "Stock transfer not found" });
    // populate lines and product refs (nested populate)
    await transfer.populate({
      path: "items",
      populate: {
        path: "product",
        select:
          "name sku averageCost currentStock trackBatch trackSerialNumbers",
      },
    });

    if (!transfer) {
      return res
        .status(404)
        .json({ success: false, message: "Stock transfer not found" });
    }

    if (transfer.status !== "pending") {
      return res.status(400).json({
        success: false,
        message: "Only pending transfers can be approved",
      });
    }

    // Load warehouse documents for names and accounts
    const [fromWarehouse, toWarehouse] = await Promise.all([
      Warehouse.findOne({ _id: transfer.fromWarehouse, company: companyId }),
      Warehouse.findOne({ _id: transfer.toWarehouse, company: companyId }),
    ]);

    if (!fromWarehouse || !toWarehouse) {
      return res
        .status(404)
        .json({
          success: false,
          message: "Source or destination warehouse not found",
        });
    }

    // Before approving re-validate available stock (on-hand minus reserved).
    // Unpopulated items are resolved in one query up front rather than one per
    // item; already-populated items still short-circuit to what they carry.
    const approveLineProducts = await loadLineProducts(Product, transfer.items, companyId);
    for (const item of transfer.items) {
      const product =
        item.product && item.product._id
          ? item.product
          : getLineProduct(approveLineProducts, item);
      if (!product) continue;

      // compute reserved in source warehouse
      const reservedAgg = await InventoryBatch.aggregate([
        {
          $match: {
            company: companyId,
            product: product._id,
            warehouse: transfer.fromWarehouse,
          },
        },
        {
          $group: {
            _id: null,
            reserved: { $sum: { $ifNull: ["$reservedQuantity", 0] } },
          },
        },
      ]);
      const reserved = (reservedAgg[0] && reservedAgg[0].reserved) || 0;

      const qty = item.quantity || (item.qty ? Number(item.qty.toString()) : 0);
      const prodStock =
        product.currentStock && product.currentStock.toString
          ? Number(product.currentStock.toString())
          : Number(product.currentStock || 0);
      const available = prodStock - reserved;
      if (available < qty) {
        return res
          .status(409)
          .json({
            success: false,
            code: "INSUFFICIENT_STOCK",
            message: `Insufficient available stock for ${product.name}`,
          });
      }
    }

    // Post transfer journal and create stock movement audit entries inside transaction helper
    const createdMovementIds = [];
    await runInTransaction(async (trx) => {
      let totalTransferValue = 0;

      const confirmLineProducts = await loadLineProducts(Product, transfer.items, companyId);
      for (const item of transfer.items) {
        const product =
          item.product && item.product._id
            ? item.product
            : getLineProduct(confirmLineProducts, item);
        const qty =
          item.quantity || (item.qty ? Number(item.qty.toString()) : 0);
        let unitCost = product?.averageCost || 0;

        // If batch exists in source, prefer its unitCost
        const srcBatch = await InventoryBatch.findOne({
          company: companyId,
          product: item.product,
          warehouse: transfer.fromWarehouse,
          availableQuantity: { $gt: 0 },
        }).session(trx || undefined);
        if (srcBatch) unitCost = srcBatch.unitCost || unitCost;

        const lineValue = qty * unitCost;
        totalTransferValue += lineValue;

        // Get current stock before modification
        const prevStock =
          product.currentStock && product.currentStock.toString
            ? Number(product.currentStock.toString())
            : Number(product.currentStock || 0);
        const newStock = Math.max(0, prevStock - qty);

        // Create transfer out movement
        const outMovement = await StockMovement.create({
          company: companyId,
          product: item.product,
          type: "out",
          reason: "transfer_out",
          quantity: qty,
          previousStock: prevStock,
          newStock: newStock,
          unitCost,
          totalCost: lineValue,
          warehouse: transfer.fromWarehouse,
          referenceType: "other",
          referenceNumber: transfer.transferNumber,
          referenceDocument: transfer._id,
          referenceModel: "StockTransfer",
          notes: `Stock Transfer - ${product.name} - from ${fromWarehouse.name} to ${toWarehouse.name} - TRF#${transfer.transferNumber}`,
          performedBy: req.user.id,
          movementDate: new Date(),
        });
        createdMovementIds.push(outMovement._id);

        // Create transfer in movement (for destination warehouse tracking)
        const inMovement = await StockMovement.create({
          company: companyId,
          product: item.product,
          type: "in",
          reason: "transfer_in",
          quantity: qty,
          previousStock: newStock,
          newStock: newStock,
          unitCost,
          totalCost: lineValue,
          warehouse: transfer.toWarehouse,
          referenceType: "other",
          referenceNumber: transfer.transferNumber,
          referenceDocument: transfer._id,
          referenceModel: "StockTransfer",
          notes: `Stock Transfer - ${product.name} - from ${fromWarehouse.name} to ${toWarehouse.name} - TRF#${transfer.transferNumber}`,
          performedBy: req.user.id,
          movementDate: new Date(),
        });
        createdMovementIds.push(inMovement._id);

        // Update product stock
        product.currentStock = newStock;
        await product.save({ session: trx });

        // ── Sync StockLevel for source warehouse (transfer_out) ────────────
        try {
          await StockLevel.updateOne(
            {
              company_id: companyId,
              product_id: item.product,
              warehouse_id: transfer.fromWarehouse,
              qty_on_hand: { $gte: qty },
            },
            {
              $inc: { qty_on_hand: -qty },
              $set: {
                last_movement_at: new Date(),
                last_movement_type: "transfer_out",
              },
            },
            trx ? { session: trx } : {},
          );
        } catch (slErr) {
          console.error(
            "StockLevel sync (transfer_out) failed:",
            slErr.message,
          );
        }

        // ── Sync StockLevel for destination warehouse (transfer_in, upsert) ──
        try {
          const destLevel = await StockLevel.findOne(
            {
              company_id: companyId,
              product_id: item.product,
              warehouse_id: transfer.toWarehouse,
            },
            null,
            trx ? { session: trx } : {},
          );
          const destPrevQty = destLevel ? destLevel.qty_on_hand || 0 : 0;
          const destPrevAvg = destLevel ? destLevel.avg_cost || 0 : 0;
          const unitCostNum =
            unitCost && unitCost.toString
              ? Number(unitCost.toString())
              : Number(unitCost || 0);
          const destNewQty = Math.round((destPrevQty + qty) * 10000) / 10000;
          const destNewAvg =
            destNewQty > 0
              ? Math.round(
                  ((destPrevQty * destPrevAvg + qty * unitCostNum) /
                    destNewQty) *
                    1000000,
                ) / 1000000
              : unitCostNum;
          const destTotalVal = Math.round(destNewQty * destNewAvg * 100) / 100;

          await StockLevel.findOneAndUpdate(
            {
              company_id: companyId,
              product_id: item.product,
              warehouse_id: transfer.toWarehouse,
            },
            {
              $set: {
                qty_on_hand: destNewQty,
                avg_cost: destNewAvg,
                total_value: destTotalVal,
                last_movement_at: new Date(),
                last_movement_type: "transfer_in",
              },
              $setOnInsert: {
                qty_reserved: 0,
                qty_on_order: 0,
              },
            },
            { upsert: true, ...(trx ? { session: trx } : {}) },
          );
        } catch (slErr) {
          console.error("StockLevel sync (transfer_in) failed:", slErr.message);
        }
      }

      // Resolve inventory accounts for both warehouses (fallback to product inventoryAccount)
      const defaultInv = "1400";
      const fromInv = fromWarehouse.inventoryAccount || null;
      const toInv = toWarehouse.inventoryAccount || null;

      // Always post journal entry for stock transfers (accounting standard)
      const debitAcct =
        toInv ||
        (await JournalService.getMappedAccountCode(
          companyId,
          "purchases",
          "inventory",
          defaultInv,
          { warehouseId: transfer.toWarehouse },
        ));
      const creditAcct =
        fromInv ||
        (await JournalService.getMappedAccountCode(
          companyId,
          "purchases",
          "inventory",
          defaultInv,
          { warehouseId: transfer.fromWarehouse },
        ));

      const debitLine = JournalService.createDebitLine(
        debitAcct,
        totalTransferValue,
        `Stock Transfer ${transfer.transferNumber} - to ${toWarehouse.name}`,
      );
      const creditLine = JournalService.createCreditLine(
        creditAcct,
        totalTransferValue,
        `Stock Transfer ${transfer.transferNumber} - from ${fromWarehouse.name}`,
      );

      // Re-throw journal errors to trigger transaction rollback
      const entryOptions = {
        date: transfer.transferDate || new Date(),
        description: `Stock Transfer - ${transfer.transferNumber}`,
        sourceType: "stock_transfer",
        sourceId: transfer._id,
        sourceReference: transfer.transferNumber,
        lines: [debitLine, creditLine],
        isAutoGenerated: true,
      };

      if (JournalService.createEntriesAtomic) {
        const created = await JournalService.createEntriesAtomic(
          companyId,
          req.user.id,
          [entryOptions],
          { session: trx || null },
        );
        const je = created && created.length ? created[0] : null;
        if (je && je._id) transfer.journalEntry = je._id;
      } else {
        const je = await JournalService.createEntry(
          companyId,
          req.user.id,
          entryOptions,
          trx ? { session: trx } : undefined,
        );
        if (je && je._id) transfer.journalEntry = je._id;
      }

      transfer.status = "in_transit";
      transfer.confirmedBy = req.user.id;
      transfer.confirmedAt = new Date();
      await transfer.save(trx ? { session: trx } : undefined);
    }).catch(async (err) => {
      // Manual rollback: delete created movements if journal failed
      if (createdMovementIds.length > 0) {
        try {
          await StockMovement.deleteMany({ _id: { $in: createdMovementIds } });
        } catch (rbErr) {
          console.error("Failed to rollback movements:", rbErr);
        }
      }
      throw err;
    });

    await transfer.populate([
      { path: "fromWarehouse", select: "name code" },
      { path: "toWarehouse", select: "name code" },
      { path: "items.product", select: "name sku" },
    ]);

    FiscalService.submitBranchTransfer(transfer._id, { companyId })
      .catch((ebmErr) => {
        console.error("EBM branch transfer submission failed after approval:", ebmErr.message);
      });

    emitDataChanged(companyId, "transfers", { affectsStock: true });
    res.json({
      success: true,
      message: "Stock transfer approved and journal/movements recorded",
      data: transfer,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Complete stock transfer (receive)
// @route   POST /api/stock/transfers/:id/complete
// @access  Private (admin, stock_manager)
exports.completeStockTransfer = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { receivedNotes } = req.body;

    const transfer = await StockTransfer.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!transfer) {
      return res
        .status(404)
        .json({ success: false, message: "Stock transfer not found" });
    }

    if (transfer.status !== "in_transit") {
      return res.status(400).json({
        success: false,
        message: "Only in-transit transfers can be completed",
      });
    }

    // Process each item and finalize transfer inside transaction helper
    await runInTransaction(async (trx) => {
      // Re-populate transfer items with product data
      await transfer.populate({ path: "items", populate: { path: "product" } });

      for (const item of transfer.items) {
        // Use already populated product if available, otherwise fetch fresh
        const product =
          item.product && typeof item.product === "object" && item.product._id
            ? item.product
            : await Product.findOne({
                _id: item.product,
                company: companyId,
              }).session(trx || undefined);

        // Get quantity - StockTransferLine uses 'qty' field
        const qty = item.qty ? Number(item.qty.toString()) : item.quantity || 0;

        // Handle batch-tracked products
        if (product?.trackBatch) {
          // Deduct from source warehouse - FIFO means oldest received first
          const sourceBatches = await InventoryBatch.find({
            company: companyId,
            product: item.product,
            warehouse: transfer.fromWarehouse,
            status: { $nin: ["exhausted"] },
            availableQuantity: { $gt: 0 },
          })
            .sort({ receivedAt: 1 })
            .session(trx || undefined);

          let remainingQty = qty;
          for (const batch of sourceBatches) {
            if (remainingQty <= 0) break;
            const deductQty = Math.min(batch.availableQuantity, remainingQty);
            batch.availableQuantity -= deductQty;
            batch.updateStatus();
            await batch.save({ session: trx });
            remainingQty -= deductQty;
          }

          // Add to destination warehouse (check if batch exists)
          const destBatchNumber = item.batchNumber || null;
          let destBatch = await InventoryBatch.findOne({
            company: companyId,
            product: item.product,
            warehouse: transfer.toWarehouse,
            batchNumber: destBatchNumber,
            status: { $nin: ["exhausted"] },
          }).session(trx || undefined);

          if (destBatch) {
            destBatch.quantity += qty;
            destBatch.availableQuantity += qty;
            destBatch.updateStatus();
            await destBatch.save({ session: trx });
          } else if (remainingQty > 0 || qty > 0) {
            // Create new batch for remaining quantity
            destBatch = await InventoryBatch.create({
              company: companyId,
              product: item.product,
              warehouse: transfer.toWarehouse,
              batchNumber: item.batchNumber,
              quantity: qty,
              availableQuantity: qty,
              unitCost: sourceBatches[0]?.unitCost || product?.averageCost || 0,
              totalCost:
                qty * (sourceBatches[0]?.unitCost || product?.averageCost || 0),
              status: "active",
            });
          }
        }
        // Handle serial-tracked products
        else if (product?.trackSerialNumbers && item.serialNumbers) {
          for (const serialNum of item.serialNumbers) {
            const serial = await SerialNumber.findOne({
              company: companyId,
              product: item.product,
              serialNumber: serialNum.toUpperCase(),
              warehouse: transfer.fromWarehouse,
            }).session(trx || undefined);

            if (serial) {
              serial.warehouse = transfer.toWarehouse;
              serial.status = "available";
              await serial.save({ session: trx });
            }
          }
        }
        // Handle regular products (non-batch, non-serial) - check for batches first, fallback to Product.currentStock
        else {
          // Check if there are batches in source warehouse - consume them even if product doesn't track batches
          const sourceBatches = await InventoryBatch.find({
            company: companyId,
            product: item.product,
            warehouse: transfer.fromWarehouse,
            status: { $nin: ["exhausted"] },
            availableQuantity: { $gt: 0 },
          })
            .sort({ receivedAt: 1 })
            .session(trx || undefined);

          if (sourceBatches.length > 0) {
            // Consume from batches (FIFO)
            let remainingQty = qty;
            for (const batch of sourceBatches) {
              if (remainingQty <= 0) break;
              const deductQty = Math.min(batch.availableQuantity, remainingQty);
              batch.availableQuantity -= deductQty;
              batch.updateStatus();
              await batch.save({ session: trx });
              remainingQty -= deductQty;
            }

            // Add remaining to destination (or all if batches were consumed)
            const destBatchNumber = item.batchNumber || null;
            let destBatch = await InventoryBatch.findOne({
              company: companyId,
              product: item.product,
              warehouse: transfer.toWarehouse,
              batchNumber: destBatchNumber,
              status: { $nin: ["exhausted"] },
            }).session(trx || undefined);

            if (destBatch) {
              destBatch.quantity += qty;
              destBatch.availableQuantity += qty;
              destBatch.updateStatus();
              await destBatch.save({ session: trx });
            } else {
              await InventoryBatch.create({
                company: companyId,
                product: item.product,
                warehouse: transfer.toWarehouse,
                batchNumber: item.batchNumber,
                quantity: qty,
                availableQuantity: qty,
                unitCost:
                  sourceBatches[0]?.unitCost || product?.averageCost || 0,
                totalCost:
                  qty *
                  (sourceBatches[0]?.unitCost || product?.averageCost || 0),
                status: "active",
              });
            }
          } else {
            // No batches - stock was already updated during approval, no action needed here
          }
        }
      }

      // Update transfer status
      transfer.status = "completed";
      transfer.completedDate = new Date();
      transfer.receivedBy = req.user.id;
      transfer.receivedDate = new Date();
      transfer.receivedNotes = receivedNotes;
      await transfer.save(trx ? { session: trx } : undefined);
    });

    res.json({
      success: true,
      message: "Stock transfer completed successfully",
      data: transfer,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Cancel stock transfer
// @route   POST /api/stock/transfers/:id/cancel
// @access  Private (admin)
exports.cancelStockTransfer = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { reason } = req.body;

    const transfer = await StockTransfer.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!transfer) {
      return res
        .status(404)
        .json({ success: false, message: "Stock transfer not found" });
    }

    // If transfer is completed, do not allow cancellation (must create reversal flow)
    if (transfer.status === "completed") {
      return res
        .status(400)
        .json({ success: false, message: "Cannot cancel completed transfer" });
    }

    // If transfer was in_transit (approved/confirmed), we should reverse any posted movements and journal
    if (transfer.status === "in_transit") {
      // Reverse stock movements created for this transfer by creating opposite movements
      const movements = await StockMovement.find({
        company: companyId,
        referenceDocument: transfer._id,
        referenceModel: "StockTransfer",
      });
      // Products for every movement in one query; the reversal writes below
      // stay sequential because each depends on the running stock position.
      const reversalProducts = await loadLineProducts(
        Product,
        movements.map((m) => ({ product: m.product })),
        companyId,
      );
      for (const m of movements) {
        const product = getLineProduct(reversalProducts, { product: m.product });
        // create opposite movement
        await StockMovement.create({
          company: companyId,
          product: m.product,
          type: m.type === "in" ? "out" : "in",
          reason:
            m.reason === "transfer_in"
              ? "transfer_out"
              : m.reason === "transfer_out"
                ? "transfer_in"
                : m.reason,
          quantity: m.quantity,
          previousStock: product.currentStock || 0,
          newStock:
            m.type === "in"
              ? Math.max(0, (product.currentStock || 0) - m.quantity)
              : (product.currentStock || 0) + m.quantity,
          unitCost: m.unitCost,
          totalCost: m.totalCost,
          warehouse: m.type === "in" ? m.warehouse : m.warehouse,
          referenceType: "other",
          referenceNumber: transfer.transferNumber,
          referenceDocument: transfer._id,
          referenceModel: "StockTransfer",
          notes: `Reversal - ${m.notes || ""}`,
          performedBy: req.user.id,
          movementDate: new Date(),
        });
      }

      // If a journal entry exists, attempt to reverse it via the journal controller (reuse existing API logic)
      if (transfer.journalEntry) {
        try {
          const reqMock = {
            params: { id: transfer.journalEntry.toString() },
            user: req.user,
            body: { reason: reason || "transfer cancel" },
          };
          // mock res for controller call - return the payload for potential callers
          const resMock = {
            json: (payload) => payload,
            status: () => ({ json: () => {} }),
          };
          await journalController.reverseJournalEntry(
            reqMock,
            resMock,
            () => {},
          );
        } catch (revErr) {
          console.error(
            "Failed to reverse journal entry for transfer:",
            revErr,
          );
        }
      }
    }

    transfer.status = "cancelled";
    transfer.notes = `${transfer.notes || ""}\nCancellation reason: ${reason || "Not specified"}`;
    await transfer.save();

    emitDataChanged(companyId, "transfers", { affectsStock: true });
    res.json({
      success: true,
      message: "Stock transfer cancelled",
      data: transfer,
    });
  } catch (error) {
    next(error);
  }
};
