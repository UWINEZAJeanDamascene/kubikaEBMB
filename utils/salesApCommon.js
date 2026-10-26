/**
 * Shared helpers for Phase 5+6 sales/AP Prisma shims.
 */

const { buildTenantModel } = require('./masterDataCommon');

const STANDARD_DOC_FIELD_MAP = {
  _id: { target: 'id', isId: true },
  id: { target: 'id', isId: true },
  company: { target: 'companyId', isId: true },
  companyId: { target: 'companyId', isId: true },
  createdBy: { target: 'createdById', isId: true },
  createdAt: { target: 'createdAt' },
  updatedAt: { target: 'updatedAt' },
};

const DEFAULT_PRODUCT_SELECT = { id: true, name: true, sku: true, barcode: true, unit: true, isStockable: true, trackingType: true, taxCode: true, taxRate: true, ebm: true };

const CLIENT_SELECT_FIELDS = new Set([
  'name', 'code', 'type', 'contact', 'taxId', 'paymentTerms', 'isActive',
  'outstandingBalance', 'creditLimit', 'notes', 'region', 'industry',
]);
const SUPPLIER_SELECT_FIELDS = new Set([
  'name', 'code', 'contact', 'taxId', 'paymentTerms', 'isActive', 'region',
  'currency', 'leadTime', 'minimumOrder', 'bankName', 'bankAccount', 'notes',
  'totalPurchases', 'lastPurchaseDate',
]);
const WAREHOUSE_SELECT_FIELDS = new Set([
  'name', 'code', 'location', 'isActive', 'address', 'rraBranchId',
]);
const PRODUCT_SELECT_FIELDS = new Set([
  'name', 'sku', 'barcode', 'unit', 'taxRate', 'taxCode', 'trackingType', 'isStockable', 'ebm',
  'isActive', 'currentStock', 'sellingPrice', 'costPrice',
]);

/**
 * Map mongoose-style populate select strings to Prisma relation select objects.
 * Unknown fields are dropped so legacy select lists (e.g. supplier "type")
 * cannot crash Prisma validation.
 */
function selectFromPopulate(select, fieldMap = {}, allowedFields = null) {
  if (!select) return null;
  const tokens = typeof select === 'string'
    ? select.split(/\s+/).filter((t) => t && !t.startsWith('-') && !t.startsWith('+'))
    : Object.keys(select).filter((k) => select[k]);
  if (!tokens.length) return null;

  const out = { id: true };
  for (const token of tokens) {
    if (token === '_id' || token === 'id') continue;
    const mapped = fieldMap[token] || token;
    if (allowedFields && !allowedFields.has(mapped)) continue;
    out[mapped] = true;
  }
  return Object.keys(out).length > 1 ? out : null;
}

function findPopulateEntry(populate = [], ...paths) {
  return (populate || []).find((p) => {
    const path = typeof p === 'object' ? p.path : p;
    return paths.includes(path);
  });
}

function buildLineInclude(lineKey = 'lines', productSelect = true) {
  return (populate = []) => {
    const inc = {};
    const wantsLines = !populate.some((p) => {
      const path = typeof p === 'object' ? p.path : p;
      return path === `-${lineKey}` || path === '-lines' || path === '-items';
    });
    if (wantsLines) {
      const productEntry = findPopulateEntry(
        populate,
        `${lineKey}.product`,
        'lines.product',
        'items.product',
      );
      let productInclude;
      if (!productSelect) {
        productInclude = undefined;
      } else if (productEntry) {
        const selected = selectFromPopulate(productEntry.select, {
          taxRate: 'taxRate',
          taxCode: 'taxCode',
          trackingType: 'trackingType',
          isStockable: 'isStockable',
        }, PRODUCT_SELECT_FIELDS) || DEFAULT_PRODUCT_SELECT;
        productInclude = { product: { select: selected } };
      } else {
        productInclude = { product: { select: DEFAULT_PRODUCT_SELECT } };
      }
      inc[lineKey] = {
        orderBy: { lineOrder: 'asc' },
        include: productInclude,
      };
    } else {
      // List reads: skip line/product payloads but keep a cheap line count.
      inc._count = { select: { [lineKey]: true } };
    }

    const clientEntry = findPopulateEntry(populate, 'client');
    if (clientEntry) {
      const selected = selectFromPopulate(clientEntry.select, {
        taxId: 'taxId',
        tin: 'taxId',
        contact: 'contact',
        address: 'contact',
        phone: 'contact',
        email: 'contact',
      }, CLIENT_SELECT_FIELDS);
      inc.client = selected ? { select: selected } : true;
    }

    const supplierEntry = findPopulateEntry(populate, 'supplier');
    if (supplierEntry) {
      const selected = selectFromPopulate(supplierEntry.select, {
        taxId: 'taxId',
        tin: 'taxId',
        contact: 'contact',
      }, SUPPLIER_SELECT_FIELDS);
      inc.supplier = selected ? { select: selected } : true;
    }

    const warehouseEntry = findPopulateEntry(populate, 'warehouse');
    if (warehouseEntry) {
      const selected = selectFromPopulate(warehouseEntry.select, {}, WAREHOUSE_SELECT_FIELDS);
      inc.warehouse = selected ? { select: selected } : true;
    }

    for (const p of populate) {
      const path = typeof p === 'object' ? p.path : p;
      if (path === 'quotation') inc.quotation = { select: { id: true, referenceNo: true } };
      if (path === 'invoice') {
        inc.invoice = {
          select: {
            id: true,
            referenceNo: true,
            status: true,
            currencyCode: true,
            totalAmount: true,
          },
        };
      }
      if (path === 'salesOrder') {
        inc.salesOrder = { select: { id: true, referenceNo: true } };
      }
      if (path === 'deliveryNote') inc.deliveryNote = { select: { id: true, referenceNo: true } };
      if (path === 'purchaseOrder') inc.purchaseOrder = { select: { id: true, referenceNo: true } };
    }
    return Object.keys(inc).length ? inc : undefined;
  };
}

function buildDocumentModel(config) {
  return buildTenantModel({
    tenantField: 'companyId',
    mutable: true,
    fieldMap: { ...STANDARD_DOC_FIELD_MAP, ...config.fieldMap },
    include: config.include || buildLineInclude(),
    ...config,
  });
}

module.exports = {
  STANDARD_DOC_FIELD_MAP,
  buildLineInclude,
  buildDocumentModel,
  selectFromPopulate,
};
