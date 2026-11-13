'use strict';

const { dbClient } = require('../lib/prisma');
const { getWarehousePriceListPrices, effectivePrice } = require('./priceListService');
const {
  ACTIONS: OFFLINE_ACTIONS,
  normalizeOfflineActionCaps,
  resolveOfflineActionCap,
} = require('./posOfflineActionCapsService');

const PAGE_SIZE = 200;

function cursorValue(value) {
  const parsed = String(value || '0');
  if (!/^\d{1,20}$/.test(parsed)) {
    const error = new Error('The POS sync cursor is invalid.');
    error.status = 400;
    error.code = 'POS_SYNC_CURSOR_INVALID';
    throw error;
  }
  return BigInt(parsed);
}

async function readProductChanges(companyId, warehouseId, productIds) {
  const uniqueIds = [...new Set(productIds.map(String))];
  if (!uniqueIds.length) return [];
  const [products, levels, quarantined] = await Promise.all([
    dbClient().$queryRawUnsafe(
      `SELECT p.id AS "_id", p.name, p.sku, p.barcode, p.image_url AS "imageUrl",
              p.image_urls AS "imageUrls", p.selling_price AS "standardSellingPrice",
              p.unit, p.tax_rate AS "taxRate", p.tax_code AS "taxCode",
              p.average_cost AS "averageCost", p.is_stockable AS "isStockable",
              p.is_no_discount AS "isNoDiscount", p.is_active AS "isActive",
              c.is_no_discount AS "categoryNoDiscount",
              p.track_serial_numbers AS "trackSerialNumbers", p.track_batch AS "trackBatch",
              p.tracking_type AS "trackingType", c.name AS "category"
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id AND c.company_id = p.company_id
        WHERE p.company_id = $1 AND p.id = ANY($2::char(24)[])
        LIMIT 200`,
      companyId,
      uniqueIds,
    ),
    dbClient().$queryRawUnsafe(
      `SELECT product_id AS "productId", qty_on_hand AS "onHandStock",
              qty_reserved AS "reservedStock"
         FROM stock_levels
        WHERE company_id = $1 AND warehouse_id = $2
          AND product_id = ANY($3::char(24)[])
        LIMIT 200`,
      companyId,
      warehouseId,
      uniqueIds,
    ),
    dbClient().stockBatch.groupBy({
      by: ['productId'],
      where: {
        companyId,
        warehouseId,
        productId: { in: uniqueIds },
        isQuarantined: true,
        qtyOnHand: { gt: 0 },
      },
      _sum: { qtyOnHand: true },
    }),
  ]);
  const stockById = new Map(levels.map((row) => [String(row.productId), row]));
  const quarantinedById = new Map(quarantined.map((row) => [
    String(row.productId),
    Number(row._sum?.qtyOnHand || 0),
  ]));
  const prices = await getWarehousePriceListPrices(companyId, warehouseId, products.map((product) => product._id));
  return products
    .filter((product) => product.isActive)
    .map((product) => {
      const stock = stockById.get(String(product._id));
      const onHandStock = Number(stock?.onHandStock || 0);
      const reservedStock = Number(stock?.reservedStock || 0);
      const quarantinedStock = quarantinedById.get(String(product._id)) || 0;
      const taxRate = Number(product.taxRate) || (String(product.taxCode || '').toUpperCase() === 'B' ? 18 : 0);
      const trackingType = product.trackingType === 'serial' || product.trackSerialNumbers
        ? 'serial'
        : product.trackingType === 'batch' || product.trackBatch
          ? 'batch'
          : (product.trackingType || 'none');
      const currentStock = Math.max(0, onHandStock - reservedStock - quarantinedStock);
      return {
        _id: String(product._id),
        name: product.name,
        sku: product.sku,
        barcode: product.barcode,
        imageUrl: product.imageUrl || null,
        imageUrls: Array.isArray(product.imageUrls) ? product.imageUrls : [],
        sellingPrice: effectivePrice(String(product._id), product.standardSellingPrice, prices.priceByProduct),
        standardSellingPrice: Number(product.standardSellingPrice) || 0,
        unit: product.unit,
        taxRate,
        taxCode: product.taxCode || (taxRate > 0 ? 'B' : 'A'),
        currentStock,
        onHandStock,
        reservedStock,
        quarantinedStock,
        averageCost: Number(product.averageCost) || 0,
        category: product.category || null,
        isNoDiscount: Boolean(product.isNoDiscount),
        categoryNoDiscount: Boolean(product.categoryNoDiscount),
        isAvailable: currentStock > 0 || !product.isStockable,
        trackingType,
        incomingTransfers: [],
        outgoingTransfers: [],
      };
    });
}

async function readCustomerChanges(companyId, ids) {
  if (!ids.length) return [];
  return dbClient().$queryRawUnsafe(
    `SELECT id AS "_id", id, name, code, contact, address, tax_id AS "taxId",
            phone_normalized AS phone, credit_limit AS "creditLimit",
            outstanding_balance AS "outstandingBalance", is_walk_in AS "isWalkIn",
            is_active AS "isActive", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM clients
      WHERE company_id = $1 AND id = ANY($2::char(24)[])
      LIMIT 200`,
    companyId,
    ids,
  );
}

async function readSettings(companyId, registerId, tillType) {
  const rows = await dbClient().$queryRawUnsafe(
    `SELECT pos_offline_enabled, pos_offline_max_hours, pos_offline_queue_limit,
            pos_negative_stock_escalation_days, allow_negative_stock,
            pos_offline_action_caps AS "offlineActionCaps"
       FROM system_settings
      WHERE company_id = $1
      LIMIT 1`,
    companyId,
  );
  if (!rows[0]) return null;
  const config = normalizeOfflineActionCaps(rows[0].offlineActionCaps);
  const actionCaps = Object.fromEntries(OFFLINE_ACTIONS.map((action) => {
    const { scope: _scope, ...cap } = resolveOfflineActionCap(config, { action, registerId, tillType });
    return [action, cap];
  }));
  return {
    ...rows[0],
    offlineActionCaps: actionCaps,
    offlineManagerApproval: config.offlineManagerApproval,
  };
}

async function pullChanges({ companyId, warehouseId, registerId, tillType, cursor: rawCursor }) {
  const cursor = cursorValue(rawCursor);
  const rows = await dbClient().$queryRawUnsafe(
    `SELECT id, entity_type AS "entityType", entity_id AS "entityId",
            warehouse_id AS "warehouseId", deleted
       FROM pos_sync_changes
      WHERE company_id = $1
        AND id > $2::bigint
        AND (warehouse_id IS NULL OR warehouse_id = $3)
      ORDER BY id ASC
      LIMIT ${PAGE_SIZE + 1}`,
    companyId,
    cursor.toString(),
    warehouseId,
  );
  const hasMore = rows.length > PAGE_SIZE;
  const page = rows.slice(0, PAGE_SIZE);
  const nextCursor = page.length ? String(page[page.length - 1].id) : rawCursor || '0';
  const catalogIds = [];
  const deletedProducts = [];
  const priceIds = [];
  const deletedCustomers = [];
  const customerIds = [];
  let settingsChanged = false;
  const latestChanges = new Map();
  for (const change of page) {
    latestChanges.set(`${change.entityType}:${change.entityId}`, change);
  }
  for (const change of latestChanges.values()) {
    const id = String(change.entityId);
    if (change.entityType === 'catalog') {
      if (change.deleted) deletedProducts.push(id);
      else catalogIds.push(id);
    } else if (change.entityType === 'prices') {
      priceIds.push(id);
    } else if (change.entityType === 'customers') {
      if (change.deleted) deletedCustomers.push(id);
      else customerIds.push(id);
    } else if (change.entityType === 'settings') {
      settingsChanged = true;
    }
  }
  const [catalog, priceProducts, customers, settings] = await Promise.all([
    readProductChanges(companyId, warehouseId, catalogIds),
    readProductChanges(companyId, warehouseId, priceIds),
    readCustomerChanges(companyId, customerIds),
    settingsChanged ? readSettings(companyId, registerId, tillType) : null,
  ]);
  return {
    cursor: nextCursor,
    generatedAt: new Date().toISOString(),
    hasMore,
    fullSnapshot: false,
    changes: {
      catalog: { upserts: catalog, deleted: [...new Set(deletedProducts)] },
      prices: priceProducts.map((product) => ({
        _id: product._id,
        sellingPrice: product.sellingPrice,
        standardSellingPrice: product.standardSellingPrice,
      })),
      customers: { upserts: customers, deleted: [...new Set(deletedCustomers)] },
      settings,
    },
  };
}

module.exports = { PAGE_SIZE, pullChanges };
