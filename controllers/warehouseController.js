const Warehouse = require('../models/Warehouse');
const InventoryBatch = require('../models/InventoryBatch');
const Product = require('../models/Product');
const { Prisma } = require('@prisma/client');
const { prisma } = require('../lib/prisma');
const { warehouseTranslateCreate, warehouseTranslateUpdate } = require('../utils/masterDataMappers');
const { validateWarehouseInsuranceConfig } = require('../utils/warehouseInsuranceConfig');
const { nextWarehouseCode } = require('../utils/warehouseCode');
const { getDefaultWarehouseInventoryAccount } = require('../services/warehouseAccountService');

const WAREHOUSE_FIELDS = ['name', 'code', 'description', 'location', 'isActive', 'isDefault', 'customFields', 'rraBranchId', 'ebmInsurances'];

function warehousePayload(body = {}) {
  const payload = {};
  for (const field of WAREHOUSE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) payload[field] = body[field];
  }
  if (payload.name !== undefined) payload.name = String(payload.name || '').trim();
  if (payload.code !== undefined) payload.code = String(payload.code || '').trim().toUpperCase();
  if (payload.description !== undefined && payload.description !== null) payload.description = String(payload.description).trim();
  if (payload.ebmInsurances !== undefined) {
    payload.ebmInsurances = validateWarehouseInsuranceConfig(payload.ebmInsurances);
  }
  return payload;
}

function isUniqueConflict(error) {
  return error?.code === 'P2002' || error?.code === '23505' || error?.code === 11000;
}

async function warehouseHasStock(companyId, warehouseId) {
  const [level, inventoryBatch, stockBatch, serial] = await Promise.all([
    prisma.stockLevel.findFirst({ where: { companyId: asId(companyId), warehouseId: asId(warehouseId), OR: [{ qtyOnHand: { gt: 0 } }, { qtyReserved: { gt: 0 } }] }, select: { id: true } }),
    prisma.inventoryBatch.findFirst({ where: { companyId: asId(companyId), warehouseId: asId(warehouseId), OR: [{ availableQuantity: { gt: 0 } }, { reservedQuantity: { gt: 0 } }] }, select: { id: true } }),
    prisma.stockBatch.findFirst({ where: { companyId: asId(companyId), warehouseId: asId(warehouseId), OR: [{ qtyOnHand: { gt: 0 } }, { reservedQuantity: { gt: 0 } }] }, select: { id: true } }),
    prisma.stockSerialNumber.findFirst({ where: { companyId: asId(companyId), warehouseId: asId(warehouseId), status: { in: ['in_stock', 'reserved', 'returned'] } }, select: { id: true } }),
  ]);
  return Boolean(level || inventoryBatch || stockBatch || serial);
}

function asId(value) {
  if (!value) return null;
  return value.toString ? value.toString() : String(value);
}

async function getWarehouseStockSummaries(companyId, warehouseIds) {
  const ids = [...new Set(warehouseIds.map(asId).filter(Boolean))];
  if (ids.length === 0) return new Map();

  const rows = await prisma.$queryRaw`
    SELECT
      warehouse_id AS "warehouseId",
      COUNT(DISTINCT product_id)::int AS "totalProducts",
      COALESCE(SUM(GREATEST(qty_on_hand - qty_reserved, 0)), 0) AS "totalQuantity",
      COALESCE(SUM(total_value), 0) AS "totalValue"
    FROM stock_levels
    WHERE company_id = ${asId(companyId)}
      AND warehouse_id IN (${Prisma.join(ids)})
      AND qty_on_hand > 0
    GROUP BY warehouse_id
  `;

  return new Map(rows.map((row) => [
    row.warehouseId,
    {
      totalProducts: Number(row.totalProducts || 0),
      totalQuantity: Number(row.totalQuantity || 0),
      totalValue: Number(row.totalValue || 0)
    }
  ]));
}

function withStockSummary(warehouse, summaries) {
  const summary = summaries.get(asId(warehouse._id)) || {
    totalProducts: 0,
    totalQuantity: 0,
    totalValue: 0
  };

  return {
    ...warehouse.toObject(),
    ...summary
  };
}

// @desc    Get all warehouses
// @route   GET /api/stock/warehouses
// @access  Private
exports.getWarehouses = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    const { search, isActive } = req.query;

    const query = { company: companyId };

    if (isActive !== undefined) {
      query.isActive = isActive === 'true';
    }

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { code: { $regex: search, $options: 'i' } }
      ];
    }

    const total = await Warehouse.countDocuments(query);
    const warehouses = await Warehouse.find(query)
      .populate('createdBy', 'name email')
      .sort({ isDefault: -1, name: 1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const stockSummaries = await getWarehouseStockSummaries(companyId, warehouses.map((warehouse) => warehouse._id));
    const warehousesWithStock = warehouses.map((warehouse) => withStockSummary(warehouse, stockSummaries));

    res.json({
      success: true,
      count: warehouses.length,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page,
      data: warehousesWithStock
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single warehouse
// @route   GET /api/stock/warehouses/:id
// @access  Private
exports.getWarehouse = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const warehouse = await Warehouse.findOne({ _id: req.params.id, company: companyId })
      .populate('createdBy', 'name email');

    if (!warehouse) {
      return res.status(404).json({
        success: false,
        message: 'Warehouse not found'
      });
    }

    const stockSummaries = await getWarehouseStockSummaries(companyId, [warehouse._id]);

    res.json({
      success: true,
      data: withStockSummary(warehouse, stockSummaries)
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create warehouse
// @route   POST /api/stock/warehouses
// @access  Private (admin, stock_manager)
exports.createWarehouse = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    const payload = warehousePayload(req.body);
    if (!payload.name) return res.status(400).json({ success: false, message: 'Warehouse name is required' });
    if (payload.isDefault && payload.isActive === false) return res.status(400).json({ success: false, message: 'An inactive warehouse cannot be the default warehouse' });
    const inventoryAccount = await getDefaultWarehouseInventoryAccount(companyId);
    const baseData = await warehouseTranslateCreate({
      ...payload,
      inventoryAccount,
      company: companyId,
      createdBy: req.user.id,
    });
    const generatedCode = !payload.code;
    let row;
    let attempts = 0;
    const maxAttempts = generatedCode ? 5 : 1;

    while (!row && attempts < maxAttempts) {
      attempts += 1;
      try {
        row = await prisma.$transaction(async (tx) => {
          let code = payload.code;
          if (!code) {
            const existingWarehouses = await tx.warehouse.findMany({
              where: { companyId: asId(companyId) },
              select: { code: true },
            });
            code = nextWarehouseCode(existingWarehouses.map((warehouse) => warehouse.code));
          }

          const data = { ...baseData, code };
          const existingDefault = await tx.warehouse.findFirst({ where: { companyId: asId(companyId), isDefault: true } });
          const shouldBeDefault = data.isActive && (data.isDefault || !existingDefault);
          if (shouldBeDefault) await tx.warehouse.updateMany({ where: { companyId: asId(companyId), isDefault: true }, data: { isDefault: false } });
          return tx.warehouse.create({ data: { ...data, isDefault: shouldBeDefault } });
        });
      } catch (error) {
        if (isUniqueConflict(error) && generatedCode && attempts < maxAttempts) continue;
        if (isUniqueConflict(error)) return res.status(409).json({ success: false, code: 'WAREHOUSE_CODE_EXISTS', message: 'A warehouse with this code already exists for this company' });
        throw error;
      }
    }

    const warehouse = await Warehouse.findOne({ _id: row.id, company: companyId });

    res.status(201).json({
      success: true,
      data: warehouse
    });
  } catch (error) {
    if (isUniqueConflict(error)) return res.status(409).json({ success: false, code: 'WAREHOUSE_CODE_EXISTS', message: 'A warehouse with this code already exists for this company' });
    next(error);
  }
};

// @desc    Update warehouse
// @route   PUT /api/stock/warehouses/:id
// @access  Private (admin, stock_manager)
exports.updateWarehouse = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    let warehouse = await Warehouse.findOne({ _id: req.params.id, company: companyId });

    if (!warehouse) {
      return res.status(404).json({
        success: false,
        message: 'Warehouse not found'
      });
    }

    const payload = warehousePayload(req.body);
    // Prevent deactivating a warehouse that still holds stock
    if (payload.isActive === false && warehouse.isActive) {
      if (await warehouseHasStock(companyId, warehouse._id)) {
        return res.status(409).json({
          success: false,
          code: 'WAREHOUSE_HAS_STOCK',
          message: 'Cannot deactivate warehouse while it holds on-hand, reserved, batch, or serialized stock'
        });
      }
    }

    if (payload.isDefault === true && (payload.isActive === false || !warehouse.isActive)) {
      return res.status(400).json({ success: false, message: 'An inactive warehouse cannot be the default warehouse' });
    }
    if (payload.isActive === false && warehouse.isDefault) {
      return res.status(409).json({ success: false, code: 'DEFAULT_WAREHOUSE', message: 'Choose another active default warehouse before deactivating this one' });
    }
    const update = warehouseTranslateUpdate(payload);
    if (Object.prototype.hasOwnProperty.call(payload, 'ebmInsurances')) {
      update.ebmInsuranceSubmitted = false;
      update.ebmInsuranceSubmissions = [];
    }
    const id = asId(warehouse._id);
    await prisma.$transaction(async (tx) => {
      if (update.isDefault === false && warehouse.isDefault) {
        const anotherDefault = await tx.warehouse.findFirst({ where: { companyId: asId(companyId), id: { not: id }, isActive: true, isDefault: true }, select: { id: true } });
        if (!anotherDefault) throw Object.assign(new Error('The company must keep one active default warehouse'), { code: 'DEFAULT_REQUIRED' });
      }
      if (update.isDefault === true) await tx.warehouse.updateMany({ where: { companyId: asId(companyId), isDefault: true, id: { not: id } }, data: { isDefault: false } });
      await tx.warehouse.update({ where: { id }, data: update });
    });
    warehouse = await Warehouse.findOne({ _id: id, company: companyId });

    res.json({
      success: true,
      data: warehouse
    });
  } catch (error) {
    if (error?.code === 'DEFAULT_REQUIRED') return res.status(409).json({ success: false, code: 'DEFAULT_WAREHOUSE_REQUIRED', message: error.message });
    if (isUniqueConflict(error)) return res.status(409).json({ success: false, code: 'WAREHOUSE_DEFAULT_CONFLICT', message: 'Another warehouse became the default at the same time. Refresh and try again.' });
    next(error);
  }
};

// @desc    Delete warehouse
// @route   DELETE /api/stock/warehouses/:id
// @access  Private (admin)
exports.deleteWarehouse = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    const warehouse = await Warehouse.findOne({ _id: req.params.id, company: companyId });

    if (!warehouse) {
      return res.status(404).json({
        success: false,
        message: 'Warehouse not found'
      });
    }

    // Check if warehouse has stock
    const hasStock = await warehouseHasStock(companyId, warehouse._id);

    if (hasStock) {
      return res.status(409).json({
        success: false,
        code: 'WAREHOUSE_HAS_STOCK',
        message: 'Cannot deactivate warehouse while it holds on-hand, reserved, batch, or serialized stock. Transfer or clear the stock first.'
      });
    }

    // Warehouses are referenced by movement history and other documents. Retire them instead of hard deleting history.
    const warehouseCount = await Warehouse.countDocuments({ company: companyId, isActive: true });
    if (warehouseCount <= 1) {
      return res.status(409).json({
        success: false,
        code: 'LAST_ACTIVE_WAREHOUSE',
        message: 'Cannot deactivate the last active warehouse'
      });
    }
    await prisma.$transaction(async (tx) => {
      const replacement = await tx.warehouse.findFirst({ where: { companyId: asId(companyId), id: { not: asId(warehouse._id) }, isActive: true }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] });
      if (!replacement) throw new Error('No active warehouse is available to replace this warehouse');
      if (warehouse.isDefault) {
        await tx.warehouse.update({ where: { id: replacement.id }, data: { isDefault: true } });
      }
      await tx.product.updateMany({ where: { companyId: asId(companyId), defaultWarehouseId: asId(warehouse._id) }, data: { defaultWarehouseId: replacement.id } });
      await tx.warehouse.update({ where: { id: asId(warehouse._id) }, data: { isActive: false, isDefault: false } });
    });

    res.json({
      success: true,
      message: 'Warehouse deactivated. Its transaction history has been retained.'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get warehouse inventory
// @route   GET /api/stock/warehouses/:id/inventory
// @access  Private
exports.getWarehouseInventory = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { page = 1, limit = 50, search, lowStock, expiring } = req.query;

    const query = {
      company: companyId,
      warehouse: req.params.id
    };

    if (lowStock === 'true') {
      query.$expr = { $lte: ['$availableQuantity', '$quantity * 0.2'] };
    }

    if (expiring === 'true') {
      const thirtyDaysFromNow = new Date();
      thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);
      query.expiryDate = { $lte: thirtyDaysFromNow, $gte: new Date() };
    }

    let inventoryQuery = InventoryBatch.find(query)
      .populate('product', 'name sku unit currentStock lowStockThreshold')
      .populate('supplier', 'name code')
      .sort({ expiryDate: 1, createdAt: -1 });

    // Handle search
    if (search) {
      const products = await Product.find({
        company: companyId,
        $or: [
          { name: { $regex: search, $options: 'i' } },
          { sku: { $regex: search, $options: 'i' } }
        ]
      }).select('_id');

      const productIds = products.map(p => p._id);
      inventoryQuery = inventoryQuery.where('product').in(productIds);
    }

    const total = await inventoryQuery.clone().countDocuments();
    const inventory = await inventoryQuery
      .limit(limit * 1)
      .skip((page - 1) * limit);

    res.json({
      success: true,
      count: inventory.length,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page,
      data: inventory
    });
  } catch (error) {
    next(error);
  }
};
