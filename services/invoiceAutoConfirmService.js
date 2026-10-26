/**
 * Shared draft → confirmed invoice flow for recurring invoices and other automations.
 */

const Invoice = require('../models/Invoice');
const Product = require('../models/Product');
const { loadLineProducts, getLineProduct } = require('../utils/lineProducts');
const Client = require('../models/Client');
const StockMovement = require('../models/StockMovement');
const JournalService = require('./journalService');
const TaxAutomationService = require('./taxAutomationService');
const warehouseService = require('./warehouseService');
const stockValidationService = require('./stockValidationService');
const cacheService = require('./cacheService');
const EBMSalesService = require('./ebmSalesService');
const { prisma } = require('../lib/prisma');
const { resolveCogsUnitCost } = require('../utils/productCost');
const { notifyPaymentReceived } = require('./notificationHelper');
const { runInTransaction } = require('./transactionService');
const { dbClient } = require('../lib/prisma');

function confirmError(code, message, statusCode = 409) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  throw err;
}

async function confirmDraftInvoiceInTransaction(companyId, invoiceId, userId) {
  const invoice = await Invoice.findOne({ _id: invoiceId, company: companyId })
    .populate('lines.product client');

  if (!invoice) confirmError('ERR_INVOICE_NOT_FOUND', 'Invoice not found', 404);
  if (invoice.status !== 'draft') {
    confirmError('ERR_INVOICE_CONFIRMED', 'Invoice is not in draft status', 409);
  }
  if (!invoice.lines || invoice.lines.length === 0) {
    confirmError('ERR_EMPTY_INVOICE', 'Invoice must have at least one line item before confirming', 400);
  }

  const claim = await dbClient().invoice.updateMany({
    where: { id: String(invoice._id), companyId: String(companyId), status: 'draft' },
    data: { status: 'processing' },
  });
  if (claim.count !== 1) confirmError('ERR_INVOICE_CONFIRMED', 'Invoice is already being confirmed or is no longer a draft.', 409);

  const DeliveryNote = require('../models/DeliveryNote');
  const deliveryNote = await DeliveryNote.findOne({
    invoice: invoice._id,
    company: companyId,
    status: 'confirmed',
  });
  if (deliveryNote) {
    confirmError(
      'ERR_DELIVERY_EXISTS',
      'Cannot confirm invoice. A confirmed delivery note already exists for this invoice.',
      409,
    );
  }
  const pendingDeliveryNote = await DeliveryNote.findOne({
    invoice: invoice._id,
    company: companyId,
    status: 'draft',
  });
  const deliveryNoteLinesByInvoiceLineId = new Map(
    (pendingDeliveryNote?.lines || [])
      .filter((line) => line.invoiceLineId)
      .map((line) => [String(line.invoiceLineId), line]),
  );
  const deliveryNoteHandlesStock = Boolean(pendingDeliveryNote);

  let totalInvoiceCOGS = 0;
  let hasStockableLines = false;

  // One query for every line's product instead of one per line.
  const autoConfirmProducts0 = await loadLineProducts(Product, invoice.lines, companyId);
  for (const line of invoice.lines) {
    const product = getLineProduct(autoConfirmProducts0, line);
    if (!product) confirmError('ERR_PRODUCT_NOT_FOUND', `Product not found: ${line.product.name}`, 400);
    if (product.isActive === false) {
      confirmError('ERR_INACTIVE_PRODUCT', `Product ${product.name} is inactive`, 400);
    }

    const qty = line.qty || line.quantity || 0;
    if (qty <= 0) confirmError('ERR_INVALID_LINE_QTY', 'Line quantity must be greater than 0', 400);
    if ((line.unitPrice || 0) < 0) confirmError('ERR_INVALID_UNIT_PRICE', 'Unit price cannot be negative', 400);

    const isStockable = product.isStockable !== false;
    if (isStockable) {
      if (product.trackingType && product.trackingType !== 'none') {
        const deliveryLine = deliveryNoteLinesByInvoiceLineId.get(String(line._id));
        const deliveredQty = Number(deliveryLine?.qtyToDeliver || 0);
        const matchesInvoiceQty = Math.abs(deliveredQty - Number(qty)) < 0.0001;
        const hasTraceability = product.trackingType === 'batch'
          ? Boolean(deliveryLine?.batchId)
          : product.trackingType === 'serial'
            && Array.isArray(deliveryLine?.serialNumbers)
            && deliveryLine.serialNumbers.length === deliveredQty
            && new Set(deliveryLine.serialNumbers.map(String)).size === deliveredQty;
        if (!deliveryNoteHandlesStock || !matchesInvoiceQty || !hasTraceability) {
          confirmError(
            'ERR_TRACEABILITY_REQUIRED',
            `Traceability is required for ${product.name}. Create a draft Delivery Note from this invoice, assign the batch or serial number during picking, then confirm the invoice.`,
            409,
          );
        }
      }
      hasStockableLines = true;
      const unitCost = await resolveCogsUnitCost(product, companyId);
      if (unitCost === 0) {
        confirmError(
          'ERR_COST_LOOKUP_FAILED',
          `COGS cost lookup failed for product ${product.name}. A stockable product with zero cost is a data integrity problem.`,
          500,
        );
      }

      const cogsAmount = qty * unitCost;
      totalInvoiceCOGS += cogsAmount;
      line.unitCost = unitCost;
      line.cogsAmount = cogsAmount;

      if (!deliveryNoteHandlesStock) {
        const warehouseId = line.warehouse || product.defaultWarehouse;
        let availableQty = 0;
        if (warehouseId) {
          const stockLevel = await warehouseService.getStockLevel(companyId, product._id, warehouseId);
          availableQty = stockLevel.qty_available || 0;
        } else {
          availableQty = product.currentStock || 0;
        }

        if (availableQty < qty) {
          confirmError(
            'ERR_INSUFFICIENT_STOCK',
            `Insufficient stock for ${product.name}. Available: ${availableQty}, Required: ${qty}`,
            409,
          );
        }

        try {
          await stockValidationService.reserveForOrder(companyId, product._id, qty, warehouseId);
        } catch (reserveErr) {
          confirmError(
            'ERR_INSUFFICIENT_STOCK',
            reserveErr.message || `Failed to reserve stock for ${product.name}`,
            409,
          );
        }
      }
    } else {
      line.unitCost = 0;
      line.cogsAmount = 0;
    }
  }

  for (const line of invoice.lines) {
    await prisma.invoiceLine.update({
      where: { id: String(line._id) },
      data: {
        unitCost: line.unitCost ?? 0,
        cogsAmount: line.cogsAmount ?? 0,
      },
    });
  }

  const taxLines = invoice.lines.map((line) => {
    const lineQty = line.qty || line.quantity || 0;
    const lineUnitPrice = line.unitPrice || 0;
    const lineSubtotal = Number(line.lineSubtotal ?? (lineQty * lineUnitPrice));
    const discountPct = Number(line.discountPct ?? 0);
    const lineNet = Math.round((lineSubtotal * (1 - discountPct / 100) + Number.EPSILON) * 100) / 100;
    return {
      netAmount: lineNet,
      taxRatePct: line.taxRate || 0,
      productId: line.product?._id || line.product,
    };
  });

  const salesTax = await TaxAutomationService.computeSalesTax(
    companyId,
    taxLines,
    invoice.invoiceDate,
  );

  try {
    const revenueEntry = await JournalService.createEntry(companyId, userId, {
      date: invoice.invoiceDate,
      description: `Invoice ${invoice.referenceNo || invoice.invoiceNumber} - Revenue Recognition`,
      sourceType: 'invoice',
      sourceId: invoice._id,
      sourceReference: invoice.referenceNo || invoice.invoiceNumber,
      lines: salesTax.journalLines,
      isAutoGenerated: true,
      sourceData: {
        vatAmount: salesTax.totals.tax,
        netAmount: salesTax.totals.net,
        grossAmount: salesTax.totals.gross,
        taxBreakdown: salesTax.lines,
      },
    });
    invoice.revenueJournalEntry = revenueEntry._id;
  } catch (journalError) {
    throw new Error(`Invoice revenue journal could not be created: ${journalError.message}`);
  }

  if (hasStockableLines && totalInvoiceCOGS > 0) {
    try {
      const cogsEntry = await JournalService.createCOGSEntry(companyId, userId, {
        invoiceId: invoice._id,
        invoiceNumber: invoice.referenceNo || invoice.invoiceNumber,
        clientName: invoice.client?.name || 'Unknown Client',
        date: invoice.invoiceDate,
        totalCost: totalInvoiceCOGS,
        lines: invoice.lines
          .filter((l) => l.cogsAmount > 0)
          .map((l) => ({
            productId: l.product._id,
            cogsAmount: l.cogsAmount,
          })),
      });
      invoice.cogsJournalEntry = cogsEntry._id;
    } catch (journalError) {
      throw new Error(`Invoice COGS journal could not be created: ${journalError.message}`);
    }
  }

  // One query for every line's product instead of one per line.
  const autoConfirmProducts1 = await loadLineProducts(Product, invoice.lines, companyId);
  if (!deliveryNoteHandlesStock) {
    for (const line of invoice.lines) {
      const product = getLineProduct(autoConfirmProducts1, line);
      if (product && product.isStockable) {
        const qty = line.qty || line.quantity || 0;
        if (qty > 0) {
          const warehouseId = line.warehouse || product.defaultWarehouse || null;
          const stockCommit = await warehouseService.commitReservedStock(
            companyId,
            product._id,
            warehouseId,
            qty,
          );
          const newStock = Number(stockCommit.currentStock);
          const previousStock = newStock + Number(qty);
          await StockMovement.create({
            company: companyId,
            product: product._id,
            type: 'out',
            reason: 'sale',
            quantity: qty,
            previousStock,
            newStock,
            unitCost: line.unitCost || 0,
            totalCost: line.cogsAmount || 0,
            referenceType: 'invoice',
            referenceNumber: invoice.referenceNo || invoice.invoiceNumber,
            referenceDocument: invoice._id,
            referenceModel: 'Invoice',
            notes: `Invoice ${invoice.referenceNo || invoice.invoiceNumber} - Sale`,
            performedBy: userId,
            movementDate: new Date(),
          });
          await dbClient().product.updateMany({
            where: { id: String(product._id), companyId: String(companyId) },
            data: { lastSaleDate: new Date() },
          });
        }
      }
    }
  }

  await Invoice.findByIdAndUpdate(invoice._id, {
    status: 'confirmed',
    stockDeducted: hasStockableLines && !deliveryNoteHandlesStock,
    confirmedAt: new Date(),
    confirmedBy: userId,
    revenueJournalEntry: invoice.revenueJournalEntry,
    cogsJournalEntry: invoice.cogsJournalEntry,
  });

  const client = await Client.findOne({ _id: invoice.client, company: companyId });
  if (client) {
    await dbClient().client.updateMany({
      where: { id: String(client._id), companyId: String(companyId) },
      data: { outstandingBalance: { increment: Number(invoice.totalAmount || invoice.grandTotal || 0) } },
    });
  }

  if (invoice.quotation) {
    const Quotation = require('../models/Quotation');
    await Quotation.findByIdAndUpdate(invoice.quotation, {
      status: 'converted',
      convertedToInvoice: invoice._id,
      conversionDate: new Date(),
    });
  }

  return Invoice.findOne({ _id: invoice._id, company: companyId })
    .populate('client lines.product createdBy');
}

async function confirmDraftInvoice(companyId, invoiceId, userId, { submitEbm = true } = {}) {
  const invoice = await runInTransaction(() =>
    confirmDraftInvoiceInTransaction(companyId, invoiceId, userId));

  try {
    await notifyPaymentReceived(companyId, invoice, 0);
  } catch (error) {
    console.error('Invoice notification failed after commit:', error);
  }
  try {
    await cacheService.bumpCompanyFinancialCaches(companyId);
  } catch (error) {
    console.error('Invoice cache invalidation failed after commit:', error);
  }

  if (!submitEbm) return invoice;
  try {
    return await EBMSalesService.submitInvoice(invoice._id, { companyId, modifierUserId: userId });
  } catch (error) {
    console.error('EBM sales submission failed after invoice confirmation:', error.message);
    return error.invoice || Invoice.findOne({ _id: invoice._id, company: companyId })
      .populate('client lines.product createdBy');
  }
}

module.exports = { confirmDraftInvoice };
