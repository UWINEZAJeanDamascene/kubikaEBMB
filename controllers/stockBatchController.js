const StockBatch = require('../models/StockBatch');
const Product = require('../models/Product');
const Warehouse = require('../models/Warehouse');
const StockSerialNumber = require('../models/StockSerialNumber');

const STOCK_BATCH_LIST_SELECT = [
  '_id', 'company', 'batchNo', 'product', 'warehouse', 'qtyReceived', 'qtyOnHand',
  'unitCost', 'manufactureDate', 'expiryDate', 'isQuarantined', 'notes',
  'createdAt', 'updatedAt'
].join(' ');

// @access  Private
exports.getStockBatches = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { product, warehouse, search, isQuarantined, page = 1, limit = 50 } = req.query;

    const query = { company: companyId };

    if (product) query.product = product;
    if (warehouse) query.warehouse = warehouse;
    if (isQuarantined === 'true' || isQuarantined === 'false') query.isQuarantined = isQuarantined === 'true';

    // Search by batch number
    if (search) {
      query.batchNo = { $regex: search, $options: 'i' };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [batches, total] = await Promise.all([
      StockBatch.find(query)
        .select(STOCK_BATCH_LIST_SELECT)
        .populate('product', 'name sku trackingType')
        .populate('warehouse', 'name code')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      StockBatch.countDocuments(query)
    ]);

    res.status(200).json({
      success: true,
      data: batches,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    next(error);
  }
};

// @access  Private
exports.getStockBatch = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const batch = await StockBatch.findOne({ _id: req.params.id, company: companyId })
      .populate('product', 'name sku trackingType unit')
      .populate('warehouse', 'name code')
      .populate('grn', 'referenceNo receivedDate')
      .lean();

    if (!batch) {
      return res.status(404).json({ success: false, message: 'Batch not found' });
    }

    res.status(200).json({ success: true, data: batch });
  } catch (error) {
    next(error);
  }
};

// @access  Private (admin, stock_manager)
exports.createStockBatch = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { batchNo, product, warehouse, grn, qtyReceived, qtyOnHand, unitCost, manufactureDate, expiryDate, isQuarantined, notes } = req.body;

    if (Number(qtyReceived || 0) !== 0 || Number(qtyOnHand || 0) !== 0) {
      return res.status(400).json({ success: false, code: 'BATCH_RECEIPT_REQUIRED', message: 'Batch quantities must be created through a stock receipt or opening stock transaction.' });
    }

    // Validate product exists and tracks batches
    const productDoc = await Product.findOne({ _id: product, company: companyId });
    if (!productDoc) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }
    if (productDoc.trackingType !== 'batch') {
      return res.status(400).json({ success: false, message: 'Product does not track batches' });
    }

    // Validate warehouse exists
    const warehouseDoc = await Warehouse.findOne({ _id: warehouse, company: companyId });
    if (!warehouseDoc) {
      return res.status(404).json({ success: false, message: 'Warehouse not found' });
    }

    // Check for duplicate batch
    const existingBatch = await StockBatch.findOne({
      company: companyId,
      product,
      warehouse,
      batchNo: batchNo.toUpperCase()
    });

    if (existingBatch) {
      return res.status(400).json({ success: false, message: 'Batch with this number already exists for this product in this warehouse' });
    }

    const batch = await StockBatch.create({
      company: companyId,
      batchNo: batchNo.toUpperCase(),
      product,
      warehouse,
      grn: grn || null,
      qtyReceived: qtyReceived || 0,
      qtyOnHand: qtyOnHand !== undefined ? qtyOnHand : (qtyReceived || 0),
      unitCost: unitCost || 0,
      manufactureDate: manufactureDate || null,
      expiryDate: expiryDate || null,
      isQuarantined: isQuarantined || false,
      notes: notes || null
    });

    await batch.populate([
      { path: 'product', select: 'name sku trackingType' },
      { path: 'warehouse', select: 'name code' },
      { path: 'grn', select: 'referenceNo' }
    ]);

    res.status(201).json({ success: true, data: batch });
  } catch (error) {
    next(error);
  }
};

// @access  Private (admin, stock_manager)
exports.updateStockBatch = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { batchNo, qtyOnHand, unitCost, manufactureDate, expiryDate, isQuarantined, notes } = req.body;

    let batch = await StockBatch.findOne({ _id: req.params.id, company: companyId });

    if (!batch) {
      return res.status(404).json({ success: false, message: 'Batch not found' });
    }

    if (qtyOnHand !== undefined && Number(qtyOnHand) !== Number(batch.qtyOnHand)) {
      return res.status(400).json({
        success: false,
        code: 'BATCH_QUANTITY_MOVEMENT_REQUIRED',
        message: 'Batch on-hand quantity is controlled by stock movements. Create a receipt or stock adjustment to change it.',
      });
    }
    if (batchNo && batchNo.toUpperCase() !== batch.batchNo) {
      return res.status(400).json({ success: false, code: 'BATCH_IDENTITY_IMMUTABLE', message: 'Batch numbers are immutable after receipt to preserve traceability.' });
    }
    if (unitCost !== undefined && Number(unitCost) !== Number(batch.unitCost)) {
      return res.status(400).json({ success: false, code: 'BATCH_COST_IMMUTABLE', message: 'Batch cost is fixed at receipt. Record a cost adjustment through the approved accounting workflow.' });
    }

    // Update fields
    if (manufactureDate !== undefined) batch.manufactureDate = manufactureDate;
    if (expiryDate !== undefined) batch.expiryDate = expiryDate;
    if (isQuarantined !== undefined) batch.isQuarantined = isQuarantined;
    if (notes !== undefined) batch.notes = notes;

    await batch.save();

    await batch.populate([
      { path: 'product', select: 'name sku trackingType' },
      { path: 'warehouse', select: 'name code' },
      { path: 'grn', select: 'referenceNo' }
    ]);

    res.status(200).json({ success: true, data: batch });
  } catch (error) {
    next(error);
  }
};

// @access  Private (admin, stock_manager)
exports.deleteStockBatch = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    const batch = await StockBatch.findOne({ _id: req.params.id, company: companyId });

    if (!batch) {
      return res.status(404).json({ success: false, message: 'Batch not found' });
    }

    // Check if batch has quantity
    if (Number(batch.qtyOnHand) > 0 || Number(batch.qtyReceived) > 0) {
      return res.status(400).json({ success: false, message: 'Received batch history is retained for traceability and cannot be deleted.' });
    }

    const linkedSerialCount = await StockSerialNumber.countDocuments({ company: companyId, batch: batch._id });
    if (linkedSerialCount > 0) {
      return res.status(409).json({
        success: false,
        code: 'BATCH_HAS_SERIAL_HISTORY',
        message: 'This batch has serial-number traceability history and cannot be deleted.',
      });
    }

    await batch.deleteOne();

    res.status(200).json({ success: true, message: 'Batch deleted successfully' });
  } catch (error) {
    next(error);
  }
};

// @access  Private
exports.getExpiringBatches = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const parsedDays = Number.parseInt(String(req.query.days ?? '30'), 10);
    const days = Number.isInteger(parsedDays) ? Math.min(365, Math.max(0, parsedDays)) : 30;
    const { warehouse } = req.query;

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() + parseInt(days));

    const query = {
      company: companyId,
      expiryDate: { $lte: cutoffDate },
      qtyOnHand: { $gt: 0 },
    };

    if (warehouse) query.warehouse = warehouse;

    const batches = await StockBatch.find(query)
      .populate('product', 'name sku')
      .populate('warehouse', 'name code')
      .sort({ expiryDate: 1 })
      .lean();

    res.status(200).json({ success: true, data: batches });
  } catch (error) {
    next(error);
  }
};

// @access  Private
exports.quarantineStockBatch = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { isQuarantined } = req.body;

    if (typeof isQuarantined !== 'boolean') {
      return res.status(400).json({
        success: false,
        code: 'BATCH_QUARANTINE_STATE_REQUIRED',
        message: 'Provide isQuarantined as true or false.',
      });
    }

    const batch = await StockBatch.findOneAndUpdate(
      { _id: req.params.id, company: companyId },
      { $set: { isQuarantined } },
      { new: true }
    ).populate('product', 'name sku');

    if (!batch) {
      return res.status(404).json({ success: false, message: 'Batch not found' });
    }

    res.status(200).json({ success: true, data: batch });
  } catch (error) {
    next(error);
  }
};
