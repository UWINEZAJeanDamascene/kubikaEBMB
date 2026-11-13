'use strict';

const { dbClient } = require('../lib/prisma');

async function getWarehousePriceListPrices(
  companyId,
  warehouseId,
  productIds = [],
  effectiveAt = new Date(),
  priceListIdOverride = null,
  usePriceListOverride = false,
) {
  if (!warehouseId) return { priceListId: null, priceByProduct: new Map(), effectiveByProduct: new Map() };
  const rows = [];
  for (let offset = 0; offset < productIds.length; offset += 500) {
    const batch = productIds.slice(offset, offset + 500).map(String);
    if (!batch.length) continue;
    rows.push(...await dbClient().$queryRawUnsafe(
      `SELECT CASE WHEN $5::boolean THEN $6::char(24) ELSE w.price_list_id END AS "priceListId",
            p.id AS "productId",
            COALESCE(
              CASE
                WHEN EXISTS (
                  SELECT 1 FROM pos_effective_prices history
                   WHERE history.company_id = w.company_id
                     AND history.product_id = p.id
                     AND history.price_list_id = CASE WHEN $5::boolean THEN $6::char(24) ELSE w.price_list_id END
                ) THEN listed.price
                ELSE pli.price
              END,
              standard.price,
              CASE
                WHEN EXISTS (
                  SELECT 1 FROM pos_effective_prices history
                   WHERE history.company_id = w.company_id
                     AND history.product_id = p.id
                     AND history.price_list_id IS NULL
                ) THEN NULL
                ELSE p.selling_price
              END
            ) AS price,
            COALESCE(listed.effective_from, standard.effective_from) AS "effectiveFrom",
            COALESCE(listed.effective_to, standard.effective_to) AS "effectiveTo"
       FROM warehouses w
       JOIN products p
         ON p.company_id = w.company_id
        AND p.id = ANY($3::char(24)[])
       LEFT JOIN price_list_items pli
         ON pli.price_list_id = CASE WHEN $5::boolean THEN $6::char(24) ELSE w.price_list_id END
        AND pli.company_id = w.company_id
        AND pli.product_id = p.id
       LEFT JOIN LATERAL (
         SELECT history.price, history.effective_from, history.effective_to
           FROM pos_effective_prices history
          WHERE history.company_id = w.company_id
            AND history.product_id = p.id
            AND history.price_list_id = CASE WHEN $5::boolean THEN $6::char(24) ELSE w.price_list_id END
            AND history.effective_from <= $4::timestamptz
            AND (history.effective_to IS NULL OR history.effective_to > $4::timestamptz)
          ORDER BY history.effective_from DESC
          LIMIT 1
       ) listed ON TRUE
       LEFT JOIN LATERAL (
         SELECT history.price, history.effective_from, history.effective_to
           FROM pos_effective_prices history
          WHERE history.company_id = w.company_id
            AND history.product_id = p.id
            AND history.price_list_id IS NULL
            AND history.effective_from <= $4::timestamptz
            AND (history.effective_to IS NULL OR history.effective_to > $4::timestamptz)
          ORDER BY history.effective_from DESC
          LIMIT 1
       ) standard ON TRUE
      WHERE w.id = $1 AND w.company_id = $2
      LIMIT 500`,
      String(warehouseId),
      String(companyId),
      batch,
      effectiveAt,
      usePriceListOverride,
      priceListIdOverride,
    ));
  }
  const priceByProduct = new Map();
  const effectiveByProduct = new Map();
  for (const row of rows) {
    if (!row.productId) continue;
    const productId = String(row.productId);
    priceByProduct.set(productId, Number(row.price));
    effectiveByProduct.set(productId, {
      effectiveFrom: row.effectiveFrom ? new Date(row.effectiveFrom).toISOString() : null,
      effectiveTo: row.effectiveTo ? new Date(row.effectiveTo).toISOString() : null,
    });
  }
  return {
    priceListId: rows[0]?.priceListId ? String(rows[0].priceListId) : null,
    priceByProduct,
    effectiveByProduct,
  };
}

function effectivePrice(productId, standardPrice, priceByProduct) {
  const listedPrice = priceByProduct?.get(String(productId));
  return listedPrice == null ? Number(standardPrice) || 0 : Number(listedPrice);
}

module.exports = { getWarehousePriceListPrices, effectivePrice };
