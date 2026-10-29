const SalesOrder = require('../models/SalesOrder');
const PickPack = require('../models/PickPack');
const DeliveryNote = require('../models/DeliveryNote');
const Client = require('../models/Client');
const Product = require('../models/Product');
const { loadLineProducts, getLineProduct } = require('../utils/lineProducts');
const Warehouse = require('../models/Warehouse');
const Company = require('../models/Company');
const emailService = require('../services/emailService');
const EBMProductService = require('../services/ebmProductService');
const { syncSalesOrderLifecycle } = require('../services/salesOrderLifecycleService');
const notificationDeliveryService = require('../services/notificationDeliveryService');

const normalizeId = (value) => {
  if (!value) return null;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return String(value._id || value.id || value);
};

async function hydrateSalesOrderRelations(docOrDocs) {
  const docs = Array.isArray(docOrDocs) ? docOrDocs : [docOrDocs];
  const valid = docs.filter(Boolean);
  if (!valid.length) return docOrDocs;

  const clientIds = [...new Set(valid.map((doc) => normalizeId(doc.client)).filter(Boolean))];
  const userIds = [...new Set(valid.map((doc) => normalizeId(doc.createdBy)).filter(Boolean))];
  const quotationIds = [...new Set(valid.map((doc) => normalizeId(doc.quotation)).filter(Boolean))];
  const productIds = [...new Set(valid.flatMap((doc) => (doc.lines || []).map((line) => normalizeId(line.product)).filter(Boolean)))];
  const warehouseIds = [...new Set(valid.flatMap((doc) => (doc.lines || []).map((line) => normalizeId(line.warehouse)).filter(Boolean)))];

  const [clients, users, quotations, products, warehouses] = await Promise.all([
    clientIds.length ? Client.find({ _id: { $in: clientIds } }, 'name code tin address phone email').lean() : [],
    userIds.length ? require('../models/User').find({ _id: { $in: userIds } }, 'name email').lean() : [],
    quotationIds.length ? require('../models/Quotation').find({ _id: { $in: quotationIds } }, 'referenceNo').lean() : [],
    productIds.length ? Product.find({ _id: { $in: productIds } }, 'name sku unit taxRate taxCode trackingType isStockable').lean() : [],
    warehouseIds.length ? Warehouse.find({ _id: { $in: warehouseIds } }, 'name code').lean() : [],
  ]);

  const clientMap = new Map(clients.map((client) => [normalizeId(client._id), client]));
  const userMap = new Map(users.map((user) => [normalizeId(user._id), user]));
  const quotationMap = new Map(quotations.map((quotation) => [normalizeId(quotation._id), quotation]));
  const productMap = new Map(products.map((product) => [normalizeId(product._id), product]));
  const warehouseMap = new Map(warehouses.map((warehouse) => [normalizeId(warehouse._id), warehouse]));

  for (const doc of valid) {
    const clientId = normalizeId(doc.client);
    if (clientId && clientMap.has(clientId)) doc.client = clientMap.get(clientId);
    const createdById = normalizeId(doc.createdBy);
    if (createdById && userMap.has(createdById)) doc.createdBy = userMap.get(createdById);
    const quotationId = normalizeId(doc.quotation);
    if (quotationId && quotationMap.has(quotationId)) doc.quotation = quotationMap.get(quotationId);
    for (const line of doc.lines || []) {
      const productId = normalizeId(line.product);
      if (productId && productMap.has(productId)) line.product = productMap.get(productId);
      const warehouseId = normalizeId(line.warehouse);
      if (warehouseId && warehouseMap.has(warehouseId)) line.warehouse = warehouseMap.get(warehouseId);
    }
  }

  return Array.isArray(docOrDocs) ? valid : valid[0];
}

const sendSOEmail = async (so, action, companyId) => {
  try {
    const config = require('../src/config/environment').getConfig();
    if (!config.features?.emailNotifications) {
      console.log('[SO Email] Email notifications disabled');
      return;
    }

    const company = await Company.findById(companyId);
    const client = await Client.findById(so.client);
    
    const soWithProducts = await SalesOrder.findById(so._id)
      .select({ client: 1, lines: 1, referenceNo: 1, status: 1 })
      .lean();
    await hydrateSalesOrderRelations(soWithProducts);
    
    if (client?.contact?.email || client?.email) {
      await emailService.sendSalesOrderEmail(soWithProducts, company, client, action);
    }
  } catch (err) {
    console.error('[SO Email] Failed to send email:', err.message);
  }
};

// Error codes
const ERR_SALES_ORDER_NOT_FOUND = 'ERR_SALES_ORDER_NOT_FOUND';
const ERR_INVALID_STATUS_TRANSITION = 'ERR_INVALID_STATUS_TRANSITION';

const toNumber = (value) => {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
};

const roundMoney = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const validateOrderLines = (lines, { allowEmpty = false } = {}) => {
  if (!Array.isArray(lines) || (!allowEmpty && lines.length === 0)) return 'Add at least one order line.';
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] || {};
    const qty = Number(line.qty);
    const unitPrice = line.unitPrice === undefined || line.unitPrice === null || line.unitPrice === ''
      ? null : Number(line.unitPrice);
    const discountPct = line.discountPct === undefined || line.discountPct === null || line.discountPct === ''
      ? 0 : Number(line.discountPct);
    const taxRate = line.taxRate === undefined || line.taxRate === null || line.taxRate === ''
      ? null : Number(line.taxRate);
    if (!line.product) return `Select a product for line ${index + 1}.`;
    if (!Number.isFinite(qty) || qty <= 0) return `Quantity on line ${index + 1} must be greater than zero.`;
    if (unitPrice !== null && (!Number.isFinite(unitPrice) || unitPrice < 0)) return `Unit price on line ${index + 1} must be zero or greater.`;
    if (!Number.isFinite(discountPct) || discountPct < 0 || discountPct > 100) return `Discount on line ${index + 1} must be between 0 and 100%.`;
    if (taxRate !== null && (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100)) return `Tax rate on line ${index + 1} must be between 0 and 100%.`;
  }
  return null;
};

/**
 * Price the lines and roll them up into the header totals. Quantities, prices,
 * discounts and tax rates come from the request; everything else is derived, so
 * a client that posts no totals still gets a correctly valued order.
 */
const priceLines = (lines = []) => {
  let subtotal = 0;
  let taxAmount = 0;

  const priced = lines.map((line) => {
    const qty = toNumber(line.qty);
    const unitPrice = toNumber(line.unitPrice);
    const gross = roundMoney(qty * unitPrice);
    const net = roundMoney(gross - gross * (toNumber(line.discountPct) / 100));
    const lineTax = roundMoney(net * (toNumber(line.taxRate) / 100));

    subtotal += net;
    taxAmount += lineTax;

    return { ...line, qty, unitPrice, lineTax, lineTotal: roundMoney(net + lineTax) };
  });

  subtotal = roundMoney(subtotal);
  taxAmount = roundMoney(taxAmount);
  return { lines: priced, totals: { subtotal, taxAmount, totalAmount: roundMoney(subtotal + taxAmount) } };
};

// @desc    Get all sales orders
// @route   GET /api/sales-orders
// @access  Private
exports.getSalesOrders = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const {
      status,
      client,
      clientId,
      startDate,
      endDate,
      fulfillmentStatus,
      search,
      page = 1,
      limit = 25,
    } = req.query;
    
    const filter = { company: companyId };
    
    if (status) filter.status = status;
    const clientFilter = client || clientId;
    if (clientFilter) filter.client = clientFilter;
    if (fulfillmentStatus) filter.fulfillmentStatus = fulfillmentStatus;
    
    if (startDate || endDate) {
      filter.orderDate = {};
      if (startDate) filter.orderDate.$gte = new Date(startDate);
      if (endDate) filter.orderDate.$lte = new Date(endDate);
    }
    
    if (search) {
      filter.$or = [
        { referenceNo: { $regex: search, $options: 'i' } },
        { notes: { $regex: search, $options: 'i' } }
      ];
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
    const skip = (pageNum - 1) * limitNum;
    
    // List path: headers, totals, currency, and line count. Product rows remain
    // omitted to keep the list response lightweight.
    const [salesOrders, totalCount] = await Promise.all([
      SalesOrder.find(filter)
        .select({ client: 1, createdBy: 1, referenceNo: 1, status: 1, orderDate: 1, expectedDate: 1, fulfillmentStatus: 1, subtotal: 1, taxAmount: 1, totalAmount: 1, currencyCode: 1, exchangeRate: 1, createdAt: 1, lineCount: 1 })
        .populate('-lines')
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      SalesOrder.countDocuments(filter)
    ]);
    if (!status) {
      await Promise.all(salesOrders
        .filter((salesOrder) => salesOrder.status === 'packed')
        .map(async (salesOrder) => {
          const reconciled = await syncSalesOrderLifecycle(salesOrder._id, companyId);
          if (reconciled) {
            salesOrder.status = reconciled.status;
            salesOrder.fulfillmentStatus = reconciled.fulfillmentStatus;
            salesOrder.fulfillmentPercent = reconciled.fulfillmentPercent;
            salesOrder.isBackorder = reconciled.isBackorder;
          }
        }));
    }
    const hydratedSalesOrders = await hydrateSalesOrderRelations(salesOrders);
    
    res.status(200).json({
      success: true,
      count: hydratedSalesOrders.length,
      total: totalCount,
      page: pageNum,
      pages: Math.ceil(totalCount / limitNum),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalCount,
        pages: Math.ceil(totalCount / limitNum),
      },
      data: hydratedSalesOrders
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single sales order
// @route   GET /api/sales-orders/:id
// @access  Private
exports.getSalesOrder = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const salesOrder = await SalesOrder.findOne({ _id: req.params.id, company: companyId })
      .select({ client: 1, lines: 1, createdBy: 1, quotation: 1, referenceNo: 1, status: 1, orderDate: 1, expectedDate: 1, fulfillmentStatus: 1, subtotal: 1, taxAmount: 1, totalAmount: 1, currencyCode: 1, exchangeRate: 1 })
      .lean();
    const hydratedSalesOrder = await hydrateSalesOrderRelations(salesOrder);
    
    if (!hydratedSalesOrder) {
      return res.status(404).json({
        success: false,
        error: ERR_SALES_ORDER_NOT_FOUND,
        message: 'Sales order not found'
      });
    }
    
    res.status(200).json({
      success: true,
      data: hydratedSalesOrder
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create new sales order
// @route   POST /api/sales-orders
// @access  Private (admin, sales, stock_manager)
exports.createSalesOrder = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { client, lines, orderDate, expectedDate, deliveryAddress, shippingMethod, terms, notes, quotation, currencyCode, exchangeRate } = req.body;

    const lineValidationError = validateOrderLines(lines);
    if (lineValidationError) return res.status(422).json({ success: false, code: 'ERR_INVALID_SALES_ORDER_LINES', message: lineValidationError });
    
    // Validate client exists
    const clientDoc = await Client.findOne({ _id: client, company: companyId });
    if (!clientDoc) {
      return res.status(404).json({
        success: false,
        message: 'Client not found'
      });
    }
    
    // Validate and process lines
    await EBMProductService.assertProductsRegistered(companyId, (lines || []).map((line) => line.product));
    const processedLines = [];
    // Products for every line in one query instead of one per line.
    const lineProducts0 = await loadLineProducts(Product, lines || [], companyId);
    // Warehouses referenced by the lines, in one query. Pure reference read:
    // nothing in this loop writes a warehouse, so a single up-front fetch is
    // equivalent to fetching per line.
    const lineWarehouseIds = [...new Set((lines || []).map((l) => l.warehouse).filter(Boolean).map(String))];
    const lineWarehouseRows = lineWarehouseIds.length
      ? await Warehouse.find({ _id: { $in: lineWarehouseIds }, company: companyId })
      : [];
    const lineWarehouses = new Map((lineWarehouseRows || []).map((w) => [String(w._id), w]));
    for (const line of lines || []) {
      const product = getLineProduct(lineProducts0, line);
      if (!product) {
        return res.status(404).json({
          success: false,
          message: `Product not found: ${line.product}`
        });
      }
      
      // Validate warehouse if provided
      if (line.warehouse) {
        const warehouse = lineWarehouses.get(String(line.warehouse)) || null;
        if (!warehouse) {
          return res.status(404).json({
            success: false,
            message: `Warehouse not found: ${line.warehouse}`
          });
        }
      }
      
      processedLines.push({
        product: line.product,
        description: line.description || product.name,
        qty: line.qty,
        unit: line.unit || product.unit,
        unitPrice: line.unitPrice === undefined || line.unitPrice === null || line.unitPrice === '' ? product.sellingPrice : line.unitPrice,
        discountPct: line.discountPct || 0,
        taxRate: line.taxRate === undefined || line.taxRate === null || line.taxRate === '' ? (product.taxRate ?? 0) : line.taxRate,
        warehouse: line.warehouse || null,
        status: 'pending'
      });
    }

    const invalidDerivedRate = processedLines.find((line) => !Number.isFinite(Number(line.taxRate)) || Number(line.taxRate) < 0 || Number(line.taxRate) > 100);
    if (invalidDerivedRate) return res.status(422).json({ success: false, code: 'ERR_INVALID_TAX_RATE', message: `Tax rate for ${invalidDerivedRate.description} must be between 0 and 100%.` });
    
    const priced = priceLines(processedLines);

    const salesOrder = await SalesOrder.create({
      company: companyId,
      client,
      quotation: quotation || null,
      orderDate: orderDate || new Date(),
      expectedDate: expectedDate || null,
      lines: priced.lines,
      ...priced.totals,
      deliveryAddress: deliveryAddress || clientDoc.address,
      shippingMethod: shippingMethod || null,
      terms: terms || null,
      notes: notes || null,
      currencyCode: currencyCode || 'RWF',
      exchangeRate: exchangeRate || 1,
      createdBy: req.user.id,
      clientTin: clientDoc.tin
    });

    try {
      await notificationDeliveryService.sendLargeOrderAlert(salesOrder, companyId);
    } catch (alertError) {
      console.error('[Sales Order Large Order Alert] Failed:', alertError.message || alertError);
    }
    
    await hydrateSalesOrderRelations(salesOrder);
    
    // Send email notification if requested (creates as confirmed)
    const sendEmailOnCreate = req.body.sendEmail || false;
    if (sendEmailOnCreate) {
      await sendSOEmail(salesOrder, 'created', companyId);
    }
    
    res.status(201).json({
      success: true,
      message: 'Sales order created successfully',
      data: salesOrder
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update sales order (draft only)
// @route   PUT /api/sales-orders/:id
// @access  Private (admin, sales, stock_manager)
exports.updateSalesOrder = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { lines, orderDate, expectedDate, deliveryAddress, shippingMethod, terms, notes, currencyCode, exchangeRate } = req.body;
    
    let salesOrder = await SalesOrder.findOne({ _id: req.params.id, company: companyId });
    
    if (!salesOrder) {
      return res.status(404).json({
        success: false,
        error: ERR_SALES_ORDER_NOT_FOUND,
        message: 'Sales order not found'
      });
    }
    
    // Only draft sales orders can be updated
    if (salesOrder.status !== 'draft') {
      return res.status(400).json({
        success: false,
        error: ERR_INVALID_STATUS_TRANSITION,
        message: `Cannot update sales order with status: ${salesOrder.status}. Only draft orders can be edited.`
      });
    }

    if (lines !== undefined) {
      const lineValidationError = validateOrderLines(lines);
      if (lineValidationError) return res.status(422).json({ success: false, code: 'ERR_INVALID_SALES_ORDER_LINES', message: lineValidationError });
    }
    
    // Process lines if provided
    if (lines) {
      const processedLines = [];
      // Products for every line in one query instead of one per line.
      const lineProducts1 = await loadLineProducts(Product, lines, companyId);
      for (const line of lines) {
        const product = getLineProduct(lineProducts1, line);
        if (!product) {
          return res.status(404).json({
            success: false,
            message: `Product not found: ${line.product}`
          });
        }

        if (line.warehouse) {
          const warehouse = await Warehouse.findOne({ _id: line.warehouse, company: companyId }).select({ _id: 1 }).lean();
          if (!warehouse) return res.status(404).json({ success: false, code: 'ERR_SALES_ORDER_WAREHOUSE_NOT_FOUND', message: `Warehouse not found: ${line.warehouse}` });
        }
        
        processedLines.push({
          product: line.product,
          description: line.description || product.name,
          qty: line.qty,
          unit: line.unit || product.unit,
          unitPrice: line.unitPrice === undefined || line.unitPrice === null || line.unitPrice === '' ? product.sellingPrice : line.unitPrice,
          discountPct: line.discountPct || 0,
          taxRate: line.taxRate === undefined || line.taxRate === null || line.taxRate === '' ? (product.taxRate ?? 0) : line.taxRate,
          warehouse: line.warehouse || null,
          status: 'pending'
        });
      }
      const invalidDerivedRate = processedLines.find((line) => !Number.isFinite(Number(line.taxRate)) || Number(line.taxRate) < 0 || Number(line.taxRate) > 100);
      if (invalidDerivedRate) return res.status(422).json({ success: false, code: 'ERR_INVALID_TAX_RATE', message: `Tax rate for ${invalidDerivedRate.description} must be between 0 and 100%.` });
      const priced = priceLines(processedLines);
      salesOrder.lines = priced.lines;
      salesOrder.subtotal = priced.totals.subtotal;
      salesOrder.taxAmount = priced.totals.taxAmount;
      salesOrder.totalAmount = priced.totals.totalAmount;
    }
    
    // Update other fields
    if (orderDate) salesOrder.orderDate = orderDate;
    if (expectedDate !== undefined) salesOrder.expectedDate = expectedDate;
    if (deliveryAddress !== undefined) salesOrder.deliveryAddress = deliveryAddress;
    if (shippingMethod !== undefined) salesOrder.shippingMethod = shippingMethod;
    if (terms !== undefined) salesOrder.terms = terms;
    if (notes !== undefined) salesOrder.notes = notes;
    if (currencyCode) salesOrder.currencyCode = currencyCode;
    if (exchangeRate) salesOrder.exchangeRate = exchangeRate;
    
    await salesOrder.save();
    await hydrateSalesOrderRelations(salesOrder);
    
    res.status(200).json({
      success: true,
      message: 'Sales order updated successfully',
      data: salesOrder
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete sales order (draft only)
// @route   DELETE /api/sales-orders/:id
// @access  Private (admin, sales)
exports.deleteSalesOrder = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const salesOrder = await SalesOrder.findOne({ _id: req.params.id, company: companyId });
    
    if (!salesOrder) {
      return res.status(404).json({
        success: false,
        error: ERR_SALES_ORDER_NOT_FOUND,
        message: 'Sales order not found'
      });
    }
    
    // Only draft sales orders can be deleted
    if (salesOrder.status !== 'draft') {
      return res.status(400).json({
        success: false,
        error: ERR_INVALID_STATUS_TRANSITION,
        message: `Cannot delete sales order with status: ${salesOrder.status}. Only draft orders can be deleted.`
      });
    }
    
    await salesOrder.deleteOne();
    
    res.status(200).json({
      success: true,
      message: 'Sales order deleted successfully',
      data: {}
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Confirm sales order (reserve stock)
// @route   POST /api/sales-orders/:id/confirm
// @access  Private (admin, sales, stock_manager)
exports.confirmSalesOrder = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    const salesOrder = await SalesOrder.findOne({ _id: req.params.id, company: companyId });
    await hydrateSalesOrderRelations(salesOrder);

    if (!salesOrder) {
      return res.status(404).json({
        success: false,
        error: ERR_SALES_ORDER_NOT_FOUND,
        message: 'Sales order not found'
      });
    }

    const resumingBackorder = salesOrder.status === 'confirmed' && salesOrder.isBackorder === true;
    if (!salesOrder.canTransitionTo('confirmed') && !resumingBackorder) {
      return res.status(400).json({
        success: false,
        error: ERR_INVALID_STATUS_TRANSITION,
        message: `Cannot confirm sales order with status: ${salesOrder.status}`
      });
    }

    if (resumingBackorder) {
      const openTask = await PickPack.findOne({ salesOrder: salesOrder._id, company: companyId, status: { $nin: ['cancelled', 'ready_for_delivery'] } }).select({ referenceNo: 1 }).lean();
      if (openTask) return res.status(409).json({ success: false, error: ERR_INVALID_STATUS_TRANSITION, message: `Complete or cancel Pick & Pack ${openTask.referenceNo} before reserving the backorder.` });
      const unresolvedNote = await DeliveryNote.findOne({ salesOrder: salesOrder._id, company: companyId, status: { $nin: ['delivered', 'cancelled'] } }).select({ referenceNo: 1, status: 1 }).lean();
      if (unresolvedNote) return res.status(409).json({ success: false, error: ERR_INVALID_STATUS_TRANSITION, message: `Resolve delivery note ${unresolvedNote.referenceNo} (${unresolvedNote.status}) before reserving the backorder.` });
    }

    const backorderItems = [];
    const updatedLines = [];

    for (const line of salesOrder.lines || []) {
      const product = line.product;
      const nextLine = { ...line };

      if (nextLine.product && typeof nextLine.product === 'object') {
        nextLine.product = nextLine.product._id || nextLine.product.id;
      }

      if (!product || !product.isStockable) {
        updatedLines.push(nextLine);
        continue;
      }

      const qtyNeeded = Math.max(0, toNumber(line.qty) - toNumber(line.qtyShipped) - toNumber(line.qtyReserved));
      if (qtyNeeded <= 0) {
        updatedLines.push(nextLine);
        continue;
      }
      const currentStock = toNumber(product.currentStock);
      const reservedQty = toNumber(product.reservedQuantity);
      const availableStock = currentStock - reservedQty;

      let qtyToReserve = 0;
      let lineStatus = 'pending';

      if (availableStock < qtyNeeded) {
        if (availableStock > 0) {
          qtyToReserve = availableStock;
          lineStatus = 'reserved';
          backorderItems.push({
            lineId: line.lineId,
            remainingQty: qtyNeeded - availableStock,
            reason: 'Insufficient stock'
          });
        } else {
          backorderItems.push({
            lineId: line.lineId,
            remainingQty: qtyNeeded,
            reason: 'Out of stock'
          });
        }
      } else {
        qtyToReserve = qtyNeeded;
        lineStatus = 'reserved';
      }

      if (qtyToReserve > 0) {
        await Product.findByIdAndUpdate(product._id || product.id, {
          $inc: { reservedQuantity: qtyToReserve }
        });
      }

      nextLine.qtyReserved = toNumber(line.qtyReserved) + qtyToReserve;
      nextLine.status = lineStatus;
      updatedLines.push(nextLine);
    }

    // New array reference so Prisma shim rewrites line rows on save()
    salesOrder.lines = updatedLines;
    salesOrder.status = 'confirmed';
    salesOrder.stockReserved = true;
    salesOrder.isBackorder = backorderItems.length > 0;

    await salesOrder.save();

    const finalSO = await SalesOrder.findById(salesOrder._id);
    await hydrateSalesOrderRelations(finalSO);

    const sendEmailOnConfirm = req.body.sendEmail || false;
    if (sendEmailOnConfirm) {
      await sendSOEmail(finalSO, 'confirmed', companyId);
    }

    res.status(200).json({
      success: true,
      message: 'Sales order confirmed successfully',
      data: finalSO,
      backorderItems: backorderItems.length > 0 ? backorderItems : undefined
    });
  } catch (error) {
    console.error('Confirm Sales Order Error:', error);
    next(error);
  }
};

// @desc    Cancel sales order
// @route   POST /api/sales-orders/:id/cancel
// @access  Private (admin, sales)
exports.cancelSalesOrder = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { reason } = req.body;
    
    const salesOrder = await SalesOrder.findOne({ _id: req.params.id, company: companyId });
    await hydrateSalesOrderRelations(salesOrder);
    
    if (!salesOrder) {
      return res.status(404).json({
        success: false,
        error: ERR_SALES_ORDER_NOT_FOUND,
        message: 'Sales order not found'
      });
    }
    
    // Cannot cancel already closed or cancelled orders
    if (['closed', 'cancelled'].includes(salesOrder.status)) {
      return res.status(400).json({
        success: false,
        error: ERR_INVALID_STATUS_TRANSITION,
        message: `Cannot cancel sales order with status: ${salesOrder.status}`
      });
    }

    if (['delivered', 'invoiced'].includes(salesOrder.status)) {
      return res.status(409).json({ success: false, error: ERR_INVALID_STATUS_TRANSITION, message: 'This order has already been delivered or invoiced. Use the delivery return or credit-note workflow to reverse completed activity.' });
    }

    const activePickPack = await PickPack.findOne({ salesOrder: salesOrder._id, company: companyId, status: { $ne: 'cancelled' } }).select({ referenceNo: 1 }).lean();
    if (activePickPack) {
      return res.status(409).json({ success: false, error: ERR_INVALID_STATUS_TRANSITION, message: `Cancel Pick & Pack ${activePickPack.referenceNo} first so its warehouse reservation can be released.` });
    }
    const activeDeliveryNote = await DeliveryNote.findOne({ salesOrder: salesOrder._id, company: companyId, status: { $ne: 'cancelled' } }).select({ referenceNo: 1, status: 1 }).lean();
    if (activeDeliveryNote) {
      return res.status(409).json({ success: false, error: ERR_INVALID_STATUS_TRANSITION, message: `Resolve delivery note ${activeDeliveryNote.referenceNo} (${activeDeliveryNote.status}) before cancelling this order.` });
    }
    
    // Release reserved stock
    if (salesOrder.stockReserved) {
      for (const line of salesOrder.lines) {
        const product = line.product;
        if (!product || !product.isStockable) continue;
        
        const reservedQty = line.qtyReserved || 0;
        if (reservedQty > 0) {
          await Product.findByIdAndUpdate(product._id, {
            $inc: { reservedQuantity: -reservedQty }
          });
        }
      }
    }
    
    // Update sales order
    salesOrder.status = 'cancelled';
    salesOrder.cancelledBy = req.user.id;
    salesOrder.cancelledDate = new Date();
    salesOrder.cancellationReason = reason || 'Cancelled by user';
    
    await salesOrder.save();
    
    // Send email notification
    const sendEmailOnCancel = req.body.sendEmail || false;
    if (sendEmailOnCancel) {
      await sendSOEmail(salesOrder, 'cancelled', companyId);
    }
    
    res.status(200).json({
      success: true,
      message: 'Sales order cancelled successfully',
      data: salesOrder
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get sales orders for a specific client
// @route   GET /api/sales-orders/client/:clientId
// @access  Private
exports.getClientSalesOrders = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const salesOrders = await SalesOrder.find({ 
      client: req.params.clientId, 
      company: companyId 
    })
      .select({ client: 1, lines: 1, createdBy: 1, referenceNo: 1, status: 1, orderDate: 1, createdAt: 1 })
      .sort({ createdAt: -1 })
      .lean();
    await hydrateSalesOrderRelations(salesOrders);
    
    res.status(200).json({
      success: true,
      count: salesOrders.length,
      data: salesOrders
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get sales orders ready for picking
// @route   GET /api/sales-orders/ready-for-picking
// @access  Private (admin, stock_manager, warehouse)
exports.getReadyForPicking = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const salesOrders = await SalesOrder.find({ 
      company: companyId,
      status: 'confirmed'
    })
      .select({ client: 1, lines: 1, referenceNo: 1, status: 1, expectedDate: 1, createdAt: 1 })
      .sort({ expectedDate: 1, createdAt: -1 })
      .lean();
    await hydrateSalesOrderRelations(salesOrders);
    
    res.status(200).json({
      success: true,
      count: salesOrders.length,
      data: salesOrders
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get sales orders ready for packing
// @route   GET /api/sales-orders/ready-for-packing
// @access  Private (admin, stock_manager, warehouse)
exports.getReadyForPacking = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const salesOrders = await SalesOrder.find({ 
      company: companyId,
      status: 'picking'
    })
      .select({ client: 1, lines: 1, createdBy: 1, referenceNo: 1, status: 1, expectedDate: 1, createdAt: 1 })
      .sort({ expectedDate: 1, createdAt: -1 })
      .lean();
    await hydrateSalesOrderRelations(salesOrders);
    
    res.status(200).json({
      success: true,
      count: salesOrders.length,
      data: salesOrders
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get sales orders ready for delivery
// @route   GET /api/sales-orders/ready-for-delivery
// @access  Private (admin, stock_manager, warehouse)
exports.getReadyForDelivery = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const salesOrders = await SalesOrder.find({ 
      company: companyId,
      status: 'packed'
    })
      .select({ client: 1, lines: 1, referenceNo: 1, status: 1, packedDate: 1, createdAt: 1 })
      .sort({ packedDate: -1 })
      .lean();
    await hydrateSalesOrderRelations(salesOrders);
    
    res.status(200).json({
      success: true,
      count: salesOrders.length,
      data: salesOrders
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get backorders
// @route   GET /api/sales-orders/backorders
// @access  Private (admin, stock_manager, sales)
exports.getBackorders = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const salesOrders = await SalesOrder.find({ 
      company: companyId,
      isBackorder: true,
      status: { $nin: ['closed', 'cancelled'] }
    })
      .select({ client: 1, lines: 1, referenceNo: 1, status: 1, isBackorder: 1, createdAt: 1 })
      .sort({ createdAt: -1 })
      .lean();
    await hydrateSalesOrderRelations(salesOrders);
    
    res.status(200).json({
      success: true,
      count: salesOrders.length,
      data: salesOrders
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get workflow status and available transitions
// @route   GET /api/sales-orders/:id/workflow
// @access  Private
exports.getWorkflowStatus = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const salesOrder = await SalesOrder.findOne({ _id: req.params.id, company: companyId })
      .select({ status: 1 });
    
    if (!salesOrder) {
      return res.status(404).json({
        success: false,
        message: 'Sales order not found'
      });
    }
    
    // Define all possible transitions
    const validTransitions = {
      'draft': ['confirmed', 'cancelled'],
      'confirmed': ['picking', 'cancelled'],
      'picking': ['packed', 'cancelled'],
      'packed': ['delivered', 'cancelled'],
      'delivered': ['invoiced', 'closed'],
      'invoiced': ['closed'],
      'closed': [],
      'cancelled': []
    };
    
    const currentStatus = salesOrder.status;
    const availableTransitions = validTransitions[currentStatus] || [];
    
    // Check if each transition is currently possible
    const transitions = availableTransitions.map(status => ({
      status,
      label: status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, ' '),
      possible: typeof salesOrder.canTransitionTo === 'function'
        ? salesOrder.canTransitionTo(status)
        : (validTransitions[currentStatus] || []).includes(status)
    }));
    
    res.status(200).json({
      success: true,
      data: {
        currentStatus,
        currentStatusLabel: currentStatus.charAt(0).toUpperCase() + currentStatus.slice(1).replace(/_/g, ' '),
        transitions,
        canEdit: ['draft', 'confirmed'].includes(currentStatus),
        canCancel: typeof salesOrder.canTransitionTo === 'function'
          ? salesOrder.canTransitionTo('cancelled')
          : (validTransitions[currentStatus] || []).includes('cancelled'),
        isComplete: ['closed', 'cancelled'].includes(currentStatus)
      }
    });
  } catch (error) {
    next(error);
  }
};
