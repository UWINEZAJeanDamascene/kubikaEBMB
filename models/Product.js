/**
 * Product model — PostgreSQL (Prisma) backed.
 * Supports mutable docs (.save()) and customFind for $expr low-stock queries.
 */

const { dbClient } = require('../lib/prisma');
const { Prisma } = require('@prisma/client');
const {
  translateFilter,
  translateSort,
  IMPOSSIBLE,
  QUERY_MAX_ROWS,
  reportUnboundedRead,
} = require('../utils/prismaCompat');
const { getCompanyId } = require('../utils/prismaTenant');
const { getReadContext, runReadContext } = require('../lib/readContext');
const { assertReadLimit, guardResultRows, recordQuerySafetyViolation } = require('../utils/querySafety');
const { buildTenantModel, STANDARD_TENANT_FIELD_MAP } = require('../utils/masterDataCommon');
const {
  productToApi,
  productTranslateCreate,
  productTranslateUpdate,
} = require('../utils/masterDataMappers');
const { sanitizeProductHistory } = require('../utils/productHistoryHelpers');

function productDocToUpdate(doc) {
  const plain = doc.toObject ? doc.toObject() : { ...doc };
  plain.history = sanitizeProductHistory(plain.history);
  return productTranslateUpdate({ $set: plain });
}

const FIELD_MAP = {
  name: { target: 'name' },
  sku: { target: 'sku', transform: (v) => ({ sku: typeof v === 'string' ? v.toUpperCase() : v }) },
  barcode: { target: 'barcode' },
  barcodeType: { target: 'barcodeType' },
  imageUrl: { target: 'imageUrl' },
  imageUrls: { target: 'imageUrls' },
  description: { target: 'description' },
  category: { target: 'categoryId', isId: true },
  unit: { target: 'unit' },
  supplier: { target: 'supplierId', isId: true },
  currentStock: { target: 'currentStock' },
  reservedQuantity: { target: 'reservedQuantity' },
  isActive: { target: 'isActive' },
  isStockable: { target: 'isStockable' },
  lowStockThreshold: { target: 'lowStockThreshold' },
  averageCost: { target: 'averageCost' },
  sellingPrice: { target: 'sellingPrice' },
  costPrice: { target: 'costPrice' },
  lastSupplyDate: { target: 'lastSupplyDate' },
  lastSaleDate: { target: 'lastSaleDate' },
  costingMethod: { target: 'costingMethod' },
  inventoryAccount: { target: 'inventoryAccount' },
  cogsAccount: { target: 'cogsAccount' },
  revenueAccount: { target: 'revenueAccount' },
  isArchived: { target: 'isArchived' },
  weight: { target: 'weight' },
  brand: { target: 'brand' },
  location: { target: 'location' },
  trackingType: { target: 'trackingType' },
  trackBatch: { target: 'trackBatch' },
  trackSerialNumbers: { target: 'trackSerialNumbers' },
  reorderPoint: { target: 'reorderPoint' },
  reorderQuantity: { target: 'reorderQuantity' },
  defaultWarehouse: { target: 'defaultWarehouseId', isId: true },
  preferredSupplier: { target: 'preferredSupplierId', isId: true },
  taxCode: { target: 'taxCode' },
  taxRate: { target: 'taxRate' },
  ebm: { target: 'ebm' },
  history: { target: 'history' },
  customFields: { target: 'customFields' },
};

// productCustomFind() re-implements filter translation independently of
// makeCompatModel()'s generic find(), so it needs the same merged map
// (company/_id/createdBy live only in STANDARD_TENANT_FIELD_MAP). Without
// this, any filter that reaches customFind (i.e. every search or low-stock
// query, since both include `company`) translated to IMPOSSIBLE and silently
// returned zero rows — confirmed against live data.
const FULL_FIELD_MAP = { ...STANDARD_TENANT_FIELD_MAP, ...FIELD_MAP };

function applyTenant(where, opts = {}) {
  if (where === IMPOSSIBLE) return where;
  if (opts.skipTenant) return where;
  if (where && where.companyId !== undefined) return where;
  const companyId = opts.companyId || getCompanyId();
  if (!companyId) return where;
  return { ...where, companyId: String(companyId) };
}

function buildProductInclude(populate = []) {
  if (!populate || !populate.length) return undefined;
  const inc = {};
  for (const p of populate) {
    const path = typeof p === 'object' ? p.path : p;
    if (path === 'category') inc.category = { select: { id: true, name: true } };
    if (path === 'supplier') inc.supplier = { select: { id: true, name: true, code: true } };
    if (path === 'preferredSupplier') inc.preferredSupplier = { select: { id: true, name: true, code: true } };
    if (path === 'defaultWarehouse') inc.defaultWarehouse = { select: { id: true, name: true, code: true } };
    if (path === 'createdBy') inc.createdBy = { select: { id: true, name: true, email: true } };
  }
  return Object.keys(inc).length ? inc : undefined;
}

const PRODUCT_SCALAR_FIELDS = [
  'id', 'companyId', 'name', 'sku', 'barcode', 'barcodeType', 'imageUrl', 'imageUrls', 'description',
  'categoryId', 'unit', 'supplierId', 'currentStock', 'reservedQuantity',
  'isActive', 'isStockable', 'lowStockThreshold', 'averageCost', 'sellingPrice',
  'costPrice', 'lastSupplyDate', 'lastSaleDate', 'costingMethod',
  'inventoryAccount', 'cogsAccount', 'revenueAccount', 'isArchived', 'weight',
  'brand', 'location', 'trackingType', 'trackBatch', 'trackSerialNumbers',
  'reorderPoint', 'reorderQuantity', 'defaultWarehouseId', 'preferredSupplierId',
  'taxCode', 'taxRate', 'ebm', 'history', 'createdById', 'customFields',
  'createdAt', 'updatedAt',
];

function parseProductSelect(spec) {
  if (!spec) return null;
  const entries = [];
  if (typeof spec === 'string') {
    for (const token of spec.split(/\s+/).filter(Boolean)) {
      const excluded = token.startsWith('-');
      const clean = token.replace(/^[+-]/, '');
      if (clean) entries.push([clean, excluded ? 0 : 1]);
    }
  } else if (typeof spec === 'object') {
    for (const [key, value] of Object.entries(spec)) entries.push([key, value]);
  }
  if (!entries.length) return null;

  const hasInclude = entries.some(([, value]) => value === 1 || value === true);
  const mode = hasInclude ? 'include' : 'exclude';
  const fields = new Set(entries
    .filter(([, value]) => mode === 'include' ? (value === 1 || value === true) : !(value === 1 || value === true))
    .map(([field]) => {
      const mapped = FULL_FIELD_MAP[field];
      return mapped && mapped.target ? mapped.target : field;
    }));
  return { mode, fields };
}

function productQueryShape(opts = {}) {
  const include = buildProductInclude(opts.populate);
  const projection = parseProductSelect(opts.select);
  if (!projection) return include ? { include } : {};

  const select = {};
  if (projection.mode === 'include') {
    for (const field of projection.fields) {
      if (PRODUCT_SCALAR_FIELDS.includes(field)) select[field] = true;
    }
    select.id = true;
    select.companyId = true;
  } else {
    for (const field of PRODUCT_SCALAR_FIELDS) {
      if (!projection.fields.has(field)) select[field] = true;
    }
    select.id = true;
  }

  for (const [key, value] of Object.entries(include || {})) select[key] = value;
  return { select };
}

const PRISMA_TO_DB = {
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  name: 'name',
  sku: 'sku',
  currentStock: 'current_stock',
  sellingPrice: 'selling_price',
  costPrice: 'cost_price',
  lowStockThreshold: 'low_stock_threshold',
  averageCost: 'average_cost',
  isActive: 'is_active',
  isArchived: 'is_archived',
};

function toDbColumn(field) {
  return PRISMA_TO_DB[field] || field;
}

// Only these DB columns may be interpolated into ORDER BY (raw SQL can't
// parameterize identifiers) — anything else falls back to created_at.
const SAFE_ORDER_COLUMNS = new Set(Object.values(PRISMA_TO_DB));

function buildExprWhere(expr) {
  const op = Object.keys(expr)[0];
  switch (op) {
    case '$lte': return 'p."current_stock" <= p."low_stock_threshold"';
    case '$lt': return 'p."current_stock" < p."low_stock_threshold"';
    case '$gte': return 'p."current_stock" >= p."low_stock_threshold"';
    case '$gt': return 'p."current_stock" > p."low_stock_threshold"';
    case '$eq': return 'p."current_stock" = p."low_stock_threshold"';
    default: return 'true';
  }
}

// Bypasses the compat layer's tx-bound delegate (it needs raw SQL for the
// $expr low-stock comparison), so it resolves the ambient transaction itself
// via dbClient() — otherwise a read inside runInTransaction would miss rows the
// same transaction just wrote.
async function productCustomFind(filter, opts, { many = false, readContext = getReadContext(), maxRows } = {}) {
  const { $expr, $or, $text, ...rest } = filter;
  const readMaxRows = Math.max(1, Number(maxRows || readContext.maxRows || QUERY_MAX_ROWS));
  const requestedLimit = opts.limit != null ? Number(opts.limit) : null;
  if (requestedLimit != null && requestedLimit > 0) {
    assertReadLimit(requestedLimit, readContext, { name: 'limit', maxRows: readMaxRows });
  }
  const where = applyTenant(translateFilter(rest, FULL_FIELD_MAP), opts);
  if (where === IMPOSSIBLE) return many ? [] : null;

  if ($or && Array.isArray($or)) {
    const clauses = [];
    for (const clause of $or) {
      const translated = translateFilter(clause, FULL_FIELD_MAP);
      if (translated !== IMPOSSIBLE) clauses.push(translated);
    }
    if (!clauses.length) return many ? [] : null;
    where.OR = clauses;
  }

  if ($text && $text.$search) {
    const term = String($text.$search).trim();
    if (term) {
      where.OR = [
        { name: { contains: term, mode: 'insensitive' } },
        { sku: { contains: term, mode: 'insensitive' } },
        { description: { contains: term, mode: 'insensitive' } },
        { barcode: { contains: term, mode: 'insensitive' } },
      ];
    }
  }

  if ($expr) {
    // Bug fix: this branch previously referenced Prisma-side camelCase names
    // (p."companyId", p."isArchived", ...) in raw SQL, but the actual Postgres
    // columns are snake_case (@map). It also used a NULLIF($n, 'null') sentinel
    // to make a filter optional, which is invalid SQL once $n binds to a
    // boolean column. Both bugs made every "Low Stock" / "In Stock" product
    // filter throw a 500 (confirmed against the live DB). And even if the SQL
    // had run, `SELECT p.*` returns snake_case keys, not the camelCase shape
    // productToApi()/matchesExpr() expected.
    //
    // Fix: use raw SQL only for what Prisma's query builder genuinely cannot
    // express — comparing two columns on the same row (current_stock vs.
    // low_stock_threshold) — to get the matching, sorted, paginated ID page.
    // Then let Prisma's own client load + shape those rows (correct camelCase
    // fields, relations, decimals) exactly like every other query path.
    const explicitLimit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? requestedLimit
      : null;
    const explicitSkip = Math.max(0, Number(opts.skip) || 0);

    const sortField = translateSort(opts.sort, FULL_FIELD_MAP);
    const sortOrder = sortField && sortField[0] ? (sortField[0].order || 'asc') : 'asc';
    const rawOrderColumn = sortField && Object.keys(sortField[0])[0] ? Object.keys(sortField[0])[0] : 'createdAt';
    const orderColumn = toDbColumn(rawOrderColumn);
    const safeOrderColumn = SAFE_ORDER_COLUMNS.has(orderColumn) ? orderColumn : 'created_at';
    const safeSortOrder = sortOrder === 'desc' ? 'desc' : 'asc';

    const conditions = [
      Prisma.sql`p.company_id = ${where.companyId}`,
      Prisma.sql`${Prisma.raw(buildExprWhere($expr))}`,
    ];
    if (where.isArchived !== undefined) conditions.push(Prisma.sql`p.is_archived = ${where.isArchived}`);
    if (where.isActive !== undefined) conditions.push(Prisma.sql`p.is_active = ${where.isActive}`);
    if (where.categoryId !== undefined) conditions.push(Prisma.sql`p.category_id = ${where.categoryId}`);
    if (where.supplierId !== undefined) conditions.push(Prisma.sql`p.supplier_id = ${where.supplierId}`);
    const whereSql = Prisma.join(conditions, ' AND ');

    const idRows = await dbClient().$queryRaw`
      SELECT p.id FROM products p
      WHERE ${whereSql}
      ORDER BY p.${Prisma.raw(`"${safeOrderColumn}"`)} ${Prisma.raw(safeSortOrder)}
      LIMIT ${explicitLimit || readMaxRows + 1} OFFSET ${explicitSkip}
    `;
    const pageIds = guardResultRows(idRows.map((r) => r.id), {
      context: readContext,
      maxRows: readMaxRows,
      name: 'Product.customFind',
      report: (rowCount, limit) => {
        reportUnboundedRead(rowCount);
        recordQuerySafetyViolation({
          code: 'UNBOUNDED_READ',
          operation: 'Product.customFind',
          purpose: `${readContext.purpose}:max=${limit}`,
        });
      },
    });
    if (pageIds.length === 0) return many ? [] : null;

    const rows = await dbClient().product.findMany({
      where: { id: { in: pageIds } },
      take: pageIds.length,
      ...productQueryShape(opts),
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered = pageIds.map((id) => byId.get(id)).filter(Boolean);

    return many ? ordered : (ordered[0] || null);
  }

  const explicitLimit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? requestedLimit
    : null;
  const baseQuery = {
    where,
    orderBy: translateSort(opts.sort, FIELD_MAP),
    skip: Math.max(0, Number(opts.skip) || 0) || undefined,
    ...productQueryShape(opts),
  };
  const effectiveMaxRows = Math.max(1, Number(readContext.maxRows || QUERY_MAX_ROWS));
  let rows = await runReadContext(
    { ...readContext, internalProbe: !explicitLimit },
    () => dbClient().product.findMany({
      ...baseQuery,
      take: explicitLimit || effectiveMaxRows + 1,
    }),
  );
  if (!explicitLimit && rows.length > effectiveMaxRows) {
    reportUnboundedRead(rows.length);
    recordQuerySafetyViolation({
      code: 'UNBOUNDED_READ',
      operation: 'Product.customFind',
      purpose: `${readContext.purpose}:max=${effectiveMaxRows}`,
    });
    rows = rows.slice(0, effectiveMaxRows);
  }

  return many ? rows : (rows[0] || null);
}

const Product = buildTenantModel({
  name: 'Product',
  collection: 'products',
  delegateName: 'product',
  fieldMap: FIELD_MAP,
  toApi: productToApi,
  translateCreate: productTranslateCreate,
  translateUpdate: productTranslateUpdate,
  docToUpdate: productDocToUpdate,
  include: buildProductInclude,
  mutable: true,
  customFind: productCustomFind,
});

module.exports = Product;
