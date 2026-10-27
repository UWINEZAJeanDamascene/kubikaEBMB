/**
 * Phase 5 (Sales/AR) + Phase 6 (Purchases/AP) mappers.
 */

const { generateObjectId, toIdString } = require('./objectId');
const { decimalToNumber, decimalToString, mapTimestamps } = require('./decimalHelpers');
const { tenantCreateBase } = require('./inventoryJournalMappers');
const { mergeUpdatePayload } = require('./masterDataMappers');
const { withReferenceNo } = require('./referenceNumbers');

const moneyStr = (v) => decimalToString(v, 2);
const qtyNum = (v) => decimalToNumber(v, 0);

function amountFromPaymentValue(value) {
  if (value == null || value === '') return 0;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const normalized = value.replace(/[^0-9,.-]+/g, '').replace(/,/g, '');
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (typeof value === 'object') {
    const parsed = Number(value.toString());
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function mapLines(row, mapper, key = 'lines') {
  return (row[key] || []).sort((a, b) => (a.lineOrder ?? 0) - (b.lineOrder ?? 0)).map(mapper);
}

function lineBase(row, extra = {}) {
  return {
    _id: row.id,
    lineId: row.lineId || row.id,
    product: row.productId,
    ...extra,
  };
}

/** Included Prisma relation rows carry `id`; legacy consumers expect `_id`. */
function relationRef(row, id) {
  if (!row || typeof row !== 'object') return id ?? null;
  const { id: rowId, ...rest } = row;
  return { _id: rowId, ...rest };
}

// ── Quotation ────────────────────────────────────────────────────────────────

function quotationLineToApi(row) {
  if (!row) return null;
  return {
    ...lineBase(row, {
      productName: row.productName ?? null,
      productSku: row.productSku ?? null,
      productUnit: row.productUnit ?? null,
      description: row.description ?? null,
      qty: qtyNum(row.qty),
      unit: row.unit ?? null,
      unitPrice: qtyNum(row.unitPrice),
      discountPct: qtyNum(row.discountPct),
      taxRate: qtyNum(row.taxRate),
      lineSubtotal: qtyNum(row.lineSubtotal),
      lineDiscount: qtyNum(row.lineDiscount),
      lineTotal: qtyNum(row.lineTotal),
      lineTax: qtyNum(row.lineTax),
      ...(row.extra || {}),
    }),
    product: row.product && typeof row.product === 'object'
      ? { _id: row.product.id, name: row.product.name, sku: row.product.sku, unit: row.product.unit }
      : row.productId,
  };
}

function quotationToApi(row) {
  if (!row) return null;
  const lines = mapLines(row, quotationLineToApi);
  const lineCount = row._count?.lines != null
    ? Number(row._count.lines)
    : (Array.isArray(lines) ? lines.length : 0);
  return {
    _id: row.id,
    company: row.companyId,
    referenceNo: row.referenceNo,
    client: relationRef(row.client, row.clientId),
    quotationDate: row.quotationDate,
    expiryDate: row.expiryDate ?? null,
    status: row.status,
    currencyCode: row.currencyCode,
    baseCurrency: row.baseCurrency,
    exchangeRate: qtyNum(row.exchangeRate),
    subtotal: qtyNum(row.subtotal),
    totalDiscount: qtyNum(row.totalDiscount),
    taxAmount: qtyNum(row.taxAmount),
    totalAmount: qtyNum(row.totalAmount),
    subtotalBase: qtyNum(row.subtotalBase),
    totalAmountBase: qtyNum(row.totalAmountBase),
    terms: row.terms ?? null,
    notes: row.notes ?? null,
    customerAction: row.customerAction ?? {},
    convertedToInvoice: row.convertedToInvoiceId ?? null,
    convertedToSalesOrder: row.convertedToSalesOrderId ?? null,
    conversionDate: row.conversionDate ?? null,
    approvedBy: row.approvedById ?? null,
    approvedDate: row.approvedDate ?? null,
    createdBy: row.createdById ?? null,
    quotationNumber: row.referenceNo,
    validUntil: row.expiryDate ?? null,
    grandTotal: qtyNum(row.totalAmount),
    publicAcceptToken: row.customerAction?.publicAcceptToken ?? null,
    publicRejectToken: row.customerAction?.publicRejectToken ?? null,
    publicTokenExpiresAt: row.customerAction?.publicTokenExpiresAt ?? null,
    lineCount,
    lines: lines.length ? lines : [],
    ...mapTimestamps(row),
  };
}

// ── Invoice (hottest read path) ──────────────────────────────────────────────

function invoiceLineToApi(row) {
  if (!row) return null;
  const api = {
    ...lineBase(row, {
      productName: row.productName ?? null,
      productCode: row.productCode ?? null,
      description: row.description ?? null,
      qty: qtyNum(row.qty),
      quantity: qtyNum(row.qty),
      unit: row.unit ?? null,
      unitPrice: qtyNum(row.unitPrice),
      discountPct: qtyNum(row.discountPct),
      taxRate: qtyNum(row.taxRate),
      taxCode: row.taxCode,
      lineSubtotal: qtyNum(row.lineSubtotal),
      lineTax: qtyNum(row.lineTax),
      lineTotal: qtyNum(row.lineTotal),
      unitCost: moneyStr(row.unitCost),
      cogsAmount: moneyStr(row.cogsAmount),
      warehouse: row.warehouseId ?? null,
      projectId: row.projectId ?? null,
      qtyDelivered: qtyNum(row.qtyDelivered),
      qtyCredited: qtyNum(row.qtyCredited),
      itemCode: row.productCode ?? null,
      subtotal: qtyNum(row.lineSubtotal),
      taxAmount: qtyNum(row.lineTax),
      totalWithTax: qtyNum(row.lineTotal),
    }),
  };
  if (row.product && typeof row.product === 'object') {
    api.product = {
      _id: row.product.id,
      name: row.product.name,
      sku: row.product.sku,
      barcode: row.product.barcode ?? null,
      unit: row.product.unit,
      ebm: row.product.ebm ?? {},
      ...(row.product.taxCode != null ? { taxCode: row.product.taxCode } : {}),
      ...(row.product.taxRate != null ? { taxRate: qtyNum(row.product.taxRate) } : {}),
      ...(row.product.trackingType != null ? { trackingType: row.product.trackingType } : {}),
      ...(row.product.isStockable != null ? { isStockable: row.product.isStockable } : {}),
    };
  }
  return api;
}

function invoiceToApi(row) {
  if (!row) return null;
  const lines = mapLines(row, invoiceLineToApi);
  const linesSubtotal = lines.reduce((s, l) => s + (Number(l.lineSubtotal) || 0), 0);
  const linesTax = lines.reduce((s, l) => s + (Number(l.lineTax) || Number(l.taxAmount) || 0), 0);
  const linesTotal = lines.reduce((s, l) => s + (Number(l.lineTotal) || Number(l.totalWithTax) || 0), 0);
  const headerSubtotal = qtyNum(row.subtotal);
  const headerTax = qtyNum(row.taxAmount);
  const headerTotal = qtyNum(row.totalAmount);
  const subtotal = headerSubtotal > 0 ? headerSubtotal : linesSubtotal;
  const taxAmount = headerTax > 0 ? headerTax : linesTax;
  const totalAmount = headerTotal > 0 ? headerTotal : linesTotal;
  const amountPaid = qtyNum(row.amountPaid);
  const lineDiscount = lines.reduce((sum, line) => sum + (
    (Number(line.lineSubtotal) || 0) * (Number(line.discountPct) || 0) / 100
  ), 0);
  const posPromotion = row.posPromotion ?? null;
  const totalDiscount = qtyNum(row.totalDiscount) > 0
    ? qtyNum(row.totalDiscount)
    : Math.max(lineDiscount, qtyNum(posPromotion?.discountAmount));
  const outstanding = row.amountOutstanding != null
    ? Math.round(Math.max(0, qtyNum(row.amountOutstanding)) * 100) / 100
    : Math.round(Math.max(0, totalAmount - amountPaid) * 100) / 100;
  // POS amounts are persisted to cents. Older sales could retain a partial
  // status from a sub-cent float difference while the stored paid/balance
  // figures correctly show a settlement. Present the financially consistent
  // terminal status in API reads without rewriting historical ledger rows.
  const status = row.status !== 'cancelled'
    && row.status !== 'draft'
    && totalAmount > 0
    && amountPaid >= totalAmount - 0.009
    && outstanding <= 0.009
    ? 'fully_paid'
    : row.status;
  return {
    _id: row.id,
    company: row.companyId,
    referenceNo: row.referenceNo,
    invoiceNumber: row.referenceNo,
    client: relationRef(row.client, row.clientId),
    customerTin: row.customerTin ?? null,
    customerName: row.customerName ?? null,
    customerAddress: row.customerAddress ?? null,
    quotation: row.quotationId ?? null,
    salesOrder: row.salesOrderId ?? null,
    deliveryNote: row.deliveryNoteId ?? null,
    status,
    posOrigin: Boolean(row.posOrigin),
    tillSessionId: row.tillSessionId ?? null,
    registerId: row.registerId ?? null,
    badDebtWrittenOff: Boolean(row.badDebtWrittenOff),
    writtenOffAt: row.writtenOffAt ?? null,
    writtenOffBy: row.writtenOffById ?? null,
    badDebtReason: row.badDebtReason ?? null,
    currencyCode: row.currencyCode,
    currency: row.currencyCode,
    exchangeRate: qtyNum(row.exchangeRate),
    subtotal: moneyStr(subtotal),
    taxAmount: moneyStr(taxAmount),
    totalTax: moneyStr(taxAmount),
    totalAmount: moneyStr(totalAmount),
    grandTotal: moneyStr(totalAmount),
    amountPaid: moneyStr(amountPaid),
    amountOutstanding: moneyStr(outstanding),
    balance: moneyStr(outstanding),
    totalAEx: qtyNum(row.totalAEx),
    totalB18: qtyNum(row.totalB18),
    totalDiscount: moneyStr(totalDiscount),
    posPromotion,
    invoiceDate: row.invoiceDate,
    date: row.invoiceDate,
    dueDate: row.dueDate,
    paidDate: row.paidDate ?? null,
    confirmedAt: row.confirmedAt ?? null,
    confirmedBy: row.confirmedById ?? null,
    cancelledAt: row.cancelledAt ?? null,
    cancelledBy: row.cancelledById ?? null,
    cancellationReason: row.cancellationReason ?? null,
    revenueJournalEntry: row.revenueJournalEntryId ?? null,
    cogsJournalEntry: row.cogsJournalEntryId ?? null,
    stockDeducted: row.stockDeducted,
    autoConfirm: row.autoConfirm,
    generatedFromRecurring: row.generatedFromRecurringId ?? null,
    creditNotes: (row.creditNotes || []).map((cn) => (typeof cn === 'object' ? cn.id : cn)),
    payments: row.payments ?? [],
    ebm: row.ebm ?? {},
    terms: row.terms ?? null,
    notes: row.notes ?? null,
    createdBy: row.createdById ?? null,
    lines,
    items: lines,
    lineCount: row._count?.lines != null ? Number(row._count.lines) : lines.length,
    ...mapTimestamps(row),
  };
}

async function invoiceTranslateCreate(data) {
  const base = tenantCreateBase(data);
  const lines = Array.isArray(data.lines || data.items) ? (data.lines || data.items) : [];

  const mappedLines = lines.map((line, idx) => {
    const qty = Number(line.qty ?? line.quantity ?? 0) || 0;
    const unitPrice = Number(line.unitPrice ?? 0) || 0;
    const discountPct = Number(line.discountPct ?? line.discount ?? 0) || 0;
    const taxRate = Number(line.taxRate ?? 0) || 0;
    const lineSubtotal = Number(
      line.lineSubtotal ?? line.subtotal ?? (qty * unitPrice * (1 - discountPct / 100)),
    ) || 0;
    const lineTax = Number(line.lineTax ?? line.taxAmount ?? (lineSubtotal * taxRate / 100)) || 0;
    const lineTotal = Number(line.lineTotal ?? line.totalWithTax ?? (lineSubtotal + lineTax)) || 0;
    return {
      id: toIdString(line.lineId || line._id) || generateObjectId(),
      companyId: base.companyId,
      lineOrder: idx,
      lineId: toIdString(line.lineId || line._id) || null,
      productId: toIdString(line.product),
      productName: line.productName ?? null,
      productCode: line.productCode ?? line.itemCode ?? null,
      description: line.description ?? null,
      qty,
      unit: line.unit ?? null,
      unitPrice,
      discountPct,
      taxRate,
      taxCode: line.taxCode ?? 'A',
      lineSubtotal,
      lineTax,
      lineTotal,
      unitCost: line.unitCost ?? 0,
      cogsAmount: line.cogsAmount ?? 0,
      warehouseId: line.warehouse ? toIdString(line.warehouse) : null,
      projectId: line.projectId || line.project_id ? toIdString(line.projectId || line.project_id) : null,
      qtyCredited: line.qtyCredited ?? 0,
      qtyDelivered: line.qtyDelivered ?? 0,
    };
  });

  const linesSubtotal = mappedLines.reduce((s, l) => s + Number(l.lineSubtotal || 0), 0);
  const linesTax = mappedLines.reduce((s, l) => s + Number(l.lineTax || 0), 0);
  const linesTotal = mappedLines.reduce((s, l) => s + Number(l.lineTotal || 0), 0);
  const lineDiscount = mappedLines.reduce((s, l) => s + Number(l.lineSubtotal || 0) * Number(l.discountPct || 0) / 100, 0);
  const taxBaseA = mappedLines.filter((l) => l.taxCode === 'A')
    .reduce((s, l) => s + Number(l.lineSubtotal || 0) * (1 - Number(l.discountPct || 0) / 100), 0);
  const taxBaseB = mappedLines.filter((l) => l.taxCode === 'B')
    .reduce((s, l) => s + Number(l.lineSubtotal || 0) * (1 - Number(l.discountPct || 0) / 100), 0);

  const subtotal = Number(data.subtotal) > 0 ? Number(data.subtotal) : linesSubtotal;
  const taxAmount = Number(data.taxAmount ?? data.totalTax) > 0
    ? Number(data.taxAmount ?? data.totalTax)
    : linesTax;
  const totalAmount = Number(data.totalAmount ?? data.grandTotal) > 0
    ? Number(data.totalAmount ?? data.grandTotal)
    : linesTotal;
  const amountPaid = Number(data.amountPaid ?? 0) || 0;
  const amountOutstanding = data.amountOutstanding != null || data.balance != null
    ? Number(data.amountOutstanding ?? data.balance)
    : Math.max(0, totalAmount - amountPaid);

  return {
    ...base,
    referenceNo: data.referenceNo || data.invoiceNumber,
    clientId: toIdString(data.client),
    customerTin: data.customerTin ?? null,
    customerName: data.customerName ?? null,
    customerAddress: data.customerAddress ?? null,
    quotationId: data.quotation ? toIdString(data.quotation) : null,
    salesOrderId: data.salesOrder ? toIdString(data.salesOrder) : null,
    deliveryNoteId: data.deliveryNote ? toIdString(data.deliveryNote) : null,
    status: data.status || 'draft',
    posOrigin: data.posOrigin === true,
    currencyCode: data.currencyCode || data.currency || 'RWF',
    exchangeRate: data.exchangeRate ?? 1,
    subtotal: moneyStr(subtotal),
    taxAmount: moneyStr(taxAmount),
    totalAmount: moneyStr(totalAmount),
    totalDiscount: moneyStr(data.totalDiscount ?? lineDiscount),
    totalAEx: moneyStr(data.totalAEx ?? taxBaseA),
    totalB18: moneyStr(data.totalB18 ?? taxBaseB),
    amountPaid: moneyStr(amountPaid),
    amountOutstanding: moneyStr(amountOutstanding),
    invoiceDate: data.invoiceDate || data.date || new Date(),
    dueDate: data.dueDate || new Date(),
    payments: data.payments ?? [],
    ebm: data.ebm ?? {},
    terms: data.terms ?? null,
    notes: data.notes ?? null,
    lines: mappedLines.length ? { create: mappedLines } : undefined,
  };
}

function invoiceTranslateUpdate(update = {}) {
  const data = mergeUpdatePayload(update);
  const out = {};
  const map = {
    referenceNo: 'referenceNo', status: 'status', posOrigin: 'posOrigin', client: 'clientId',
    customerTin: 'customerTin', customerName: 'customerName', customerAddress: 'customerAddress',
    quotation: 'quotationId', salesOrder: 'salesOrderId', deliveryNote: 'deliveryNoteId',
    currencyCode: 'currencyCode', currency: 'currencyCode', exchangeRate: 'exchangeRate',
    subtotal: 'subtotal', taxAmount: 'taxAmount', totalAmount: 'totalAmount',
    totalDiscount: 'totalDiscount', totalAEx: 'totalAEx', totalB18: 'totalB18',
    amountPaid: 'amountPaid', amountOutstanding: 'amountOutstanding',
    confirmedAt: 'confirmedAt', confirmedBy: 'confirmedById',
    cancelledAt: 'cancelledAt', cancelledBy: 'cancelledById', cancellationReason: 'cancellationReason',
    badDebtWrittenOff: 'badDebtWrittenOff', writtenOffAt: 'writtenOffAt',
    writtenOffBy: 'writtenOffById', badDebtReason: 'badDebtReason',
    invoiceDate: 'invoiceDate', dueDate: 'dueDate', paidDate: 'paidDate',
    payments: 'payments', ebm: 'ebm', terms: 'terms', notes: 'notes',
    revenueJournalEntry: 'revenueJournalEntryId', cogsJournalEntry: 'cogsJournalEntryId',
    stockDeducted: 'stockDeducted', autoConfirm: 'autoConfirm',
    balance: 'amountOutstanding',
  };
  const idTargets = new Set([
    'clientId', 'quotationId', 'salesOrderId', 'deliveryNoteId',
    'revenueJournalEntryId', 'cogsJournalEntryId', 'writtenOffById', 'confirmedById', 'cancelledById',
  ]);
  for (const [k, t] of Object.entries(map)) {
    if (data[k] !== undefined) {
      out[t] = idTargets.has(t) && data[k] ? toIdString(data[k]) : data[k];
    }
  }
  // Merge dotted ebm.* patches (legacy Mongo-style nested $set paths).
  const ebmPatches = {};
  for (const [k, v] of Object.entries(data)) {
    if (k.startsWith('ebm.')) ebmPatches[k.slice(4)] = v;
  }
  if (Object.keys(ebmPatches).length) {
    const base = out.ebm && typeof out.ebm === 'object' && !Array.isArray(out.ebm) ? out.ebm : {};
    out.ebm = { ...base, ...ebmPatches };
  }
  return out;
}

// ── SalesOrder ─────────────────────────────────────────────────────────────

function salesOrderLineToApi(row) {
  if (!row) return null;
  const trace = row.traceability || {};
  const base = lineBase(row, {
    description: row.description ?? null,
    qty: qtyNum(row.qty),
    qtyReserved: qtyNum(row.qtyReserved),
    qtyPicked: qtyNum(row.qtyPicked),
    qtyShipped: qtyNum(row.qtyShipped),
    qtyDelivered: qtyNum(row.qtyDelivered),
    qtyInvoiced: qtyNum(row.qtyInvoiced),
    unit: row.unit ?? null,
    unitPrice: qtyNum(row.unitPrice),
    discountPct: qtyNum(row.discountPct),
    taxRate: qtyNum(row.taxRate),
    lineTotal: qtyNum(row.lineTotal),
    lineTax: qtyNum(row.lineTax),
    warehouse: row.warehouseId ?? null,
    batchId: row.batchId ?? null,
    serialNumbers: row.serialNumbers ?? [],
    status: row.status,
    deliveryNoteLines: trace.deliveryNoteLines ?? [],
    invoiceLines: trace.invoiceLines ?? [],
  });
  if (row.product && typeof row.product === 'object') {
    base.product = {
      _id: row.product.id,
      name: row.product.name,
      sku: row.product.sku,
      unit: row.product.unit,
      ...(row.product.taxRate != null ? { taxRate: qtyNum(row.product.taxRate) } : {}),
      ...(row.product.taxCode != null ? { taxCode: row.product.taxCode } : {}),
      ...(row.product.trackingType != null ? { trackingType: row.product.trackingType } : {}),
      ...(row.product.isStockable != null ? { isStockable: row.product.isStockable } : {}),
    };
  }
  return base;
}

function salesOrderToApi(row) {
  if (!row) return null;
  const lines = mapLines(row, salesOrderLineToApi);
  const lineCount = row._count?.lines != null
    ? Number(row._count.lines)
    : (row.lineCount != null ? Number(row.lineCount) : (Array.isArray(lines) ? lines.length : 0));
  return {
    _id: row.id,
    company: row.companyId,
    referenceNo: row.referenceNo,
    client: relationRef(row.client, row.clientId),
    quotation: relationRef(row.quotation, row.quotationId),
    orderDate: row.orderDate,
    expectedDate: row.expectedDate ?? null,
    status: row.status,
    currencyCode: row.currencyCode,
    exchangeRate: qtyNum(row.exchangeRate),
    subtotal: qtyNum(row.subtotal),
    taxAmount: qtyNum(row.taxAmount),
    totalAmount: qtyNum(row.totalAmount),
    fulfillmentStatus: row.fulfillmentStatus,
    fulfillmentPercent: qtyNum(row.fulfillmentPercent),
    stockReserved: row.stockReserved,
    isBackorder: row.isBackorder,
    parentOrder: row.parentOrderId ?? null,
    deliveryNotes: row.deliveryNotes ?? [],
    invoices: row.invoices ?? [],
    pickPackId: row.pickPackId ?? null,
    terms: row.terms ?? null,
    notes: row.notes ?? null,
    createdBy: row.createdById ?? null,
    lineCount,
    // List projections expose the count without allocating placeholder line rows.
    lines,
    ...mapTimestamps(row),
  };
}

// ── PurchaseOrder / GRN / AP ───────────────────────────────────────────────

function purchaseOrderLineToApi(row) {
  if (!row) return null;
  const budgetRefs = row.budgetRefs && typeof row.budgetRefs === 'object' ? row.budgetRefs : {};
  return {
    _id: row.id,
    product: row.product && typeof row.product === 'object'
      ? relationRef(row.product, row.productId)
      : row.productId,
    qtyOrdered: qtyNum(row.qtyOrdered),
    qtyReceived: qtyNum(row.qtyReceived),
    unitCost: qtyNum(row.unitCost),
    landedUnitCost: row.landedUnitCost == null ? null : qtyNum(row.landedUnitCost),
    taxRate: qtyNum(row.taxRate),
    taxAmount: qtyNum(row.taxAmount),
    lineTotal: qtyNum(row.lineTotal),
    ...budgetRefs,
    // Keep the legacy API's snake-case fields while preserving the canonical
    // camel-case JSON keys used by Prisma.
    budgetId: budgetRefs.budgetId ?? budgetRefs.budget_id ?? null,
    budget_line_id: budgetRefs.budgetLineId ?? budgetRefs.budget_line_id ?? null,
    accountId: budgetRefs.accountId ?? budgetRefs.account_id ?? null,
    project_id: budgetRefs.projectId ?? budgetRefs.project_id ?? null,
    projectName: budgetRefs.projectName ?? null,
    projectCode: budgetRefs.projectCode ?? null,
    encumbrance_id: budgetRefs.encumbranceId ?? budgetRefs.encumbrance_id ?? null,
  };
}

function purchaseOrderToApi(row) {
  if (!row) return null;
  const lines = mapLines(row, purchaseOrderLineToApi);
  const linesSubtotal = lines.reduce(
    (s, l) => s + (Number(l.qtyOrdered) || 0) * (Number(l.unitCost) || 0),
    0,
  );
  const linesTax = lines.reduce((s, l) => s + (Number(l.taxAmount) || 0), 0);
  const linesTotal = lines.reduce(
    (s, l) => s + (Number(l.lineTotal) || 0),
    0,
  ) || (linesSubtotal + linesTax);
  const lineCount = row._count?.lines != null ? Number(row._count.lines) : lines.length;
  const headerSubtotal = qtyNum(row.subtotal);
  const headerTax = qtyNum(row.taxAmount);
  const headerTotal = qtyNum(row.totalAmount);
  const subtotal = headerSubtotal > 0 ? headerSubtotal : linesSubtotal;
  const taxAmount = headerTax > 0 ? headerTax : linesTax;
  const totalAmount = headerTotal > 0 ? headerTotal : linesTotal;
  return {
    _id: row.id,
    company: row.companyId,
    referenceNo: row.referenceNo,
    supplier: relationRef(row.supplier, row.supplierId),
    warehouse: relationRef(row.warehouse, row.warehouseId),
    orderDate: row.orderDate,
    expectedDeliveryDate: row.expectedDeliveryDate ?? null,
    status: row.status,
    source: row.source,
    aiProposalId: row.aiProposalId ?? null,
    autoReorderProduct: row.autoReorderProductId ?? null,
    currencyCode: row.currencyCode,
    exchangeRate: qtyNum(row.exchangeRate),
    subtotal,
    taxAmount,
    totalAmount,
    amountPaid: qtyNum(row.amountPaid),
    balance: qtyNum(row.balance) > 0 || qtyNum(row.amountPaid) > 0
      ? qtyNum(row.balance)
      : Math.max(0, totalAmount - qtyNum(row.amountPaid)),
    paymentStatus: row.paymentStatus,
    payments: row.payments ?? [],
    freight: row.freight ?? {},
    ebm: row.ebm ?? {},
    notes: row.notes ?? null,
    approvedBy: row.approvedById ?? null,
    approvedAt: row.approvedAt ?? null,
    createdBy: row.createdById ?? null,
    lines,
    linesCount: lineCount,
    ...mapTimestamps(row),
  };
}

function grnLineToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    purchaseOrderLine: row.purchaseOrderLineId ?? null,
    product: row.product && typeof row.product === 'object'
      ? relationRef(row.product, row.productId)
      : row.productId,
    qtyReceived: qtyNum(row.qtyReceived),
    unitCost: qtyNum(row.unitCost),
    taxRate: qtyNum(row.taxRate),
    batchNo: row.batchNo ?? null,
    serialNumbers: row.serialNumbers ?? [],
    ...(row.extra || {}),
  };
}

function grnToApi(row) {
  if (!row) return null;
  const lines = mapLines(row, grnLineToApi);
  return {
    _id: row.id,
    company: row.companyId,
    referenceNo: row.referenceNo,
    purchaseOrder: relationRef(row.purchaseOrder, row.purchaseOrderId),
    warehouse: relationRef(row.warehouse, row.warehouseId),
    supplier: relationRef(row.supplier, row.supplierId),
    receivedDate: row.receivedDate,
    status: row.status,
    supplierInvoiceNo: row.supplierInvoiceNo ?? null,
    totalAmount: moneyStr(row.totalAmount),
    balance: moneyStr(row.balance),
    amountPaid: moneyStr(row.amountPaid),
    paymentStatus: row.paymentStatus,
    paymentDueDate: row.paymentDueDate ?? null,
    journalEntry: row.journalEntryId ?? null,
    freight: row.freight ?? {},
    ebm: row.ebm ?? {},
    ebmImportReference: row.ebmImportReference ?? null,
    createdBy: row.createdById ?? null,
    confirmedBy: row.confirmedById ?? null,
    lines,
    ...mapTimestamps(row),
  };
}

function arReceiptToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    company: row.companyId,
    referenceNo: row.referenceNo,
    client: relationRef(row.client, row.clientId),
    receiptDate: row.receiptDate,
    paymentMethod: row.paymentMethod,
    bankAccount: row.bankAccountId ?? null,
    amountReceived: moneyStr(row.amountReceived),
    currencyCode: row.currencyCode,
    exchangeRate: qtyNum(row.exchangeRate),
    reference: row.reference ?? null,
    status: row.status,
    journalEntry: row.journalEntryId ?? null,
    reverseJournalEntry: row.reverseJournalEntryId ?? null,
    unallocatedAmount: moneyStr(row.unallocatedAmount),
    postedBy: row.postedById ?? null,
    postedAt: row.postedAt ?? null,
    reversedAt: row.reversedAt ?? null,
    reversedBy: row.reversedById ?? null,
    reversalReason: row.reversalReason ?? null,
    notes: row.notes ?? null,
    createdBy: row.createdById ?? null,
    ...mapTimestamps(row),
  };
}

function arReceiptAllocationToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    company: row.companyId,
    receipt: row.receiptId,
    invoice: row.invoiceId,
    amountAllocated: moneyStr(row.amountAllocated),
    createdBy: row.createdById ?? null,
    ...mapTimestamps(row),
  };
}

function apPaymentToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    company: row.companyId,
    referenceNo: row.referenceNo,
    reference: row.externalReference ?? null,
    notes: row.notes ?? null,
    postedBy: row.postedById ?? null,
    postedAt: row.postedAt ?? null,
    reversedBy: row.reversedById ?? null,
    reversedAt: row.reversedAt ?? null,
    reversalReason: row.reversalReason ?? null,
    supplier: relationRef(row.supplier, row.supplierId),
    paymentDate: row.paymentDate,
    paymentMethod: row.paymentMethod,
    bankAccount: row.bankAccountId ?? null,
    amountPaid: moneyStr(row.amountPaid),
    currencyCode: row.currencyCode,
    exchangeRate: qtyNum(row.exchangeRate),
    status: row.status,
    journalEntry: row.journalEntryId ?? null,
    unallocatedAmount: moneyStr(row.unallocatedAmount),
    createdBy: row.createdById ?? null,
    ...mapTimestamps(row),
  };
}

function apPaymentAllocationToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    company: row.companyId,
    payment: row.paymentId,
    grn: row.grnId,
    amountAllocated: moneyStr(row.amountAllocated),
    createdBy: row.createdById ?? null,
    ...mapTimestamps(row),
  };
}

function creditNoteLineTaxParts(lineTotal, taxRate) {
  const total = qtyNum(lineTotal);
  const rate = qtyNum(taxRate);
  if (total <= 0 || rate <= 0) return { lineSubtotal: total, lineTax: 0 };
  const lineSubtotal = total / (1 + rate / 100);
  return { lineSubtotal, lineTax: total - lineSubtotal };
}

function creditNoteToApi(row) {
  if (!row) return null;
  const lines = mapLines(row, (l) => {
    const lineTotal = qtyNum(l.lineTotal);
    const taxRate = qtyNum(l.taxRate);
    const { lineSubtotal, lineTax } = creditNoteLineTaxParts(lineTotal, taxRate);
    return {
      _id: l.id,
      invoiceLineId: l.invoiceLineId ?? null,
      product: relationRef(l.product, l.productId),
      productName: l.productName ?? (l.product && l.product.name) ?? null,
      productCode: (l.product && l.product.sku) ?? null,
      quantity: qtyNum(l.quantity),
      originalQty: qtyNum(l.originalQty),
      unitPrice: qtyNum(l.unitPrice),
      unitCost: qtyNum(l.unitCost),
      taxRate,
      discountPct: qtyNum(l.discountPct),
      lineSubtotal: l.lineSubtotal != null ? qtyNum(l.lineSubtotal) : lineSubtotal,
      lineTax: l.lineTax != null ? qtyNum(l.lineTax) : lineTax,
      lineTotal,
      returnToWarehouse: l.returnToWarehouseId ?? null,
      batchId: l.batchId ?? null,
      serialNumbers: l.serialNumbers ?? [],
    };
  });
  return {
    _id: row.id,
    company: row.companyId,
    referenceNo: row.referenceNo,
    creditNoteNumber: row.referenceNo,
    invoice: relationRef(row.invoice, row.invoiceId),
    client: relationRef(row.client, row.clientId),
    creditDate: row.creditDate,
    reason: row.reason ?? null,
    type: row.type,
    status: row.status,
    posOrigin: Boolean(row.posOrigin),
    currencyCode: row.currencyCode,
    subtotal: qtyNum(row.subtotal),
    taxAmount: qtyNum(row.taxAmount),
    totalAmount: qtyNum(row.totalAmount),
    grandTotal: qtyNum(row.totalAmount),
    stockReversed: row.stockReversed,
    confirmedBy: row.confirmedById ?? null,
    confirmedAt: row.confirmedAt ?? null,
    amountRefunded: qtyNum(row.amountRefunded),
    amountAppliedToAR: qtyNum(row.amountAppliedToAR),
    amountAvailableAsCredit: qtyNum(row.amountAvailableAsCredit),
    amountRefundedFromAR: qtyNum(row.amountRefundedFromAR),
    amountRefundedFromCredit: qtyNum(row.amountRefundedFromCredit),
    amountAppliedToOtherInvoices: qtyNum(row.amountAppliedToOtherInvoices),
    applications: row.applications ?? [],
    appliedTo: row.appliedToInvoiceId ?? null,
    appliedDate: row.appliedAt ?? null,
    notes: row.notes ?? null,
    payments: row.payments ?? [],
    ebm: row.ebm ?? {},
    lines,
    items: lines,
    createdBy: row.createdById ?? null,
    ...mapTimestamps(row),
  };
}

function deliveryNoteToApi(row) {
  if (!row) return null;
  const lines = mapLines(row, (l) => {
    const qtyToDeliver = qtyNum(l.qtyToDeliver);
    const unitPrice = qtyNum(l.unitPrice);
    const unitCost = qtyNum(l.unitCost);
    const lineTotal = qtyNum(l.lineTotal) || (unitPrice * qtyToDeliver) || (unitCost * qtyToDeliver);
    const product = l.product && typeof l.product === 'object'
      ? relationRef(l.product, l.productId)
      : l.productId;
    const productName = l.productName
      || (product && typeof product === 'object' ? product.name : null)
      || null;
    return {
      _id: l.id,
      invoiceLineId: l.invoiceLineId ?? null,
      salesOrderLineId: l.salesOrderLineId ?? null,
      product,
      productName,
      productCode: l.productCode ?? (product && typeof product === 'object' ? product.sku : null) ?? null,
      description: productName,
      unit: l.unit ?? (product && typeof product === 'object' ? product.unit : null) ?? null,
      qtyToDeliver,
      quantity: qtyToDeliver,
      deliveredQty: qtyNum(l.deliveredQty),
      batchId: l.batchId ?? null,
      serialNumbers: l.serialNumbers ?? [],
      discountPct: qtyNum(l.discountPct),
      taxRate: qtyNum(l.taxRate),
      taxCode: l.taxCode ?? 'A',
      lineSubtotal: qtyNum(l.lineSubtotal),
      lineTax: qtyNum(l.lineTax),
      unitCost,
      unitPrice,
      lineTotal,
      notes: l.notes ?? null,
    };
  });
  const grandTotal = lines.reduce((sum, l) => sum + (Number(l.lineTotal) || 0), 0);
  return {
    _id: row.id,
    company: row.companyId,
    referenceNo: row.referenceNo,
    salesOrder: relationRef(row.salesOrder, row.salesOrderId),
    pickPack: row.pickPackId ?? null,
    invoice: relationRef(row.invoice, row.invoiceId),
    client: relationRef(row.client, row.clientId),
    warehouse: relationRef(row.warehouse, row.warehouseId),
    quotation: relationRef(row.quotation, row.quotationId),
    sourceType: row.sourceType ?? null,
    deliveryDate: row.deliveryDate,
    status: row.status,
    stockDeducted: row.stockDeducted,
    confirmedBy: row.confirmedById ?? null,
    confirmedAt: row.confirmedAt ?? null,
    dispatchedBy: row.dispatchedById ?? null,
    dispatchedAt: row.dispatchedAt ?? null,
    deliveredBy: row.deliveredBy ?? null,
    deliveredAt: row.deliveredAt ?? null,
    receivedBy: row.receivedBy ?? null,
    actualDeliveryDate: row.actualDeliveryDate ?? null,
    carrier: row.carrier ?? null,
    vehicle: row.vehicle ?? null,
    trackingNumber: row.trackingNumber ?? null,
    deliveryAddress: row.deliveryAddress ?? null,
    cancelledBy: row.cancelledById ?? null,
    cancelledAt: row.cancelledAt ?? null,
    cancellationReason: row.cancellationReason ?? null,
    notes: row.notes ?? null,
    lines,
    items: lines,
    itemsCount: lines.length,
    grandTotal,
    totalAmount: grandTotal,
    createdBy: row.createdById ?? null,
    ...mapTimestamps(row),
  };
}

// ── PickPack ───────────────────────────────────────────────────────────────

function pickPackLineToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    salesOrderLineId: row.salesOrderLineId,
    product: row.product && typeof row.product === 'object'
      ? relationRef(row.product, row.productId)
      : row.productId,
    warehouse: row.warehouse && typeof row.warehouse === 'object'
      ? relationRef(row.warehouse, row.warehouseId)
      : (row.warehouseId ?? null),
    location: row.location ?? null,
    qtyToPick: qtyNum(row.qtyToPick),
    qtyPicked: qtyNum(row.qtyPicked),
    qtyPacked: qtyNum(row.qtyPacked),
    batchId: row.batchId ?? null,
    batchNo: row.batchNo ?? null,
    serialNumbers: row.serialNumbers ?? [],
    unit: row.unit ?? null,
    status: row.status,
    pickedBy: row.pickedById ?? null,
    pickedAt: row.pickedAt ?? null,
    pickingNotes: row.pickingNotes ?? null,
    packedBy: row.packedById ?? null,
    packedAt: row.packedAt ?? null,
    packingNotes: row.packingNotes ?? null,
    issues: row.issues ?? [],
  };
}

function pickPackToApi(row) {
  if (!row) return null;
  const lines = mapLines(row, pickPackLineToApi);
  return {
    _id: row.id,
    company: row.companyId,
    referenceNo: row.referenceNo,
    salesOrder: relationRef(row.salesOrder, row.salesOrderId),
    client: relationRef(row.client, row.clientId),
    warehouse: relationRef(row.warehouse, row.warehouseId),
    status: row.status,
    assignedTo: row.assignedToId ?? null,
    assignedAt: row.assignedAt ?? null,
    pickingStartedAt: row.pickingStartedAt ?? null,
    pickingCompletedAt: row.pickingCompletedAt ?? null,
    packingStartedAt: row.packingStartedAt ?? null,
    packingCompletedAt: row.packingCompletedAt ?? null,
    priority: row.priority,
    notes: row.notes ?? null,
    packageCount: row.packageCount ?? 0,
    packageType: row.packageType ?? 'box',
    totalWeight: qtyNum(row.totalWeight),
    shippingMethod: row.shippingMethod ?? null,
    trackingNumber: row.trackingNumber ?? null,
    deliveryNote: row.deliveryNoteId ?? null,
    createdBy: row.createdById ?? null,
    cancelledBy: row.cancelledById ?? null,
    lines,
    ...mapTimestamps(row),
  };
}

function purchaseToApi(row) {
  if (!row) return null;
  const lines = mapLines(row, (l) => {
    const qty = qtyNum(l.qty);
    const unitCost = qtyNum(l.unitCost);
    const taxRate = qtyNum(l.taxRate);
    const net = qty * unitCost;
    const lineTotal = qtyNum(l.lineTotal) || (net * (1 + taxRate / 100));
    const taxAmount = Math.max(0, lineTotal - net);
    return {
      _id: l.id,
      product: l.product && typeof l.product === 'object'
        ? relationRef(l.product, l.productId)
        : l.productId,
      // Legacy controllers/UI use `quantity`; Prisma field is `qty`
      qty,
      quantity: qty,
      unitCost,
      taxRate,
      taxAmount,
      lineTotal,
      totalWithTax: lineTotal,
      ...(l.extra || {}),
    };
  });
  const subtotal = qtyNum(row.subtotal);
  const taxAmount = qtyNum(row.taxAmount);
  const totalAmount = qtyNum(row.totalAmount) || (subtotal + taxAmount);
  const payments = Array.isArray(row.payments) ? row.payments : [];
  const amountPaid = payments.reduce(
    (sum, p) => sum + amountFromPaymentValue(p?.amount ?? p?.amountPaid ?? p?.total ?? 0),
    0,
  );
  const balance = row.balance != null ? qtyNum(row.balance) : Math.max(totalAmount - amountPaid, 0);
  const lineCount = row._count?.lines != null ? Number(row._count.lines) : lines.length;
  return {
    _id: row.id,
    company: row.companyId,
    purchaseNumber: row.purchaseNumber,
    supplier: relationRef(row.supplier, row.supplierId),
    supplierInvoiceNumber: row.supplierInvoiceNumber ?? null,
    warehouse: relationRef(row.warehouse, row.warehouseId),
    status: row.status,
    currency: row.currency,
    exchangeRate: row.exchangeRate == null ? null : qtyNum(row.exchangeRate),
    subtotal,
    taxAmount,
    totalTax: taxAmount,
    totalAmount,
    // Legacy aliases used by journal/email/receive flows
    roundedAmount: totalAmount,
    grandTotal: totalAmount,
    payments,
    amountPaid,
    balance,
    purchaseDate: row.purchaseDate,
    stockAdded: row.stockAdded,
    ebm: row.ebm ?? {},
    items: lines,
    lines,
    lineCount,
    createdBy: row.createdById ?? null,
    ...mapTimestamps(row),
  };
}

function genericTranslateCreate(data, headerMap, lineMapper) {
  const base = tenantCreateBase(data);
  const lines = Array.isArray(data.lines || data.items) ? (data.lines || data.items) : [];
  const header = {};
  for (const [mongoKey, prismaKey] of Object.entries(headerMap)) {
    if (data[mongoKey] !== undefined) {
      header[prismaKey] = prismaKey.endsWith('Id') && data[mongoKey]
        ? toIdString(data[mongoKey]) : data[mongoKey];
    }
  }
  return {
    ...base,
    ...header,
    lines: lines.length && lineMapper
      ? { create: lines.map((l, idx) => lineMapper(l, idx, base.companyId)) }
      : undefined,
  };
}

/** HTML date inputs and API payloads often send YYYY-MM-DD; Prisma needs Date objects. */
function coerceDateTime(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return new Date(`${s}T00:00:00.000Z`);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function coerceQuotationDates(data) {
  if (!data || typeof data !== 'object') return data;
  const next = { ...data };
  if (next.quotationDate != null) {
    next.quotationDate = coerceDateTime(next.quotationDate) ?? new Date();
  }
  if (next.expiryDate != null) {
    next.expiryDate = coerceDateTime(next.expiryDate);
  }
  if (next.approvedDate != null) next.approvedDate = coerceDateTime(next.approvedDate);
  if (next.conversionDate != null) next.conversionDate = coerceDateTime(next.conversionDate);
  return next;
}

function pickHeader(data, headerMap, idFields = []) {
  const out = {};
  for (const [mongoKey, prismaKey] of Object.entries(headerMap)) {
    if (data[mongoKey] !== undefined) {
      out[prismaKey] = idFields.includes(prismaKey) && data[mongoKey]
        ? toIdString(data[mongoKey]) : data[mongoKey];
    }
  }
  return out;
}

function headerTranslateCreate(data, headerMap, idFields = []) {
  const base = tenantCreateBase(data);
  return { ...base, ...pickHeader(data, headerMap, idFields) };
}

function genericTranslateUpdate(headerMap, idFields = []) {
  return (update = {}) => pickHeader(mergeUpdatePayload(update), headerMap, idFields);
}

function defaultLineCreate(line, idx, companyId, extra = {}) {
  return {
    id: toIdString(line._id) || generateObjectId(),
    companyId,
    lineOrder: idx,
    productId: toIdString(line.product),
    ...extra,
  };
}

// ── RecurringInvoice / Run / PurchaseReturn / FreightBill ───────────────────

function recurringInvoiceLineToApi(row) {
  if (!row) return null;
  const qty = qtyNum(row.qty);
  const unitPrice = qtyNum(row.unitPrice);
  const discountPct = qtyNum(row.discountPct);
  const taxRate = qtyNum(row.taxRate);
  const lineSubtotal = qty * unitPrice * (1 - discountPct / 100);
  const lineTax = lineSubtotal * (taxRate / 100);
  const lineTotal = lineSubtotal + lineTax;
  const productName = row.productName ?? (row.product && row.product.name) ?? null;
  const productCode = row.productCode ?? (row.product && row.product.sku) ?? null;
  return {
    ...lineBase(row, {
      description: row.description ?? null,
      productName: row.productName ?? productName,
      productCode: row.productCode ?? productCode,
      qty,
      quantity: qty,
      unitPrice,
      unit: row.unit ?? null,
      discountPct,
      taxRate,
      taxCode: row.taxCode || 'A',
      lineSubtotal,
      lineTax,
      lineTotal,
      warehouse: row.warehouseId ?? null,
    }),
    product: relationRef(row.product, row.productId),
  };
}

function recurringInvoiceToApi(row) {
  if (!row) return null;
  const lines = mapLines(row, recurringInvoiceLineToApi);
  const subtotal = lines.reduce((sum, line) => sum + (line.lineSubtotal || 0), 0);
  const taxAmount = lines.reduce((sum, line) => sum + (line.lineTax || 0), 0);
  const totalAmount = lines.reduce((sum, line) => sum + (line.lineTotal || 0), 0);
  return {
    _id: row.id,
    company: row.companyId,
    referenceNo: row.referenceNo,
    client: relationRef(row.client, row.clientId),
    schedule: row.schedule ?? {},
    startDate: row.startDate,
    endDate: row.endDate ?? null,
    nextRunDate: row.nextRunDate ?? null,
    status: row.status,
    autoConfirm: row.autoConfirm,
    currencyCode: row.currencyCode,
    notes: row.notes ?? null,
    lastRunAt: row.lastRunAt ?? null,
    subtotal,
    taxAmount,
    totalAmount,
    createdBy: relationRef(row.createdBy, row.createdById),
    lines,
    ...mapTimestamps(row),
  };
}

function recurringInvoiceRunToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    company: row.companyId,
    template: row.recurringInvoiceId,
    recurringInvoice: row.recurringInvoiceId,
    runDate: row.runDate,
    invoice: relationRef(row.invoice, row.invoiceId),
    status: row.status,
    errorMessage: row.errorMessage ?? null,
    createdAt: row.createdAt,
  };
}

function purchaseReturnLineToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    grnLine: row.grnLineId ?? null,
    purchaseLine: row.purchaseLineId ?? null,
    qtyReturned: qtyNum(row.qtyReturned),
    unitCost: qtyNum(row.unitCost),
    serialNumbers: Array.isArray(row.serialNumbers) ? row.serialNumbers : [],
    product: row.product && typeof row.product === 'object'
      ? { _id: row.product.id, name: row.product.name, sku: row.product.sku, unit: row.product.unit }
      : row.productId,
  };
}

function purchaseReturnToApi(row) {
  if (!row) return null;
  const lines = mapLines(row, purchaseReturnLineToApi);
  const subtotal = lines.reduce((sum, line) => sum + (line.qtyReturned * line.unitCost), 0);
  const totalAmount = qtyNum(row.totalAmount);
  return {
    _id: row.id,
    company: row.companyId,
    referenceNo: row.referenceNo,
    grn: relationRef(row.grn, row.grnId),
    purchase: relationRef(row.purchase, row.purchaseId),
    supplier: relationRef(row.supplier, row.supplierId),
    warehouse: relationRef(row.warehouse, row.warehouseId),
    returnDate: row.returnDate,
    reason: row.reason ?? null,
    supplierCreditNoteNo: row.supplierCreditNoteNo ?? null,
    status: row.status,
    subtotal: moneyStr(subtotal),
    taxAmount: moneyStr(Math.max(0, totalAmount - subtotal)),
    totalAmount: moneyStr(totalAmount),
    journalEntry: row.journalEntryId ?? null,
    confirmedBy: row.confirmedById ?? null,
    confirmedAt: row.confirmedAt ?? null,
    refundMethod: row.refundMethod ?? null,
    bankAccountId: row.bankAccountId ?? null,
    refundJournalEntry: row.refundJournalEntryId ?? null,
    refundBankTransaction: row.refundBankTransactionId ?? null,
    bankRefundReference: row.bankRefundReference ?? null,
    refundedAt: row.refundedAt ?? null,
    createdBy: row.createdById ?? null,
    lines,
    ...mapTimestamps(row),
  };
}

function freightBillToApi(row) {
  if (!row) return null;
  return {
    _id: row.id,
    company: row.companyId,
    referenceNo: row.referenceNo,
    supplier: relationRef(row.supplier, row.supplierId),
    carrierName: row.carrierName ?? null,
    amount: moneyStr(row.amount),
    account: row.account ?? null,
    invoiceDate: row.invoiceDate ?? null,
    paymentMethod: row.paymentMethod ?? null,
    status: row.status,
    grnMatches: row.grnMatches ?? [],
    journalEntry: row.journalEntryId ?? null,
    createdBy: row.createdById ?? null,
    ...mapTimestamps(row),
  };
}

// ── Translate: Quotation ─────────────────────────────────────────────────────

const QUOTATION_HEADER = {
  referenceNo: 'referenceNo',
  client: 'clientId',
  status: 'status',
  quotationDate: 'quotationDate',
  expiryDate: 'expiryDate',
  currencyCode: 'currencyCode',
  baseCurrency: 'baseCurrency',
  exchangeRate: 'exchangeRate',
  subtotal: 'subtotal',
  totalDiscount: 'totalDiscount',
  taxAmount: 'taxAmount',
  totalAmount: 'totalAmount',
  subtotalBase: 'subtotalBase',
  totalAmountBase: 'totalAmountBase',
  approvedBy: 'approvedById',
  approvedDate: 'approvedDate',
  convertedToInvoice: 'convertedToInvoiceId',
  convertedToSalesOrder: 'convertedToSalesOrderId',
  conversionDate: 'conversionDate',
  terms: 'terms',
  notes: 'notes',
  customerAction: 'customerAction',
};

function quotationTranslateCreate(data) {
  const payload = coerceQuotationDates(data);
  return genericTranslateCreate(payload, QUOTATION_HEADER, (line, idx, companyId) =>
    defaultLineCreate(line, idx, companyId, {
      lineId: toIdString(line.lineId || line._id) || null,
      productName: line.productName ?? null,
      productSku: line.productSku ?? null,
      productUnit: line.productUnit ?? null,
      description: line.description ?? null,
      qty: line.qty ?? line.quantity ?? 0,
      unit: line.unit ?? null,
      unitPrice: line.unitPrice ?? 0,
      discountPct: line.discountPct ?? line.discount ?? 0,
      taxRate: line.taxRate ?? 0,
      lineSubtotal: line.lineSubtotal ?? line.subtotal ?? 0,
      lineDiscount: line.lineDiscount ?? 0,
      lineTotal: line.lineTotal ?? 0,
      lineTax: line.lineTax ?? line.taxAmount ?? 0,
      extra: { ...(line.extra || {}), ...(line.taxCode ? { taxCode: line.taxCode } : {}) },
    }));
}

const quotationTranslateUpdateHeader = genericTranslateUpdate(QUOTATION_HEADER, ['clientId']);
const quotationTranslateUpdate = (update = {}) =>
  coerceQuotationDates(quotationTranslateUpdateHeader(update));

// ── Translate: SalesOrder ────────────────────────────────────────────────────

const SALES_ORDER_HEADER = {
  referenceNo: 'referenceNo',
  client: 'clientId',
  quotation: 'quotationId',
  status: 'status',
  orderDate: 'orderDate',
  expectedDate: 'expectedDate',
  currencyCode: 'currencyCode',
  exchangeRate: 'exchangeRate',
  subtotal: 'subtotal',
  taxAmount: 'taxAmount',
  totalAmount: 'totalAmount',
  fulfillmentStatus: 'fulfillmentStatus',
  fulfillmentPercent: 'fulfillmentPercent',
  stockReserved: 'stockReserved',
  isBackorder: 'isBackorder',
  pickPackId: 'pickPackId',
  terms: 'terms',
  notes: 'notes',
};

function salesOrderTranslateCreate(data) {
  return genericTranslateCreate(data, SALES_ORDER_HEADER, (line, idx, companyId) =>
    defaultLineCreate(line, idx, companyId, {
      lineId: toIdString(line.lineId || line._id) || null,
      description: line.description ?? null,
      qty: line.qty ?? line.quantity ?? 0,
      qtyReserved: line.qtyReserved ?? 0,
      qtyPicked: line.qtyPicked ?? 0,
      qtyShipped: line.qtyShipped ?? 0,
      qtyDelivered: line.qtyDelivered ?? 0,
      qtyInvoiced: line.qtyInvoiced ?? 0,
      unit: line.unit ?? null,
      unitPrice: line.unitPrice ?? 0,
      discountPct: line.discountPct ?? line.discount ?? 0,
      taxRate: line.taxRate ?? 0,
      lineTotal: line.lineTotal ?? 0,
      lineTax: line.lineTax ?? line.taxAmount ?? 0,
      warehouseId: line.warehouse ? toIdString(line.warehouse) : null,
      batchId: line.batchId ? toIdString(line.batchId) : null,
      serialNumbers: line.serialNumbers ?? [],
      status: line.status ?? 'pending',
      traceability: {
        deliveryNoteLines: line.deliveryNoteLines ?? [],
        invoiceLines: line.invoiceLines ?? [],
      },
    }));
}

const salesOrderTranslateUpdate = genericTranslateUpdate(SALES_ORDER_HEADER, ['clientId', 'quotationId']);

// ── Translate: CreditNote ────────────────────────────────────────────────────

const CREDIT_NOTE_HEADER = {
  referenceNo: 'referenceNo',
  invoice: 'invoiceId',
  client: 'clientId',
  status: 'status',
  posOrigin: 'posOrigin',
  stockReversed: 'stockReversed',
  creditDate: 'creditDate',
  reason: 'reason',
  type: 'type',
  currencyCode: 'currencyCode',
  subtotal: 'subtotal',
  taxAmount: 'taxAmount',
  totalAmount: 'totalAmount',
  notes: 'notes',
  amountRefunded: 'amountRefunded',
  amountAppliedToAR: 'amountAppliedToAR',
  amountAvailableAsCredit: 'amountAvailableAsCredit',
  amountRefundedFromAR: 'amountRefundedFromAR',
  amountRefundedFromCredit: 'amountRefundedFromCredit',
  amountAppliedToOtherInvoices: 'amountAppliedToOtherInvoices',
  applications: 'applications',
  appliedTo: 'appliedToInvoiceId',
  appliedDate: 'appliedAt',
  confirmedBy: 'confirmedById',
  confirmedAt: 'confirmedAt',
};

function creditNoteTranslateCreate(data) {
  return genericTranslateCreate(data, CREDIT_NOTE_HEADER, (line, idx, companyId) =>
    defaultLineCreate(line, idx, companyId, {
      invoiceLineId: line.invoiceLineId ? toIdString(line.invoiceLineId) : null,
      productName: line.productName ?? null,
      quantity: line.quantity ?? line.qty ?? 0,
      originalQty: line.originalQty ?? 0,
      unitPrice: line.unitPrice ?? 0,
      unitCost: line.unitCost ?? 0,
      taxRate: line.taxRate ?? 0,
      discountPct: line.discountPct ?? 0,
      lineSubtotal: line.lineSubtotal ?? 0,
      lineTax: line.lineTax ?? 0,
      lineTotal: line.lineTotal ?? 0,
      returnToWarehouseId: line.returnToWarehouse ? toIdString(line.returnToWarehouse) : null,
      batchId: line.batchId ? toIdString(line.batchId) : null,
      serialNumbers: line.serialNumbers ?? [],
    }));
}

const creditNoteTranslateUpdate = genericTranslateUpdate(CREDIT_NOTE_HEADER, ['invoiceId', 'clientId']);

// ── Translate: DeliveryNote ──────────────────────────────────────────────────

const DELIVERY_NOTE_HEADER = {
  referenceNo: 'referenceNo',
  salesOrder: 'salesOrderId',
  pickPack: 'pickPackId',
  invoice: 'invoiceId',
  client: 'clientId',
  warehouse: 'warehouseId',
  quotation: 'quotationId',
  status: 'status',
  deliveryDate: 'deliveryDate',
  notes: 'notes',
  sourceType: 'sourceType',
  confirmedBy: 'confirmedById',
  confirmedAt: 'confirmedAt',
  dispatchedBy: 'dispatchedById',
  dispatchedAt: 'dispatchedAt',
  deliveredBy: 'deliveredBy',
  deliveredAt: 'deliveredAt',
  receivedBy: 'receivedBy',
  actualDeliveryDate: 'actualDeliveryDate',
  carrier: 'carrier',
  vehicle: 'vehicle',
  trackingNumber: 'trackingNumber',
  deliveryAddress: 'deliveryAddress',
  cancelledBy: 'cancelledById',
  cancelledAt: 'cancelledAt',
  cancellationReason: 'cancellationReason',
};

function deliveryNoteTranslateCreate(data) {
  return genericTranslateCreate(data, DELIVERY_NOTE_HEADER, (line, idx, companyId) =>
    defaultLineCreate(line, idx, companyId, {
      invoiceLineId: line.invoiceLineId ? toIdString(line.invoiceLineId) : null,
      salesOrderLineId: line.salesOrderLineId ? toIdString(line.salesOrderLineId) : null,
      productName: line.productName ?? null,
      productCode: line.productCode ?? null,
      unit: line.unit ?? null,
      qtyToDeliver: line.qtyToDeliver ?? line.qty ?? 0,
      deliveredQty: line.deliveredQty ?? 0,
      unitCost: line.unitCost ?? 0,
      unitPrice: line.unitPrice ?? 0,
      discountPct: line.discountPct ?? 0,
      taxRate: line.taxRate ?? 0,
      taxCode: line.taxCode ?? 'A',
      lineSubtotal: line.lineSubtotal ?? 0,
      lineTax: line.lineTax ?? 0,
      lineTotal: line.lineTotal ?? 0,
      batchId: line.batchId ? toIdString(line.batchId) : null,
      serialNumbers: line.serialNumbers ?? [],
      notes: line.notes ?? null,
    }));
}

const deliveryNoteTranslateUpdate = genericTranslateUpdate(
  DELIVERY_NOTE_HEADER,
  ['salesOrderId', 'pickPackId', 'invoiceId', 'clientId', 'warehouseId', 'quotationId'],
);

// ── Translate: PickPack ──────────────────────────────────────────────────────

const PICK_PACK_HEADER = {
  referenceNo: 'referenceNo',
  salesOrder: 'salesOrderId',
  client: 'clientId',
  warehouse: 'warehouseId',
  status: 'status',
  assignedTo: 'assignedToId',
  assignedAt: 'assignedAt',
  pickingStartedAt: 'pickingStartedAt',
  pickingCompletedAt: 'pickingCompletedAt',
  packingStartedAt: 'packingStartedAt',
  packingCompletedAt: 'packingCompletedAt',
  priority: 'priority',
  notes: 'notes',
  packageCount: 'packageCount',
  packageType: 'packageType',
  totalWeight: 'totalWeight',
  shippingMethod: 'shippingMethod',
  trackingNumber: 'trackingNumber',
  deliveryNote: 'deliveryNoteId',
  cancelledBy: 'cancelledById',
  cancelledAt: 'cancelledAt',
  cancellationReason: 'cancellationReason',
};

function pickPackTranslateCreate(data) {
  return genericTranslateCreate(data, PICK_PACK_HEADER, (line, idx, companyId) =>
    defaultLineCreate(line, idx, companyId, {
      salesOrderLineId: String(line.salesOrderLineId || line.lineId || ''),
      warehouseId: line.warehouse ? toIdString(line.warehouse) : null,
      location: line.location ?? null,
      qtyToPick: line.qtyToPick ?? 0,
      qtyPicked: line.qtyPicked ?? 0,
      qtyPacked: line.qtyPacked ?? 0,
      batchId: line.batchId ? toIdString(line.batchId) : null,
      batchNo: line.batchNo ?? null,
      serialNumbers: line.serialNumbers ?? [],
      unit: line.unit ?? null,
      status: line.status ?? 'pending',
      pickedById: line.pickedBy ? toIdString(line.pickedBy) : null,
      pickedAt: line.pickedAt ?? null,
      pickingNotes: line.pickingNotes ?? null,
      packedById: line.packedBy ? toIdString(line.packedBy) : null,
      packedAt: line.packedAt ?? null,
      packingNotes: line.packingNotes ?? null,
      issues: line.issues ?? [],
    }));
}

const pickPackTranslateUpdate = genericTranslateUpdate(
  PICK_PACK_HEADER,
  ['salesOrderId', 'clientId', 'warehouseId', 'assignedToId', 'deliveryNoteId', 'cancelledById'],
);

// ── Translate: ARReceipt / Allocation ────────────────────────────────────────

const AR_RECEIPT_HEADER = {
  referenceNo: 'referenceNo',
  client: 'clientId',
  status: 'status',
  receiptDate: 'receiptDate',
  paymentMethod: 'paymentMethod',
  bankAccount: 'bankAccountId',
  amountReceived: 'amountReceived',
  currencyCode: 'currencyCode',
  exchangeRate: 'exchangeRate',
  reference: 'reference',
  unallocatedAmount: 'unallocatedAmount',
};

const arReceiptTranslateCreate = (data) => headerTranslateCreate(data, AR_RECEIPT_HEADER, ['clientId', 'bankAccountId']);
const arReceiptTranslateUpdate = genericTranslateUpdate(AR_RECEIPT_HEADER, ['clientId', 'bankAccountId']);

const AR_RECEIPT_ALLOC_HEADER = {
  receipt: 'receiptId',
  invoice: 'invoiceId',
  amountAllocated: 'amountAllocated',
};

const arReceiptAllocationTranslateCreate = (data) =>
  headerTranslateCreate(data, AR_RECEIPT_ALLOC_HEADER, ['receiptId', 'invoiceId']);
const arReceiptAllocationTranslateUpdate = genericTranslateUpdate(AR_RECEIPT_ALLOC_HEADER, ['receiptId', 'invoiceId']);

// ── Translate: RecurringInvoice / Run ────────────────────────────────────────

const RECURRING_INVOICE_HEADER = {
  referenceNo: 'referenceNo',
  client: 'clientId',
  status: 'status',
  schedule: 'schedule',
  startDate: 'startDate',
  endDate: 'endDate',
  nextRunDate: 'nextRunDate',
  autoConfirm: 'autoConfirm',
  currencyCode: 'currencyCode',
  notes: 'notes',
};

function recurringInvoiceTranslateCreate(data) {
  return genericTranslateCreate(data, RECURRING_INVOICE_HEADER, (line, idx, companyId) =>
    defaultLineCreate(line, idx, companyId, {
      description: line.description ?? null,
      productName: line.productName ?? null,
      productCode: line.productCode ?? null,
      qty: line.qty ?? line.quantity ?? 0,
      unit: line.unit ?? null,
      unitPrice: line.unitPrice ?? 0,
      discountPct: line.discountPct ?? line.discount ?? 0,
      taxRate: line.taxRate ?? 0,
      taxCode: line.taxCode || 'A',
      warehouseId: line.warehouse ? toIdString(line.warehouse) : null,
    }));
}

const recurringInvoiceTranslateUpdate = genericTranslateUpdate(RECURRING_INVOICE_HEADER, ['clientId']);

const RECURRING_INVOICE_RUN_HEADER = {
  template: 'recurringInvoiceId',
  recurringInvoice: 'recurringInvoiceId',
  runDate: 'runDate',
  invoice: 'invoiceId',
  status: 'status',
  errorMessage: 'errorMessage',
};

const recurringInvoiceRunTranslateCreate = (data) => {
  const { createdById, ...payload } = headerTranslateCreate(
    data,
    RECURRING_INVOICE_RUN_HEADER,
    ['recurringInvoiceId', 'invoiceId'],
  );
  return payload;
};
const recurringInvoiceRunTranslateUpdate = genericTranslateUpdate(
  RECURRING_INVOICE_RUN_HEADER,
  ['recurringInvoiceId', 'invoiceId'],
);

// ── Translate: PurchaseOrder / Purchase / GRN / Return ───────────────────────

const PURCHASE_ORDER_HEADER = {
  referenceNo: 'referenceNo',
  aiProposalId: 'aiProposalId',
  supplier: 'supplierId',
  warehouse: 'warehouseId',
  status: 'status',
  orderDate: 'orderDate',
  expectedDeliveryDate: 'expectedDeliveryDate',
  currencyCode: 'currencyCode',
  exchangeRate: 'exchangeRate',
  subtotal: 'subtotal',
  taxAmount: 'taxAmount',
  totalAmount: 'totalAmount',
  amountPaid: 'amountPaid',
  balance: 'balance',
  paymentStatus: 'paymentStatus',
  payments: 'payments',
  notes: 'notes',
  approvedBy: 'approvedById',
  approvedAt: 'approvedAt',
};

function purchaseOrderTranslateCreate(data) {
  const lines = Array.isArray(data.lines || data.items) ? (data.lines || data.items) : [];
  const linesSubtotal = lines.reduce((s, l) => {
    const qty = Number(l.qtyOrdered ?? l.qty ?? 0) || 0;
    const unitCost = Number(l.unitCost ?? 0) || 0;
    return s + qty * unitCost;
  }, 0);
  const linesTax = lines.reduce((s, l) => s + (Number(l.taxAmount) || 0), 0);
  const linesTotal = lines.reduce((s, l) => s + (Number(l.lineTotal) || 0), 0)
    || (linesSubtotal + linesTax);

  const subtotal = Number(data.subtotal) > 0 ? Number(data.subtotal) : linesSubtotal;
  const taxAmount = Number(data.taxAmount) > 0 ? Number(data.taxAmount) : linesTax;
  const totalAmount = Number(data.totalAmount) > 0 ? Number(data.totalAmount) : linesTotal;

  const payload = {
    ...data,
    subtotal: moneyStr(subtotal),
    taxAmount: moneyStr(taxAmount),
    totalAmount: moneyStr(totalAmount),
    balance: data.balance != null ? moneyStr(data.balance) : moneyStr(totalAmount),
  };

  return genericTranslateCreate(payload, {
    ...PURCHASE_ORDER_HEADER,
    balance: 'balance',
    amountPaid: 'amountPaid',
    paymentStatus: 'paymentStatus',
    freight: 'freight',
    source: 'source',
  }, (line, idx, companyId) => {
    const qty = Number(line.qtyOrdered ?? line.qty ?? 0) || 0;
    const unitCost = Number(line.unitCost ?? 0) || 0;
    const taxRate = Number(line.taxRate ?? 0) || 0;
    const lineSubtotal = qty * unitCost;
    const taxAmountLine = Number(line.taxAmount) > 0
      ? Number(line.taxAmount)
      : lineSubtotal * (taxRate / 100);
    const lineTotal = Number(line.lineTotal) > 0
      ? Number(line.lineTotal)
      : lineSubtotal + taxAmountLine;
    const budgetRefs = {};
    const budgetId = line.budgetId || line.budget_id;
    const budgetLineId = line.budget_line_id || line.budgetLineId;
    if (budgetId) budgetRefs.budgetId = toIdString(budgetId);
    if (budgetLineId) budgetRefs.budgetLineId = toIdString(budgetLineId);
    if (line.accountId || line.account_id) budgetRefs.accountId = toIdString(line.accountId || line.account_id);
    if (line.project_id || line.projectId) budgetRefs.projectId = toIdString(line.project_id || line.projectId);
    if (line.projectName) budgetRefs.projectName = String(line.projectName);
    if (line.projectCode) budgetRefs.projectCode = String(line.projectCode);
    if (line.encumbrance_id || line.encumbranceId) budgetRefs.encumbranceId = toIdString(line.encumbrance_id || line.encumbranceId);
    return defaultLineCreate(line, idx, companyId, {
      qtyOrdered: qty,
      qtyReceived: line.qtyReceived ?? 0,
      unitCost,
      taxRate,
      taxAmount: taxAmountLine,
      lineTotal,
      ...(Object.keys(budgetRefs).length ? { budgetRefs } : {}),
    });
  });
}

const purchaseOrderTranslateUpdate = genericTranslateUpdate(
  PURCHASE_ORDER_HEADER,
  ['supplierId', 'warehouseId'],
);

const PURCHASE_HEADER = {
  purchaseNumber: 'purchaseNumber',
  supplier: 'supplierId',
  supplierInvoiceNumber: 'supplierInvoiceNumber',
  warehouse: 'warehouseId',
  status: 'status',
  currency: 'currency',
  exchangeRate: 'exchangeRate',
  subtotal: 'subtotal',
  taxAmount: 'taxAmount',
  totalAmount: 'totalAmount',
  payments: 'payments',
  purchaseDate: 'purchaseDate',
};

function purchaseTranslateCreate(data) {
  const lines = Array.isArray(data.lines || data.items) ? (data.lines || data.items) : [];
  const mappedLines = lines.map((line) => {
    const qty = Number(line.qty ?? line.quantity ?? 0) || 0;
    const unitCost = Number(line.unitCost ?? 0) || 0;
    const discount = Number(line.discount ?? 0) || 0;
    const taxRate = Number(line.taxRate ?? 0) || 0;
    const net = qty * unitCost - discount;
    const taxAmount = Number(line.taxAmount) >= 0 && line.taxAmount != null
      ? Number(line.taxAmount)
      : net * (taxRate / 100);
    const lineTotal = Number(line.lineTotal ?? line.totalWithTax) > 0
      ? Number(line.lineTotal ?? line.totalWithTax)
      : net + taxAmount;
    return { ...line, qty, quantity: qty, unitCost, taxRate, taxAmount, lineTotal, totalWithTax: lineTotal };
  });

  let subtotal = Number(data.subtotal);
  let taxAmount = Number(data.taxAmount ?? data.totalTax);
  let totalAmount = Number(data.totalAmount ?? data.roundedAmount ?? data.grandTotal);
  if (!Number.isFinite(subtotal) || subtotal <= 0) {
    subtotal = mappedLines.reduce((s, l) => s + (Number(l.qty) * Number(l.unitCost) - Number(l.discount || 0)), 0);
  }
  if (!Number.isFinite(taxAmount) || taxAmount < 0) {
    taxAmount = mappedLines.reduce((s, l) => s + Number(l.taxAmount || 0), 0);
  }
  if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
    totalAmount = mappedLines.reduce((s, l) => s + Number(l.lineTotal || 0), 0) || (subtotal + taxAmount);
  }

  return genericTranslateCreate(
    { ...data, items: mappedLines, lines: mappedLines, subtotal, taxAmount, totalAmount },
    PURCHASE_HEADER,
    (line, idx, companyId) =>
      defaultLineCreate(line, idx, companyId, {
        qty: line.qty ?? line.quantity ?? 0,
        unitCost: line.unitCost ?? 0,
        taxRate: line.taxRate ?? 0,
        lineTotal: line.lineTotal ?? line.totalWithTax ?? 0,
        extra: {
          ...(line.extra && typeof line.extra === 'object' ? line.extra : {}),
          ...(line.budgetId || line.budget_id ? { budgetId: toIdString(line.budgetId || line.budget_id) } : {}),
          ...(line.budget_line_id || line.budgetLineId ? { budget_line_id: toIdString(line.budget_line_id || line.budgetLineId) } : {}),
          ...(line.accountId || line.account_id ? { accountId: toIdString(line.accountId || line.account_id) } : {}),
          ...(line.project_id || line.projectId ? { project_id: toIdString(line.project_id || line.projectId) } : {}),
          ...(line.projectName ? { projectName: String(line.projectName) } : {}),
          ...(line.projectCode ? { projectCode: String(line.projectCode) } : {}),
          ...(line.encumbrance_id || line.encumbranceId ? { encumbrance_id: toIdString(line.encumbrance_id || line.encumbranceId) } : {}),
          ...(line.taxCode ? { taxCode: line.taxCode } : {}),
          ...(line.discount != null ? { discount: Number(line.discount) || 0 } : {}),
          ...(line.trackingType ? { trackingType: String(line.trackingType) } : {}),
          ...(line.batchNo ? { batchNo: String(line.batchNo).trim() } : {}),
          ...(line.lotNo ? { lotNo: String(line.lotNo).trim() } : {}),
          ...(line.manufactureDate ? { manufactureDate: line.manufactureDate } : {}),
          ...(line.expiryDate ? { expiryDate: line.expiryDate } : {}),
          ...(Array.isArray(line.serialNumbers) ? { serialNumbers: line.serialNumbers.map((value) => String(value).trim().toUpperCase()).filter(Boolean) } : {}),
        },
      }),
  );
}

const purchaseTranslateUpdate = genericTranslateUpdate(PURCHASE_HEADER, ['supplierId', 'warehouseId']);

const GRN_HEADER = {
  referenceNo: 'referenceNo',
  purchaseOrder: 'purchaseOrderId',
  warehouse: 'warehouseId',
  supplier: 'supplierId',
  status: 'status',
  receivedDate: 'receivedDate',
  supplierInvoiceNo: 'supplierInvoiceNo',
  totalAmount: 'totalAmount',
  balance: 'balance',
  amountPaid: 'amountPaid',
  paymentStatus: 'paymentStatus',
  paymentDueDate: 'paymentDueDate',
  journalEntry: 'journalEntryId',
  confirmedBy: 'confirmedById',
  confirmedAt: 'confirmedAt',
  freight: 'freight',
  ebmImportReference: 'ebmImportReference',
};

function grnTranslateCreate(data) {
  return genericTranslateCreate(data, GRN_HEADER, (line, idx, companyId) =>
    defaultLineCreate(line, idx, companyId, {
      purchaseOrderLineId: line.purchaseOrderLine ? toIdString(line.purchaseOrderLine) : null,
      qtyReceived: line.qtyReceived ?? line.qty ?? 0,
      unitCost: line.unitCost ?? 0,
      landedUnitCost: line.landedUnitCost ?? null,
      taxRate: line.taxRate ?? 0,
      batchNo: line.batchNo ?? null,
      serialNumbers: Array.isArray(line.serialNumbers) ? line.serialNumbers : [],
    }));
}

const grnTranslateUpdate = genericTranslateUpdate(
  GRN_HEADER,
  ['purchaseOrderId', 'warehouseId', 'supplierId', 'journalEntryId', 'confirmedById'],
);

const PURCHASE_RETURN_HEADER = {
  referenceNo: 'referenceNo',
  grn: 'grnId',
  purchase: 'purchaseId',
  supplier: 'supplierId',
  warehouse: 'warehouseId',
  status: 'status',
  returnDate: 'returnDate',
  reason: 'reason',
  supplierCreditNoteNo: 'supplierCreditNoteNo',
  totalAmount: 'totalAmount',
  refundMethod: 'refundMethod',
  bankAccountId: 'bankAccountId',
  bankRefundReference: 'bankRefundReference',
  refundedAt: 'refundedAt',
  confirmedAt: 'confirmedAt',
  confirmedBy: 'confirmedById',
  refundBankTransaction: 'refundBankTransactionId',
  journalEntry: 'journalEntryId',
  refundJournalEntry: 'refundJournalEntryId',
};

function purchaseReturnTranslateCreate(data) {
  return genericTranslateCreate(data, PURCHASE_RETURN_HEADER, (line, idx, companyId) =>
    defaultLineCreate(line, idx, companyId, {
      grnLineId: line.grnLine ? toIdString(line.grnLine) : null,
      purchaseLineId: line.purchaseLine ? toIdString(line.purchaseLine) : null,
      qtyReturned: line.qtyReturned ?? line.qty ?? 0,
      unitCost: line.unitCost ?? 0,
      serialNumbers: Array.isArray(line.serialNumbers) ? line.serialNumbers : [],
    }));
}

const purchaseReturnTranslateUpdate = genericTranslateUpdate(
  PURCHASE_RETURN_HEADER,
  ['grnId', 'purchaseId', 'supplierId', 'warehouseId', 'bankAccountId', 'journalEntryId', 'refundJournalEntryId', 'refundBankTransactionId', 'confirmedById'],
);

// ── Translate: APPayment / Allocation / FreightBill ────────────────────────

const AP_PAYMENT_HEADER = {
  referenceNo: 'referenceNo',
  reference: 'externalReference',
  notes: 'notes',
  supplier: 'supplierId',
  status: 'status',
  paymentDate: 'paymentDate',
  paymentMethod: 'paymentMethod',
  bankAccount: 'bankAccountId',
  amountPaid: 'amountPaid',
  currencyCode: 'currencyCode',
  exchangeRate: 'exchangeRate',
  unallocatedAmount: 'unallocatedAmount',
};

const apPaymentTranslateCreate = (data) => headerTranslateCreate(data, AP_PAYMENT_HEADER, ['supplierId', 'bankAccountId']);
const apPaymentTranslateUpdate = genericTranslateUpdate(AP_PAYMENT_HEADER, ['supplierId', 'bankAccountId']);

const AP_PAYMENT_ALLOC_HEADER = {
  payment: 'paymentId',
  grn: 'grnId',
  amountAllocated: 'amountAllocated',
};

const apPaymentAllocationTranslateCreate = (data) =>
  headerTranslateCreate(data, AP_PAYMENT_ALLOC_HEADER, ['paymentId', 'grnId']);
const apPaymentAllocationTranslateUpdate = genericTranslateUpdate(AP_PAYMENT_ALLOC_HEADER, ['paymentId', 'grnId']);

const FREIGHT_BILL_HEADER = {
  referenceNo: 'referenceNo',
  supplier: 'supplierId',
  carrierName: 'carrierName',
  amount: 'amount',
  account: 'account',
  invoiceDate: 'invoiceDate',
  paymentMethod: 'paymentMethod',
  status: 'status',
  grnMatches: 'grnMatches',
};

const freightBillTranslateCreate = (data) => headerTranslateCreate(data, FREIGHT_BILL_HEADER, ['supplierId']);
const freightBillTranslateUpdate = genericTranslateUpdate(FREIGHT_BILL_HEADER, ['supplierId']);

module.exports = {
  quotationToApi,
  quotationLineToApi,
  quotationTranslateCreate: withReferenceNo('QUOT', quotationTranslateCreate, { model: 'quotation' }),
  quotationTranslateUpdate,
  salesOrderToApi,
  salesOrderLineToApi,
  salesOrderTranslateCreate: withReferenceNo('SO', salesOrderTranslateCreate, { model: 'salesOrder' }),
  salesOrderTranslateUpdate,
  invoiceToApi,
  invoiceLineToApi,
  invoiceTranslateCreate: withReferenceNo('INV', invoiceTranslateCreate, { model: 'invoice' }),
  invoiceTranslateUpdate,
  creditNoteToApi,
  creditNoteTranslateCreate: withReferenceNo('CN', creditNoteTranslateCreate, { model: 'creditNote' }),
  creditNoteTranslateUpdate,
  deliveryNoteToApi,
  deliveryNoteTranslateCreate: withReferenceNo('DN', deliveryNoteTranslateCreate, { model: 'deliveryNote' }),
  deliveryNoteTranslateUpdate,
  pickPackToApi,
  pickPackLineToApi,
  pickPackTranslateCreate: withReferenceNo('PK', pickPackTranslateCreate, { model: 'pickPack' }),
  pickPackTranslateUpdate,
  arReceiptToApi,
  arReceiptTranslateCreate: withReferenceNo('RCP', arReceiptTranslateCreate, { model: 'aRReceipt' }),
  arReceiptTranslateUpdate,
  arReceiptAllocationToApi,
  arReceiptAllocationTranslateCreate,
  arReceiptAllocationTranslateUpdate,
  recurringInvoiceToApi,
  recurringInvoiceLineToApi,
  // REC-NNNNN — the only document numbered without a year segment.
  recurringInvoiceTranslateCreate: withReferenceNo('REC', recurringInvoiceTranslateCreate, {
    yearScoped: false,
    model: 'recurringInvoice',
  }),
  recurringInvoiceTranslateUpdate,
  recurringInvoiceRunToApi,
  recurringInvoiceRunTranslateCreate,
  recurringInvoiceRunTranslateUpdate,
  purchaseOrderToApi,
  purchaseOrderLineToApi,
  purchaseOrderTranslateCreate: withReferenceNo('PO', purchaseOrderTranslateCreate, { model: 'purchaseOrder' }),
  purchaseOrderTranslateUpdate,
  purchaseToApi,
  purchaseTranslateCreate: withReferenceNo('PO', purchaseTranslateCreate, {
    field: 'purchaseNumber',
    model: 'purchase',
  }),
  purchaseTranslateUpdate,
  grnToApi,
  grnLineToApi,
  grnTranslateCreate: withReferenceNo('GRN', grnTranslateCreate, { model: 'goodsReceivedNote' }),
  grnTranslateUpdate,
  purchaseReturnToApi,
  purchaseReturnLineToApi,
  purchaseReturnTranslateCreate: withReferenceNo('PRN', purchaseReturnTranslateCreate, { model: 'purchaseReturn' }),
  purchaseReturnTranslateUpdate,
  apPaymentToApi,
  apPaymentTranslateCreate: withReferenceNo('PAY', apPaymentTranslateCreate, { model: 'aPPayment' }),
  apPaymentTranslateUpdate,
  apPaymentAllocationToApi,
  apPaymentAllocationTranslateCreate,
  apPaymentAllocationTranslateUpdate,
  freightBillToApi,
  freightBillTranslateCreate: withReferenceNo('FB', freightBillTranslateCreate, { model: 'freightBill' }),
  freightBillTranslateUpdate,
  genericTranslateCreate,
  genericTranslateUpdate,
  mapLines,
};
