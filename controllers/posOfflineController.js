'use strict';

const { randomBytes } = require('crypto');
const Product = require('../models/Product');
const StockLevel = require('../models/StockLevel');
const StockSerialNumber = require('../models/StockSerialNumber');
const StockMovement = require('../models/StockMovement');
const TillSession = require('../models/TillSession');
const Warehouse = require('../models/Warehouse');
const SystemSettingsService = require('../services/systemSettingsService');
const posPaymentService = require('../services/posPaymentService');
const AuditLogService = require('../services/AuditLogService');
const { findClaimedRegister } = require('../services/posRegisterService');
const { runInTransaction } = require('../services/transactionService');
const { dbClient } = require('../lib/prisma');
const { issueCapability } = require('../services/posOfflineCapabilityService');
const moduleEntitlementService = require('../services/moduleEntitlementService');
const { getWarehousePriceListPrices, effectivePrice } = require('../services/priceListService');
const { getWarehouseTransferVisibility } = require('../services/posTransferVisibilityService');
const { nextReferenceNo } = require('../utils/referenceNumbers');
const { generateObjectId } = require('../utils/objectId');
const {
  ACTIONS: OFFLINE_ACTIONS,
  normalizeOfflineActionCaps,
  resolveOfflineActionCap,
} = require('../services/posOfflineActionCapsService');
const { resolveOfflinePolicy } = require('../services/posOfflinePolicyService');
const { allocateOfflineReceiptBlock, RECEIPT_BLOCK_SIZE } = require('../services/posOfflineReceiptNumberService');

const id = () => randomBytes(12).toString('hex');
const SNAPSHOT_READ_BATCH_SIZE = 500;
const MAX_SNAPSHOT_PRODUCTS = 5000;
const MAX_SNAPSHOT_SERIALS = 20000;
const MAX_SNAPSHOT_BATCHES = 20000;
const userIdOf = (req) => String(req.user?.id || req.user?._id || '');
const companyIdOf = (req) => String(
  req.company?._id
  || req.company?.id
  || req.user?.company?._id
  || req.user?.company?.id
  || req.user?.company
  || '',
);
const number = (value) => {
  if (value == null) return 0;
  const converted = Number(value.toString ? value.toString() : value);
  return Number.isFinite(converted) ? converted : 0;
};
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const resolveSnapshotTaxRate = (product) => {
  const configured = number(product.taxRate);
  if (configured > 0) return configured;
  const taxCode = String(product.taxCode || '').trim().toUpperCase();
  return taxCode === 'B' ? 18 : 0;
};

async function readSnapshotRowsInBatches(model, filter, { maxRows, select } = {}) {
  const rows = [];
  while (rows.length <= maxRows) {
    const limit = Math.min(SNAPSHOT_READ_BATCH_SIZE, maxRows + 1 - rows.length);
    let query = model.find(filter)
      .sort({ _id: 1 })
      .skip(rows.length)
      .limit(limit);
    if (select) query = query.select(select);
    const batch = await query.lean();
    rows.push(...batch);
    if (batch.length < limit) break;
  }
  return rows;
}

exports.issueSnapshot = async (req, res, next) => {
  try {
    const posContext = req.posAuthContext;
    if (!posContext) {
      return res.status(401).json({ success: false, code: 'POS_SESSION_INVALID', message: 'Sign in to this till again.' });
    }
    const companyId = String(posContext.company.id);
    const userId = String(posContext.session.userId);
    const deviceId = String(req.body?.deviceId || '').trim();
    const registerId = String(req.body?.registerId || '').trim();
    const warehouseId = String(req.body?.warehouseId || '').trim();
    if (!deviceId || deviceId.length > 160 || !registerId || !warehouseId) {
      return res.status(400).json({ success: false, code: 'POS_OFFLINE_SNAPSHOT_BINDING_INVALID', message: 'A device, assigned register, and warehouse are required.' });
    }
    if (deviceId.toLowerCase() !== String(posContext.posDevice.deviceId || '').toLowerCase()
      || registerId !== String(posContext.register.code)) {
      return res.status(403).json({ success: false, code: 'POS_OFFLINE_SNAPSHOT_BINDING_INVALID', message: 'The active POS session does not match this device and register.' });
    }
    const settings = await SystemSettingsService.get(companyId);
    const fiscalEntitlement = await moduleEntitlementService.getEntitlement(companyId, 'fiscal.ebm', { useCache: false });
    const requiresFiscalSubmission = fiscalEntitlement.status === 'on';
    const fiscalMode = requiresFiscalSubmission ? 'ebm' : 'none';
    const claimedRegister = await findClaimedRegister(companyId, registerId, deviceId);
    if (!claimedRegister) {
      return res.status(403).json({ success: false, code: 'POS_REGISTER_CLAIM_REQUIRED', message: 'This device is not assigned to the requested POS register.' });
    }
    const offlinePolicy = resolveOfflinePolicy(settings.pos_offline_policy || settings.posOfflinePolicy, {
      settings: {
        posOfflineEnabled: settings.pos_offline_enabled,
        posOfflineMaxHours: settings.pos_offline_max_hours,
        posOfflineQueueLimit: settings.pos_offline_queue_limit,
        posOfflineMaxSales: settings.pos_offline_max_sales,
        posOfflineMaxSingleSale: settings.pos_offline_max_single_sale,
      },
      tillType: claimedRegister.systemTillType || 'retail',
      registerId: String(claimedRegister.id),
    });
    if (!offlinePolicy.enabled) {
      return res.status(403).json({ success: false, code: 'POS_OFFLINE_DISABLED', message: 'Offline POS is disabled for this register.' });
    }
    const paymentSettings = await posPaymentService.getPaymentSettings(companyId);
    const paymentFlow = posPaymentService.resolvePaymentFlow(paymentSettings, String(claimedRegister.id));
    const [warehouse, till] = await Promise.all([
      Warehouse.findOne({ _id: warehouseId, company: companyId, isActive: { $ne: false } }).lean(),
      TillSession.findOne({
        company: companyId,
        openedBy: userId,
        registerId: claimedRegister.code,
        status: 'open',
      }).lean(),
    ]);
    if (!warehouse || !till) {
      return res.status(409).json({ success: false, code: 'POS_OFFLINE_CONTEXT_UNAVAILABLE', message: 'An active warehouse and an open till for this cashier are required to create an offline snapshot.' });
    }

    const products = await readSnapshotRowsInBatches(
      Product,
      { company: companyId, isActive: true },
      {
        maxRows: MAX_SNAPSHOT_PRODUCTS,
        select: '_id name sku sellingPrice unit taxRate taxCode isStockable trackingType trackSerialNumbers trackBatch averageCost',
      },
    );
    if (products.length > MAX_SNAPSHOT_PRODUCTS) {
      return res.status(413).json({ success: false, code: 'POS_OFFLINE_CATALOG_TOO_LARGE', message: 'The active catalog exceeds the safe offline snapshot limit. Reduce the catalog or use POS online.' });
    }
    const productIds = products.map((product) => product._id);
    const batchProductIds = products
      .filter((product) => product.trackingType === 'batch' || product.trackBatch)
      .map((product) => String(product._id));
    const [stockRows, serialRows, promotionRows, priceListPricing, transferVisibility] = await Promise.all([
      readSnapshotRowsInBatches(StockLevel, {
        company_id: companyId,
        warehouse_id: warehouseId,
        product_id: { $in: productIds },
      }, { maxRows: MAX_SNAPSHOT_PRODUCTS }),
      readSnapshotRowsInBatches(StockSerialNumber, {
        company: companyId,
        warehouse: warehouseId,
        status: { $in: ['in_stock', 'returned'] },
      }, { maxRows: MAX_SNAPSHOT_SERIALS, select: 'product serialNo' }),
      dbClient().$queryRawUnsafe(
        'SELECT id, name, code, discount_type AS "discountType", value, starts_at AS "startsAt", ends_at AS "endsAt" FROM pos_promotions WHERE company_id = $1 AND is_active = TRUE AND starts_at <= CURRENT_TIMESTAMP AND ends_at > CURRENT_TIMESTAMP',
        companyId,
      ),
      getWarehousePriceListPrices(companyId, warehouseId, productIds),
      getWarehouseTransferVisibility(companyId, warehouseId, productIds),
    ]);
    const batchRows = [];
    while (batchProductIds.length && batchRows.length <= MAX_SNAPSHOT_BATCHES) {
      const take = Math.min(SNAPSHOT_READ_BATCH_SIZE, MAX_SNAPSHOT_BATCHES + 1 - batchRows.length);
      const page = await dbClient().stockBatch.findMany({
        where: {
          companyId,
          warehouseId,
          productId: { in: batchProductIds },
          isQuarantined: false,
          qtyOnHand: { gt: 0 },
        },
        select: {
          id: true,
          productId: true,
          batchNo: true,
          qtyOnHand: true,
          reservedQuantity: true,
          unitCost: true,
          expiryDate: true,
          createdAt: true,
        },
        orderBy: { id: 'asc' },
        skip: batchRows.length,
        take,
      });
      batchRows.push(...page);
      if (page.length < take) break;
    }
    if (stockRows.length > MAX_SNAPSHOT_PRODUCTS) {
      return res.status(413).json({ success: false, code: 'POS_OFFLINE_STOCK_CATALOG_TOO_LARGE', message: 'The warehouse stock catalog exceeds the safe offline snapshot limit. Use POS online.' });
    }
    if (serialRows.length > MAX_SNAPSHOT_SERIALS) {
      return res.status(413).json({ success: false, code: 'POS_OFFLINE_SERIAL_CATALOG_TOO_LARGE', message: 'This warehouse has too many available serial numbers for a safe offline snapshot. Use POS online for serialized products.' });
    }
    if (batchRows.length > MAX_SNAPSHOT_BATCHES) {
      return res.status(413).json({ success: false, code: 'POS_OFFLINE_BATCH_CATALOG_TOO_LARGE', message: 'This warehouse has too many batch records for a safe offline snapshot. Use POS online for batch-tracked products.' });
    }
    const stockByProduct = new Map(stockRows.map((row) => [String(row.product_id), row]));
    const serialsByProduct = new Map();
    for (const serial of serialRows) {
      const key = String(serial.product);
      const values = serialsByProduct.get(key) || [];
      values.push(String(serial.serialNo).trim().toUpperCase());
      serialsByProduct.set(key, values);
    }
    const batchesByProduct = new Map();
    const snapshotIssuedAt = Date.now();
    for (const batch of batchRows) {
      const availableQuantity = Math.max(0, number(batch.qtyOnHand) - number(batch.reservedQuantity));
      const expiryDate = batch.expiryDate ? new Date(batch.expiryDate) : null;
      if (availableQuantity <= 0 || (expiryDate && expiryDate.getTime() < snapshotIssuedAt)) continue;
      const key = String(batch.productId);
      const values = batchesByProduct.get(key) || [];
      values.push({
        id: String(batch.id),
        batchNo: String(batch.batchNo || ''),
        availableQuantity,
        expiryDate: expiryDate ? expiryDate.toISOString() : null,
        unitCost: number(batch.unitCost),
        createdAt: batch.createdAt ? new Date(batch.createdAt).getTime() : 0,
      });
      batchesByProduct.set(key, values);
    }
    for (const batches of batchesByProduct.values()) {
      batches.sort((left, right) => (
        (left.expiryDate ? new Date(left.expiryDate).getTime() : Number.MAX_SAFE_INTEGER)
          - (right.expiryDate ? new Date(right.expiryDate).getTime() : Number.MAX_SAFE_INTEGER)
        || left.createdAt - right.createdAt
        || left.id.localeCompare(right.id)
      ));
      for (const batch of batches) delete batch.createdAt;
    }
    const productSnapshots = Object.fromEntries(products.map((product) => {
      const productId = String(product._id);
      const stock = stockByProduct.get(productId);
      const trackingType = product.trackingType === 'serial' || product.trackSerialNumbers
        ? 'serial'
        : product.trackingType === 'batch' || product.trackBatch
          ? 'batch'
          : (product.trackingType || 'none');
      return [productId, {
        name: product.name,
        sku: product.sku || '',
        unit: product.unit || 'pcs',
        standardPrice: number(product.sellingPrice),
        price: effectivePrice(productId, number(product.sellingPrice), priceListPricing.priceByProduct),
        taxRate: resolveSnapshotTaxRate(product),
        taxCode: product.taxCode || (resolveSnapshotTaxRate(product) > 0 ? 'B' : 'A'),
        isStockable: product.isStockable !== false,
        trackingType,
        averageCost: number(product.averageCost),
        availableStock: Math.max(0, number(stock?.qty_on_hand) - number(stock?.qty_reserved)),
        batches: batchesByProduct.get(productId) || [],
        serialNumbers: serialsByProduct.get(productId) || [],
        incomingTransfers: transferVisibility[productId]?.incoming || [],
        outgoingTransfers: transferVisibility[productId]?.outgoing || [],
      }];
    }));
    const issuedAt = Date.now();
    const maxHours = offlinePolicy.maxHours;
    const expiresAt = issuedAt + maxHours * 60 * 60 * 1000;
    const actionCapsConfig = normalizeOfflineActionCaps(
      settings.pos_offline_action_caps || settings.posOfflineActionCaps,
    );
    const offlineActionCaps = Object.fromEntries(OFFLINE_ACTIONS.map((action) => {
      const { scope: _scope, ...cap } = resolveOfflineActionCap(actionCapsConfig, {
        action,
        tillType: claimedRegister.systemTillType || 'retail',
        registerId: String(claimedRegister.id),
      });
      return [action, cap];
    }));
    const snapshotId = id();
    let receiptNumbers;
    let snapshotData;
    const queueLimit = offlinePolicy.maxTotalValueRwf;
    await dbClient().$transaction(async (tx) => {
      // Reserve receipt numbers and persist the snapshot atomically. If snapshot
      // creation fails, PostgreSQL rolls back the reservations as well.
      receiptNumbers = await allocateOfflineReceiptBlock({
        queryRaw: (...args) => tx.$queryRawUnsafe(...args),
        executeRaw: (...args) => tx.$executeRawUnsafe(...args),
        companyId,
        deviceId,
        registerId: String(claimedRegister.id),
        blockId: snapshotId,
        expiresAt: new Date(expiresAt),
        nextReferenceNo,
        generateId: generateObjectId,
        size: RECEIPT_BLOCK_SIZE,
      });
      snapshotData = {
        fiscalMode,
        entitlementVersion: fiscalEntitlement.version,
        products: productSnapshots,
        transfersByProduct: transferVisibility,
        priceListId: priceListPricing.priceListId,
        promotions: promotionRows.map((promotion) => ({
          id: String(promotion.id),
          name: promotion.name,
          code: promotion.code,
          discountType: promotion.discountType,
          value: number(promotion.value),
          startsAt: new Date(promotion.startsAt).toISOString(),
          endsAt: new Date(promotion.endsAt).toISOString(),
        })),
        negativeStockAllowed: Boolean(settings.allow_negative_stock),
        escalationDays: Math.max(1, Math.min(365, Number(settings.pos_negative_stock_escalation_days) || 3)),
        maxHours,
        paymentFlow,
        receiptNumbers,
        offlinePolicy: {
          enabled: true,
          requiresFiscalSubmission,
          provisionalFiscalReceiptsAllowed: offlinePolicy.provisionalFiscalReceiptsAllowed === true,
          maxHours,
          maxSales: offlinePolicy.maxSales,
          maxSingleSaleRwf: offlinePolicy.maxSingleSaleRwf,
          queueLimit: offlinePolicy.maxTotalValueRwf,
          maxTotalValueRwf: offlinePolicy.maxTotalValueRwf,
          actions: offlinePolicy.actions,
          tillType: String(claimedRegister.systemTillType || 'retail').toLowerCase(),
          registerId: String(claimedRegister.id),
          actionCaps: offlineActionCaps,
          offlineManagerApproval: actionCapsConfig.offlineManagerApproval,
        },
      };
      await tx.$executeRawUnsafe(
        'INSERT INTO pos_offline_snapshots (id, company_id, user_id, device_id, register_id, warehouse_id, till_session_id, snapshot_data, fiscal_mode, entitlement_version, queue_limit, issued_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11::numeric, $12::timestamptz, $13::timestamptz)',
        snapshotId, companyId, userId, deviceId, registerId, warehouseId, String(till._id),
        JSON.stringify(snapshotData), fiscalMode, fiscalEntitlement.version, queueLimit, new Date(issuedAt), new Date(expiresAt),
      );
    });
    const capability = issueCapability({
      id: snapshotId,
      companyId,
      userId,
      deviceId,
      registerId,
      warehouseId,
      tillSessionId: String(till._id),
      paymentFlow,
      receiptNumbers,
      requiresFiscalSubmission,
      fiscalMode,
      entitlementVersion: fiscalEntitlement.version,
      provisionalFiscalReceiptsAllowed: offlinePolicy.provisionalFiscalReceiptsAllowed === true,
      issuedAt,
      expiresAt,
    });
    const publicBatchesByProduct = Object.fromEntries(
      [...batchesByProduct.entries()].map(([productId, batches]) => [
        productId,
        batches.map(({ unitCost, ...batch }) => batch),
      ]),
    );
    res.status(200).json({
      success: true,
      data: {
        capability,
        issuedAt: new Date(issuedAt).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
        queueLimit,
        maxHours,
        offlineActionCaps,
        offlineManagerApproval: actionCapsConfig.offlineManagerApproval,
        offlinePolicy: snapshotData.offlinePolicy,
        paymentFlow,
        receiptNumbers,
        productCount: products.length,
        serialNumbersByProduct: Object.fromEntries([...serialsByProduct.entries()]),
        batchesByProduct: publicBatchesByProduct,
        transfersByProduct: transferVisibility,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.listConflicts = async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    await dbClient().$executeRawUnsafe(
      "UPDATE pos_offline_conflicts SET status = 'escalated', updated_at = CURRENT_TIMESTAMP WHERE company_id = $1 AND status = 'open' AND escalation_at <= CURRENT_TIMESTAMP",
      companyId,
    );
    const conflicts = await dbClient().$queryRawUnsafe(
      `SELECT c.id, c.offline_sale_id AS "offlineSaleId", c.invoice_id AS "invoiceId", i.reference_no AS "invoiceNumber", c.product_id AS "productId", p.name AS "productName", c.warehouse_id AS "warehouseId", c.conflict_type AS "conflictType", c.details, c.status, c.escalation_at AS "escalationAt", c.created_at AS "createdAt" FROM pos_offline_conflicts c LEFT JOIN invoices i ON i.id = c.invoice_id AND i.company_id = c.company_id LEFT JOIN products p ON p.id = c.product_id AND p.company_id = c.company_id WHERE c.company_id = $1 AND c.status IN ('open', 'escalated') ORDER BY c.escalation_at ASC, c.created_at ASC LIMIT 500`,
      companyId,
    );
    res.status(200).json({ success: true, data: conflicts });
  } catch (error) {
    next(error);
  }
};

exports.resolveConflict = async (req, res, next) => {
  try {
    const companyId = companyIdOf(req);
    const userId = userIdOf(req);
    const conflictId = String(req.params.conflictId || '');
    const resolution = String(req.body?.resolution || '');
    const reason = String(req.body?.reason || '').trim();
    const evidenceReference = String(req.body?.evidenceReference || '').trim();
    const allowed = new Set(['record_missing_receipt', 'stock_adjustment_recorded', 'confirm_shortage', 'assign_serials']);
    if (!allowed.has(resolution) || reason.length < 10 || reason.length > 1000) {
      return res.status(400).json({ success: false, code: 'POS_OFFLINE_RESOLUTION_INVALID', message: 'Select a supported resolution and provide a reason of 10–1000 characters.' });
    }

    const result = await runInTransaction(async () => {
      const rows = await dbClient().$queryRawUnsafe(
        'SELECT id, offline_sale_id AS "offlineSaleId", invoice_id AS "invoiceId", product_id AS "productId", warehouse_id AS "warehouseId", conflict_type AS "conflictType", details, status, created_at AS "createdAt" FROM pos_offline_conflicts WHERE id = $1 AND company_id = $2 FOR UPDATE',
        conflictId, companyId,
      );
      const conflict = rows[0];
      if (!conflict) throw fail(404, 'POS_OFFLINE_CONFLICT_NOT_FOUND', 'Offline POS conflict was not found.');
      if (!['open', 'escalated'].includes(conflict.status)) throw fail(409, 'POS_OFFLINE_CONFLICT_RESOLVED', 'This offline POS conflict has already been resolved.');
      if (conflict.conflictType === 'serial' && resolution !== 'assign_serials') {
        throw fail(400, 'POS_OFFLINE_RESOLUTION_INVALID', 'Serial conflicts must be resolved by assigning available serial numbers.');
      }
      if (conflict.conflictType === 'stock' && resolution === 'assign_serials') {
        throw fail(400, 'POS_OFFLINE_RESOLUTION_INVALID', 'Serial assignment is only valid for serial conflicts.');
      }

      let serials = [];
      if (resolution === 'assign_serials') {
        if (conflict.conflictType !== 'serial') throw fail(400, 'POS_OFFLINE_RESOLUTION_INVALID', 'Serial assignment is only valid for serial conflicts.');
        serials = Array.isArray(req.body?.serialNumbers)
          ? req.body.serialNumbers.map((value) => String(value).trim().toUpperCase()).filter(Boolean)
          : [];
        const quantity = Number(conflict.details?.quantity) || 0;
        if (serials.length !== quantity || new Set(serials).size !== serials.length) {
          throw fail(400, 'POS_OFFLINE_SERIAL_ASSIGNMENT_INVALID', `Assign exactly ${quantity} unique serial number(s).`);
        }
        const available = await StockSerialNumber.find({
          company: companyId,
          product: conflict.productId,
          warehouse: conflict.warehouseId,
          serialNo: { $in: serials },
          status: { $in: ['in_stock', 'returned'] },
        }).select('_id serialNo').lean();
        if (available.length !== serials.length) throw fail(409, 'POS_OFFLINE_SERIAL_ASSIGNMENT_UNAVAILABLE', 'One or more serial numbers are no longer available in this warehouse.');
        const updated = await StockSerialNumber.updateMany({
          company: companyId,
          product: conflict.productId,
          warehouse: conflict.warehouseId,
          serialNo: { $in: serials },
          status: { $in: ['in_stock', 'returned'] },
        }, { $set: { status: 'dispatched', dispatchedVia: conflict.invoiceId, dispatchedAt: new Date() } });
        if (updated.modifiedCount !== serials.length) throw fail(409, 'POS_OFFLINE_SERIAL_ASSIGNMENT_UNAVAILABLE', 'Serial availability changed while resolving the conflict.');
        await StockMovement.updateMany({
          company: companyId,
          product: conflict.productId,
          warehouse: conflict.warehouseId,
          referenceDocument: conflict.invoiceId,
          reason: 'sale',
        }, { $set: { serialNumbers: serials } });
      } else if (['record_missing_receipt', 'stock_adjustment_recorded'].includes(resolution)) {
        if (evidenceReference.length < 4 || evidenceReference.length > 120) {
          throw fail(400, 'POS_OFFLINE_EVIDENCE_REQUIRED', 'Enter the posted receipt or stock-adjustment reference before resolving this conflict.');
        }
        const movement = await StockMovement.findOne({
          company: companyId,
          product: conflict.productId,
          warehouse: conflict.warehouseId,
          referenceNumber: evidenceReference,
          type: 'in',
          movementDate: { $gte: new Date(conflict.createdAt) },
        }).lean();
        if (!movement) throw fail(409, 'POS_OFFLINE_EVIDENCE_NOT_FOUND', 'No matching posted inbound stock movement was found for this product and warehouse. Post the receipt or adjustment first.');
      } else if (conflict.conflictType === 'serial') {
        throw fail(400, 'POS_OFFLINE_RESOLUTION_INVALID', 'Serial conflicts must be resolved by assigning available serial numbers.');
      }

      const updated = await dbClient().$executeRawUnsafe(
        "UPDATE pos_offline_conflicts SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP, resolved_by_id = $1, resolution = $2, resolution_reason = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4 AND company_id = $5 AND status IN ('open', 'escalated')",
        userId, resolution, JSON.stringify({ reason, evidenceReference: evidenceReference || null, serialNumbers: serials }),
        conflictId, companyId,
      );
      if (updated !== 1) throw fail(409, 'POS_OFFLINE_CONFLICT_RESOLVED', 'This offline POS conflict was resolved by another manager.');
      return { conflict, resolution };
    });

    await AuditLogService.log({
      companyId,
      userId,
      action: 'pos_offline_conflict.resolve',
      entityType: 'pos_offline_conflict',
      entityId: conflictId,
      changes: { resolution: result.resolution, reason, evidenceReference: evidenceReference || null },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });
    res.status(200).json({ success: true, message: 'Offline POS conflict resolved and audited.' });
  } catch (error) {
    next(error);
  }
};
