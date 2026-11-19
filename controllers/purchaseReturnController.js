const PurchaseReturn = require('../models/PurchaseReturn');
const GoodsReceivedNote = require('../models/GoodsReceivedNote');
const InventoryBatch = require('../models/InventoryBatch');
const StockBatch = require('../models/StockBatch');
const StockSerialNumber = require('../models/StockSerialNumber');
const StockMovement = require('../models/StockMovement');
const Product = require('../models/Product');
const StockLevel = require('../models/StockLevel');
const Supplier = require('../models/Supplier');
const Company = require('../models/Company');
const JournalService = require('../services/journalService');
const transactionService = require('../services/transactionService');
const PurchaseOrder = require('../models/PurchaseOrder');
const Purchase = require('../models/Purchase');
const emailService = require('../services/emailService');
const cacheService = require('../services/cacheService');
const DEFAULT_ACCOUNTS = require('../constants/chartOfAccounts').DEFAULT_ACCOUNTS;
const { parsePagination, paginationMeta } = require('../utils/pagination');
const { nextReferenceNo } = require('../utils/referenceNumbers');
const {
  getPurchaseUnitSnapshot,
  toBaseQuantity,
  toBaseUnitCost,
} = require('../utils/purchaseUnitRules');
const {
  buildReturnLines,
  buildPurchaseReturnLines,
  calculateReturnTotals,
  calculatePurchaseReturnTotals,
  idOf,
  validateReturnSerialNumbers,
} = require('../utils/purchaseReturnRules');

async function lockPurchaseReturn(tx, returnId, companyId) {
  if (!tx) return;
  if (typeof tx.$queryRaw !== 'function') {
    throw new Error('Purchase return confirmation requires a PostgreSQL transaction');
  }
  await tx.$queryRaw`
    SELECT id FROM purchase_returns
    WHERE id = ${String(returnId)} AND company_id = ${String(companyId)}
    FOR UPDATE`;
}

async function lockGRN(tx, grnId, companyId) {
  if (!tx) return;
  await tx.$queryRaw`
    SELECT id FROM goods_received_notes
    WHERE id = ${String(grnId)} AND company_id = ${String(companyId)}
    FOR UPDATE`;
}

async function lockPurchase(tx, purchaseId, companyId) {
  if (!tx) return;
  await tx.$queryRaw`
    SELECT id FROM purchases
    WHERE id = ${String(purchaseId)} AND company_id = ${String(companyId)}
    FOR UPDATE`;
}

async function lockProductAndStockLevel(tx, productId, warehouseId, companyId) {
  if (!tx) return;
  await tx.$queryRaw`
    SELECT id FROM products
    WHERE id = ${String(productId)} AND company_id = ${String(companyId)}
    FOR UPDATE`;
  await tx.$queryRaw`
    SELECT id FROM stock_levels
    WHERE product_id = ${String(productId)}
      AND warehouse_id = ${String(warehouseId)}
      AND company_id = ${String(companyId)}
    FOR UPDATE`;
}

async function lockStockBatch(tx, batchId, companyId) {
  if (!tx) return;
  await tx.$queryRaw`
    SELECT id FROM stock_batches
    WHERE id = ${String(batchId)} AND company_id = ${String(companyId)}
    FOR UPDATE`;
}

async function lockBankAccount(tx, bankAccountId, companyId) {
  if (!tx) return;
  await tx.$queryRaw`
    SELECT id FROM bank_accounts
    WHERE id = ${String(bankAccountId)} AND company_id = ${String(companyId)}
    FOR UPDATE`;
}

function parseReturnDate(value) {
  if (value == null || value === '') return new Date();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw Object.assign(new Error('Return date is invalid'), { status: 400 });
  }
  return date;
}

const sendPurchaseReturnEmail = async (pr, company, supplier, action) => {
  try {
    const config = require('../src/config/environment').getConfig();
    if (!config.features?.emailNotifications || !config.email?.gmailUser) {
      return;
    }

    const supplierEmail = supplier?.contact?.email || supplier?.email;
    if (!supplierEmail) {
      console.warn('[PurchaseReturn] No supplier email found');
      return;
    }

    // Populate product data for email
    const Product = require('../models/Product');
    let populatedLines = pr.lines || [];
    if (populatedLines.length > 0 && !populatedLines[0].product?.name) {
      populatedLines = await Promise.all(populatedLines.map(async (line) => {
        if (line.product && typeof line.product === 'string') {
          const product = await Product.findById(line.product);
          return { ...line, product };
        }
        return line;
      }));
    }

    const actionText = { created: 'Created', confirmed: 'Confirmed', refunded: 'Refunded', cancelled: 'Cancelled' }[action] || 'Updated';
    const subject = `Purchase Return ${pr.referenceNo || pr.returnNumber} - ${actionText}`;

    let itemsHtml = '';
    if (populatedLines.length > 0) {
      itemsHtml = populatedLines.map(line => `
        <tr>
          <td style="padding:10px; border-bottom:1px solid #ddd;">${line.product?.name || line.description || line.product || 'Item'}</td>
          <td style="padding:10px; border-bottom:1px solid #ddd; text-align:center;">${line.qtyReturned || 0}</td>
          <td style="padding:10px; border-bottom:1px solid #ddd; text-align:right;">${pr.currencyCode || 'USD'} ${(line.unitCost || 0).toFixed(2)}</td>
        </tr>
      `).join('');
    }

    const html = `
      <div style="font-family:Arial,sans-serif; max-width:600px; margin:0 auto;">
        <div style="background:#ef4444; padding:30px; border-radius:10px 10px 0 0;">
          <h1 style="color:white; margin:0; text-align:center;">↩️ Purchase Return ${actionText}</h1>
        </div>
        <div style="background:#f9f9f9; padding:30px; border:1px solid #ddd; border-top:none; border-radius:0 0 10px 10px;">
          <h2 style="color:#ef4444; margin:0 0 5px;">${pr.referenceNo || pr.returnNumber || ''}</h2>
          <p style="color:#666; margin:5px 0;">Date: ${new Date(pr.returnDate || pr.createdAt).toLocaleDateString()}</p>
          <p style="color:#666; margin:5px 0;">Status: <strong>${actionText}</strong></p>
          <div style="background:white; padding:15px; border-radius:8px; margin:20px 0;">
            <strong>Supplier:</strong><br/>${supplier?.name || 'Supplier'}
          </div>
          <table style="width:100%; border-collapse:collapse; margin:20px 0;">
            <thead>
              <tr style="background:#ef4444; color:white;">
                <th style="padding:12px; text-align:left;">Product</th>
                <th style="padding:12px; text-align:center;">Qty</th>
                <th style="padding:12px; text-align:right;">Unit Cost</th>
              </tr>
            </thead>
            <tbody>${itemsHtml}</tbody>
          </table>
          <div style="text-align:right; margin:20px 0;">
            <p style="margin:5px 0; font-size:18px; font-weight:bold; color:#ef4444;">Total: ${pr.currencyCode || 'USD'} ${(pr.totalAmount || 0).toFixed(2)}</p>
          </div>
          ${pr.reason ? `<div style="background:white; padding:15px; border-radius:8px; margin:20px 0;"><strong>Reason:</strong><br/>${pr.reason}</div>` : ''}
          <div style="text-align:center; margin-top:30px;">
            <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/purchase-returns/${pr._id}" style="background:#ef4444; color:white; padding:12px 30px; text-decoration:none; border-radius:8px; display:inline-block;">View Return</a>
          </div>
          <hr style="border:none; border-top:1px solid #ddd; margin:30px 0;"/>
          <p style="font-size:12px; color:#888; text-align:center;">KUBIKA system — Manage Your Stock From Supply to Final Sale</p>
        </div>
      </div>`;

    await emailService.sendEmail(supplierEmail, subject, html);
  } catch (err) {
    console.error('[PurchaseReturn] Email failed:', err.message);
  }
};

exports.createPurchaseReturn = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const payload = req.body || {};
    const hasGrn = Boolean(payload.grn);
    const hasPurchase = Boolean(payload.purchase);
    if (hasGrn === hasPurchase) {
      return res.status(400).json({ success: false, message: 'Select exactly one source: a confirmed GRN or a received direct purchase.' });
    }

    let grn = null;
    let purchase = null;
    let lines;
    let totals;
    if (hasGrn) {
      grn = await GoodsReceivedNote.findOne({ _id: payload.grn, company: companyId });
      if (!grn) return res.status(404).json({ success: false, message: 'GRN not found' });
      if (grn.status !== 'confirmed') return res.status(409).json({ success: false, message: 'Can only return against confirmed GRN' });
      const confirmedReturns = await PurchaseReturn.find({
        company: companyId,
        grn: grn._id,
        status: 'confirmed',
      }).lean();
      lines = buildReturnLines(grn, payload.lines, confirmedReturns);
      totals = calculateReturnTotals(grn, lines);
    } else {
      purchase = await Purchase.findOne({ _id: payload.purchase, company: companyId });
      if (!purchase) return res.status(404).json({ success: false, message: 'Purchase not found' });
      if (purchase.status !== 'received' || !purchase.stockAdded) {
        return res.status(409).json({ success: false, message: 'Can only return stock from a received direct purchase.' });
      }
      if (!purchase.warehouse) {
        return res.status(409).json({ success: false, message: 'The direct purchase has no warehouse assigned for stock return.' });
      }
      const confirmedReturns = await PurchaseReturn.find({
        company: companyId,
        purchase: purchase._id,
        status: 'confirmed',
      }).lean();
      lines = buildPurchaseReturnLines(purchase, payload.lines, confirmedReturns);
      const sourceProducts = await Product.find({
        _id: { $in: [...new Set(lines.map((line) => idOf(line.product)))] },
        company: companyId,
      });
      if (sourceProducts.some((product) => (product.trackingType || 'none') !== 'none')) {
        return res.status(409).json({
          success: false,
          message: 'Tracked products must be returned against their confirmed GRN so batch or serial traceability can be verified.',
        });
      }
      totals = calculatePurchaseReturnTotals(purchase, lines);
    }
    const reason = String(payload.reason || '').trim();
    if (!reason) {
      return res.status(400).json({ success: false, message: 'Return reason is required' });
    }

    const supplierCreditNoteNo = await nextReferenceNo(companyId, 'SCN', {
      field: 'supplierCreditNoteNo',
      model: 'purchaseReturn',
    });
    const pr = await PurchaseReturn.create({
      company: companyId,
      createdBy: req.user.id,
      status: 'draft',
      grn: grn?._id || null,
      purchase: purchase?._id || null,
      supplier: grn?.supplier || purchase?.supplier,
      warehouse: grn?.warehouse || purchase?.warehouse,
      referenceNo: payload.referenceNo,
      returnDate: parseReturnDate(payload.returnDate),
      supplierCreditNoteNo,
      reason,
      lines,
      totalAmount: totals.totalAmount,
    });

    // Send email notification
    if (req.body.sendEmail && pr.status !== 'draft') {
      const company = await Company.findById(companyId);
      const sourceGrn = pr.grn ? await GoodsReceivedNote.findById(pr.grn) : null;
      const sourcePurchase = pr.purchase ? await Purchase.findById(pr.purchase) : null;
      const supplier = await Supplier.findById(sourceGrn?.supplier || sourcePurchase?.supplier);
      await sendPurchaseReturnEmail(pr, company, supplier, 'created');
    }

    res.status(201).json({ success: true, data: pr });
  } catch (err) { next(err); }
};

exports.updatePurchaseReturn = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const pr = await PurchaseReturn.findOne({ _id: req.params.id, company: companyId });
    if (!pr) return res.status(404).json({ success: false, message: 'Purchase return not found' });
    if (pr.status !== 'draft') return res.status(409).json({ success: false, message: 'Only draft returns can be edited' });

    const payload = req.body || {};
    if (payload.grn || payload.purchase || payload.supplier || payload.warehouse) {
      return res.status(400).json({ success: false, message: 'A draft return cannot be moved to another source, supplier, or warehouse' });
    }

    const isDirectPurchase = Boolean(idOf(pr.purchase));
    const grn = isDirectPurchase
      ? null
      : await GoodsReceivedNote.findOne({ _id: idOf(pr.grn), company: companyId });
    const purchase = isDirectPurchase
      ? await Purchase.findOne({ _id: idOf(pr.purchase), company: companyId })
      : null;
    if (!isDirectPurchase && (!grn || grn.status !== 'confirmed')) {
      return res.status(409).json({ success: false, message: 'The source GRN is no longer available for return' });
    }
    if (isDirectPurchase && (!purchase || purchase.status !== 'received' || !purchase.stockAdded)) {
      return res.status(409).json({ success: false, message: 'The source direct purchase is no longer available for return' });
    }
    const confirmedReturns = await PurchaseReturn.find({
      company: companyId,
      ...(isDirectPurchase ? { purchase: idOf(pr.purchase) } : { grn: grn?._id }),
      status: 'confirmed',
    }).lean();
    if (payload.lines !== undefined) {
      pr.lines = isDirectPurchase
        ? buildPurchaseReturnLines(purchase, payload.lines, confirmedReturns, pr._id)
        : buildReturnLines(grn, payload.lines, confirmedReturns, pr._id);
    }
    if (payload.referenceNo !== undefined) pr.referenceNo = String(payload.referenceNo).trim();
    if (payload.returnDate !== undefined) pr.returnDate = parseReturnDate(payload.returnDate);
    if (payload.reason !== undefined) {
      const reason = String(payload.reason || '').trim();
      if (!reason) return res.status(400).json({ success: false, message: 'Return reason is required' });
      pr.reason = reason;
    }
    const totals = isDirectPurchase
      ? calculatePurchaseReturnTotals(purchase, pr.lines || [])
      : calculateReturnTotals(grn, pr.lines || []);
    pr.totalAmount = totals.totalAmount;
    await pr.save();
    res.json({ success: true, data: pr });
  } catch (err) { next(err); }
};

// Confirm purchase return
exports.confirmPurchaseReturn = async (req, res, next) => {
  const companyId = req.user.company._id;

  const doConfirm = async (sess) => {
    const useSession = !!sess;
    const opts = useSession ? { session: sess } : {};

    await lockPurchaseReturn(sess, req.params.id, companyId);
    const pr = await PurchaseReturn.findOne({ _id: req.params.id, company: companyId }, null, opts);
    if (!pr) {
      throw Object.assign(new Error('Purchase return not found'), { status: 404 });
    }
    if (pr.status !== 'draft') {
      throw Object.assign(new Error('Only draft purchase returns can be confirmed'), { status: 409 });
    }

    const isDirectPurchase = Boolean(idOf(pr.purchase));
    let grn = null;
    let purchase = null;
    let sourceWarehouse;
    let sourceReference;
    if (isDirectPurchase) {
      await lockPurchase(sess, idOf(pr.purchase), companyId);
      const purchaseQuery = Purchase.findOne({ _id: idOf(pr.purchase), company: companyId });
      purchase = useSession ? await purchaseQuery.session(sess) : await purchaseQuery;
      if (!purchase) throw Object.assign(new Error('Source purchase not found'), { status: 404 });
      if (purchase.status !== 'received' || !purchase.stockAdded) {
        throw Object.assign(new Error('Cannot return stock from a purchase that has not been received'), { status: 409 });
      }
      if (!purchase.warehouse) {
        throw Object.assign(new Error('The source purchase has no warehouse assigned for stock return'), { status: 409 });
      }
      sourceWarehouse = idOf(purchase.warehouse);
      sourceReference = purchase.purchaseNumber;
    } else {
      await lockGRN(sess, idOf(pr.grn), companyId);
      const grnQuery = GoodsReceivedNote.findOne({ _id: idOf(pr.grn), company: companyId });
      grn = useSession ? await grnQuery.session(sess) : await grnQuery;
      if (!grn) throw Object.assign(new Error('GRN not found'), { status: 404 });
      if (grn.status !== 'confirmed') throw Object.assign(new Error('Cannot return against unconfirmed GRN'), { status: 409 });
      sourceWarehouse = idOf(grn.warehouse);
      sourceReference = grn.referenceNo;
    }

    const confirmedReturnsQuery = PurchaseReturn.find({
      company: companyId,
      status: 'confirmed',
      ...(isDirectPurchase ? { purchase: idOf(pr.purchase) } : { grn: idOf(pr.grn) }),
    });
    const confirmedReturns = useSession
      ? await confirmedReturnsQuery.session(sess).lean()
      : await confirmedReturnsQuery.lean();
    const returnLines = isDirectPurchase
      ? buildPurchaseReturnLines(purchase, pr.lines || [], confirmedReturns, pr._id)
      : buildReturnLines(grn, pr.lines || [], confirmedReturns, pr._id);
    const returnTotals = isDirectPurchase
      ? calculatePurchaseReturnTotals(purchase, returnLines)
      : calculateReturnTotals(grn, returnLines);

    const productIds = [...new Set(returnLines.map((line) => idOf(line.product)))].sort();
    for (const productId of productIds) {
      await lockProductAndStockLevel(sess, productId, sourceWarehouse, companyId);
    }

    // Track created resources for manual rollback
    const createdMovements = [];
    const modifiedBatches = [];
    const modifiedStockBatches = [];
    const modifiedSerials = [];
    const modifiedProducts = new Map();
    const inventoryValueByProduct = new Map();
    const inventoryAccountByProduct = new Map();

    for (const line of returnLines) {
      const sourceLineId = idOf(isDirectPurchase ? line.purchaseLine : line.grnLine);
      const sourceLine = (isDirectPurchase ? purchase.items || [] : grn.lines || [])
        .find((item) => idOf(item._id || item.id) === sourceLineId);
      if (!sourceLine) throw Object.assign(new Error('Source purchase line not found'), { status: 404 });
      const unitSnapshot = getPurchaseUnitSnapshot(sourceLine);
      const baseQuantity = toBaseQuantity(line.qtyReturned, unitSnapshot);

      // Check warehouse stock
      const productQuery = Product.findOne({ _id: line.product, company: companyId });
      const product = useSession ? await productQuery.session(sess) : await productQuery;
      if (!product) throw Object.assign(new Error('Product not found'), { status: 404 });
      const stockLevelQuery = StockLevel.findOne({
        company_id: companyId,
        product_id: line.product,
        warehouse_id: sourceWarehouse,
      });
      const stockLevel = useSession ? await stockLevelQuery.session(sess) : await stockLevelQuery;
      if (!stockLevel) throw Object.assign(new Error('No stock record exists for this product at the GRN warehouse'), { status: 409 });
      const onHand = Number(stockLevel.qty_on_hand) || 0;
      const reserved = Number(stockLevel.qty_reserved) || 0;
      const baseUnitCost = toBaseUnitCost(line.unitCost, unitSnapshot);
      const stockFallbackCost = Number(stockLevel.avg_cost) || Number(product.averageCost) || baseUnitCost;
      if (baseQuantity > Math.min(onHand - reserved, Number(product.currentStock) || 0) + 1e-9) {
        throw Object.assign(new Error('INSUFFICIENT_STOCK'), { status: 409 });
      }
      const trackingType = product.trackingType || 'none';
      const serialNumbers = Array.isArray(line.serialNumbers) ? line.serialNumbers : [];
      if (isDirectPurchase && trackingType !== 'none') {
        throw Object.assign(new Error('Tracked products must be returned against their confirmed GRN so batch or serial traceability can be verified.'), { status: 409 });
      }
      if (trackingType === 'serial') {
        const validatedSerialNumbers = validateReturnSerialNumbers(sourceLine, line.qtyReturned, serialNumbers);
        const serialQuery = StockSerialNumber.find({
          company: companyId,
          product: line.product,
          warehouse: sourceWarehouse,
          grn: grn._id,
          status: 'in_stock',
          serialNo: { $in: validatedSerialNumbers },
        });
        const availableSerialRows = useSession ? await serialQuery.session(sess) : await serialQuery;
        if (availableSerialRows.length !== validatedSerialNumbers.length) {
          throw Object.assign(new Error('One or more selected serial numbers are no longer available at the GRN warehouse'), { status: 409 });
        }
        const returnedAt = new Date();
        const serialUpdate = await StockSerialNumber.updateMany(
          {
            _id: { $in: availableSerialRows.map((serial) => serial._id) },
            company: companyId,
            product: line.product,
            warehouse: sourceWarehouse,
            grn: grn._id,
            status: 'in_stock',
          },
          { $set: { status: 'returned', returnedVia: pr._id, returnedAt } },
        );
        if (serialUpdate.modifiedCount !== validatedSerialNumbers.length) {
          throw Object.assign(new Error('One or more selected serial numbers are no longer available'), { status: 409 });
        }
        for (const serial of availableSerialRows) {
          modifiedSerials.push({
            id: serial._id,
            status: serial.status,
            returnedVia: serial.returnedVia,
            returnedAt: serial.returnedAt,
          });
        }
      } else if (serialNumbers.length) {
        throw Object.assign(new Error('Serial numbers can only be returned for serial-tracked products'), { status: 409 });
      }

      if (trackingType === 'batch') {
        const batchNo = String(sourceLine.batchNo || '').trim().toUpperCase();
        if (!batchNo) {
          throw Object.assign(new Error('The source GRN line is missing its batch number'), { status: 409 });
        }
        const stockBatchQuery = StockBatch.findOne({
          company: companyId,
          product: line.product,
          warehouse: sourceWarehouse,
          batchNo,
        });
        let stockBatch = useSession ? await stockBatchQuery.session(sess) : await stockBatchQuery;
        if (stockBatch && useSession) {
          await lockStockBatch(sess, stockBatch._id, companyId);
          const lockedStockBatchQuery = StockBatch.findOne({
            _id: stockBatch._id,
            company: companyId,
          });
          stockBatch = await lockedStockBatchQuery.session(sess);
        }
        const batchOnHand = Number(stockBatch?.qtyOnHand) || 0;
        const batchReserved = Number(stockBatch?.reservedQuantity) || 0;
        if (!stockBatch || baseQuantity > batchOnHand - batchReserved + 1e-9) {
          throw Object.assign(new Error('Insufficient unreserved quantity in the source batch'), { status: 409 });
        }
        modifiedStockBatches.push({ id: stockBatch._id, qtyOnHand: batchOnHand });
        stockBatch.qtyOnHand = batchOnHand - baseQuantity;
        await stockBatch.save(opts);
      }
      let inventoryCostRemoved = stockFallbackCost * baseQuantity;

      // A return can be against an older receipt after the original FIFO layer
      // has been partially consumed, merged, or adjusted. Validate and consume
      // the product's remaining warehouse stock across all available layers;
      // the supplier credit still uses the original GRN unit cost above.
      if (product.costingMethod === 'fifo') {
        const batches = await InventoryBatch.find({
          company: companyId,
          product: line.product,
          warehouse: pr.warehouse,
          availableQuantity: { $gt: 0 },
        }).sort({ receivedDate: 1 }).session(sess);
        const requestedQuantity = baseQuantity;
        let remainingQuantity = requestedQuantity;
        let fifoCost = 0;
        for (const batch of batches) {
          if (remainingQuantity <= 1e-9) break;
          const previousAvailable = Number(batch.availableQuantity) || 0;
          const quantityFromBatch = Math.min(previousAvailable, remainingQuantity);
          modifiedBatches.push({ id: batch._id, prevAvailable: previousAvailable });
          fifoCost += quantityFromBatch * (Number(batch.unitCost) || stockFallbackCost);
          batch.availableQuantity = previousAvailable - quantityFromBatch;
          await batch.save(opts);
          remainingQuantity -= quantityFromBatch;
        }
        inventoryCostRemoved = fifoCost + remainingQuantity * stockFallbackCost;
        // Product.currentStock is the authoritative quantity check above.
        // Some older/adjusted stock has no matching InventoryBatch layer, so
        // do not reject a valid return solely because this legacy cost-layer
        // mirror is short. Consume any layers that are present without making
        // them negative, and let the product stock movement record the return.
      }

      inventoryCostRemoved = Math.round((inventoryCostRemoved + Number.EPSILON) * 100) / 100;

      // Reduce product and warehouse stock in the same transaction as the return.
      const previousStock = Number(product.currentStock) || 0;
      if (!modifiedProducts.has(String(product._id))) modifiedProducts.set(String(product._id), { prevStock: product.currentStock, prevAvg: product.averageCost });
      product.currentStock = (product.currentStock || 0) - baseQuantity;
      await product.save(opts);
      const stockUnitCost = baseQuantity > 0 ? inventoryCostRemoved / baseQuantity : stockFallbackCost;
      stockLevel.applyMovement('return_out', baseQuantity, stockUnitCost);
      await stockLevel.save(opts);
      inventoryValueByProduct.set(
        String(line.product),
        Math.round(
          ((inventoryValueByProduct.get(String(line.product)) || 0) + inventoryCostRemoved + Number.EPSILON) * 100,
        ) / 100,
      );
      inventoryAccountByProduct.set(String(line.product), product.inventoryAccount || null);

      // Create return_out stock movement
      const movement = new StockMovement({
        company: companyId,
        product: line.product,
        type: 'out',
        reason: 'return',
        quantity: baseQuantity,
        previousStock,
        newStock: product.currentStock,
        unitCost: stockUnitCost,
        totalCost: stockUnitCost * baseQuantity,
        warehouse: sourceWarehouse,
        referenceType: 'return',
        referenceNumber: pr.referenceNo,
        referenceDocument: pr._id,
        referenceModel: 'PurchaseReturn',
        performedBy: req.user.id,
        movementDate: new Date()
      });
      await movement.save(opts);
      createdMovements.push(movement._id);

    }

    // Build journal lines: reverse AP and VAT, and remove inventory at carrying value.
    const journalLines = [];
    // DR Accounts Payable - total incl tax
    const apAcct = await JournalService.getMappedAccountCode(companyId, 'purchases', 'accountsPayable', DEFAULT_ACCOUNTS.accountsPayable);
    journalLines.push(JournalService.createDebitLine(apAcct, returnTotals.totalAmount, `Purchase Return ${pr.referenceNo} - ${isDirectPurchase ? 'Purchase' : 'GRN'}#${sourceReference}`));

    if (returnTotals.taxAmount > 0) {
      // CR VAT Input (2210) — reverses the DR VAT Input from the original GRN
      const vatAcct = await JournalService.getMappedAccountCode(companyId, 'tax', 'vatInput', DEFAULT_ACCOUNTS.vatInput);
      journalLines.push(JournalService.createCreditLine(vatAcct, returnTotals.taxAmount, `VAT reversal ${pr.referenceNo}`));
    }

    let inventoryCostTotal = 0;
    for (const [productId, amount] of inventoryValueByProduct.entries()) {
      inventoryCostTotal += amount;
      let inventoryAccount = inventoryAccountByProduct.get(productId);
      if (inventoryAccount && /^[0-9a-fA-F]{24}$/.test(String(inventoryAccount))) {
        const account = await require('../models/ChartOfAccount').findById(inventoryAccount).lean();
        inventoryAccount = account?.code;
      }
      if (!inventoryAccount) {
        inventoryAccount = await JournalService.getMappedAccountCode(
          companyId,
          'purchases',
          'inventory',
          DEFAULT_ACCOUNTS.inventory,
          { productId, warehouseId: sourceWarehouse },
        );
      }
      journalLines.push(JournalService.createCreditLine(
        inventoryAccount || DEFAULT_ACCOUNTS.inventory,
        amount,
        `Inventory returned - ${pr.referenceNo}`,
      ));
    }

    inventoryCostTotal = Math.round((inventoryCostTotal + Number.EPSILON) * 100) / 100;
    const returnPriceVariance = Number((returnTotals.subtotal - inventoryCostTotal).toFixed(2));
    if (returnPriceVariance !== 0) {
      const purchaseReturnsAcct = await JournalService.getMappedAccountCode(
        companyId,
        'purchases',
        'purchaseReturns',
        DEFAULT_ACCOUNTS.purchaseReturns,
      );
      journalLines.push(returnPriceVariance > 0
        ? JournalService.createCreditLine(purchaseReturnsAcct, returnPriceVariance, `Purchase return price variance - ${pr.referenceNo}`)
        : JournalService.createDebitLine(purchaseReturnsAcct, Math.abs(returnPriceVariance), `Purchase return price variance - ${pr.referenceNo}`));
    }

    // Post journal
    const supplier = await (require('../models/Supplier')).findById(pr.supplier).lean();
    const narration = `Purchase Return - ${supplier ? supplier.name : ''} - ${isDirectPurchase ? 'Purchase' : 'GRN'}#${sourceReference} - PRN#${pr.referenceNo}`;

    let je;
    try {
      je = await JournalService.createEntry(companyId, req.user.id, {
        date: new Date(),
        description: narration,
        sourceType: 'purchase_return',
        sourceId: pr._id,
        sourceReference: pr.referenceNo,
        lines: journalLines,
        isAutoGenerated: true,
        session: useSession ? sess : null
      });

      pr.journalEntry = je._id;
      pr.status = 'confirmed';
      pr.confirmedBy = req.user.id;
      pr.confirmedAt = new Date();
      pr.totalAmount = returnTotals.totalAmount;
      // Reverse the project/budget actual recognized when these goods were
      // received. Supplier cash refunds and credit settlement do not create a
      // second project actual; this is tied to the accepted physical return.
      const BudgetService = require('../services/budgetService');
      for (const line of pr.lines || []) {
        const returnedSourceLine = isDirectPurchase
          ? (purchase.items || []).find((item) => idOf(item._id || item.id) === idOf(line.purchaseLine))
          : grn.lines.id(line.grnLine);
        const poLine = !isDirectPurchase && returnedSourceLine?.purchaseOrderLine && grn.purchaseOrder
          ? await PurchaseOrder.findOne({ _id: grn.purchaseOrder, company: companyId }).then(po => po ? po.lines.id(returnedSourceLine.purchaseOrderLine) : null)
          : null;
        const budgetLineId = isDirectPurchase ? returnedSourceLine?.budget_line_id : poLine?.budget_line_id;
        if (!budgetLineId) continue;
        const rate = Number(isDirectPurchase ? returnedSourceLine.taxRate : poLine.taxRate) || 0;
        const amount = Number((Number(line.qtyReturned || 0) * Number(line.unitCost || 0) * (1 + rate / 100)).toFixed(2));
        await BudgetService.reverseActualConsumptionToLine({
          companyId, budgetLineId, amount,
          document_id: pr._id, document_number: pr.referenceNo,
          source_id: pr._id, source_number: pr.referenceNo,
          created_by: req.user.id,
          notes: `Accepted supplier return ${pr.referenceNo} against ${isDirectPurchase ? 'purchase' : 'GRN'} ${sourceReference}`,
        });
      }
      await pr.save(opts);
      await require('../services/apTrackingService').recordPurchaseReturn(pr, req.user.id);

      return pr;
    } catch (jeErr) {
      // If we're inside a real transaction the DB will rollback when the transaction fails.
      // If not (no session support), perform manual rollback of created resources.
      if (!useSession) {
        try {
          // remove created stock movements
          if (createdMovements.length) await StockMovement.deleteMany({ _id: { $in: createdMovements } });
          // restore modified batches
          for (const b of modifiedBatches) {
            try {
              await InventoryBatch.findByIdAndUpdate(b.id, { $set: { availableQuantity: b.prevAvailable } });
            } catch (e) { /* best-effort */ }
          }
          for (const b of modifiedStockBatches) {
            try {
              await StockBatch.findByIdAndUpdate(b.id, { $set: { qtyOnHand: b.qtyOnHand } });
            } catch (e) { /* best-effort */ }
          }
          for (const serial of modifiedSerials) {
            try {
              await StockSerialNumber.findByIdAndUpdate(serial.id, {
                $set: {
                  status: serial.status,
                  returnedVia: serial.returnedVia,
                  returnedAt: serial.returnedAt,
                },
              });
            } catch (e) { /* best-effort */ }
          }
          // restore modified products
          for (const [pid, vals] of modifiedProducts.entries()) {
            try {
              await Product.findByIdAndUpdate(pid, { $set: { currentStock: vals.prevStock, averageCost: vals.prevAvg } });
            } catch (e) { /* best-effort */ }
          }
        } catch (rbErr) {
          console.error('Rollback failed after journal error', rbErr);
        }
      }
      throw jeErr;
    }
  };

  try {
    const result = await transactionService.runInTransaction(async (trx) => await doConfirm(trx));

    // Confirming a purchase return reduces Product.currentStock directly
    // (not through /api/products or /api/stock/*), so the route-level cache
    // invalidation middleware on those routes never fires for it. Without
    // this, the browse stock/product caches would keep serving the
    // pre-return quantity for up to their TTL.
    try {
      await cacheService.bumpCompanyStockCaches(companyId);
      await cacheService.bumpCompanyFinancialCaches(companyId);
      await cacheService.invalidateByCompany(companyId, 'report');
    } catch (cacheErr) {
      console.error('Cache invalidation after purchase return confirm failed:', cacheErr);
    }
    require('../lib/realtimeEvents').emitDataChanged(companyId, 'purchase_return', {
      affectsStock: true,
      affectsFinance: true,
    });

    // Send email notification
    if (req.body.sendEmail) {
      const confirmedPR = await PurchaseReturn.findById(result._id).populate('grn').populate('purchase');
      const company = await Company.findById(companyId);
      const grn = confirmedPR.grn
        ? await GoodsReceivedNote.findById(confirmedPR.grn)
        : null;
      const purchase = confirmedPR.purchase
        ? await Purchase.findById(confirmedPR.purchase)
        : null;
      const supplier = await Supplier.findById(grn?.supplier || purchase?.supplier);
      await sendPurchaseReturnEmail(confirmedPR, company, supplier, 'confirmed');
    }
    
    res.json({ success: true, message: 'Purchase return confirmed', data: await PurchaseReturn.findById(result._id) });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ success: false, message: err.message });
    next(err);
  }
};

exports.listPurchaseReturns = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const q = { company: companyId };
    const { supplier_id, grn_id, purchase_id, purchase_order_id, status, date_from, date_to } = req.query;
    if (supplier_id) q.supplier = supplier_id;
    if (grn_id) q.grn = grn_id;
    if (purchase_id) q.purchase = purchase_id;
    if (purchase_order_id) {
      const sourceGrns = await GoodsReceivedNote.find({
        company: companyId,
        purchaseOrder: purchase_order_id,
      });
      q.grn = { $in: sourceGrns.map((grn) => grn._id) };
    }
    if (status) q.status = status;
    if (date_from || date_to) q.returnDate = {};
    if (date_from) q.returnDate.$gte = new Date(date_from);
    if (date_to) q.returnDate.$lte = new Date(date_to);

    const { page, limit, skip } = parsePagination(req.query);
    const total = await PurchaseReturn.countDocuments(q);
    const list = await PurchaseReturn.find(q)
      .populate('grn', 'referenceNo')
      .populate('purchase', 'purchaseNumber')
      .populate('supplier', 'name code')
      .populate('warehouse', 'name code')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    res.json({
      success: true,
      data: list,
      pagination: paginationMeta(page, limit, total),
    });
  } catch (err) { next(err); }
};

exports.getPurchaseReturn = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const pr = await PurchaseReturn.findOne({ _id: req.params.id, company: companyId })
      .populate('grn', 'referenceNo')
      .populate('purchase', 'purchaseNumber')
      .populate('supplier', 'name code')
      .populate('warehouse', 'name code')
      .populate('lines.product', 'name sku')
      .populate('confirmedBy', 'name email')
      .populate('createdBy', 'name email')
      .populate('bankAccountId', 'name');
    if (!pr) return res.status(404).json({ success: false, message: 'Purchase return not found' });
    res.json({ success: true, data: pr });
  } catch (err) { next(err); }
};

// Draft returns have no stock or accounting impact, so they can be safely removed.
exports.deletePurchaseReturn = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const purchaseReturn = await PurchaseReturn.findOne({ _id: req.params.id, company: companyId });
    if (!purchaseReturn) {
      return res.status(404).json({ success: false, message: 'Purchase return not found' });
    }
    if (purchaseReturn.status !== 'draft') {
      return res.status(409).json({ success: false, message: 'Only draft purchase returns can be deleted' });
    }

    await PurchaseReturn.findOneAndDelete({ _id: req.params.id, company: companyId });
    res.json({ success: true, message: 'Draft purchase return deleted successfully' });
  } catch (err) { next(err); }
};

// Get summary of purchase returns
exports.getPurchaseReturnSummary = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { startDate, endDate } = req.query;
    
    const match = { company: companyId };
    if (startDate || endDate) {
      match.returnDate = {};
      if (startDate) match.returnDate.$gte = new Date(startDate);
      if (endDate) match.returnDate.$lte = new Date(endDate);
    }
    
    const summary = await PurchaseReturn.aggregate([
      { $match: match },
      { $group: {
        _id: '$status',
        count: { $sum: 1 },
        totalAmount: { $sum: '$totalAmount' }
      }}
    ]);
    
    const result = {
      total: summary.reduce((s, g) => s + g.count, 0),
      byStatus: summary
    };
    
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
};

// Process refund for purchase return
exports.processRefund = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { id } = req.params;
    const { refundMethod, bankAccountId, reference } = req.body || {};
    const result = await transactionService.runInTransaction(async (trx) => {
      await lockPurchaseReturn(trx, id, companyId);
      const query = PurchaseReturn.findOne({ _id: id, company: companyId });
      const pr = trx ? await query.session(trx) : await query;
      if (!pr) throw Object.assign(new Error('Purchase return not found'), { status: 404 });
      if (pr.status !== 'confirmed') {
        throw Object.assign(new Error('Can only settle confirmed returns'), { status: 409 });
      }
      if (pr.refundMethod && pr.refundMethod !== 'none') {
        throw Object.assign(new Error('Supplier settlement already recorded'), { status: 409 });
      }

      const refundAmt = Number(pr.totalAmount) || 0;
      if (refundAmt <= 0) throw Object.assign(new Error('No amount to settle'), { status: 400 });
      if (!['credit', 'bank_transfer', 'cash'].includes(refundMethod)) {
        throw Object.assign(new Error('Invalid refund method'), { status: 400 });
      }
      if (refundMethod === 'bank_transfer' && !bankAccountId) {
        throw Object.assign(new Error('Bank account required for bank transfer'), { status: 400 });
      }

      const now = new Date();
      let debitAccount;
      let bankAccount;
      if (refundMethod === 'bank_transfer') {
        await lockBankAccount(trx, bankAccountId, companyId);
        const bankQuery = require('../models/BankAccount').BankAccount.findOne({
          _id: bankAccountId,
          company: companyId,
          isActive: true,
        });
        bankAccount = trx ? await bankQuery.session(trx) : await bankQuery;
        if (!bankAccount) throw Object.assign(new Error('Invalid or inactive bank account'), { status: 400 });
        debitAccount = bankAccount.ledgerAccountId
          || await JournalService.getMappedAccountCode(
            companyId,
            'cash',
            'cashAtBank',
            DEFAULT_ACCOUNTS.cashAtBank || '1100',
          );
      } else if (refundMethod === 'cash') {
        debitAccount = await JournalService.getMappedAccountCode(
          companyId,
          'cash',
          'cashOnHand',
          DEFAULT_ACCOUNTS.cashOnHand || '1000',
        );
      }

      if (refundMethod !== 'credit') {
        const apAccount = await JournalService.getMappedAccountCode(
          companyId,
          'purchases',
          'accountsPayable',
          DEFAULT_ACCOUNTS.accountsPayable,
        );
        const je = await JournalService.createEntry(companyId, req.user.id, {
          date: now,
          description: `Supplier refund received for purchase return ${pr.referenceNo}`,
          sourceType: 'purchase_return_refund',
          sourceId: pr._id,
          sourceReference: pr.referenceNo,
          lines: [
            JournalService.createDebitLine(debitAccount, refundAmt, `Refund received - PRN#${pr.referenceNo}`),
            JournalService.createCreditLine(apAccount, refundAmt, `Settle supplier credit - PRN#${pr.referenceNo}`),
          ],
          isAutoGenerated: true,
          session: trx || null,
        });
        pr.refundJournalEntry = je._id;

        if (refundMethod === 'bank_transfer') {
          const bankTransaction = await bankAccount.addTransaction({
            type: 'deposit',
            amount: refundAmt,
            description: `Purchase return refund - PRN#${pr.referenceNo}`,
            date: now,
            referenceNumber: reference || pr.referenceNo,
            paymentMethod: 'bank_transfer',
            status: 'completed',
            reference: pr._id,
            referenceType: 'PurchaseReturn',
            sourceDocumentType: 'purchase_return_refund',
            sourceDocumentId: pr._id,
            sourceReference: pr.referenceNo,
            journalEntryId: je._id,
            createdBy: req.user.id,
            notes: `Supplier refund for purchase return ${pr.referenceNo}`,
          });
          pr.refundBankTransaction = bankTransaction._id;
        }
      }

      pr.refundMethod = refundMethod;
      pr.bankAccountId = refundMethod === 'bank_transfer' ? bankAccountId : null;
      pr.bankRefundReference = String(reference || '').trim() || null;
      pr.refundedAt = refundMethod === 'credit' ? null : now;
      await pr.save({ session: trx || null });
      if (refundMethod !== 'credit') {
        await require('../services/apTrackingService').recordPurchaseReturnRefund(pr, req.user.id);
      }
      return pr;
    });

    // Send email notification for refund
    if (req.body?.sendEmail) {
      const company = await Company.findById(companyId);
      const grn = result.grn ? await GoodsReceivedNote.findById(result.grn) : null;
      const purchase = result.purchase ? await Purchase.findById(result.purchase) : null;
      const supplier = await Supplier.findById(grn?.supplier || purchase?.supplier);
      await sendPurchaseReturnEmail(result, company, supplier, 'refunded');
    }

    try {
      await cacheService.bumpCompanyFinancialCaches(companyId);
      await cacheService.invalidateByCompany(companyId, 'report');
    } catch (cacheErr) {
      console.error('Cache invalidation after purchase return settlement failed:', cacheErr);
    }
    require('../lib/realtimeEvents').emitDataChanged(companyId, 'purchase_return', {
      affectsFinance: true,
    });

    res.json({ success: true, message: 'Supplier settlement recorded successfully', data: result });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ success: false, message: err.message });
    next(err);
  }
};
