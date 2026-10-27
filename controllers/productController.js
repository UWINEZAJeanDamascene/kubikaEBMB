const mongoose = require('mongoose');
const Product = require('../models/Product');
const { dbClient } = require('../lib/prisma');
const User = require('../models/User');
const StockMovement = require('../models/StockMovement');
const Quotation = require('../models/Quotation');
const Invoice = require('../models/Invoice');
const Supplier = require('../models/Supplier');
const EBMCode = require('../models/EBMCode');
const TaxAutomationService = require('../services/taxAutomationService');
const bwipjs = require('bwip-js');
const QRCode = require('qrcode');
const ChartOfAccount = require('../models/ChartOfAccount');
const { notifyLowStock, notifyOutOfStock, notifyStockReceived } = require('../services/notificationHelper');
const cacheService = require('../services/cacheService');
const { parsePagination, paginationMeta } = require('../utils/pagination');
const slowQueryMonitor = require('../utils/slowQueryMonitor');
const {
  slimProductForHistory,
  buildProductHistoryChanges,
  enrichProductHistory,
} = require('../utils/productHistoryHelpers');

async function timedQuery(label, fn) {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    slowQueryMonitor.record(label, Date.now() - start);
  }
}

async function validateProductAccounts(body, companyId) {
  const errors = {};
  const checks = [
    { key: 'inventoryAccount', types: ['asset'], label: 'inventoryAccount' },
    { key: 'cogsAccount', types: ['cogs', 'expense'], label: 'cogsAccount' },
    { key: 'revenueAccount', types: ['revenue'], label: 'revenueAccount' },
  ];

  for (const { key, types, label } of checks) {
    const value = body[key];
    if (!value) continue;

    let account = null;
    try {
      if (mongoose.Types.ObjectId.isValid(value)) {
        account = await ChartOfAccount.findOne({ _id: value, company: companyId, isActive: true });
      }
    } catch (err) {
      // ignore cast errors and fall back to code lookup
    }

    if (!account) {
      account = await ChartOfAccount.findOne({ code: value, company: companyId, isActive: true });
    }

    if (!account) {
      errors[label] = 'Account not found for this company';
      continue;
    }
    if (!types.includes(account.type)) {
      errors[label] = `Account must be of type ${types.join('/')}`;
    }
  }

  return errors;
}

async function applySyncedEbmTaxRate(body, companyId, existingProduct = null) {
  const ebm = body.ebm && typeof body.ebm === 'object' && !Array.isArray(body.ebm) ? body.ebm : {};
  const explicitEbmCode = ebm.taxTyCd || ebm.taxTypeCode;
  let code = explicitEbmCode;
  if (!code && Object.prototype.hasOwnProperty.call(body, 'taxCode')) {
    if (typeof body.taxCode !== 'string' || !['A', 'B', 'C', 'D'].includes(body.taxCode)) {
      const error = new Error('Tax type must be an exact RRA tax type code from class 04.');
      error.code = 'EBM_PRODUCT_TAX_CODE_INVALID';
      error.statusCode = 422;
      throw error;
    }
    code = body.taxCode;
  }
  if (!code) code = existingProduct?.ebm?.taxTyCd || existingProduct?.ebm?.taxTypeCode;
  if (typeof code !== 'string' || code.trim() !== code || !code) {
    const error = new Error('Select an RRA tax type code before saving this product.');
    error.code = 'EBM_PRODUCT_TAX_CODE_MISSING';
    error.statusCode = 422;
    throw error;
  }

  if (!['A', 'B', 'C', 'D'].includes(code)) {
    const error = new Error('Tax type must be an active RRA tax type code.');
    error.code = 'EBM_PRODUCT_TAX_CODE_INVALID';
    error.statusCode = 422;
    throw error;
  }

  const syncedCode = await EBMCode.findOne({
    company: companyId,
    codeClass: '04',
    code,
    active: { $ne: false },
    useYn: { $ne: 'N' },
  }).lean();
  if (!syncedCode) {
    const error = new Error(`RRA tax type ${code} is not present as an active code in this company's synchronized class 04.`);
    error.code = 'EBM_PRODUCT_TAX_CODE_INVALID';
    error.statusCode = 409;
    throw error;
  }

  const taxRate = await TaxAutomationService.getActiveTaxRate(companyId, {
    code,
    date: new Date(),
  });
  const rate = taxRate?.ratePct == null ? NaN : Number(taxRate.ratePct);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
    const error = new Error(`Configure an active company tax rate for code ${code}; no rate is inferred from the RRA code name or user-defined code fields.`);
    error.code = 'EBM_PRODUCT_TAX_RATE_UNAVAILABLE';
    error.statusCode = 409;
    throw error;
  }

  body.taxCode = code;
  body.taxRate = rate;
  body.ebm = {
    ...ebm,
    taxTyCd: code,
    taxTypeCode: code,
    taxRateSource: {
      type: 'company_tax_rate',
      taxRateId: taxRate._id || taxRate.id,
      code: taxRate.code,
      ratePct: rate,
    },
  };
}

const ALLOWED_PRODUCT_SORT_FIELDS = new Set([
  'createdAt', 'updatedAt', 'name', 'sku', 'currentStock', 'sellingPrice', 'costPrice',
]);

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Prefix-first search clauses — faster on indexed name/sku than full contains scans. */
function buildProductSearchOr(term) {
  const trimmed = String(term).trim();
  if (!trimmed) return null;
  const escaped = escapeRegex(trimmed);
  const or = [
    { sku: { $regex: `^${escaped}`, $options: 'i' } },
    { name: { $regex: `^${escaped}`, $options: 'i' } },
    { barcode: trimmed },
  ];
  if (trimmed.length >= 4) {
    or.push({ description: { $regex: escaped, $options: 'i' } });
  }
  return or;
}

function serializeProductDoc(product) {
  if (!product) return product;
  if (typeof product.toJSON === 'function') return product.toJSON();
  if (typeof product.toObject === 'function') return product.toObject();
  return product;
}

// @desc    Get all products
// @route   GET /api/products
// @access  Private
exports.getProducts = async (req, res, next) => {
  try {
    const {
      search,
      category,
      supplier,
      status,
      sortBy = 'createdAt',
      order = 'desc'
    } = req.query;
    const isArchived =
      req.query.isArchived === undefined
        ? false
        : req.query.isArchived === true || req.query.isArchived === 'true';

    const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 20 });

    // Multi-tenancy: Filter by company
    const company = req.user && req.user.company;
    const companyId = (company && company._id) ? company._id : company;

    const query = { 
      company: companyId,
      isArchived
    };

    // By default only return active products unless explicitly requested
    if (req.query.include_inactive !== 'true') {
      query.isActive = true;
    }

    if (search && search.trim()) {
      const searchOr = buildProductSearchOr(search);
      if (searchOr) query.$or = searchOr;
    }

    if (category && category.trim()) {
      query.category = category;
    }

    if (supplier && supplier.trim()) {
      query.supplier = supplier;
    }

    // Status filtering: 'in_stock', 'low_stock', 'out_of_stock'
    if (status && status.trim()) {
      if (status === 'out_of_stock') {
        query.currentStock = 0;
      } else if (status === 'low_stock') {
        query.$expr = { $lte: ['$currentStock', '$lowStockThreshold'] };
        query.currentStock = { $gt: 0 };
      } else if (status === 'in_stock') {
        query.$expr = { $gt: ['$currentStock', '$lowStockThreshold'] };
      }
    }

    const sortField = ALLOWED_PRODUCT_SORT_FIELDS.has(String(sortBy)) ? sortBy : 'createdAt';

    const isPicker = req.query.forPicker === '1';
    const isStockLevels = req.query.forStockLevels === '1';
    const PRODUCT_LIST_SELECT = (isPicker ? [
      '_id', 'company', 'name', 'sku', 'barcode', 'unit', 'currentStock',
      'isActive', 'isArchived', 'trackingType', 'trackBatch',
      'trackSerialNumbers', 'defaultWarehouse', 'sellingPrice', 'costPrice',
      'preferredSupplier', 'averageCost', 'taxCode', 'taxRate', 'createdAt', 'updatedAt'
    ] : isStockLevels ? [
      '_id', 'company', 'name', 'sku', 'category', 'unit', 'currentStock',
      'reservedQuantity', 'averageCost', 'costPrice', 'lowStockThreshold',
      'isActive', 'isArchived', 'createdAt', 'updatedAt'
    ] : [
      '_id', 'company', 'name', 'sku', 'barcode', 'category', 'unit', 'supplier',
      'currentStock', 'reservedQuantity', 'isActive', 'lowStockThreshold',
      'averageCost', 'sellingPrice', 'costPrice', 'costingMethod', 'isArchived',
      'trackingType', 'trackBatch', 'trackSerialNumbers', 'defaultWarehouse', 'ebm', 'createdAt', 'updatedAt'
    ]).join(' ');

    const hasComplexFilter = !!(query.$or || query.$expr || query.$text);
    const productQuery = Product.find(query)
      .select(PRODUCT_LIST_SELECT)
      .sort({ [sortField]: order === 'desc' ? -1 : 1 })
      .skip(skip)
      .limit(limit)
      .lean();

    if (isStockLevels) {
      productQuery.populate('category', 'name');
    } else if (!isPicker) {
      productQuery
        .populate('category', 'name')
        .populate('supplier', 'name code');
    }

    // Start the count with the page lookup. Previously a full first page
    // always waited for these two independent database queries in sequence.
    const totalPromise = timedQuery(
      hasComplexFilter ? 'getProducts complex count' : 'getProducts count',
      () => Product.countDocuments(query),
    );
    // If the final page is short, the exact total is derived without awaiting
    // the count. Consume a possible background error in that case so it never
    // becomes an unhandled rejection.
    totalPromise.catch((error) => {
      console.error('getProducts count error:', error);
    });

    const products = await timedQuery(
      hasComplexFilter ? 'getProducts complex find' : 'getProducts find',
      () => productQuery,
    );

    let total;
    if (products.length < limit) {
      total = skip + products.length;
    } else {
      total = await totalPromise;
    }

    const quarantinedRows = products.length
      ? await dbClient().stockBatch.groupBy({
        by: ['productId'],
        where: {
          companyId: String(companyId),
          productId: { in: products.map((product) => String(product._id)) },
          isQuarantined: true,
          qtyOnHand: { gt: 0 },
        },
        _sum: { qtyOnHand: true },
      })
      : [];
    const quarantinedByProduct = new Map(quarantinedRows.map((row) => [String(row.productId), Number(row._sum?.qtyOnHand || 0)]));

    const data = products.map((p) => {
      const obj = serializeProductDoc(p);
      obj.quarantinedStock = quarantinedByProduct.get(String(p._id)) || 0;
      if ((!p.averageCost || Number(p.averageCost) === 0) && p.costPrice && Number(p.costPrice) > 0) {
        obj.averageCost = p.costPrice;
      }
      return obj;
    });

    res.json({
      success: true,
      count: products.length,
      total,
      pagination: paginationMeta(page, limit, total),
      pages: Math.ceil(total / limit) || 0,
      currentPage: page,
      data
    });
  } catch (error) {
    console.error('getProduct error:', error);
    next(error);
  }
};

// @desc    Get single product
// @route   GET /api/products/:id
// @access  Private
exports.getProduct = async (req, res, next) => {
  try {
    const company = req.user && req.user.company;
    const companyId = (company && company._id) ? company._id : company;

    const PRODUCT_DETAIL_SELECT = [
      '_id', 'company', 'name', 'sku', 'barcode', 'barcodeType', 'description',
      'category', 'unit', 'supplier', 'preferredSupplier', 'currentStock',
      'reservedQuantity', 'isActive', 'isStockable', 'lowStockThreshold',
      'averageCost', 'sellingPrice', 'costPrice', 'costingMethod',
      'inventoryAccount', 'cogsAccount', 'revenueAccount', 'isArchived',
      'brand', 'location', 'trackingType', 'trackBatch', 'trackSerialNumbers',
      'reorderPoint', 'reorderQuantity', 'defaultWarehouse', 'taxCode', 'taxRate',
      'ebm', 'createdBy', 'createdAt', 'updatedAt'
    ].join(' ');

    const product = await Product.findOne({ _id: req.params.id, company: companyId })
      .select(PRODUCT_DETAIL_SELECT)
      .populate('category', 'name')
      .populate('supplier', 'name code')
      .populate('preferredSupplier', 'name code')
      .populate('defaultWarehouse', 'name code')
      .populate('createdBy', 'name email')
      .lean();

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }


    const quarantined = await dbClient().stockBatch.aggregate({
      where: { companyId: String(companyId), productId: String(product._id), isQuarantined: true, qtyOnHand: { gt: 0 } },
      _sum: { qtyOnHand: true },
    });
    return res.json({
      success: true,
      data: { ...product, quarantinedStock: Number(quarantined._sum?.qtyOnHand || 0) },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create new product
// @route   POST /api/products
// @access  Private (admin, stock_manager)
exports.createProduct = async (req, res, next) => {
  try {
    const company = req.user && req.user.company;
    const companyId = (company && company._id) ? company._id : company;
    
    req.body.company = companyId;
    req.body.createdBy = req.user.id;

    // If category is provided, pre-fill account suggestions from category defaults (suggestion only)
    if (req.body.category) {
      try {
        const category = await require('../models/Category').findOne({ _id: req.body.category, company: companyId }).lean();
        if (category) {
          if (!req.body.inventoryAccount && category.defaultInventoryAccount) req.body.inventoryAccount = category.defaultInventoryAccount;
          if (!req.body.cogsAccount && category.defaultCogsAccount) req.body.cogsAccount = category.defaultCogsAccount;
          if (!req.body.revenueAccount && category.defaultRevenueAccount) req.body.revenueAccount = category.defaultRevenueAccount;
        }
      } catch (e) {
        // ignore prefill errors
      }
    }

    // Business rule: require mapping account codes
    if (!req.body.inventoryAccount && !req.body.inventory_account_id && !req.body.inventory_account) {
      return res.status(422).json({ success: false, errors: { inventoryAccount: 'inventory_account_id is required' } });
    }
    if (!req.body.cogsAccount && !req.body.cogs_account_id && !req.body.cogs_account) {
      return res.status(422).json({ success: false, errors: { cogsAccount: 'cogs_account_id is required' } });
    }
    if (!req.body.revenueAccount && !req.body.revenue_account_id && !req.body.revenue_account) {
      return res.status(422).json({ success: false, errors: { revenueAccount: 'revenue_account_id is required' } });
    }

    // Normalize account fields to new schema keys
    if (req.body.inventory_account_id) req.body.inventoryAccount = req.body.inventory_account_id;
    if (req.body.cogs_account_id) req.body.cogsAccount = req.body.cogs_account_id;
    if (req.body.revenue_account_id) req.body.revenueAccount = req.body.revenue_account_id;

    const accountErrors = await validateProductAccounts(req.body, companyId);
    if (Object.keys(accountErrors).length) {
      return res.status(422).json({ success: false, errors: accountErrors });
    }

    // If averageCost is not provided or is 0, use costPrice as default
    if ((!req.body.averageCost || Number(req.body.averageCost) === 0) && req.body.costPrice && Number(req.body.costPrice) > 0) {
      req.body.averageCost = req.body.costPrice;
    }

    await applySyncedEbmTaxRate(req.body, companyId);

    const product = await Product.create(req.body);

    // Link product to supplier if supplier is provided
    if (product.supplier) {
      const supplier = await Supplier.findOne({ _id: product.supplier, company: companyId });
      if (supplier) {
        const isProductAlreadyLinked = supplier.productsSupplied.some(
          (p) => p.toString() === product._id.toString()
        );
        
        if (!isProductAlreadyLinked) {
          supplier.productsSupplied.push(product._id);
          await supplier.save();
        }
      }
    }

    // Invalidate cache - product changes affect stock reports
    try {
      await cacheService.invalidateByCompany(companyId, 'product');
      await cacheService.invalidateByCompany(companyId, 'stock');
      // Also invalidate all product type caches to ensure fresh data
      await cacheService.invalidateType('product');
    } catch (e) {
      console.error('Cache invalidation failed:', e);
    }

    res.status(201).json({
      success: true,
      data: product
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update product
// @route   PUT /api/products/:id
// @access  Private (admin, stock_manager)
exports.updateProduct = async (req, res, next) => {
  try {
    const company = req.user && req.user.company;
    const companyId = (company && company._id) ? company._id : company;
    
    let product = await Product.findOne({ _id: req.params.id, company: companyId });

    if (!product) {
      return res.status(404).json({ 
        success: false, 
        message: 'Product not found' 
      });
    }

    // Store old values for history (slim snapshot - never embed nested history)
    const oldValues = slimProductForHistory(product);
    const oldSupplierId = product.supplier?.toString();
    const newSupplierId = req.body.supplier;

    // Business rule: Block changing costingMethod when stock history exists
    const incomingCosting = req.body.costingMethod || req.body.costing_method || req.body.costingMethod;
    if (incomingCosting && incomingCosting !== product.costingMethod) {
      const hasMovements = await StockMovement.exists({ product: product._id, company: companyId });
      if (hasMovements) {
        return res.status(409).json({ success: false, code: 'COSTING_METHOD_LOCKED', message: 'Changing costing_method is locked while stock exists' });
      }
    }

    // Normalize account fields to new schema keys
    if (req.body.inventory_account_id) req.body.inventoryAccount = req.body.inventory_account_id;
    if (req.body.cogs_account_id) req.body.cogsAccount = req.body.cogs_account_id;
    if (req.body.revenue_account_id) req.body.revenueAccount = req.body.revenue_account_id;

    const accountErrors = await validateProductAccounts(req.body, companyId);
    if (Object.keys(accountErrors).length) {
      return res.status(422).json({ success: false, errors: accountErrors });
    }

    const taxSettingsSubmitted = Object.prototype.hasOwnProperty.call(req.body, 'taxCode')
      || (req.body.ebm && typeof req.body.ebm === 'object' && !Array.isArray(req.body.ebm)
        && (Object.prototype.hasOwnProperty.call(req.body.ebm, 'taxTyCd')
          || Object.prototype.hasOwnProperty.call(req.body.ebm, 'taxTypeCode')));

    // Merge the ebm payload so an edit never drops RRA registration state
    // (ebmItemCode, isRegisteredWithEBM, registration timestamps) that the form does not submit.
    if (req.body.ebm && typeof req.body.ebm === 'object' && !Array.isArray(req.body.ebm)) {
      const existingEbm = (product.ebm && typeof product.ebm === 'object') ? product.ebm : {};
      req.body.ebm = { ...existingEbm, ...req.body.ebm };
    }

    if (taxSettingsSubmitted) {
      await applySyncedEbmTaxRate(req.body, companyId, product);
    }

    // Update product
    Object.assign(product, req.body);

    // If averageCost is 0 but costPrice is set, use costPrice as averageCost
    if ((!product.averageCost || Number(product.averageCost) === 0) && product.costPrice && Number(product.costPrice) > 0) {
      product.averageCost = product.costPrice;
    }

    // Add history entry
    product.history.push({
      action: 'updated',
      changedBy: req.user.id,
      timestamp: new Date(),
      changes: buildProductHistoryChanges(oldValues, req.body),
    });

    await product.save();

    // Check for low stock / out of stock and send notifications
    if (product.currentStock !== undefined) {
      if (product.currentStock === 0) {
        try {
          await notifyOutOfStock(companyId, product);
        } catch (err) {
          console.error('Failed to send out of stock notification:', err);
        }
      } else if (product.lowStockThreshold && product.currentStock <= product.lowStockThreshold) {
        try {
          await notifyLowStock(companyId, product, product.currentStock);
        } catch (err) {
          console.error('Failed to send low stock notification:', err);
        }
      }
    }

    // Handle supplier linking
    // If supplier changed or newly assigned
    if (newSupplierId && newSupplierId !== oldSupplierId) {
      // Remove from old supplier's productsSupplied
      if (oldSupplierId) {
        try {
          const oldSupplier = await Supplier.findOne({ _id: oldSupplierId, company: companyId });
          if (oldSupplier) {
            oldSupplier.productsSupplied = oldSupplier.productsSupplied.filter(
              (p) => p.toString() !== product._id.toString()
            );
            await oldSupplier.save();
          }
        } catch (err) {
          console.error('Failed to remove product from old supplier:', err);
        }
      }
      // Add to new supplier
      const newSupplier = await Supplier.findOne({ _id: newSupplierId, company: companyId });
      if (newSupplier) {
        const isProductAlreadyLinked = newSupplier.productsSupplied.some(
          (p) => p.toString() === product._id.toString()
        );
        
        if (!isProductAlreadyLinked) {
          newSupplier.productsSupplied.push(product._id);
          await newSupplier.save();
        }
      }
    }

    // Invalidate cache - product changes affect stock reports
    try {
      await cacheService.invalidateByCompany(companyId, 'product');
      await cacheService.invalidateByCompany(companyId, 'stock');
    } catch (e) {
      console.error('Cache invalidation failed:', e);
    }

    res.json({
      success: true,
      data: product
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete product
// @route   DELETE /api/products/:id
// @access  Private (admin, stock_manager)
exports.deleteProduct = async (req, res, next) => {
  try {
    const company = req.user && req.user.company;
    const companyId = (company && company._id) ? company._id : company;
    
    const product = await Product.findOne({ _id: req.params.id, company: companyId });

    if (!product) {
      return res.status(404).json({ 
        success: false, 
        message: 'Product not found' 
      });
    }

    // Default to soft-delete: set isActive = false
    const hard = req.query.hard === 'true';

    if (hard) {
      // If there is any stock history, forbid hard delete
      const hasMovements = await StockMovement.exists({ product: product._id, company: companyId });
      if (hasMovements) {
        return res.status(409).json({ success: false, message: 'Cannot hard delete product with stock history' });
      }
      await Product.findByIdAndDelete(req.params.id);
    } else {
      product.isActive = false;
      product.history.push({
        action: 'archived',
        changedBy: req.user.id,
        timestamp: new Date(),
        notes: 'soft-deleted',
      });
      await product.save();
    }

    // Invalidate cache - product deletion affects stock reports
    try {
      await cacheService.invalidateByCompany(companyId, 'product');
      await cacheService.invalidateByCompany(companyId, 'stock');
    } catch (e) {
      console.error('Cache invalidation failed:', e);
    }

    res.json({ success: true, message: hard ? 'Product deleted' : 'Product archived (isActive=false)' });
  } catch (error) {
    next(error);
  }
};

// @desc    Archive product
// @route   PUT /api/products/:id/archive
// @access  Private (admin, stock_manager)
exports.archiveProduct = async (req, res, next) => {
  try {
    const company = req.user && req.user.company;
    const companyId = (company && company._id) ? company._id : company;
    
    const product = await Product.findOne({ _id: req.params.id, company: companyId });

    if (!product) {
      return res.status(404).json({ 
        success: false, 
        message: 'Product not found' 
      });
    }

    product.isArchived = true;
    product.history.push({
      action: 'archived',
      changedBy: req.user.id,
      timestamp: new Date(),
      notes: req.body.notes,
    });

    await product.save();

    // Invalidate cache - archiving affects stock reports
    try {
      await cacheService.invalidateByCompany(companyId, 'product');
      await cacheService.invalidateByCompany(companyId, 'stock');
    } catch (e) {
      console.error('Cache invalidation failed:', e);
    }

    res.json({
      success: true,
      message: 'Product archived successfully',
      data: product
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Restore archived product
// @route   PUT /api/products/:id/restore
// @access  Private (admin, stock_manager)
exports.restoreProduct = async (req, res, next) => {
  try {
    const company = req.user && req.user.company;
    const companyId = (company && company._id) ? company._id : company;
    
    const product = await Product.findOne({ _id: req.params.id, company: companyId });

    if (!product) {
      return res.status(404).json({ 
        success: false, 
        message: 'Product not found' 
      });
    }

    product.isArchived = false;
    product.history.push({
      action: 'restored',
      changedBy: req.user.id,
      timestamp: new Date(),
      notes: req.body.notes,
    });

    await product.save();

    // Invalidate cache - restoring affects stock reports
    try {
      await cacheService.invalidateByCompany(companyId, 'product');
      await cacheService.invalidateByCompany(companyId, 'stock');
    } catch (e) {
      console.error('Cache invalidation failed:', e);
    }

    res.json({
      success: true,
      message: 'Product restored successfully',
      data: product
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get product history
// @route   GET /api/products/:id/history
// @access  Private
exports.getProductHistory = async (req, res, next) => {
  try {
    const company = req.user && req.user.company;
    const companyId = (company && company._id) ? company._id : company;

    const product = await Product.findOne({ _id: req.params.id, company: companyId });

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found',
      });
    }

    const history = await enrichProductHistory(product.history || [], User);

    res.json({
      success: true,
      data: history,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get product lifecycle (complete traceability)
// @route   GET /api/products/:id/lifecycle
// @access  Private
exports.getProductLifecycle = async (req, res, next) => {
  try {
    const company = req.user && req.user.company;
    const companyId = (company && company._id) ? company._id : company;

    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
    const limit = Math.min(100, parseInt(String(req.query.limit || '50'), 10));
    const skip = (page - 1) * limit;

    const product = await Product.findOne({ _id: req.params.id, company: companyId })
      .select('-history -ebm -customFields')
      .populate('category', 'name')
      .populate('history.changedBy', 'name email');

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found',
      });
    }

    const [stockMovements, stockTotal, quotations, invoices] = await Promise.all([
      timedQuery('getProductLifecycle stockMovements', () =>
        StockMovement.find({ product: req.params.id, company: companyId })
          .select('-company')
          .populate('supplier', 'name code')
          .populate('performedBy', 'name email')
          .sort({ movementDate: -1 })
          .skip(skip)
          .limit(limit),
      ),
      StockMovement.countDocuments({ product: req.params.id, company: companyId }),
      Quotation.find({ 'items.product': req.params.id, company: companyId })
        .select('-company')
        .populate('client', 'name code')
        .populate('createdBy', 'name email')
        .sort({ createdAt: -1 })
        .limit(20),
      Invoice.find({ 'items.product': req.params.id, company: companyId })
        .select('-company')
        .populate('client', 'name code')
        .populate('createdBy', 'name email')
        .sort({ createdAt: -1 })
        .limit(20),
    ]);

    res.json({
      success: true,
      data: {
        product,
        stockMovements,
        stockTotal,
        quotations,
        invoices,
        timeline: buildTimeline(product, stockMovements, quotations, invoices),
      },
    });
  } catch (error) {
    next(error);
  }
};

// Helper function to build timeline
const buildTimeline = (product, stockMovements, quotations, invoices) => {
  const timeline = [];

  // Add product creation
  timeline.push({
    type: 'product_created',
    date: product.createdAt,
    description: 'Product created',
    details: product
  });

  // Add stock movements
  stockMovements.forEach(movement => {
    timeline.push({
      type: 'stock_movement',
      date: movement.movementDate,
      description: `Stock ${movement.type} - ${movement.reason}`,
      details: movement
    });
  });

  // Add quotations
  quotations.forEach(quotation => {
    timeline.push({
      type: 'quotation',
      date: quotation.createdAt,
      description: `Quotation ${quotation.quotationNumber} - ${quotation.status}`,
      details: quotation
    });
  });

  // Add invoices
  invoices.forEach(invoice => {
    timeline.push({
      type: 'invoice',
      date: invoice.invoiceDate,
      description: `Invoice ${invoice.invoiceNumber} - ${invoice.status}`,
      details: invoice
    });
  });

  // Sort by date descending
  return timeline.sort((a, b) => new Date(b.date) - new Date(a.date));
};

// @desc    Get low stock products
// @route   GET /api/products/low-stock
// @access  Private
exports.getLowStockProducts = async (req, res, next) => {
  try {
    const company = req.user && req.user.company;
    const companyId = (company && company._id) ? company._id : company;

    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
    const limit = Math.min(100, parseInt(String(req.query.limit || '50'), 10));
    const skip = (page - 1) * limit;

    const products = await Product.find({
      company: companyId,
      isArchived: false,
      $expr: { $lte: ['$currentStock', '$lowStockThreshold'] }
    })
      .select('-history -ebm -customFields')
      .populate('category', 'name')
      .sort({ currentStock: 1 })
      .skip(skip)
      .limit(limit);

    const total = await Product.countDocuments({
      company: companyId,
      isArchived: false,
      $expr: { $lte: ['$currentStock', '$lowStockThreshold'] },
    });

    res.json({
      success: true,
      count: products.length,
      total,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit) || 0,
      },
      data: products,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Check low stock and send notifications for all products
// @route   POST /api/products/check-low-stock
// @access  Private (admin)
exports.checkLowStockAndNotify = async (req, res, next) => {
  try {
    const company = req.user && req.user.company;
    const companyId = (company && company._id) ? company._id : company;
    
    // Find all products that are low stock or out of stock
    const products = await Product.find({
      company: companyId,
      isArchived: false
    });

    let outOfStockCount = 0;
    let lowStockCount = 0;
    let alreadyNotified = [];

    // Check each product
    for (const product of products) {
      if (product.currentStock === 0) {
        outOfStockCount++;
        try {
          await notifyOutOfStock(companyId, product);
        } catch (err) {
          console.error('Failed to send out of stock notification:', err);
        }
      } else if (product.lowStockThreshold && product.currentStock <= product.lowStockThreshold) {
        lowStockCount++;
        try {
          await notifyLowStock(companyId, product, product.currentStock);
        } catch (err) {
          console.error('Failed to send low stock notification:', err);
        }
      }
    }

    res.json({
      success: true,
      message: `Notifications sent: ${outOfStockCount} out of stock, ${lowStockCount} low stock`,
      data: {
        outOfStockCount,
        lowStockCount
      }
    });
  } catch (error) {
    next(error);
  }
};

exports.analyzeReorder = async (req, res, next) => {
  try {
    const company = req.user && req.user.company;
    const companyId = (company && company._id) ? company._id : company;
    const AutoPurchaseOrderService = require('../services/autoPurchaseOrderService');
    const result = await AutoPurchaseOrderService.analyzeItem({
      companyId,
      productId: req.params.id
    });

    if (!result) {
      return res.status(404).json({ success: false, message: 'Product not found or not reorderable' });
    }

    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

exports.triggerAutoReorder = async (req, res, next) => {
  try {
    const company = req.user && req.user.company;
    const companyId = (company && company._id) ? company._id : company;
    const AutoPurchaseOrderService = require('../services/autoPurchaseOrderService');
    const result = await AutoPurchaseOrderService.checkAndCreateForItem({
      companyId,
      productId: req.params.id,
      performedBy: req.user.id || req.user._id,
      force: req.body?.force === true
    });

    if (!result) {
      return res.status(404).json({ success: false, message: 'Product not found or not reorderable' });
    }

    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

// @desc    Get product barcode image (PNG)
// @route   GET /api/products/:id/barcode
// @access  Private
exports.getProductBarcode = async (req, res, next) => {
  try {
    const company = req.user && req.user.company;
    const companyId = (company && company._id) ? company._id : company;
    const product = await Product.findOne({ _id: req.params.id, company: companyId });

    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    const requestedType = (req.query.type || product.barcodeType || 'CODE128').toString().toUpperCase();
    let bcid = 'code128';
    if (requestedType === 'EAN13' || requestedType === 'EAN-13') {
      bcid = 'ean13';
    } else if (requestedType === 'EAN8' || requestedType === 'EAN-8') {
      bcid = 'ean8';
    } else if (requestedType === 'UPC') {
      bcid = 'upca';
    } else if (requestedType === 'CODE39') {
      bcid = 'code39';
    } else if (requestedType === 'ITF14') {
      bcid = 'itf14';
    }

    // Build a scan-friendly payload URL for QR use and for context
    const frontendBase = process.env.FRONTEND_BASE_URL || req.get('origin') || '';
    const code = product.barcode || product.sku || String(product._id);
    const query = new URLSearchParams({
      code,
      sku: product.sku || '',
      barcode: product.barcode || ''
    });
    const payloadUrl = frontendBase ? `${frontendBase.replace(/\/$/, '')}/products/${product._id}?${query.toString()}` : `product:${product._id}`;

    // Fallback text/value
    const text = product.barcode || product.sku || String(product._id);

    // Validate and normalize numeric barcode types
    let codeText = String(text);
    if (['ean13', 'ean8', 'upca'].includes(bcid)) {
      codeText = codeText.replace(/[^0-9]/g, '');
      if (bcid === 'ean13' || bcid === 'upca') {
        if (codeText.length < 12) codeText = codeText.padStart(12, '0');
        if (codeText.length > 12) codeText = codeText.slice(0, 12);
      } else if (bcid === 'ean8') {
        if (codeText.length < 7) codeText = codeText.padStart(7, '0');
        if (codeText.length > 7) codeText = codeText.slice(0, 7);
      }
    }

    // Strict length/character validations per barcode type
    if (bcid === 'ean13' && codeText.length !== 13) {
      return res.status(400).json({ success: false, message: 'EAN-13 barcode must be exactly 13 digits' });
    }
    if (bcid === 'upca' && codeText.length !== 12) {
      return res.status(400).json({ success: false, message: 'UPC-A barcode must be exactly 12 digits' });
    }
    if (bcid === 'ean8' && codeText.length !== 8) {
      return res.status(400).json({ success: false, message: 'EAN-8 barcode must be exactly 8 digits' });
    }
    if (bcid === 'itf14' && !/^\d{14}$/.test(codeText)) {
      return res.status(400).json({ success: false, message: 'ITF-14 barcode must be exactly 14 digits' });
    }
    if (bcid === 'code39') {
      codeText = codeText.toUpperCase();
      if (!/^[0-9A-Z .$/+%-]+$/.test(codeText)) {
        return res.status(400).json({ success: false, message: 'CODE39 barcode contains unsupported characters' });
      }
    }

    // If requested type is NONE, indicate there's nothing printable
    if (requestedType === 'NONE') {
      return res.status(400).json({ success: false, message: 'This product has no printable barcode type configured' });
    }

    const png = await bwipjs.toBuffer({
      bcid,
      text: ['ean13', 'ean8', 'upca', 'itf14', 'code39'].includes(bcid) ? codeText : String(text),
      scale: parseInt(req.query.scale || '3', 10),
      height: parseInt(req.query.height || '10', 10),
      includetext: true,
      textxalign: 'center'
    });

    res.set('Content-Type', 'image/png');
    return res.send(png);
  } catch (error) {
    next(error);
  }
};

// @desc    Get product QR code image (PNG)
// @route   GET /api/products/:id/qrcode
// @access  Private
exports.getProductQRCode = async (req, res, next) => {
  try {
    const company = req.user && req.user.company;
    const companyId = (company && company._id) ? company._id : company;
    const product = await Product.findOne({ _id: req.params.id, company: companyId });

    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    // Build a default URL for product lookup. Prefer FRONTEND_BASE_URL env, else origin.
    const frontendBase = process.env.FRONTEND_BASE_URL || req.get('origin') || '';
    const code = product.barcode || product.sku || String(product._id);
    const query = new URLSearchParams({
      code,
      sku: product.sku || '',
      barcode: product.barcode || ''
    });
    const payloadUrl = frontendBase ? `${frontendBase.replace(/\/$/, '')}/products/${product._id}?${query.toString()}` : `product:${product._id}`;

    const pngBuffer = await QRCode.toBuffer(payloadUrl, {
      type: 'png',
      width: parseInt(req.query.width || '300', 10),
      margin: 1
    });

    res.set('Content-Type', 'image/png');
    res.send(pngBuffer);
  } catch (error) {
    next(error);
  }
};

// @desc    Register product with RRA EBM
// @route   POST /api/products/:id/ebm/register
// @access  Private (admin)
exports.registerProductWithEBM = async (req, res, next) => {
  try {
    const company = req.user && req.user.company;
    const companyId = (company && company._id) ? company._id : company;
    const productId = req.params.id;

    const EBMProductService = require('../services/ebmProductService');

    // Allow optional tin override or other options via body
    const options = {};
    if (req.body && req.body.tin) options.tin = req.body.tin;

    const product = await EBMProductService.registerProduct(companyId, productId, options);

    res.json({ success: true, data: product, message: 'Product registered with RRA EBM' });
  } catch (error) {
    // Let upstream error handler format the response
    next(error);
  }
};

// @desc    Register all active products with RRA EBM
// @route   POST /api/products/ebm/register-all
// @access  Private (admin)
exports.registerAllProductsWithEBM = async (req, res, next) => {
  try {
    const company = req.user && req.user.company;
    const companyId = (company && company._id) ? company._id : company;
    const EBMProductService = require('../services/ebmProductService');
    const options = {};
    if (req.body && req.body.tin) options.tin = req.body.tin;
    const result = await EBMProductService.registerAllProducts(companyId, options);
      return res.json({
      success: true,
      data: result,
      message: `${result.registered} newly registered; ${result.alreadyRegistered} already registered; ${result.reconciliationRequired || 0} need RRA branch reconciliation; ${result.failed} failed.`,
    });
  } catch (error) {
    next(error);
  }
};

exports.backfillProductWarehouses = async (req, res, next) => {
  try {
    const company = req.user && req.user.company;
    const companyId = (company && company._id) ? company._id : company;
    const EBMProductService = require('../services/ebmProductService');
    const result = await EBMProductService.backfillDefaultWarehouses(companyId);
    res.json({ success: true, data: result, message: `${result.updated} product default warehouse(s) updated.` });
  } catch (error) {
    next(error);
  }
};
