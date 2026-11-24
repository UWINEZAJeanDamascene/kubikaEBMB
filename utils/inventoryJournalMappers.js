/**
 * Maps Prisma Phase 3 (inventory) + Phase 4 (journal) rows to legacy Mongoose JSON shapes.
 */

const { generateObjectId, toIdString } = require('./objectId');
const { decimalToNumber, decimalToString, idRef, mapTimestamps } = require('./decimalHelpers');
const { mergeUpdatePayload, productToApi, warehouseToApi } = require('./masterDataMappers');
const { withReferenceNo } = require('./referenceNumbers');

function qtyStr(v, dp = 4) {
  return decimalToString(v, dp);
}

function moneyStr(v) {
  return decimalToString(v, 2);
}

function tenantCreateBase(data, companyField = 'company') {
  return {
    id: toIdString(data._id || data.id) || generateObjectId(),
    companyId: toIdString(data[companyField] || data.companyId || data.company_id),
    createdById: data.createdBy
      ? toIdString(data.createdBy)
      : (data.created_by ? toIdString(data.created_by) : null),
  };
}

function pickMapped(data, map, { idFields = [] } = {}) {
  const out = {};
  for (const [key, value] of Object.entries(data)) {
    const target = map[key];
    if (!target || value === undefined) continue;
    if (idFields.includes(target)) {
      out[target] = value ? toIdString(value) : null;
    } else {
      out[target] = value;
    }
  }
  return out;
}

// ── StockLevel (snake_case API) ─────────────────────────────────────────────

function stockLevelToApi(row) {
  if (!row) return null;
  const qtyOnHand = decimalToNumber(row.qtyOnHand, 0);
  const qtyReserved = decimalToNumber(row.qtyReserved, 0);
  return {
    _id: row.id,
    company_id: row.companyId,
    product_id: row.productId,
    warehouse_id: row.warehouseId,
    qty_on_hand: qtyOnHand,
    qty_reserved: qtyReserved,
    qty_on_order: decimalToNumber(row.qtyOnOrder, 0),
    avg_cost: decimalToNumber(row.avgCost, 0),
    total_value: decimalToNumber(row.totalValue, 0),
    qty_available: Math.max(0, qtyOnHand - qtyReserved),
    last_counted_at: row.lastCountedAt ?? null,
    last_counted_by: row.lastCountedById ?? null,
    last_movement_at: row.lastMovementAt ?? null,
    last_movement_type: row.lastMovementType ?? null,
    ...mapTimestamps(row),
  };
}

const STOCK_LEVEL_INPUT = {
  company_id: 'companyId',
  product_id: 'productId',
  warehouse_id: 'warehouseId',
  qty_on_hand: 'qtyOnHand',
  qty_reserved: 'qtyReserved',
  qty_on_order: 'qtyOnOrder',
  avg_cost: 'avgCost',
  total_value: 'totalValue',
  last_counted_at: 'lastCountedAt',
  last_counted_by: 'lastCountedById',
  last_movement_at: 'lastMovementAt',
  last_movement_type: 'lastMovementType',
};

async function stockLevelTranslateCreate(data) {
  const base = tenantCreateBase(data, 'company_id');
  // StockLevel has no created_by column. tenantCreateBase is shared with
  // other inventory models, so remove its default creator field here.
  delete base.createdById;
  const mapped = pickMapped(data, STOCK_LEVEL_INPUT, {
    idFields: ['companyId', 'productId', 'warehouseId', 'lastCountedById'],
  });
  if (mapped.qtyOnHand !== undefined && mapped.avgCost !== undefined) {
    mapped.totalValue = Math.round(Number(mapped.qtyOnHand) * Number(mapped.avgCost) * 100) / 100;
  }
  return { ...base, ...mapped };
}

function stockLevelTranslateUpdate(update = {}) {
  const data = mergeUpdatePayload(update);
  const mapped = pickMapped(data, STOCK_LEVEL_INPUT, {
    idFields: ['lastCountedById'],
  });
  if (mapped.qtyOnHand !== undefined && mapped.avgCost !== undefined) {
    mapped.totalValue = Math.round(Number(mapped.qtyOnHand) * Number(mapped.avgCost) * 100) / 100;
  }
  return mapped;
}

// ── StockMovement ───────────────────────────────────────────────────────────

function stockMovementToApi(row) {
  if (!row) return null;
  const api = {
    _id: row.id,
    company: row.companyId,
    company_id: row.companyId,
    product: row.productId ?? null,
    product_id: row.productId ?? null,
    type: row.type,
    reason: row.reason,
    quantity: qtyStr(row.quantity),
    previousStock: qtyStr(row.previousStock),
    newStock: qtyStr(row.newStock),
    unitCost: moneyStr(row.unitCost),
    totalCost: moneyStr(row.totalCost),
    supplier: row.supplierId ?? null,
    warehouse: row.warehouseId ?? null,
    batchNumber: row.batchNumber ?? null,
    lotNumber: row.lotNumber ?? null,
    serialNumbers: Array.isArray(row.serialNumbers) ? row.serialNumbers : [],
    expiryDate: row.expiryDate ?? null,
    referenceType: row.referenceType ?? null,
    referenceNumber: row.referenceNumber ?? null,
    referenceDocument: row.referenceDocumentId ?? null,
    referenceModel: row.referenceModel ?? null,
    reversalOfMovement: row.reversalOfMovementId ?? null,
    notes: row.notes ?? null,
    performedBy: row.performedById ?? null,
    movementDate: row.movementDate,
    ...(row.fiscalMode === 'none' ? {} : { ebm: row.ebm ?? {} }),
    fiscalMode: row.fiscalMode ?? null,
    fiscalStatus: row.fiscalStatus ?? null,
    ...mapTimestamps(row),
  };
  if (row.product && typeof row.product === 'object') {
    api.product = { _id: row.product.id, ...row.product };
  }
  if (row.supplier && typeof row.supplier === 'object') {
    api.supplier = { _id: row.supplier.id, name: row.supplier.name, code: row.supplier.code };
  }
  if (row.warehouse && typeof row.warehouse === 'object') {
    api.warehouse = { _id: row.warehouse.id, name: row.warehouse.name, code: row.warehouse.code };
  }
  return api;
}

const STOCK_MOVEMENT_INPUT = {
  company: 'companyId',
  company_id: 'companyId',
  product: 'productId',
  product_id: 'productId',
  type: 'type',
  reason: 'reason',
  quantity: 'quantity',
  previousStock: 'previousStock',
  newStock: 'newStock',
  unitCost: 'unitCost',
  totalCost: 'totalCost',
  supplier: 'supplierId',
  warehouse: 'warehouseId',
  batchNumber: 'batchNumber',
  lotNumber: 'lotNumber',
  serialNumbers: 'serialNumbers',
  expiryDate: 'expiryDate',
  referenceType: 'referenceType',
  referenceNumber: 'referenceNumber',
  referenceDocument: 'referenceDocumentId',
  referenceModel: 'referenceModel',
  reversalOfMovement: 'reversalOfMovementId',
  notes: 'notes',
  performedBy: 'performedById',
  movementDate: 'movementDate',
  ebm: 'ebm',
};

/**
 * The schema splits transfers by direction (transfer_in / transfer_out) while the
 * stock adjustment dialog and the legacy transfer service still send a bare
 * `transfer`. Direction comes from the movement type, or from the stock delta when
 * the movement is typed as an adjustment.
 */
function normalizeMovementReason(data, reason) {
  if (reason !== 'transfer') return reason;
  if (data.type === 'out') return 'transfer_out';
  if (data.type === 'in') return 'transfer_in';
  const previous = Number(data.previousStock ?? 0);
  const next = Number(data.newStock ?? previous);
  return next < previous ? 'transfer_out' : 'transfer_in';
}

async function stockMovementTranslateCreate(data) {
  const mapped = pickMapped(data, STOCK_MOVEMENT_INPUT, {
    idFields: ['productId', 'supplierId', 'warehouseId', 'performedById', 'referenceDocumentId', 'reversalOfMovementId'],
  });
  if (mapped.reason !== undefined) mapped.reason = normalizeMovementReason(data, mapped.reason);

  // Stock movements have `performedById`, not `createdById`.  Do not spread
  // tenantCreateBase blindly here: its generic creator field was being dropped
  // by Prisma on every movement write. Treat the legacy `createdBy` input as
  // the actor when callers have not already provided `performedBy`.
  const { createdById: legacyCreatedById, ...tenantBase } = tenantCreateBase(data);
  if (mapped.performedById == null && legacyCreatedById) {
    mapped.performedById = legacyCreatedById;
  }
  return { ...tenantBase, ...mapped };
}

function stockMovementTranslateUpdate(update = {}) {
  return pickMapped(mergeUpdatePayload(update), STOCK_MOVEMENT_INPUT, {
    idFields: ['productId', 'supplierId', 'warehouseId', 'performedById', 'referenceDocumentId', 'reversalOfMovementId'],
  });
}

// ── InventoryBatch ────────────────────────────────────────────────────────────

function inventoryBatchToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    company: row.companyId,
    product: row.productId,
    warehouse: row.warehouseId,
    batchNumber: row.batchNumber ?? null,
    lotNumber: row.lotNumber ?? null,
    expiryDate: row.expiryDate ?? null,
    quantity: decimalToNumber(row.quantity, 0),
    availableQuantity: decimalToNumber(row.availableQuantity, 0),
    reservedQuantity: decimalToNumber(row.reservedQuantity, 0),
    unitCost: decimalToNumber(row.unitCost, 0),
    totalCost: decimalToNumber(row.totalCost, 0),
    supplier: row.supplierId ?? null,
    stockMovement: row.stockMovementId ?? null,
    manufacturingDate: row.manufacturingDate ?? null,
    notes: row.notes ?? null,
    status: row.status,
    receivedDate: row.receivedDate,
    createdBy: row.createdById ?? null,
    isExpired: row.expiryDate ? new Date(row.expiryDate) < new Date() : false,
    ...mapTimestamps(row),
  };
}

const INVENTORY_BATCH_INPUT = {
  company: 'companyId',
  product: 'productId',
  warehouse: 'warehouseId',
  batchNumber: 'batchNumber',
  lotNumber: 'lotNumber',
  expiryDate: 'expiryDate',
  quantity: 'quantity',
  availableQuantity: 'availableQuantity',
  reservedQuantity: 'reservedQuantity',
  unitCost: 'unitCost',
  totalCost: 'totalCost',
  supplier: 'supplierId',
  stockMovement: 'stockMovementId',
  manufacturingDate: 'manufacturingDate',
  notes: 'notes',
  status: 'status',
  receivedDate: 'receivedDate',
  createdBy: 'createdById',
};

async function inventoryBatchTranslateCreate(data) {
  return {
    ...tenantCreateBase(data),
    ...pickMapped(data, INVENTORY_BATCH_INPUT, {
      idFields: ['productId', 'warehouseId', 'supplierId', 'stockMovementId', 'createdById'],
    }),
  };
}

function inventoryBatchTranslateUpdate(update = {}) {
  return pickMapped(mergeUpdatePayload(update), INVENTORY_BATCH_INPUT, {
    idFields: ['productId', 'warehouseId', 'supplierId', 'stockMovementId', 'createdById'],
  });
}

// ── InventoryLayer ────────────────────────────────────────────────────────────

function inventoryLayerToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    company: row.companyId,
    product: row.productId,
    warehouse: row.warehouseId ?? null,
    qtyReceived: decimalToNumber(row.qtyReceived, 0),
    qtyRemaining: decimalToNumber(row.qtyRemaining, 0),
    unitCost: decimalToNumber(row.unitCost, 0),
    receiptDate: row.receiptDate,
    sourceRef: {
      sourceType: row.sourceType ?? null,
      sourceId: row.sourceId ?? null,
    },
    originTransfer: row.originTransferId ?? null,
    originQty: row.originQty != null ? decimalToNumber(row.originQty, 0) : null,
    createdBy: row.createdById ?? null,
    createdAt: row.createdAt,
  };
}

const INVENTORY_LAYER_INPUT = {
  company: 'companyId',
  product: 'productId',
  warehouse: 'warehouseId',
  qtyReceived: 'qtyReceived',
  qtyRemaining: 'qtyRemaining',
  unitCost: 'unitCost',
  receiptDate: 'receiptDate',
  createdBy: 'createdById',
  originTransfer: 'originTransferId',
  originQty: 'originQty',
};

async function inventoryLayerTranslateCreate(data) {
  const mapped = pickMapped(data, INVENTORY_LAYER_INPUT, {
    idFields: ['productId', 'warehouseId', 'createdById', 'originTransferId'],
  });
  if (data.sourceRef) {
    mapped.sourceType = data.sourceRef.sourceType ?? null;
    mapped.sourceId = data.sourceRef.sourceId ? toIdString(data.sourceRef.sourceId) : null;
  }
  return { ...tenantCreateBase(data), ...mapped };
}

function inventoryLayerTranslateUpdate(update = {}) {
  const data = mergeUpdatePayload(update);
  const mapped = pickMapped(data, INVENTORY_LAYER_INPUT, {
    idFields: ['warehouseId', 'createdById', 'originTransferId'],
  });
  if (data.sourceRef) {
    mapped.sourceType = data.sourceRef.sourceType ?? null;
    mapped.sourceId = data.sourceRef.sourceId ? toIdString(data.sourceRef.sourceId) : null;
  }
  return mapped;
}

// ── StockTransfer / Line ──────────────────────────────────────────────────────

function stockTransferLineToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    company: row.companyId,
    transfer: row.transferId,
    product: row.productId,
    qty: decimalToNumber(row.qty, 0),
    unitCost: row.unitCost != null ? decimalToNumber(row.unitCost, 0) : null,
    qtyReceived: decimalToNumber(row.qtyReceived, 0),
    inTransitQty: decimalToNumber(row.inTransitQty, 0),
    inTransitValue: decimalToNumber(row.inTransitValue, 0),
    inventoryIdentity: row.inventoryIdentity ?? {},
    receivedIdentity: row.receivedIdentity ?? {},
    notes: row.notes ?? null,
    createdBy: row.createdById ?? null,
    ...mapTimestamps(row),
  };
}

function stockTransferToApi(row) {
  if (!row) return null;
  const lineCount = row._count?.lines != null ? Number(row._count.lines) : (row.lines || []).length;
  const items = row.lines ? row.lines.map((l) => l.id) : [];
  return {
    _id: row.id,
    company: row.companyId,
    transferNumber: row.transferNumber,
    fromWarehouse: row.fromWarehouseId,
    toWarehouse: row.toWarehouseId,
    items,
    lineCount,
    status: row.status,
    transferDate: row.transferDate,
    expectedArrivalAt: row.expectedArrivalAt ?? null,
    completedDate: row.completedDate ?? null,
    reason: row.reason,
    notes: row.notes ?? null,
    confirmedBy: row.confirmedById ?? null,
    confirmedAt: row.confirmedAt ?? null,
    receivedBy: row.receivedById ?? null,
    receivedDate: row.receivedDate ?? null,
    receivedNotes: row.receivedNotes ?? null,
    discrepancyBy: row.discrepancyById ?? null,
    discrepancyAt: row.discrepancyAt ?? null,
    cancelledBy: row.cancelledById ?? null,
    cancelledAt: row.cancelledAt ?? null,
    inTransitValue: decimalToNumber(row.inTransitValue, 0),
    discrepancies: (row.discrepancies || []).map((item) => ({
      _id: item.id,
      transfer: item.transferId,
      transferLine: item.transferLineId,
      expectedQty: decimalToNumber(item.expectedQty, 0),
      receivedQty: decimalToNumber(item.receivedQty, 0),
      varianceQty: decimalToNumber(item.varianceQty, 0),
      notes: item.notes ?? null,
      recordedBy: item.recordedById,
      recordedAt: item.recordedAt,
      createdAt: item.createdAt,
    })),
    referenceNumber: row.referenceNumber ?? null,
    signatures: row.signatures ?? [],
    journalEntry: row.journalEntryId ?? null,
    ...(row.fiscalMode === 'none' ? {} : { ebm: row.ebm ?? {} }),
    fiscalMode: row.fiscalMode ?? null,
    fiscalStatus: row.fiscalStatus ?? null,
    createdBy: row.createdById ?? null,
    ...mapTimestamps(row),
  };
}

const STOCK_TRANSFER_INPUT = {
  company: 'companyId',
  transferNumber: 'transferNumber',
  fromWarehouse: 'fromWarehouseId',
  toWarehouse: 'toWarehouseId',
  status: 'status',
  transferDate: 'transferDate',
  expectedArrivalAt: 'expectedArrivalAt',
  completedDate: 'completedDate',
  reason: 'reason',
  notes: 'notes',
  confirmedBy: 'confirmedById',
  confirmedAt: 'confirmedAt',
  receivedBy: 'receivedById',
  receivedDate: 'receivedDate',
  receivedNotes: 'receivedNotes',
  discrepancyBy: 'discrepancyById',
  discrepancyAt: 'discrepancyAt',
  cancelledBy: 'cancelledById',
  cancelledAt: 'cancelledAt',
  inTransitValue: 'inTransitValue',
  referenceNumber: 'referenceNumber',
  signatures: 'signatures',
  journalEntry: 'journalEntryId',
  ebm: 'ebm',
  createdBy: 'createdById',
};

async function stockTransferTranslateCreate(data) {
  return {
    ...tenantCreateBase(data),
    ...pickMapped(data, STOCK_TRANSFER_INPUT, {
      idFields: ['fromWarehouseId', 'toWarehouseId', 'confirmedById', 'receivedById', 'discrepancyById', 'cancelledById', 'journalEntryId', 'createdById'],
    }),
  };
}

function stockTransferTranslateUpdate(update = {}) {
  return pickMapped(mergeUpdatePayload(update), STOCK_TRANSFER_INPUT, {
    idFields: ['fromWarehouseId', 'toWarehouseId', 'confirmedById', 'receivedById', 'discrepancyById', 'cancelledById', 'journalEntryId', 'createdById'],
  });
}

const STOCK_TRANSFER_LINE_INPUT = {
  company: 'companyId',
  transfer: 'transferId',
  product: 'productId',
  qty: 'qty',
  unitCost: 'unitCost',
  qtyReceived: 'qtyReceived',
  inTransitQty: 'inTransitQty',
  inTransitValue: 'inTransitValue',
  inventoryIdentity: 'inventoryIdentity',
  receivedIdentity: 'receivedIdentity',
  notes: 'notes',
  createdBy: 'createdById',
};

async function stockTransferLineTranslateCreate(data) {
  return {
    ...tenantCreateBase(data),
    ...pickMapped(data, STOCK_TRANSFER_LINE_INPUT, {
      idFields: ['transferId', 'productId', 'createdById'],
    }),
  };
}

function stockTransferLineTranslateUpdate(update = {}) {
  return pickMapped(mergeUpdatePayload(update), STOCK_TRANSFER_LINE_INPUT, {
    idFields: ['transferId', 'productId', 'createdById'],
  });
}

// ── StockAudit / Line ─────────────────────────────────────────────────────────

function stockAuditLineToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    audit: row.auditId ?? null,
    product: row.productId,
    qtySystem: row.qtySystem,
    qtyCounted: row.qtyCounted ?? null,
    qtyVariance: row.qtyVariance,
    unitCost: row.unitCost,
    varianceValue: row.varianceValue,
    journalEntry: row.journalEntryId ?? null,
    notes: row.notes ?? null,
    ...mapTimestamps(row),
  };
}

function stockAuditToApi(row) {
  if (!row) return null;
  const items = (row.lines || []).map(stockAuditLineToApi);
  return {
    _id: row.id,
    company: row.companyId,
    referenceNo: row.referenceNo,
    warehouse: row.warehouseId,
    auditDate: row.auditDate,
    status: row.status,
    totalVarianceValue: row.totalVarianceValue,
    notes: row.notes ?? null,
    postedBy: row.postedById ?? null,
    postedAt: row.postedAt ?? null,
    createdBy: row.createdById,
    type: row.type,
    category: row.categoryId ?? null,
    items,
    totalItems: row.totalItems,
    itemsCounted: row.itemsCounted,
    itemsWithVariance: row.itemsWithVariance,
    journalEntry: row.journalEntryId ?? null,
    approvedBy: row.approvedById ?? null,
    approvedDate: row.approvedDate ?? null,
    startDate: row.startDate,
    completedDate: row.completedDate ?? null,
    dueDate: row.dueDate ?? null,
    ...mapTimestamps(row),
  };
}

const STOCK_AUDIT_INPUT = {
  company: 'companyId',
  referenceNo: 'referenceNo',
  warehouse: 'warehouseId',
  auditDate: 'auditDate',
  status: 'status',
  totalVarianceValue: 'totalVarianceValue',
  notes: 'notes',
  postedBy: 'postedById',
  postedAt: 'postedAt',
  createdBy: 'createdById',
  type: 'type',
  category: 'categoryId',
  totalItems: 'totalItems',
  itemsCounted: 'itemsCounted',
  itemsWithVariance: 'itemsWithVariance',
  journalEntry: 'journalEntryId',
  approvedBy: 'approvedById',
  approvedDate: 'approvedDate',
  startDate: 'startDate',
  completedDate: 'completedDate',
  dueDate: 'dueDate',
};

async function stockAuditTranslateCreate(data) {
  return {
    ...tenantCreateBase(data),
    ...pickMapped(data, STOCK_AUDIT_INPUT, {
      idFields: ['warehouseId', 'postedById', 'createdById', 'categoryId', 'journalEntryId', 'approvedById'],
    }),
  };
}

function stockAuditTranslateUpdate(update = {}) {
  return pickMapped(mergeUpdatePayload(update), STOCK_AUDIT_INPUT, {
    idFields: ['warehouseId', 'postedById', 'categoryId', 'journalEntryId', 'approvedById'],
  });
}

// ── ReorderPoint ──────────────────────────────────────────────────────────────

function reorderPointToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    company: row.companyId,
    product: row.productId,
    supplier: row.supplierId,
    reorderPoint: decimalToNumber(row.reorderPoint, 0),
    reorderQuantity: decimalToNumber(row.reorderQuantity, 0),
    safetyStock: decimalToNumber(row.safetyStock, 0),
    maxStock: row.maxStock != null ? decimalToNumber(row.maxStock, 0) : null,
    leadTimeDays: row.leadTimeDays,
    estimatedUnitCost: row.estimatedUnitCost != null ? decimalToNumber(row.estimatedUnitCost, 0) : null,
    autoReorder: row.autoReorder,
    isActive: row.isActive,
    lastReorderDate: row.lastReorderDate ?? null,
    lastReorderQuantity: row.lastReorderQuantity != null ? decimalToNumber(row.lastReorderQuantity, 0) : null,
    lastReorderPrice: row.lastReorderPrice != null ? decimalToNumber(row.lastReorderPrice, 0) : null,
    nextReorderDate: row.nextReorderDate ?? null,
    notes: row.notes ?? null,
    createdBy: row.createdById ?? null,
    ...mapTimestamps(row),
  };
}

const REORDER_POINT_INPUT = {
  company: 'companyId',
  product: 'productId',
  supplier: 'supplierId',
  reorderPoint: 'reorderPoint',
  reorderQuantity: 'reorderQuantity',
  safetyStock: 'safetyStock',
  maxStock: 'maxStock',
  leadTimeDays: 'leadTimeDays',
  estimatedUnitCost: 'estimatedUnitCost',
  autoReorder: 'autoReorder',
  isActive: 'isActive',
  lastReorderDate: 'lastReorderDate',
  lastReorderQuantity: 'lastReorderQuantity',
  lastReorderPrice: 'lastReorderPrice',
  nextReorderDate: 'nextReorderDate',
  notes: 'notes',
  createdBy: 'createdById',
};

async function reorderPointTranslateCreate(data) {
  return {
    ...tenantCreateBase(data),
    ...pickMapped(data, REORDER_POINT_INPUT, {
      idFields: ['productId', 'supplierId', 'createdById'],
    }),
  };
}

function reorderPointTranslateUpdate(update = {}) {
  return pickMapped(mergeUpdatePayload(update), REORDER_POINT_INPUT, {
    idFields: ['productId', 'supplierId', 'createdById'],
  });
}

// ── StockBatch / StockSerialNumber ────────────────────────────────────────────

function stockBatchToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    company: row.companyId,
    batchNo: row.batchNo,
    product: row.product ? productToApi(row.product) : row.productId,
    warehouse: row.warehouse ? warehouseToApi(row.warehouse) : row.warehouseId,
    grn: row.grnId ?? null,
    qtyReceived: decimalToNumber(row.qtyReceived, 0),
    qtyOnHand: decimalToNumber(row.qtyOnHand, 0),
    reservedQuantity: decimalToNumber(row.reservedQuantity, 0),
    unitCost: decimalToNumber(row.unitCost, 0),
    manufactureDate: row.manufactureDate ?? null,
    expiryDate: row.expiryDate ?? null,
    lotNumber: row.lotNumber ?? null,
    recallStatus: row.recallStatus || 'active',
    isQuarantined: row.isQuarantined,
    notes: row.notes ?? null,
    ...mapTimestamps(row),
  };
}

const STOCK_BATCH_INPUT = {
  company: 'companyId',
  batchNo: 'batchNo',
  product: 'productId',
  warehouse: 'warehouseId',
  grn: 'grnId',
  qtyReceived: 'qtyReceived',
  qtyOnHand: 'qtyOnHand',
  unitCost: 'unitCost',
  manufactureDate: 'manufactureDate',
  expiryDate: 'expiryDate',
  lotNumber: 'lotNumber',
  recallStatus: 'recallStatus',
  isQuarantined: 'isQuarantined',
  notes: 'notes',
};

async function stockBatchTranslateCreate(data) {
  const base = tenantCreateBase(data);
  // StockBatch has no created_by column in the Prisma schema.
  delete base.createdById;
  return {
    ...base,
    ...pickMapped(data, STOCK_BATCH_INPUT, { idFields: ['productId', 'warehouseId', 'grnId'] }),
  };
}

function stockBatchTranslateUpdate(update = {}) {
  return pickMapped(mergeUpdatePayload(update), STOCK_BATCH_INPUT, {
    idFields: ['productId', 'warehouseId', 'grnId'],
  });
}

function stockSerialNumberToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    company: row.companyId,
    serialNo: row.serialNo,
    product: row.product ? productToApi(row.product) : row.productId,
    warehouse: row.warehouse ? warehouseToApi(row.warehouse) : row.warehouseId,
    grn: row.grnId ?? null,
    batch: row.batch ? stockBatchToApi(row.batch) : row.batchId ?? null,
    unitCost: decimalToNumber(row.unitCost, 0),
    status: row.status,
    dispatchedVia: row.dispatchedVia ?? null,
    dispatchedAt: row.dispatchedAt ?? null,
    returnedVia: row.returnedVia ?? null,
    returnedAt: row.returnedAt ?? null,
    notes: row.notes ?? null,
    ...mapTimestamps(row),
  };
}

const STOCK_SERIAL_INPUT = {
  company: 'companyId',
  serialNo: 'serialNo',
  product: 'productId',
  warehouse: 'warehouseId',
  grn: 'grnId',
  batch: 'batchId',
  unitCost: 'unitCost',
  status: 'status',
  dispatchedVia: 'dispatchedVia',
  dispatchedAt: 'dispatchedAt',
  returnedVia: 'returnedVia',
  returnedAt: 'returnedAt',
  notes: 'notes',
};

async function stockSerialNumberTranslateCreate(data) {
  const base = tenantCreateBase(data);
  // StockSerialNumber has no created_by column in the Prisma schema.
  delete base.createdById;
  return {
    ...base,
    ...pickMapped(data, STOCK_SERIAL_INPUT, {
      idFields: ['productId', 'warehouseId', 'grnId', 'batchId'],
    }),
  };
}

function stockSerialNumberTranslateUpdate(update = {}) {
  return pickMapped(mergeUpdatePayload(update), STOCK_SERIAL_INPUT, {
    idFields: ['productId', 'warehouseId', 'grnId', 'batchId'],
  });
}

// ── Journal ───────────────────────────────────────────────────────────────────

function journalLineToApi(line) {
  if (!line) return null;
  return {
    accountCode: line.accountCode,
    accountName: line.accountName,
    description: line.description ?? null,
    debit: moneyStr(line.debit),
    credit: moneyStr(line.credit),
    reference: line.reference ?? null,
    reconciled: Boolean(line.reconciled),
    matchedStatementLineId: line.matchedStatementLineId ?? null,
  };
}

function journalEntryToApi(row) {
  if (!row) return null;
  const lines = (row.lines || [])
    .sort((a, b) => (a.lineOrder ?? 0) - (b.lineOrder ?? 0))
    .map(journalLineToApi);
  const totalDebit = moneyStr(row.totalDebit);
  const totalCredit = moneyStr(row.totalCredit);
  return {
    _id: row.id,
    company: row.companyId,
    entryNumber: row.entryNumber,
    date: row.date,
    description: row.description,
    sourceType: row.sourceType ?? null,
    sourceId: row.sourceId ?? null,
    sourceReference: row.sourceReference ?? null,
    reference: row.reference ?? row.sourceReference ?? null,
    lines,
    status: row.status,
    totalDebit,
    totalCredit,
    debitTotal: totalDebit,
    creditTotal: totalCredit,
    isAutoGenerated: row.isAutoGenerated,
    reversalOf: row.reversalOfId ?? null,
    createdBy: row.createdById,
    postedBy: row.postedById ?? null,
    notes: row.notes ?? null,
    reversed: row.reversed,
    reconciliationStatus: row.reconciliationStatus,
    reconciledAt: row.reconciledAt ?? null,
    reconciledInReconciliationId: row.reconciledInReconciliationId ?? null,
    reconciledBy: row.reconciledById ?? null,
    isReconciliationAdjustingEntry: row.isReconciliationAdjustingEntry,
    reversedAt: row.reversedAt ?? null,
    reversedBy: row.reversedById ?? null,
    reversalEntryId: row.reversalEntryId ?? null,
    isLocked: row.isLocked,
    lockedAt: row.lockedAt ?? null,
    lockedBy: row.lockedById ?? null,
    lockedReason: row.lockedReason ?? null,
    ...mapTimestamps(row),
  };
}

function linesToPrismaCreate(companyId, lines = []) {
  return lines.map((line, idx) => {
    const row = {
      id: generateObjectId(),
      companyId,
      lineOrder: idx,
      accountCode: line.accountCode,
      accountName: line.accountName || line.accountCode,
      description: line.description || null,
      debit: moneyStr(line.debit),
      credit: moneyStr(line.credit),
      reference: line.reference || null,
      reconciled: Boolean(line.reconciled),
    };
    if (line.matchedStatementLineId) {
      row.matchedStatementLineId = toIdString(line.matchedStatementLineId);
    }
    // Omit null accountId — keeps Prisma on UncheckedCreateInput (companyId) path.
    if (line.accountId) {
      row.accountId = toIdString(line.accountId);
    }
    return row;
  });
}

async function journalEntryTranslateCreate(data) {
  const base = tenantCreateBase(data);
  const lines = Array.isArray(data.lines) ? data.lines : [];
  const sumDebit = lines.reduce((s, l) => s + decimalToNumber(l.debit, 0), 0);
  const sumCredit = lines.reduce((s, l) => s + decimalToNumber(l.credit, 0), 0);
  // createdById is required on JournalEntry — fall back to postedBy when callers only set that.
  const createdById =
    toIdString(data.createdBy || data.createdById || data.postedBy || data.postedById || base.createdById)
    || null;
  if (!createdById) {
    throw new Error('Journal entry requires createdBy (or postedBy)');
  }
  if (!base.companyId) {
    throw new Error('Journal entry requires company');
  }

  return {
    ...base,
    createdById,
    entryNumber: data.entryNumber,
    date: data.date || new Date(),
    description: data.description,
    sourceType: data.sourceType ?? null,
    sourceId: data.sourceId != null ? String(data.sourceId) : null,
    sourceReference: data.sourceReference ?? data.reference ?? null,
    reference: data.reference ?? data.sourceReference ?? null,
    status: data.status || 'draft',
    totalDebit: sumDebit.toFixed(2),
    totalCredit: sumCredit.toFixed(2),
    debitTotal: sumDebit.toFixed(2),
    creditTotal: sumCredit.toFixed(2),
    isAutoGenerated: Boolean(data.isAutoGenerated),
    reversalOfId: data.reversalOf ? toIdString(data.reversalOf) : null,
    postedById: data.postedBy ? toIdString(data.postedBy) : (data.postedById ? toIdString(data.postedById) : null),
    notes: data.notes ?? null,
    reversed: Boolean(data.reversed),
    reconciliationStatus: data.reconciliationStatus || 'unreconciled',
    lines: { create: linesToPrismaCreate(base.companyId, lines) },
  };
}

function journalEntryTranslateUpdate(update = {}) {
  const data = mergeUpdatePayload(update);
  const out = {};
  const map = {
    entryNumber: 'entryNumber',
    date: 'date',
    description: 'description',
    sourceType: 'sourceType',
    sourceId: 'sourceId',
    sourceReference: 'sourceReference',
    reference: 'reference',
    status: 'status',
    totalDebit: 'totalDebit',
    totalCredit: 'totalCredit',
    debitTotal: 'debitTotal',
    creditTotal: 'creditTotal',
    isAutoGenerated: 'isAutoGenerated',
    reversalOf: 'reversalOfId',
    postedBy: 'postedById',
    notes: 'notes',
    reversed: 'reversed',
    reconciliationStatus: 'reconciliationStatus',
    isLocked: 'isLocked',
    lockedReason: 'lockedReason',
  };
  Object.assign(out, pickMapped(data, map, { idFields: ['reversalOfId', 'postedById'] }));
  return out;
}

function accountBalanceToApi(row) {
  if (!row) return null;
  const debit = decimalToNumber(row.debit, 0);
  const credit = decimalToNumber(row.credit, 0);
  return {
    _id: row.id,
    company: row.companyId,
    accountCode: row.accountCode,
    debit,
    credit,
    net: debit - credit,
    updatedAt: row.updatedAt,
  };
}

function accountMappingToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    company: row.companyId,
    module: row.module,
    key: row.key,
    accountCode: row.accountCode,
    description: row.description ?? null,
    createdBy: row.createdById ?? null,
    ...mapTimestamps(row),
  };
}

const ACCOUNT_MAPPING_INPUT = {
  company: 'companyId',
  module: 'module',
  key: 'key',
  accountCode: 'accountCode',
  description: 'description',
  createdBy: 'createdById',
};

async function accountMappingTranslateCreate(data) {
  return {
    ...tenantCreateBase(data),
    ...pickMapped(data, ACCOUNT_MAPPING_INPUT, { idFields: ['createdById'] }),
  };
}

function accountMappingTranslateUpdate(update = {}) {
  return pickMapped(mergeUpdatePayload(update), ACCOUNT_MAPPING_INPUT, { idFields: ['createdById'] });
}

function accountingPeriodToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    company_id: row.companyId,
    name: row.name,
    period_type: row.periodType,
    start_date: row.startDate,
    end_date: row.endDate,
    fiscal_year: row.fiscalYear,
    status: row.status,
    closed_by: row.closedById ?? null,
    closed_at: row.closedAt ?? null,
    year_end_close_entry_id: row.yearEndCloseEntryId ?? null,
    is_year_end: row.isYearEnd,
    ...mapTimestamps(row),
  };
}

const ACCOUNTING_PERIOD_INPUT = {
  company_id: 'companyId',
  name: 'name',
  period_type: 'periodType',
  start_date: 'startDate',
  end_date: 'endDate',
  fiscal_year: 'fiscalYear',
  status: 'status',
  closed_by: 'closedById',
  closed_at: 'closedAt',
  year_end_close_entry_id: 'yearEndCloseEntryId',
  is_year_end: 'isYearEnd',
};

async function accountingPeriodTranslateCreate(data) {
  return {
    ...tenantCreateBase(data, 'company_id'),
    ...pickMapped(data, ACCOUNTING_PERIOD_INPUT, {
      idFields: ['closedById', 'yearEndCloseEntryId'],
    }),
  };
}

function accountingPeriodTranslateUpdate(update = {}) {
  return pickMapped(mergeUpdatePayload(update), ACCOUNTING_PERIOD_INPUT, {
    idFields: ['closedById', 'yearEndCloseEntryId'],
  });
}

function periodToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    company: row.companyId,
    name: row.name ?? null,
    startDate: row.startDate,
    endDate: row.endDate,
    status: row.status,
    ...mapTimestamps(row),
  };
}

const PERIOD_INPUT = {
  company: 'companyId',
  name: 'name',
  startDate: 'startDate',
  endDate: 'endDate',
  status: 'status',
};

async function periodTranslateCreate(data) {
  return {
    ...tenantCreateBase(data),
    ...pickMapped(data, PERIOD_INPUT),
  };
}

function periodTranslateUpdate(update = {}) {
  return pickMapped(mergeUpdatePayload(update), PERIOD_INPUT);
}

module.exports = {
  stockLevelToApi,
  stockLevelTranslateCreate,
  stockLevelTranslateUpdate,
  stockMovementToApi,
  stockMovementTranslateCreate,
  stockMovementTranslateUpdate,
  inventoryBatchToApi,
  inventoryBatchTranslateCreate,
  inventoryBatchTranslateUpdate,
  inventoryLayerToApi,
  inventoryLayerTranslateCreate,
  inventoryLayerTranslateUpdate,
  stockTransferToApi,
  stockTransferLineToApi,
  stockTransferTranslateCreate: withReferenceNo('TRF', stockTransferTranslateCreate, {
    field: 'transferNumber',
    model: 'stockTransfer',
  }),
  stockTransferTranslateUpdate,
  stockTransferLineTranslateCreate,
  stockTransferLineTranslateUpdate,
  stockAuditToApi,
  stockAuditLineToApi,
  stockAuditTranslateCreate: withReferenceNo('AUD', stockAuditTranslateCreate, { model: 'stockAudit' }),
  stockAuditTranslateUpdate,
  reorderPointToApi,
  reorderPointTranslateCreate,
  reorderPointTranslateUpdate,
  stockBatchToApi,
  stockBatchTranslateCreate,
  stockBatchTranslateUpdate,
  stockSerialNumberToApi,
  stockSerialNumberTranslateCreate,
  stockSerialNumberTranslateUpdate,
  journalEntryToApi,
  journalLineToApi,
  journalEntryTranslateCreate,
  journalEntryTranslateUpdate,
  linesToPrismaCreate,
  accountBalanceToApi,
  accountMappingToApi,
  accountMappingTranslateCreate,
  accountMappingTranslateUpdate,
  accountingPeriodToApi,
  accountingPeriodTranslateCreate,
  accountingPeriodTranslateUpdate,
  periodToApi,
  periodTranslateCreate,
  periodTranslateUpdate,
  tenantCreateBase,
  qtyStr,
  moneyStr,
};
