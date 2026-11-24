'use strict';

const salesLegacyController = require('./salesLegacyController');
const posController = require('./posController');
const Client = require('../models/Client');
const Warehouse = require('../models/Warehouse');
const StockBatch = require('../models/StockBatch');
const { dbClient } = require('../lib/prisma');

function bindPosUser(req, res) {
  const auth = req.posAuthContext;
  if (!auth?.user?.id || !auth?.company?.id || !auth?.register?.id) {
    res.status(401).json({
      success: false,
      code: 'POS_SESSION_INVALID',
      message: 'Sign in to this Pharmacy register again.',
    });
    return false;
  }
  req.user = {
    ...auth.user,
    id: String(auth.user.id),
    company: { _id: String(auth.company.id) },
  };
  req.body = {
    ...req.body,
    registerId: String(auth.register.code),
    deviceId: String(auth.posDevice?.deviceId || auth.register.claimedDeviceId || ''),
  };
  return true;
}

exports.searchProducts = (req, res, next) => {
  if (!bindPosUser(req, res)) return;
  req.query = { ...req.query, pharmacyOnly: 'true' };
  return salesLegacyController.getPosProducts(req, res, next);
};

exports.listWarehouses = async (req, res, next) => {
  if (!bindPosUser(req, res)) return;
  try {
    const warehouses = await Warehouse.find({
      company: req.user.company._id,
      isActive: { $ne: false },
    }).sort({ name: 1 });
    return res.json({
      success: true,
      data: warehouses.map((warehouse) => ({
        id: String(warehouse._id),
        name: warehouse.name,
        code: warehouse.code,
      })),
    });
  } catch (error) {
    return next(error);
  }
};

exports.searchCustomers = async (req, res, next) => {
  if (!bindPosUser(req, res)) return;
  const search = String(req.query.q || '').trim();
  if (search.length > 80) {
    return res.status(400).json({
      success: false,
      code: 'PHARMACY_CUSTOMER_SEARCH_INVALID',
      message: 'Customer search must be 80 characters or fewer.',
    });
  }
  if (search.length < 2) return res.json({ success: true, data: [] });

  try {
    const escapedSearch = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const customers = await Client.find({
      company: req.user.company._id,
      isActive: true,
      isWalkIn: { $ne: true },
      $or: [
        { name: { $regex: escapedSearch, $options: 'i' } },
        { code: { $regex: escapedSearch, $options: 'i' } },
      ],
    })
      .select('name code contact')
      .limit(20)
      .lean();

    return res.json({
      success: true,
      data: customers.map((customer) => ({
        id: String(customer._id || customer.id),
        name: String(customer.name || ''),
        code: String(customer.code || ''),
        phone: typeof customer.contact?.phone === 'string' ? customer.contact.phone : null,
      })),
    });
  } catch (error) {
    return next(error);
  }
};

exports.getCustomer = async (req, res, next) => {
  if (!bindPosUser(req, res)) return;
  const customerId = String(req.params.customerId || '').trim();
  if (!customerId || customerId.length > 80) {
    return res.status(400).json({
      success: false,
      code: 'PHARMACY_CUSTOMER_ID_INVALID',
      message: 'Choose a valid customer account.',
    });
  }
  try {
    const customer = await Client.findOne({
      _id: customerId,
      company: req.user.company._id,
      isActive: true,
      isWalkIn: { $ne: true },
    })
      .select('name code contact')
      .lean();
    if (!customer) {
      return res.status(404).json({
        success: false,
        code: 'PHARMACY_CUSTOMER_NOT_FOUND',
        message: 'This customer account is no longer available on this register.',
      });
    }
    return res.json({
      success: true,
      data: {
        id: String(customer._id || customer.id),
        name: String(customer.name || ''),
        code: String(customer.code || ''),
        phone: typeof customer.contact?.phone === 'string' ? customer.contact.phone : null,
      },
    });
  } catch (error) {
    return next(error);
  }
};

exports.getFiscalReceipt = async (req, res, next) => {
  if (!bindPosUser(req, res)) return;
  const invoiceId = String(req.params.invoiceId || '').trim();
  if (!/^[a-f\d]{24}$/i.test(invoiceId)) {
    return res.status(400).json({
      success: false,
      code: 'PHARMACY_RECEIPT_ID_INVALID',
      message: 'Choose a valid Pharmacy sale.',
    });
  }
  try {
    const rows = await dbClient().$queryRawUnsafe(
      'SELECT register_id AS "registerId", cashier_id AS "cashierId" FROM invoices WHERE id = $1 AND company_id = $2 AND pos_origin = TRUE LIMIT 1',
      invoiceId,
      req.user.company._id,
    );
    const invoice = rows[0];
    const belongsToRegister = String(invoice?.registerId || '') === String(req.posAuthContext.register.id);
    const belongsToCashier = !invoice?.registerId
      && String(invoice?.cashierId || '') === String(req.posAuthContext.user.id);
    if (!invoice || (!belongsToRegister && !belongsToCashier)) {
      return res.status(404).json({
        success: false,
        code: 'PHARMACY_RECEIPT_NOT_FOUND',
        message: 'This sale is not available on the current Pharmacy register.',
      });
    }

    let statusCode = 200;
    const receiptResponse = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(payload) {
        if (statusCode >= 400 || payload?.success !== true) {
          return res.status(statusCode).json(payload);
        }
        const data = payload.data || {};
        const ebm = data.ebm && typeof data.ebm === 'object' ? data.ebm : {};
        const fiscalMode = String(data.fiscalMode || ebm.fiscalEnvironment || ebm.environment || '').toLowerCase() || null;
        return res.json({
          success: true,
          data: {
            fiscalMode,
            fiscalStatus: String(ebm.ebmStatus || (fiscalMode === 'none' ? 'not_required' : 'not_submitted')).toLowerCase(),
            fiscalReceiptNumber: typeof ebm.rcptNo === 'string' ? ebm.rcptNo : null,
            fiscalReceiptDate: typeof ebm.rcptDtDisplay === 'string'
              ? ebm.rcptDtDisplay
              : typeof ebm.rcptDt === 'string' ? ebm.rcptDt : null,
            fiscalQrCodeDataUrl: typeof ebm.qrCodeDataUrl === 'string' ? ebm.qrCodeDataUrl : null,
            fiscalError: typeof ebm.fiscalError === 'string'
              ? ebm.fiscalError
              : typeof ebm.lastError === 'string' ? ebm.lastError : null,
          },
        });
      },
    };
    req.params = { ...req.params, invoiceId };
    return posController.getReceipt(req, receiptResponse, next);
  } catch (error) {
    return next(error);
  }
};

exports.listBatches = async (req, res, next) => {
  if (!bindPosUser(req, res)) return;
  const productId = String(req.query.productId || '');
  const warehouseId = String(req.query.warehouseId || '');
  if (!/^[a-f\d]{24}$/i.test(productId) || !/^[a-f\d]{24}$/i.test(warehouseId)) {
    return res.status(400).json({
      success: false,
      code: 'PHARMACY_BATCH_QUERY_INVALID',
      message: 'Choose a valid product and pharmacy stock location.',
    });
  }
  try {
    const batches = await StockBatch.find({
      company: req.user.company._id,
      product: productId,
      warehouse: warehouseId,
      qtyOnHand: { $gt: 0 },
      isQuarantined: { $ne: true },
      recallStatus: 'active',
    }).sort({ expiryDate: 1, createdAt: 1 });
    const data = batches
      .map((batch) => {
        const availableQuantity = Math.max(
          0,
          Number(batch.qtyOnHand || 0) - Number(batch.reservedQuantity || 0),
        );
        return {
          id: String(batch._id),
          batchNo: String(batch.batchNo || ''),
          expiryDate: batch.expiryDate || null,
          availableQuantity,
        };
      })
      .filter((batch) => batch.availableQuantity > 0
        && (!batch.expiryDate || new Date(batch.expiryDate).getTime() >= Date.now()));
    return res.json({ success: true, data });
  } catch (error) {
    return next(error);
  }
};

exports.createSale = (req, res, next) => {
  if (!bindPosUser(req, res)) return;
  return salesLegacyController.createDirectSale(req, res, next);
};
