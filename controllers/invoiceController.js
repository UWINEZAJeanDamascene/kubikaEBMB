const Invoice = require("../models/Invoice");
const DeliveryNote = require("../models/DeliveryNote");
const SalesOrder = require("../models/SalesOrder");
const Product = require("../models/Product");
const Client = require("../models/Client");
const Project = require("../models/Project");
const StockMovement = require("../models/StockMovement");
const InvoiceReceiptMetadata = require("../models/InvoiceReceiptMetadata");
const PDFDocument = require("pdfkit");
const notificationService = require("../services/notificationHelper");
const emailService = require("../services/emailService");
const Company = require("../models/Company");
const cacheService = require("../services/cacheService");
const { loadLineProducts, getLineProduct } = require("../utils/lineProducts");
const JournalService = require("../services/journalService");
const { runInTransaction } = require("../services/transactionService");
const { dbClient } = require("../lib/prisma");
const { generateObjectId } = require("../utils/objectId");
const { DEFAULT_ACCOUNTS } = require("../constants/chartOfAccounts");
const { buildInvoiceTaxCorrection } = require("../utils/invoiceDeliveryNoteTax");
const { parseBoundedPage } = require("../utils/querySafety");
const { consumeApproval: consumePosManagerApproval } = require('./posManagerApprovalController');
const {
  drawEbmCertificationBlock,
  drawTaxBreakdown,
  formatMoney,
  formatReceiptDate,
  generateQrPng,
  lineTaxDetails,
} = require("../utils/pdfUtils");

const {
  notifyInvoiceCreated,
  notifyPaymentReceived,
  notifyPaymentOverdue,
  notifyInvoiceSent,
} = require("../services/notificationHelper");

const normalizeId = (value) => {
  if (!value) return null;
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return String(value._id || value.id || value);
};

async function validateInvoiceProjectAssignments(lines, companyId, clientId) {
  const ids = [...new Set((lines || []).map((line) => normalizeId(line.projectId || line.project_id)).filter(Boolean))];
  if (!ids.length) return;
  const projects = await Project.find({
    _id: { $in: ids },
    company_id: companyId,
    is_template: false,
    is_active: true,
  });
  if (projects.length !== ids.length) {
    throw Object.assign(new Error("One or more invoice lines reference a project that is unavailable in this company."), { statusCode: 400 });
  }
  for (const project of projects) {
    const linkedClientId = normalizeId(project.client_id);
    if (linkedClientId && linkedClientId !== normalizeId(clientId)) {
      throw Object.assign(new Error(`Project ${project.name} belongs to a different client.`), { statusCode: 400 });
    }
  }
}

async function hydrateInvoiceRelations(docOrDocs, companyId) {
  const docs = Array.isArray(docOrDocs) ? docOrDocs : [docOrDocs];
  const valid = docs.filter(Boolean);
  if (!valid.length) return docOrDocs;

  const clientIds = [...new Set(valid.map((doc) => normalizeId(doc.client)).filter(Boolean))];
  const userIds = [...new Set(valid.flatMap((doc) => [doc.createdBy, doc.confirmedBy, doc.cancelledBy, doc.updatedBy].map(normalizeId)).filter(Boolean))];
  const productIds = [...new Set(valid.flatMap((doc) => (doc.lines || []).map((line) => normalizeId(line.product)).filter(Boolean)))];
  const quotationIds = [...new Set(valid.map((doc) => normalizeId(doc.quotation)).filter(Boolean))];
  const warehouseIds = [...new Set(valid.flatMap((doc) => (doc.lines || []).map((line) => normalizeId(line.warehouse)).filter(Boolean)))];

  const tenantFilter = companyId ? { company: companyId } : {};
  const [clients, users, products, quotations, warehouses] = await Promise.all([
    clientIds.length ? Client.find({ ...tenantFilter, _id: { $in: clientIds } }, 'name code contact type taxId').limit(clientIds.length).lean() : [],
    userIds.length ? require('../models/User').find({ _id: { $in: userIds } }, 'name email').limit(userIds.length).lean() : [],
    productIds.length ? Product.find({ ...tenantFilter, _id: { $in: productIds } }, 'name sku unit').limit(productIds.length).lean() : [],
    quotationIds.length ? require('../models/Quotation').find({ ...tenantFilter, _id: { $in: quotationIds } }, 'referenceNo').limit(quotationIds.length).lean() : [],
    warehouseIds.length ? require('../models/Warehouse').find({ ...tenantFilter, _id: { $in: warehouseIds } }, 'name code').limit(warehouseIds.length).lean() : [],
  ]);

  const clientMap = new Map(clients.map((client) => [normalizeId(client._id), client]));
  const userMap = new Map(users.map((user) => [normalizeId(user._id), user]));
  const productMap = new Map(products.map((product) => [normalizeId(product._id), product]));
  const quotationMap = new Map(quotations.map((quotation) => [normalizeId(quotation._id), quotation]));
  const warehouseMap = new Map(warehouses.map((warehouse) => [normalizeId(warehouse._id), warehouse]));

  for (const doc of valid) {
    const clientId = normalizeId(doc.client);
    if (clientId && clientMap.has(clientId)) doc.client = clientMap.get(clientId);
    const createdById = normalizeId(doc.createdBy);
    if (createdById && userMap.has(createdById)) doc.createdBy = userMap.get(createdById);
    const quotationId = normalizeId(doc.quotation);
    if (quotationId && quotationMap.has(quotationId)) doc.quotation = quotationMap.get(quotationId);
    for (const line of doc.lines || []) {
      const pid = normalizeId(line.product);
      if (pid && productMap.has(pid)) line.product = productMap.get(pid);
      if (line.warehouse) {
        const wid = normalizeId(line.warehouse);
        if (wid && warehouseMap.has(wid)) line.warehouse = warehouseMap.get(wid);
      }
    }
    if (doc.payments) {
      for (const payment of doc.payments) {
        const recordedById = normalizeId(payment.recordedBy);
        if (recordedById && userMap.has(recordedById)) payment.recordedBy = userMap.get(recordedById);
      }
    }
  }

  return Array.isArray(docOrDocs) ? valid : valid[0];
}

// @desc    Get all invoices
// @route   GET /api/invoices
// @access  Private
exports.getInvoices = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { page, limit, skip } = parseBoundedPage(req.query, { defaultLimit: 20, maxLimit: 100 });
    const {
      status,
      clientId,
      startDate,
      endDate,
      date_from,
      date_to,
      ebmStatus,
      expiry_before,
      quotation_id,
    } = req.query;
    const query = { company: companyId };

    // Status filter - support both old and new status names, and comma-separated list
    if (status) {
      // Check if status contains comma (multiple statuses)
      if (status.includes(",")) {
        const statuses = status.split(",").map((s) => s.trim());
        // Map old statuses to new
        const statusMap = {
          partial: "partially_paid",
          paid: "fully_paid",
        };
        const mappedStatuses = statuses.map((s) => statusMap[s] || s);
        query.status = { $in: mappedStatuses };
      } else {
        // Single status - Map old status to new
        const statusMap = {
          partial: "partially_paid",
          paid: "fully_paid",
        };
        query.status = statusMap[status] || status;
      }
    }

    if (clientId) {
      query.client = clientId;
    }

    if (ebmStatus) {
      query["ebm.ebmStatus"] = ebmStatus;
    }

    // Date filters - Module 6 naming
    if (startDate || endDate || date_from || date_to) {
      query.invoiceDate = {};
      const from = startDate || date_from;
      const to = endDate || date_to;
      if (from) query.invoiceDate.$gte = new Date(from);
      if (to) query.invoiceDate.$lte = new Date(to);
    }

    // Expiry/due date filter
    if (expiry_before) {
      query.dueDate = { $lte: new Date(expiry_before) };
    }

    // Quotation filter - Module 6 naming
    if (quotation_id) {
      query.quotation = quotation_id;
    }

    const total = await Invoice.countDocuments(query);
    const invoices = await Invoice.find(query)
      .select({ client: 1, createdBy: 1, quotation: 1, referenceNo: 1, status: 1, invoiceDate: 1, dueDate: 1, totalAmount: 1, amountPaid: 1, amountOutstanding: 1, company: 1, createdAt: 1 })
      .populate('-lines')
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit)
      .skip(skip)
      .lean();

    const hydratedInvoices = await hydrateInvoiceRelations(invoices, companyId);

    res.json({
      success: true,
      count: hydratedInvoices.length,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page,
      data: hydratedInvoices,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single invoice
// @route   GET /api/invoices/:id
// @access  Private
exports.getInvoice = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const invoice = await Invoice.findOne({
      _id: req.params.id,
      company: companyId,
    }).select({
      client: 1,
      lines: 1,
      createdBy: 1,
      quotation: 1,
      payments: 1,
      revenueJournalEntry: 1,
      cogsJournalEntry: 1,
      referenceNo: 1,
      status: 1,
      totalAmount: 1,
      amountPaid: 1,
      amountOutstanding: 1,
      currencyCode: 1,
      exchangeRate: 1,
      invoiceDate: 1,
      dueDate: 1,
      paidDate: 1,
      subtotal: 1,
      taxAmount: 1,
      totalAEx: 1,
      totalB18: 1,
      totalDiscount: 1,
      ebm: 1,
      terms: 1,
      notes: 1,
      company: 1,
    }).lean();

    const hydratedInvoice = await hydrateInvoiceRelations(invoice, companyId);

    if (!hydratedInvoice) {
      return res.status(404).json({
        success: false,
        message: "Invoice not found",
      });
    }

    const fiscalMode = String(hydratedInvoice.ebm?.fiscalEnvironment || '').toLowerCase();
    const fiscalQr = fiscalMode === 'production' && hydratedInvoice.ebm?.ebmStatus === 'submitted'
      ? await generateQrPng(hydratedInvoice.ebm, { width: 164 })
      : null;
    if (fiscalQr) {
      hydratedInvoice.ebm = {
        ...hydratedInvoice.ebm,
        qrCodeDataUrl: `data:image/png;base64,${fiscalQr.toString('base64')}`,
      };
    }

    // Get receipt metadata if exists
    const receiptMetadata = await InvoiceReceiptMetadata.findOne({
      invoice: invoice._id,
      company: companyId,
    });

    res.json({
      success: true,
      data: {
        ...hydratedInvoice,
        receiptMetadata,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create new invoice (draft)
// @route   POST /api/invoices
// @access  Private (admin, stock_manager, sales)
exports.createInvoice = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const {
      lines, // Module 6 naming
      items, // Legacy naming
      client: clientId,
      quotation,
      currencyCode, // Module 6 naming
      currency, // Legacy naming
      exchangeRate,
      paymentTerms,
      customerTin,
      customerAddress,
      customerName,
      dueDate,
      invoiceDate,
    } = req.body;

    // Support both lines (Module 6) and items (legacy)
    const invoiceLines = lines || items;
    const currencyVal = String(currencyCode || currency || "RWF").trim().toUpperCase();

    if (!Array.isArray(invoiceLines) || invoiceLines.length === 0) {
      return res.status(400).json({ success: false, code: "ERR_INVALID_INVOICE", message: "A customer and at least one invoice line are required." });
    }

    // Get client details for TIN and address
    const client = await Client.findOne({ _id: clientId, company: companyId });
    if (!client) {
      return res.status(404).json({
        success: false,
        message: "Client not found",
      });
    }

    await validateInvoiceProjectAssignments(invoiceLines, companyId, clientId);

    // Validate products and check stock.
    //
    // Products are fetched in ONE query rather than one per line. This loop
    // previously issued a findOne per invoice line, so a 20-line invoice cost
    // 20 sequential round-trips — several seconds against a remote database,
    // paid on every invoice creation. Validation below is unchanged: the lines
    // are still walked in order and the first failure still wins, so error
    // messages and their precedence are identical.
    const productMap = {};
    const lineProductIds = [...new Set(
      invoiceLines.map((line) => line.product).filter(Boolean).map((id) => id.toString()),
    )];
    const fetchedProducts = lineProductIds.length
      ? await Product.find({ _id: { $in: lineProductIds }, company: companyId })
      : [];
    const productsById = new Map(fetchedProducts.map((p) => [p._id.toString(), p]));

    for (const line of invoiceLines) {
      const product = line.product ? productsById.get(line.product.toString()) : null;
      if (!product) {
        return res.status(400).json({
          success: false,
          message: `Product not found: ${line.product}`,
        });
      }
      // Validate product is active
      if (product.isActive === false) {
        return res.status(400).json({
          success: false,
          code: "ERR_INACTIVE_PRODUCT",
          message: `Product ${product.name} is inactive`,
        });
      }
      productMap[line.product.toString()] = product;
      const qty = Number(line.qty ?? line.quantity);
      const unitPrice = Number(line.unitPrice);
      const discountPct = Number(line.discountPct ?? line.discount ?? 0);
      const taxRate = Number(line.taxRate ?? product.taxRate ?? 0);
      if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0 || !Number.isFinite(discountPct) || discountPct < 0 || discountPct > 100 || !Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) {
        return res.status(400).json({ success: false, code: "ERR_INVALID_INVOICE_LINE", message: `Invoice line for ${product.name} has an invalid quantity, price, discount, or tax rate.` });
      }
    }

    // Process lines with tax codes
    const processedLines = invoiceLines.map((line, index) => {
      const qty = Number(line.qty ?? line.quantity);
      const unitPrice = Number(line.unitPrice);
      const discountPct = Number(line.discountPct ?? line.discount ?? 0);
      const subtotal = qty * unitPrice;
      const discountAmount = subtotal * (discountPct / 100);
      const netAmount = subtotal - discountAmount;
      const product = productMap[line.product.toString()];
      const taxRate =
        line.taxRate != null
          ? line.taxRate
          : product?.taxRate != null
            ? Number(product.taxRate)
            : 0;
      const taxCode = line.taxCode || product?.taxCode || "A";
      const taxAmount = Math.round((netAmount * (taxRate / 100) + Number.EPSILON) * 100) / 100;
      const totalWithTax = netAmount + taxAmount;

      return {
        ...line,
        projectId: normalizeId(line.projectId || line.project_id) || null,
        productName: line.productName || product?.name,
        productCode: line.productCode || line.itemCode || product?.sku,
        qty: qty,
        quantity: qty, // backwards compat
        discountPct: discountPct,
        discount: discountPct, // backwards compat
        taxCode,
        taxRate,
        lineSubtotal: subtotal,
        subtotal: subtotal, // backwards compat
        lineTax: taxAmount,
        taxAmount: taxAmount, // backwards compat
        lineTotal: totalWithTax,
        totalWithTax: totalWithTax, // backwards compat
        ...(line.warehouse && line.warehouse.toString() !== ""
          ? { warehouse: line.warehouse }
          : {}),
      };
    });

    const invoice = await Invoice.create({
      company: companyId,
      lines: processedLines,
      items: processedLines, // backwards compat
      client: clientId,
      quotation: quotation,
      currencyCode: currencyVal,
      exchangeRate: Number(exchangeRate) > 0 ? Number(exchangeRate) : 1,
      customerTin: customerTin || client.taxId,
      customerName: customerName || client.name,
      customerAddress: customerAddress || client.contact?.address,
      dueDate: dueDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // Default 30 days
      invoiceDate: invoiceDate || new Date(),
      createdBy: req.user.id || req.user._id,
      status: "draft",
      amountPaid: 0,
      amountOutstanding: processedLines.reduce((sum, line) => sum + Number(line.lineTotal || 0), 0),
      subtotal: processedLines.reduce((sum, line) => sum + Number(line.lineSubtotal || 0) - (Number(line.lineSubtotal || 0) * Number(line.discountPct || 0) / 100), 0),
      taxAmount: processedLines.reduce((sum, line) => sum + Number(line.lineTax || 0), 0),
      totalDiscount: processedLines.reduce((sum, line) => sum + (Number(line.lineSubtotal || 0) * Number(line.discountPct || 0) / 100), 0),
      totalAEx: processedLines.filter((line) => line.taxCode === "A").reduce((sum, line) => sum + (Number(line.lineSubtotal || 0) * (1 - Number(line.discountPct || 0) / 100)), 0),
      totalB18: processedLines.filter((line) => line.taxCode === "B").reduce((sum, line) => sum + (Number(line.lineSubtotal || 0) * (1 - Number(line.discountPct || 0) / 100)), 0),
    });

    // Atomically consume inventory layers, create stock movements, update product stock,
    // and post COGS + Sales journal entries using the central transaction helper.
    // Only deduct stock if autoConfirm is true (instant confirmation)
    const autoConfirm = req.body.autoConfirm || false;

    if (autoConfirm) {
      invoice = await require('../services/invoiceAutoConfirmService')
        .confirmDraftInvoice(companyId, invoice._id, req.user.id || req.user._id);
    }

    // Attempt to send invoice email to client if email exists
    const sendEmailOnCreate = req.body.sendEmail || false;
    if (sendEmailOnCreate) {
      try {
        const company = await Company.findById(companyId);
        const clientData = await Client.findById(clientId);
        await emailService.sendInvoiceEmail(invoice, company, clientData);
        try {
          await notifyInvoiceSent(companyId, invoice);
        } catch (e) {
          console.error("notifyInvoiceSent failed", e);
        }
      } catch (emailErr) {
        console.error("Invoice email error:", emailErr);
      }
    }

    // Notify invoice created
    try {
      await notifyInvoiceCreated(companyId, invoice);
    } catch (e) {
      console.error("notifyInvoiceCreated failed", e);
    }

    res.status(201).json({
      success: true,
      data: await hydrateInvoiceRelations(invoice, companyId),
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update invoice
// @route   PUT /api/invoices/:id
// @access  Private (admin, stock_manager, sales)
exports.updateInvoice = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    let invoice = await Invoice.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: "Invoice not found",
      });
    }

    // Only draft invoices can be updated - Module 6 Business Rule
    if (invoice.status !== "draft") {
      return res.status(409).json({
        success: false,
        code: "ERR_INVOICE_CONFIRMED",
        message:
          "Cannot edit invoice. Invoice is already confirmed. Cancel and create new instead.",
      });
    }

    // Support both lines (Module 6) and items (legacy)
    const lines = req.body.lines || req.body.items;
    if (lines !== undefined && (!Array.isArray(lines) || lines.length === 0)) {
      return res.status(400).json({ success: false, code: "ERR_EMPTY_INVOICE", message: "A draft invoice must contain at least one line." });
    }

    // If lines are updated, validate stock and products
    if (lines) {
      await validateInvoiceProjectAssignments(lines, companyId, req.body.client || invoice.client);
      // Validate products are active
      const __lineProducts1 = await loadLineProducts(Product, lines, companyId);
      for (const line of lines) {
        const product = getLineProduct(__lineProducts1, line);
        if (!product) {
          return res.status(400).json({
            success: false,
            message: `Product not found: ${line.product}`,
          });
        }
        if (product.isActive === false) {
          return res.status(400).json({
            success: false,
            code: "ERR_INACTIVE_PRODUCT",
            message: `Product ${product.name} is inactive`,
          });
        }
        const qty = Number(line.qty ?? line.quantity);
        const unitPrice = Number(line.unitPrice);
        const discountPct = Number(line.discountPct ?? line.discount ?? 0);
        const taxRate = Number(line.taxRate ?? product.taxRate ?? 0);
        if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0 || !Number.isFinite(discountPct) || discountPct < 0 || discountPct > 100 || !Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) {
          return res.status(400).json({ success: false, code: "ERR_INVALID_INVOICE_LINE", message: `Invoice line for ${product.name} has an invalid quantity, price, discount, or tax rate.` });
        }
      }

      // Recalculate line totals
      req.body.lines = lines.map((line, index) => {
        const qty = line.qty || line.quantity || 0;
        const unitPrice = line.unitPrice || 0;
        const discountPct = line.discountPct || line.discount || 0;
        const subtotal = qty * unitPrice;
        const discountAmount = subtotal * (discountPct / 100);
        const netAmount = subtotal - discountAmount;
        const product = getLineProduct(__lineProducts1, line);
        const taxRate = Number(line.taxRate ?? product?.taxRate ?? 0);
        const taxAmount = Math.round((netAmount * (taxRate / 100) + Number.EPSILON) * 100) / 100;
        const totalWithTax = netAmount + taxAmount;
        return {
          product: normalizeId(line.product),
          productName: line.productName || product?.name,
          productCode: line.productCode || product?.sku,
          description: line.description || product?.name,
          unit: line.unit || product?.unit,
          taxRate,
          qty: qty,
          quantity: qty,
          discountPct: discountPct,
          discount: discountPct,
          lineSubtotal: subtotal,
          subtotal: subtotal,
          lineTax: taxAmount,
          taxAmount: taxAmount,
          lineTotal: totalWithTax,
          totalWithTax: totalWithTax,
        };
      });
      req.body.items = req.body.lines; // backwards compat
    }

    // Recalculate header totals from lines
    if (req.body.lines && req.body.lines.length) {
      let newSubtotal = 0;
      let newTaxAmount = 0;
      for (const line of req.body.lines) {
        const qty = line.qty || line.quantity || 0;
        const unitPrice = Number(line.unitPrice) || 0;
        const discountPct = Number(line.discountPct || line.discount || 0);
        const taxRate = Number(line.taxRate) || 0;
        const lineSubtotal = qty * unitPrice;
        const lineAfterDiscount = lineSubtotal * (1 - discountPct / 100);
        const lineTax = lineAfterDiscount * (taxRate / 100);
        newSubtotal += lineAfterDiscount;
        newTaxAmount += lineTax;
      }
      const newTotalDiscount = req.body.lines.reduce((sum, l) => {
        const qty = l.qty || l.quantity || 0;
        const unitPrice = Number(l.unitPrice) || 0;
        const discountPct = Number(l.discountPct || l.discount || 0);
        return sum + (qty * unitPrice * discountPct) / 100;
      }, 0);
      const newTotal = newSubtotal + newTaxAmount;
      req.body.subtotal = Math.round(newSubtotal * 100) / 100;
      req.body.taxAmount = Math.round(newTaxAmount * 100) / 100;
      req.body.totalDiscount = Math.round(newTotalDiscount * 100) / 100;
      req.body.totalAmount = Math.round(newTotal * 100) / 100;
      req.body.total = Math.round(newTotal * 100) / 100;
      req.body.roundedAmount = Math.round(newTotal * 100) / 100;
      req.body.amountOutstanding = Math.max(
        0,
        Math.round((newTotal - (invoice.amountPaid || 0)) * 100) / 100,
      );
    }

    const allowedUpdates = {};
    for (const key of ["client", "quotation", "salesOrder", "customerTin", "customerName", "customerAddress", "currencyCode", "exchangeRate", "invoiceDate", "dueDate", "terms", "notes"]) {
      if (req.body[key] !== undefined) allowedUpdates[key] = req.body[key];
    }
    if (req.body.lines) {
      for (const key of ["lines", "subtotal", "taxAmount", "totalDiscount", "totalAmount", "roundedAmount", "amountOutstanding"]) {
        if (req.body[key] !== undefined) allowedUpdates[key] = req.body[key];
      }
    }
    invoice = await runInTransaction(async () => {
      const updated = await Invoice.findOneAndUpdate(
        { _id: req.params.id, company: companyId },
        allowedUpdates,
        { new: true, runValidators: true },
      );
      if (req.body.lines || req.body.items) {
        const invoiceId = normalizeId(updated._id);
        const prisma = dbClient();
        await prisma.invoiceLine.deleteMany({ where: { invoiceId, companyId: String(companyId) } });
        await prisma.invoiceLine.createMany({ data: req.body.lines.map((line, lineOrder) => ({
          id: generateObjectId(), companyId: String(companyId), invoiceId, lineOrder,
          lineId: line.lineId || null, productId: normalizeId(line.product),
          productName: line.productName || null, productCode: line.productCode || null,
          description: line.description || null, qty: Number(line.qty), unit: line.unit || null,
          unitPrice: Number(line.unitPrice), discountPct: Number(line.discountPct || 0),
          taxRate: Number(line.taxRate || 0), taxCode: line.taxCode || "A",
          lineSubtotal: Number(line.lineSubtotal || 0), lineTax: Number(line.lineTax || 0),
          lineTotal: Number(line.lineTotal || 0), unitCost: Number(line.unitCost || 0),
          cogsAmount: Number(line.cogsAmount || 0),
          warehouseId: line.warehouse ? normalizeId(line.warehouse) : null,
          projectId: line.projectId || line.project_id ? normalizeId(line.projectId || line.project_id) : null,
        })) });
      }
      return Invoice.findOne({ _id: req.params.id, company: companyId });
    });
    invoice = await hydrateInvoiceRelations(invoice);

    res.json({
      success: true,
      data: invoice,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete invoice
// @route   DELETE /api/invoices/:id
// @access  Private (admin)
exports.deleteInvoice = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const invoice = await Invoice.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: "Invoice not found",
      });
    }

    // Only draft invoices can be deleted
    if (invoice.status !== "draft") {
      return res.status(400).json({
        success: false,
        message: "Only draft invoices can be deleted",
      });
    }

    await invoice.deleteOne();

    res.json({
      success: true,
      message: "Invoice deleted successfully",
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Confirm invoice (deduct stock) - Module 6 Enhanced
// @route   PUT /api/invoices/:id/confirm
// @access  Private (admin, stock_manager)
exports.confirmInvoice = async (req, res, next) => {
  try {
    const companyId = String(req.user.company._id || req.user.company.id);
    const userId = String(req.user.id || req.user._id);
    const invoice = await require('../services/invoiceAutoConfirmService')
      .confirmDraftInvoice(companyId, req.params.id, userId);
    res.json({ success: true, message: 'Invoice confirmed successfully.', data: await hydrateInvoiceRelations(invoice, companyId) });
  } catch (error) {
    if (error.status || error.statusCode) {
      return res.status(error.status || error.statusCode).json({
        success: false, code: error.code || 'INVOICE_CONFIRMATION_FAILED', message: error.message,
      });
    }
    next(error);
  }
};

exports.correctInvoiceTaxFromDeliveryNote = async (req, res, next) => {
  try {
    const companyId = String(req.user.company._id || req.user.company.id);
    const userId = String(req.user.id || req.user._id);
    const invoiceId = req.params.id;
    const invoice = await Invoice.findOne({ _id: invoiceId, company: companyId }).lean();
    if (!invoice) {
      return res.status(404).json({ success: false, code: 'ERR_INVOICE_NOT_FOUND', message: 'Invoice not found.' });
    }
    if (invoice.status !== 'confirmed') {
      return res.status(409).json({ success: false, code: 'ERR_INVOICE_TAX_CORRECTION_STATUS', message: 'Only an unpaid confirmed invoice can be corrected from its delivery note.' });
    }
    const embeddedPayments = Array.isArray(invoice.payments)
      ? invoice.payments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0)
      : 0;
    if (Number(invoice.amountPaid || 0) > 0 || embeddedPayments > 0) {
      return res.status(409).json({ success: false, code: 'ERR_INVOICE_TAX_CORRECTION_PAID', message: 'This invoice has payments. Use the credit-note workflow to correct it.' });
    }
    if (['submitted', 'pending'].includes(invoice.ebm?.ebmStatus) || invoice.ebm?.rcptNo) {
      return res.status(409).json({ success: false, code: 'ERR_INVOICE_TAX_CORRECTION_EBM', message: 'This invoice has an EBM submission or pending submission. Correct it through the fiscal credit-note workflow.' });
    }

    const invoiceKey = normalizeId(invoice._id);
    const deliveryNote = await DeliveryNote.findOne({
      invoice: invoiceKey,
      company: companyId,
    }).lean();
    if (!deliveryNote) {
      return res.status(404).json({ success: false, code: 'ERR_INVOICE_TAX_DELIVERY_NOTE_NOT_FOUND', message: 'No delivery note is linked to this invoice.' });
    }

    if (deliveryNote.salesOrder) {
      deliveryNote.salesOrder = await SalesOrder.findOne({
        _id: normalizeId(deliveryNote.salesOrder),
        company: companyId,
      }).lean();
    }
    const plan = buildInvoiceTaxCorrection(invoice, deliveryNote);
    const creditNote = await dbClient().creditNote.findFirst({
      where: { invoiceId: invoiceKey, companyId, status: { notIn: ['draft', 'cancelled'] } },
      select: { id: true },
    });
    if (creditNote) {
      return res.status(409).json({ success: false, code: 'ERR_INVOICE_TAX_CORRECTION_CREDIT_NOTE', message: 'This invoice has an issued credit note. Correct it through the credit-note workflow.' });
    }

    if (Math.abs(plan.taxDelta) < 0.01) {
      return res.status(200).json({
        success: true,
        message: 'Invoice tax already matches the linked delivery note.',
        data: invoice,
      });
    }

    await runInTransaction(async () => {
      const prisma = dbClient();
      const currentInvoice = await prisma.invoice.findFirst({
        where: { id: invoiceKey, companyId },
        select: { status: true, amountPaid: true, taxAmount: true, ebm: true },
      });
      if (!currentInvoice || currentInvoice.status !== 'confirmed'
        || Number(currentInvoice.amountPaid) > 0
        || ['submitted', 'pending'].includes(currentInvoice.ebm?.ebmStatus)
        || currentInvoice.ebm?.rcptNo) {
        const conflict = new Error('Invoice state changed; refresh and review it before applying a tax correction.');
        conflict.code = 'ERR_INVOICE_TAX_CORRECTION_CONFLICT';
        conflict.statusCode = 409;
        throw conflict;
      }

      const existingCreditNote = await prisma.creditNote.findFirst({
        where: { invoiceId: invoiceKey, companyId, status: { notIn: ['draft', 'cancelled'] } },
        select: { id: true },
      });
      if (existingCreditNote) {
        const conflict = new Error('An issued credit note now exists for this invoice; use the credit-note workflow.');
        conflict.code = 'ERR_INVOICE_TAX_CORRECTION_CREDIT_NOTE';
        conflict.statusCode = 409;
        throw conflict;
      }

      const invoiceUpdate = await prisma.invoice.updateMany({
        where: {
          id: invoiceKey,
          companyId,
          status: 'confirmed',
          amountPaid: 0,
          taxAmount: currentInvoice.taxAmount,
        },
        data: {
          subtotal: plan.subtotal,
          taxAmount: plan.taxAmount,
          totalAmount: plan.totalAmount,
          amountOutstanding: plan.totalAmount,
          totalAEx: plan.totalAEx,
          totalB18: plan.totalB18,
        },
      });
      if (invoiceUpdate.count !== 1) {
        const conflict = new Error('Invoice changed before the tax correction could be applied. Refresh and retry.');
        conflict.code = 'ERR_INVOICE_TAX_CORRECTION_CONFLICT';
        conflict.statusCode = 409;
        throw conflict;
      }

      for (const line of plan.lines) {
        const lineUpdate = await prisma.invoiceLine.updateMany({
          where: { id: String(line.id), invoiceId: invoiceKey, companyId },
          data: {
            taxRate: line.taxRate,
            taxCode: line.taxCode,
            lineTax: line.lineTax,
            lineTotal: line.lineTotal,
          },
        });
        if (lineUpdate.count !== 1) {
          throw new Error(`Invoice line ${line.id} could not be updated with its delivery-note tax.`);
        }
      }

      const taxDelta = Math.abs(plan.taxDelta);
      const debitAccount = plan.taxDelta > 0 ? DEFAULT_ACCOUNTS.accountsReceivable : DEFAULT_ACCOUNTS.vatOutput;
      const creditAccount = plan.taxDelta > 0 ? DEFAULT_ACCOUNTS.vatOutput : DEFAULT_ACCOUNTS.accountsReceivable;
      await JournalService.createEntry(companyId, userId, {
        date: invoice.invoiceDate || new Date(),
        description: `Tax correction for Invoice ${invoice.referenceNo}`,
        sourceType: 'invoice_tax_correction',
        sourceId: invoiceKey,
        sourceReference: invoice.referenceNo,
        isAutoGenerated: true,
        notes: `Tax recalculated from linked delivery note ${deliveryNote.referenceNo}.`,
        lines: [
          {
            accountCode: debitAccount,
            accountName: debitAccount === DEFAULT_ACCOUNTS.accountsReceivable ? 'Accounts Receivable' : 'VAT Output',
            description: `Tax correction for Invoice ${invoice.referenceNo}`,
            debit: plan.taxDelta > 0 ? taxDelta : 0,
            credit: plan.taxDelta < 0 ? taxDelta : 0,
          },
          {
            accountCode: creditAccount,
            accountName: creditAccount === DEFAULT_ACCOUNTS.vatOutput ? 'VAT Output' : 'Accounts Receivable',
            description: `Tax correction for Invoice ${invoice.referenceNo}`,
            debit: plan.taxDelta < 0 ? taxDelta : 0,
            credit: plan.taxDelta > 0 ? taxDelta : 0,
          },
        ],
        sourceData: {
          taxCode: plan.lines.every((line) => line.taxCode === plan.lines[0].taxCode) ? plan.lines[0].taxCode : null,
          taxRate: plan.subtotal > 0 ? Math.round((plan.taxAmount / plan.subtotal) * 10000) / 100 : 0,
          vatAmount: taxDelta,
          netAmount: 0,
          grossAmount: taxDelta,
          metadata: { correctionForInvoiceId: invoiceKey, deliveryNoteId: deliveryNote._id },
        },
      });

      const clientUpdate = await prisma.client.updateMany({
        where: { id: normalizeId(invoice.client), companyId },
        data: { outstandingBalance: { increment: plan.taxDelta } },
      });
      if (clientUpdate.count !== 1) {
        throw new Error('Customer receivable balance could not be updated for the invoice tax correction.');
      }
    });

    const correctedInvoice = await Invoice.findOne({ _id: invoiceKey, company: companyId });
    await cacheService.bumpCompanyFinancialCaches(companyId);
    res.status(200).json({
      success: true,
      message: `Invoice tax corrected by ${Math.abs(plan.taxDelta).toFixed(2)} from its linked delivery note.`,
      data: correctedInvoice,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        code: error.code || 'ERR_INVOICE_TAX_CORRECTION_FAILED',
        message: error.message,
      });
    }
    next(error);
  }
};

// @desc    Record payment for invoice
// @route   POST /api/invoices/:id/payment
// @access  Private (admin, stock_manager, sales)
exports.recordPayment = async (req, res, next) => {
  try {
    const companyId = String(req.user.company._id || req.user.company.id);
    const invoice = await Invoice.findOne({ _id: req.params.id, company: companyId });
    if (!invoice) return res.status(404).json({ success: false, code: 'ERR_INVOICE_NOT_FOUND', message: 'Invoice not found.' });
    if (!['sent', 'confirmed', 'partially_paid'].includes(invoice.status)) {
      return res.status(409).json({ success: false, code: 'ERR_INVOICE_NOT_PAYABLE', message: 'Only a sent or confirmed invoice with an outstanding balance can receive payment.' });
    }
    const amountReceived = Number(req.body.amountReceived ?? req.body.amount);
    if (!Number.isFinite(amountReceived) || amountReceived <= 0) {
      return res.status(400).json({ success: false, code: 'ERR_INVALID_PAYMENT_AMOUNT', message: 'Payment amount must be a positive number.' });
    }
    const proxyResponse = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    const receiptController = require('./arReceiptController');
    const receiptRequest = {
      ...req,
      body: {
        client: normalizeId(invoice.client), amountReceived,
        paymentMethod: req.body.paymentMethod || 'cash',
        bankAccountId: req.body.bankAccountId || req.body.bankAccount || undefined,
        receiptDate: req.body.receiptDate || new Date(),
        currencyCode: invoice.currencyCode || 'RWF',
        exchangeRate: req.body.exchangeRate || invoice.exchangeRate || 1,
        reference: req.body.reference || null,
        notes: req.body.notes || null,
        allocations: [{ invoiceId: normalizeId(invoice._id), amount: amountReceived }],
      },
    };
    await receiptController.createReceipt(receiptRequest, proxyResponse, (err) => { throw err; });
    if (proxyResponse.statusCode >= 400 || proxyResponse.body?.success === false) {
      return res.status(proxyResponse.statusCode).json(proxyResponse.body);
    }
    const receiptId = proxyResponse.body?.data?._id;
    if (!receiptId) throw new Error('Receipt was created without an identifier.');
    await receiptController.postReceipt({
      ...req,
      params: { ...req.params, id: receiptId },
      body: {},
    }, proxyResponse, (err) => { throw err; });
    if (proxyResponse.statusCode >= 400 || proxyResponse.body?.success === false) {
      return res.status(proxyResponse.statusCode).json(proxyResponse.body);
    }
    const freshInvoice = await Invoice.findOne({ _id: invoice._id, company: companyId });
    await hydrateInvoiceRelations(freshInvoice, companyId);
    res.json({
      success: true,
      message: 'Payment recorded and posted successfully.',
      data: freshInvoice,
      receipt: proxyResponse.body.data,
    });
  } catch (error) { next(error); }
};

// @desc    Cancel invoice (reverse stock and journal entries) - Module 6 Enhanced
// @route   PUT /api/invoices/:id/cancel
// @access  Private (admin)
exports.cancelInvoice = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { reason } = req.body;

    const invoice = await Invoice.findOne({
      _id: req.params.id,
      company: companyId,
    }).select({
      lines: 1,
      client: 1,
      status: 1,
      posOrigin: 1,
      company: 1,
      referenceNo: 1,
      invoiceNumber: 1,
      totalAmount: 1,
      roundedAmount: 1,
      amountPaid: 1,
      grandTotal: 1,
      taxAmount: 1,
      subtotal: 1,
      amountOutstanding: 1,
      balance: 1,
      payments: 1,
      stockReserved: 1,
      stockDeducted: 1,
      ebm: 1,
    });

    if (Array.isArray(invoice?.lines)) {
      const productIds = [...new Set(invoice.lines.map((line) => normalizeId(line.product)).filter(Boolean))];
      const productRows = productIds.length ? await Product.find({ _id: { $in: productIds } }, 'name sku unit taxRate taxCode isStockable').lean() : [];
      const productMap = new Map(productRows.map((product) => [normalizeId(product._id), product]));
      invoice.lines = invoice.lines.map((line) => ({
        ...line,
        product: productMap.get(normalizeId(line.product)) || line.product,
      }));
    }

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: "Invoice not found",
      });
    }

    if (['submitted', 'pending', 'outcome_unknown', 'accepted'].includes(String(invoice.ebm?.ebmStatus || '').toLowerCase())) {
      return res.status(409).json({
        success: false,
        code: 'EBM_FISCAL_CANCELLATION_UNSUPPORTED',
        message: 'This invoice has a submitted or unresolved fiscal state. Do not cancel it locally; reconcile with RRA and use the confirmed fiscal correction workflow.',
      });
    }

    if (!invoice.posOrigin && (invoice.status !== "draft" || Number(invoice.amountPaid || 0) > 0 || invoice.stockDeducted)) {
      return res.status(409).json({
        success: false,
        code: "ERR_CREDIT_NOTE_REQUIRED",
        message: "An issued, paid, or inventory-posted invoice must be corrected with a credit note. Only an unposted draft can be cancelled.",
      });
    }

    // Module 6 Business Rule: Cannot cancel if delivery note exists
    const DeliveryNote = require("../models/DeliveryNote");
    const existingDeliveryNote = await DeliveryNote.findOne({
      invoice: invoice._id,
      status: "confirmed",
    });
    if (existingDeliveryNote) {
      return res.status(409).json({
        success: false,
        code: "ERR_DELIVERY_EXISTS",
        message:
          "Cannot cancel invoice. A confirmed delivery note already exists for this invoice.",
      });
    }

    if (invoice.posOrigin) {
      const normalizedReason = String(reason || '').trim();
      if (normalizedReason.length < 5) {
        return res.status(400).json({ success: false, code: 'POS_VOID_REASON_REQUIRED', message: 'Enter a clear reason before voiding this POS sale.' });
      }
      await consumePosManagerApproval({
        approvalId: req.body.posManagerApprovalId,
        companyId,
        cashierId: req.user.id,
        action: 'void',
        subjectId: String(invoice._id),
        payload: { invoiceId: String(invoice._id), reason: normalizedReason },
      });
    }

    // Reverse stock if reserved - Module 6: release qty_reserved
    if (invoice.stockReserved) {
      const warehouseService = require("../services/warehouseService");

      const __lineProducts5 = await loadLineProducts(Product, invoice.lines, companyId);
      for (const line of invoice.lines) {
        const product = getLineProduct(__lineProducts5, line);
        if (!product) continue;

        const qty = line.qty || line.quantity || 0;
        const warehouseId = line.warehouse || product.defaultWarehouse;

        if (warehouseId) {
          // Release from warehouse reservation
          try {
            await warehouseService.releaseStock(
              companyId,
              product._id,
              warehouseId,
              qty,
            );
          } catch (relErr) {
            console.error("Failed to release warehouse stock:", relErr);
          }
        } else {
          // Release from product qtyReserved
          product.qtyReserved = Math.max(0, (product.qtyReserved || 0) - qty);
          await product.save();
        }
      }
      invoice.stockReserved = false;
    }

    // Module 6 Business Rule: Reverse journal entries
    if (invoice.revenueJournalEntry || invoice.cogsJournalEntry) {
      try {
        // Reverse revenue entry
        if (invoice.revenueJournalEntry) {
          await JournalService.reverse(companyId, req.user.id, {
            entryId: invoice.revenueJournalEntry,
            narration: `Reversed: Invoice ${invoice.referenceNo || invoice.invoiceNumber} cancelled`,
          });
        }

        // Reverse COGS entry
        if (invoice.cogsJournalEntry) {
          await JournalService.reverse(companyId, req.user.id, {
            entryId: invoice.cogsJournalEntry,
            narration: `Reversed: COGS for Invoice ${invoice.referenceNo || invoice.invoiceNumber} cancelled`,
          });
        }
      } catch (reverseErr) {
        console.error("Failed to reverse journal entries:", reverseErr);
        // Don't fail the cancellation, just log the error
      }
    }

    // Update client outstanding balance
    const client = await Client.findOne({
      _id: invoice.client,
      company: companyId,
    });
    if (client) {
      const grandTotal =
        invoice.roundedAmount || parseFloat(invoice.totalAmount) || 0;
      const paid = parseFloat(invoice.amountPaid) || 0;
      const unpaidAmount = grandTotal - paid;
      client.outstandingBalance -= unpaidAmount;
      if (client.outstandingBalance < 0) client.outstandingBalance = 0;
      await client.save();
    }

    invoice.status = "cancelled";
    invoice.cancelledAt = new Date();
    invoice.cancelledBy = req.user.id || req.user._id;
    invoice.cancellationReason = reason;

    await invoice.save();

    // Invalidate report cache
    try {
      await cacheService.bumpCompanyFinancialCaches(companyId);
    } catch (e) {
      console.error("Cache invalidation failed:", e);
    }

    res.json({
      success: true,
      message:
        "Invoice cancelled, journal entries reversed, and stock reservations released",
      data: invoice,
    });
  } catch (error) {
    next(error);
  }
};

// Verify the invoice customer's TIN with the configured EBM service.
exports.verifyInvoiceCustomerTin = async (req, res, next) => {
  try {
    const companyId = String(req.user.company._id || req.user.company.id);
    if (req.body.branchId && req.body.bhfId && String(req.body.branchId) !== String(req.body.bhfId)) {
      return res.status(422).json({ success: false, code: 'EBM_BRANCH_ID_CONFLICT', message: 'Provide one matching RRA branch ID.' });
    }
    const invoice = await Invoice.findOne({ _id: req.params.id, company: companyId })
      .populate('lines.product')
      .populate('deliveryNote');
    if (!invoice) return res.status(404).json({ success: false, code: 'EBM_INVOICE_NOT_FOUND', message: 'Invoice not found for RRA customer TIN verification.' });
    const requestedBranch = req.body.branchId || req.body.bhfId || null;
    const branch = await require('../services/ebmSalesService').resolveBranch(invoice, companyId, requestedBranch);
    const result = await require('../services/ebmCustomerTinService').verifyInvoiceCustomerTin(
      companyId,
      req.params.id,
      { branchId: branch.rraBranchId },
    );
    res.json({ success: true, data: result.invoice, verification: result.verification });
  } catch (error) {
    next(error);
  }
};

// Submit a confirmed invoice to RRA/EBM and return the persisted submission state.
exports.submitInvoiceEbm = async (req, res, next) => {
  try {
    if (req.body.variant && req.body.variant !== 'sale') {
      return res.status(409).json({ success: false, code: 'EBM_SALES_VARIANT_UNSUPPORTED', message: 'Only normal fiscal sales are supported by this endpoint. Proforma and copy submissions require a confirmed RRA contract.' });
    }
    if (req.body.branchId && req.body.bhfId && String(req.body.branchId) !== String(req.body.bhfId)) {
      return res.status(422).json({ success: false, code: 'EBM_BRANCH_ID_CONFLICT', message: 'Provide one matching RRA branch ID.' });
    }
    const companyId = String(req.user.company._id || req.user.company.id);
    const invoice = await require('../services/ebmSalesService').submitInvoice(req.params.id, {
      companyId,
      branchId: req.body.branchId || req.body.bhfId || null,
      purchaserAcceptance: req.body.prchrAcptcYn ?? null,
      modifierUserId: req.user.id || req.user._id,
    });
    res.json({ success: true, message: 'Invoice submitted to EBM.', data: await hydrateInvoiceRelations(invoice, companyId) });
  } catch (error) {
    if (error.invoice) {
      error.data = await hydrateInvoiceRelations(error.invoice, String(req.user.company._id || req.user.company.id));
    }
    next(error);
  }
};

// @desc    Save receipt metadata
// @route   POST /api/invoices/:id/receipt-metadata
// @access  Private (admin)
exports.saveReceiptMetadata = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const {
      sdcId,
      receiptNumber,
      receiptSignature,
      internalData,
      mrcCode,
      deviceId,
      fiscalDate,
    } = req.body;

    const invoice = await Invoice.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: "Invoice not found",
      });
    }

    let metadata = await InvoiceReceiptMetadata.findOne({
      invoice: invoice._id,
      company: companyId,
    });

    if (metadata) {
      metadata = await InvoiceReceiptMetadata.findByIdAndUpdate(
        metadata._id,
        {
          sdcId,
          receiptNumber,
          receiptSignature,
          internalData,
          mrcCode,
          deviceId,
          fiscalDate,
        },
        { new: true },
      );
    } else {
      metadata = await InvoiceReceiptMetadata.create({
        invoice: invoice._id,
        company: companyId,
        sdcId,
        receiptNumber,
        receiptSignature,
        internalData,
        mrcCode,
        deviceId,
        fiscalDate: fiscalDate || new Date(),
      });
    }

    res.json({
      success: true,
      data: metadata,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get invoices for a specific client
// @route   GET /api/invoices/client/:clientId
// @access  Private
exports.getClientInvoices = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const invoices = await Invoice.find({
      client: req.params.clientId,
      company: companyId,
    })
      .select({ client: 1, lines: 1, createdBy: 1, referenceNo: 1, status: 1, invoiceDate: 1, totalAmount: 1, amountPaid: 1, amountOutstanding: 1 })
      .sort({ invoiceDate: -1 })
      .lean();
    await hydrateInvoiceRelations(invoices);

    res.json({
      success: true,
      count: invoices.length,
      data: invoices,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get invoices containing a specific product
// @route   GET /api/invoices/product/:productId
// @access  Private
exports.getProductInvoices = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const invoices = await Invoice.find({
      "lines.product": req.params.productId,
      company: companyId,
    })
      .select({ client: 1, lines: 1, createdBy: 1, referenceNo: 1, status: 1, invoiceDate: 1, totalAmount: 1, amountPaid: 1, amountOutstanding: 1 })
      .sort({ invoiceDate: -1 })
      .lean();
    await hydrateInvoiceRelations(invoices);

    res.json({
      success: true,
      count: invoices.length,
      data: invoices,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Generate invoice PDF
// @route   GET /api/invoices/:id/pdf
// @access  Private
exports.generateInvoicePDF = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const invoice = await Invoice.findOne({
      _id: req.params.id,
      company: companyId,
    }).select({ client: 1, lines: 1, createdBy: 1, referenceNo: 1, invoiceNumber: 1, status: 1, invoiceDate: 1, dueDate: 1, items: 1, payments: 1, ebm: 1, terms: 1, notes: 1, customerTin: 1, customerName: 1, customerAddress: 1, currencyCode: 1, exchangeRate: 1, totalDiscount: 1, posPromotion: 1, subtotal: 1, taxAmount: 1, totalAmount: 1, grandTotal: 1, amountPaid: 1, amountOutstanding: 1 }).lean();
    await hydrateInvoiceRelations(invoice);

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: "Invoice not found",
      });
    }

    // Get company info
    const company = await Company.findById(companyId);

    const fiscalMode = String(invoice.ebm?.fiscalEnvironment || invoice.ebm?.mode || invoice.ebm?.environment || '').toLowerCase();
    const qrPng = fiscalMode === 'production' && invoice.ebm?.ebmStatus === 'submitted'
      ? await generateQrPng(invoice.ebm, { width: 110 })
      : null;

    // Create PDF document with more breathable layout
    const doc = new PDFDocument({ margin: 50, size: "A4", bufferPages: true });

    // Set response headers
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=invoice-${invoice.referenceNo || invoice.invoiceNumber}.pdf`,
    );

    // Pipe PDF to response
    doc.pipe(res);

    const currency = String(invoice.currencyCode || "RWF").trim().toUpperCase();
    /* Legacy non-RWF currency selector retained only in history; invoice PDFs always print RWF.
      currency === "USD"
        ? "$"
        : currency === "EUR"
          ? "â‚¬"
          : currency === "GBP"
            ? "Â£"
        : currency === "LBP"
              ? "LL"
              : currency === "RWF"
                ? ""
    */

    // Helper to format money
    const fmt = (v) => {
      return formatMoney(v, currency);
    };
    const fmtDate = (value, withTime = false) => {
      if (!value) return "N/A";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return "N/A";
      return new Intl.DateTimeFormat("en-GB", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        ...(withTime ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}),
      }).format(date);
    };
    const formatAddress = (address) => {
      if (!address) return "";
      if (typeof address === "string") return address;
      return [address.street, address.city, address.state, address.country, address.postcode].filter(Boolean).join(", ");
    };
    const companyTin = String(company?.tax_identification_number || company?.taxIdentificationNumber || company?.tin || "").trim();
    const customerTin = String(invoice.customerTin || invoice.client?.taxId || "").trim();
    const hasCustomerTin = /^\d{9}$/.test(customerTin);
    const fiscalPayload = invoice.ebm?.salesPayload || invoice.ebm?.rraPayload || {};
    const receiptPayload = fiscalPayload.receipt || {};
    const branchId = fiscalPayload.bhfId || invoice.ebm?.branchId || null;
    const purchaseCode = fiscalPayload.prcOrdCd || invoice.ebm?.prcOrdCd || null;
    const customerPhone = invoice.customerPhone || invoice.client?.contact?.phone || fiscalPayload.custMblNo || receiptPayload.custMblNo || null;

    // Page counter
    let pageNumber = 1;

    // Draw header - reusable for first page and subsequent pages
    const drawHeader = () => {
      // Clear top area
      doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(20);
      doc.text(company?.name || "Company", 50, 42, { width: 300 });

      doc.font("Helvetica").fontSize(8.5).fillColor("#526174");
      const contactX = 50;
      let contactY = 67;
      const companyAddress = formatAddress(company?.address);
      if (companyAddress) {
        doc.text(companyAddress, contactX, contactY, { width: 260 });
        contactY += 12;
      }
      if (company?.phone) {
        doc.text(`Phone: ${company.phone}`, contactX, contactY);
        contactY += 12;
      }
      if (company?.email) {
        doc.text(`Email: ${company.email}`, contactX, contactY);
        contactY += 12;
      }
      if (companyTin) {
        doc.text(`TIN: ${companyTin}`, contactX, contactY);
      }

      // Invoice title block
      doc.fontSize(25).fillColor("#0f172a").font("Helvetica-Bold");
      doc.text("INVOICE", 0, 40, { align: "right" });
      doc.fontSize(10).font("Helvetica").fillColor("#526174");
      doc.text(`# ${invoice.invoiceNumber || invoice.referenceNo}`, 0, 72, { align: "right" });

      // Status badge
      const statusColors = {
        draft: ["#6b7280", "Draft"],
        confirmed: ["#f59e0b", "Confirmed"],
        paid: ["#10b981", "Paid"],
        partial: ["#3b82f6", "Partial"],
        cancelled: ["#ef4444", "Cancelled"],
      };
      const statusInfo = statusColors[invoice.status] || [
        "#6b7280",
        invoice.status,
      ];
      doc.fillColor(statusInfo[0]).font("Helvetica-Bold").fontSize(8);
      doc.text(statusInfo[1].toUpperCase(), 0, 90, { align: "right" });

      // Horizontal rule
      doc
        .moveTo(50, 116)
        .lineTo(doc.page.width - 50, 116)
        .lineWidth(1.5)
        .strokeColor("#14b8a6")
        .stroke();
    };

    // Footer: page numbers and timestamp
    const drawFooter = (pn) => {
      const bottom = doc.page.height - 72;
      doc.fontSize(8).fillColor("#9ca3af").font("Helvetica");
      doc.text(`Generated: ${new Date().toLocaleString()}`, 50, bottom, {
        align: "left",
      });
      doc.text(`Page ${pn}`, 0, bottom, { align: "right" });
    };

    // Draw invoice details and bill-to box
    const drawInvoiceDetails = (startY) => {
      // Dates box
      doc.roundedRect(50, startY, 240, 150, 7).fillAndStroke("#f8fafc", "#dbe4ee");
      doc.fillColor("#0f172a").fontSize(9).font("Helvetica-Bold");
      doc.text("INVOICE DETAILS", 62, startY + 11);

      doc.font("Helvetica").fontSize(8).fillColor("#64748b");
      doc.text("Invoice date", 62, startY + 31);
      doc.fillColor("#111827").text(
        fmtDate(invoice.invoiceDate),
        145,
        startY + 31,
      );

      doc.fillColor("#64748b").text("Due date", 62, startY + 48);
      doc.fillColor("#111827").text(
        invoice.dueDate
          ? fmtDate(invoice.dueDate)
          : "On Delivery",
        145,
        startY + 48,
      );

      doc.fillColor("#64748b").text("Currency", 62, startY + 65);
      doc.fillColor("#111827").text(currency, 145, startY + 65);
      doc.fillColor("#64748b").text("RRA branch", 62, startY + 82);
      doc.fillColor("#111827").text(branchId || "Not assigned", 145, startY + 82);
      doc.fillColor("#64748b").text("Fiscal status", 62, startY + 99);
      const fiscalStatusLabel = fiscalMode === 'mock'
        ? 'Mock only - not RRA certified'
        : fiscalMode === 'sandbox'
          ? 'Sandbox - not production certified'
          : fiscalMode === 'production' && invoice.ebm?.ebmStatus === 'submitted'
            ? 'RRA response accepted'
            : invoice.ebm?.ebmStatus === 'failed'
              ? 'Submission failed'
              : 'Not yet fiscalized';
      doc.fillColor(fiscalMode === 'mock' || fiscalMode === 'sandbox' ? "#b45309" : "#0f766e").font("Helvetica-Bold").fontSize(7.5).text(fiscalStatusLabel, 145, startY + 99, { width: 135 });
      doc.font("Helvetica").fontSize(8).fillColor("#64748b").text("VSDC invoice no", 62, startY + 116);
      doc.fillColor("#111827").text(fiscalPayload.invcNo == null ? "Not allocated" : String(fiscalPayload.invcNo), 145, startY + 116, { width: 135 });
      doc.fillColor("#64748b").text("Original invoice no", 62, startY + 133);
      doc.fillColor("#111827").text(fiscalPayload.orgInvcNo == null ? "-" : String(fiscalPayload.orgInvcNo), 145, startY + 133, { width: 135 });

      // Bill To
      doc.roundedRect(305, startY, 240, 150, 7).fillAndStroke("#f8fafc", "#dbe4ee");
      doc.fillColor("#0f172a").fontSize(9).font("Helvetica-Bold");
      doc.text("BILL TO", 317, startY + 11);
      doc.font("Helvetica-Bold").fontSize(11).fillColor("#111827");
      doc.text(
        invoice.customerName || invoice.client?.name || "N/A",
        317,
        startY + 31,
        { width: 215 },
      );
      doc.font("Helvetica").fontSize(8).fillColor("#526174");
      let billY = startY + 50;
      if (hasCustomerTin) {
        doc.text(`Buyer TIN: ${customerTin}`, 317, billY);
        billY += 13;
      } else if (!hasCustomerTin && customerTin) {
        doc.fillColor("#b91c1c").text(`Buyer TIN (check format): ${customerTin}`, 317, billY, { width: 215 });
        billY += 13;
      }
      if (purchaseCode) {
        doc.fillColor("#526174").text(`Purchase code: ${purchaseCode}`, 317, billY, { width: 215 });
        billY += 13;
      }
      if (customerPhone) {
        doc.text(`Phone: ${customerPhone}`, 317, billY);
        billY += 13;
      }
      const customerAddress = formatAddress(invoice.customerAddress || invoice.client?.contact?.address);
      if (customerAddress)
        doc.text(customerAddress, 317, billY, { width: 215 });
    };

    const drawRraDetails = (startY) => {
      return drawEbmCertificationBlock(doc, {
        y: startY,
        ebm: invoice.ebm || {},
        qrPng,
        title: fiscalMode === 'production' && invoice.ebm?.ebmStatus === 'submitted' ? 'RRA FISCAL RECEIPT' : 'FISCAL RECEIPT DETAILS',
        receiptDateFormatter: formatReceiptDate,
      });
    };

    // Table header renderer (callable on new pages)
    const tableHeader = (y) => {
      doc.rect(50, y, doc.page.width - 100, 28).fill("#111827");
      doc.fillColor("#ffffff").fontSize(10).font("Helvetica-Bold");
      doc.text("#", 56, y + 8);
      doc.text("Item / Description", 80, y + 8);
      doc.text("Qty", 310, y + 8, { width: 40, align: "right" });
      doc.text("Unit Price", 355, y + 8, { width: 65, align: "right" });
      doc.text("Tax", 425, y + 8, { width: 45, align: "right" });
      doc.text("Total", 475, y + 8, { width: 70, align: "right" });
    };

    // Start first page
    drawHeader();
    let firstContentY = 140;
    if (invoice.ebm?.ebmStatus === "failed") {
      doc.rect(50, 128, doc.page.width - 100, 34).fillAndStroke("#fef2f2", "#ef4444");
      doc.fillColor("#991b1b").font("Helvetica-Bold").fontSize(9);
      doc.text("RRA CERTIFICATION FAILED - this invoice is not yet RRA certified and may not be used as a valid tax document until resolved.", 60, 138, { width: doc.page.width - 120 });
      firstContentY = 176;
    }
    drawInvoiceDetails(firstContentY);

    // Table
    let y = firstContentY + 174;
    let tableSectionStartY = y;
    tableHeader(y);
    y += 34;
    doc.font("Helvetica").fontSize(9).fillColor("#111827");

    // Rows with automatic page breaks and repeated header
    invoice.items.forEach((item, idx) => {
      // Page break if low space
      if (y > doc.page.height - 160) {
        // footer for the page
        doc.rect(50, tableSectionStartY, doc.page.width - 100, Math.max(1, y - tableSectionStartY))
          .lineWidth(0.8).strokeColor("#dbe4ee").stroke();
        drawFooter(pageNumber);
        doc.addPage();
        pageNumber += 1;
        drawHeader();
        y = 140; // position after header
        tableSectionStartY = y;
        tableHeader(y);
        y += 34;
        doc.font("Helvetica").fontSize(9).fillColor("#111827");
      }

      // Alternate background
      if (idx % 2 === 0) {
        doc.rect(50, y - 6, doc.page.width - 100, 44).fill("#f9fafb");
        doc.fillColor("#111827");
      }

      const productName = item.product?.name || item.description || "N/A";
      const submittedLine = invoice.ebm?.salesPayload?.itemList?.[idx] || {};
      const tax = lineTaxDetails({ ...(item.toObject ? item.toObject() : item), ...submittedLine, product: item.product });
      doc.fillColor("#111827");
      doc.text(`${idx + 1}`, 56, y);
      doc.text(productName, 80, y, { width: 230 });
      doc.fontSize(7).fillColor("#6b7280");
      const itemCodeLabel = tax.itemCode ? `Item code: ${tax.itemCode}` : "Item code: not recorded";
      const unitLabel = tax.quantityUnitCode || item.unit || "unit not recorded";
      const packageLabel = tax.packageUnitCode ? `  Package: ${tax.packageQuantity ?? '-'} ${tax.packageUnitCode}` : "";
      doc.text(`${itemCodeLabel}  Qty unit: ${unitLabel}${packageLabel}`, 80, y + 11, { width: 230 });
      doc.text(`${tax.itemClassCd !== "N/A" ? `Class: ${tax.itemClassCd}  ` : ""}${tax.taxTypeLabel}`, 80, y + 22, { width: 230 });
      const taxableLabel = tax.taxableAmount == null ? "Not recorded" : fmt(tax.taxableAmount);
      const taxAmountLabel = tax.vatAmount == null ? "Not recorded" : fmt(tax.vatAmount);
      doc.text(`Taxable: ${taxableLabel}  Tax: ${taxAmountLabel}${tax.discountAmount > 0 ? `  Discount: ${fmt(tax.discountAmount)}` : ""}`, 80, y + 33, { width: 230 });
      doc.fontSize(9).fillColor("#111827");
      doc.text((item.quantity || 0).toString(), 310, y, {
        width: 40,
        align: "right",
      });
      doc.text(fmt(item.unitPrice), 355, y, { width: 65, align: "right" });
      doc.text(tax.taxTyCd || 'N/A', 425, y, {
        width: 45,
        align: "right",
      });
      doc.text(tax.lineTotal == null ? "Not recorded" : fmt(tax.lineTotal), 475, y, { width: 70, align: "right" });
      y += 38;
    });

    // Draw totals block (ensure space)
    if (y > doc.page.height - 300) {
      drawFooter(pageNumber);
      doc.addPage();
      pageNumber += 1;
      drawHeader();
      y = 140;
    }

    const totalsX = 50;
    const totalsWidth = doc.page.width - 100;
    const invoiceLineDiscount = (invoice.items || invoice.lines || []).reduce((sum, line) => {
      const base = Number(line.lineSubtotal ?? line.subtotal ?? (Number(line.quantity || line.qty || 0) * Number(line.unitPrice || line.price || 0)));
      return sum + Math.max(0, base) * Math.max(0, Number(line.discountPct || 0)) / 100;
    }, 0);
    const pdfDiscountAmount = Math.max(Number(invoice.totalDiscount || 0), Number(invoice.posPromotion?.discountAmount || 0), invoiceLineDiscount);
    const pdfDiscountLabel = invoice.posPromotion?.name
      ? `Promotion: ${invoice.posPromotion.name}`
      : invoice.posPromotion?.code
        ? `Promotion: ${invoice.posPromotion.code}`
        : "Discount";
    const totalsBottom = drawTaxBreakdown(doc, {
      x: totalsX,
      y,
      width: totalsWidth,
      ebm: invoice.ebm || {},
      fallback: invoice.toObject ? invoice.toObject({ virtuals: true }) : invoice,
      currency,
      discountAmount: pdfDiscountAmount,
      discountLabel: pdfDiscountLabel,
      border: false,
      background: "#f9fafb",
    });
    // One continuous outline makes the item table and its fiscal totals read as
    // a single invoice section, while retaining a subtle divider between them.
    doc.moveTo(totalsX + 10, y + 1).lineTo(totalsX + totalsWidth - 10, y + 1)
      .lineWidth(0.6).strokeColor("#e5e7eb").stroke();
    doc.rect(totalsX, tableSectionStartY, totalsWidth, totalsBottom - tableSectionStartY)
      .lineWidth(0.8).strokeColor("#dbe4ee").stroke();
    let ty = totalsBottom + 8;

    if (invoice.amountPaid > 0) {
      doc.fillColor("#10b981").fontSize(10).font("Helvetica");
      doc.text("Paid", totalsX + 10, ty - 8, { width: 200, align: "left" });
      doc.text(`- ${fmt(invoice.amountPaid)}`, totalsX + totalsWidth - 140, ty - 8, {
        width: 130,
        align: "right",
      });
      ty += 18;

      doc.fillColor("#ef4444").fontSize(11).font("Helvetica-Bold");
      doc.text("BALANCE DUE", totalsX + 10, ty - 8, { width: 200, align: "left" });
      doc.text(fmt(invoice.balance), totalsX + totalsWidth - 140, ty - 8, {
        width: 130,
        align: "right",
      });
    }

    // Payment history
    y = ty + 18;
    if (invoice.payments && invoice.payments.length > 0) {
      if (y > doc.page.height - 120) {
        drawFooter(pageNumber);
        doc.addPage();
        pageNumber += 1;
        drawHeader();
        y = 140;
      }

      doc.rect(50, y, doc.page.width - 100, 20).fill("#f0fdf4");
      doc.fillColor("#166534").fontSize(10).font("Helvetica-Bold");
      doc.text("PAYMENT HISTORY", 56, y + 5);
      y += 28;

      doc.font("Helvetica").fontSize(9).fillColor("#111827");
      invoice.payments.forEach((payment, idx) => {
        if (y > doc.page.height - 100) {
          drawFooter(pageNumber);
          doc.addPage();
          pageNumber += 1;
          drawHeader();
          y = 140;
        }

        doc.text(
          `${idx + 1}. ${payment.paymentMethod?.replace(/_/g, " ").toUpperCase() || "Payment"}`,
          56,
          y,
        );
        doc.text(fmt(payment.amount), 510, y, { width: 70, align: "right" });
        doc.text(`Ref: ${payment.reference || "N/A"}`, 300, y);
        doc.text(
          `Date: ${payment.paidDate ? new Date(payment.paidDate).toLocaleDateString() : "N/A"}`,
          380,
          y,
        );
        y += 16;
      });
    }

    // Terms and notes
    y += 18;
    if (invoice.terms) {
      doc.font("Helvetica").fontSize(9);
      const termsHeight = doc.heightOfString(String(invoice.terms), { width: doc.page.width - 120, font: "Helvetica", fontSize: 9 });
      if (y + 38 + termsHeight > doc.page.height - 92) {
        drawFooter(pageNumber);
        doc.addPage();
        pageNumber += 1;
        drawHeader();
        y = 140;
      }
      doc.rect(50, y, doc.page.width - 100, 30).fill("#fffbeb");
      doc.fillColor("#92400e").fontSize(10).font("Helvetica-Bold");
      doc.text("TERMS & CONDITIONS", 56, y + 6);
      y += 20;
      doc.font("Helvetica").fontSize(9).fillColor("#111827");
      doc.text(invoice.terms, 56, y + 6, { width: doc.page.width - 120 });
      y += termsHeight + 36;
    }

    if (invoice.notes) {
      doc.font("Helvetica").fontSize(9);
      const notesHeight = doc.heightOfString(String(invoice.notes), { width: doc.page.width - 120, font: "Helvetica", fontSize: 9 });
      if (y + 18 + notesHeight > doc.page.height - 92) {
        drawFooter(pageNumber);
        doc.addPage();
        pageNumber += 1;
        drawHeader();
        y = 140;
      }
      doc.fillColor("#374151").fontSize(10).font("Helvetica-Bold");
      doc.text("NOTES", 56, y);
      y += 14;
      doc.font("Helvetica").fontSize(9).fillColor("#6b7280");
      doc.text(invoice.notes, 56, y, { width: doc.page.width - 120 });
      y += notesHeight + 18;
    }

    // Keep fiscal receipt evidence after all invoice and payment details.
    const fiscalBlockHeight = 166;
    const fiscalY = y + 12;
    if (fiscalY + fiscalBlockHeight > doc.page.height - 96) {
      drawFooter(pageNumber);
      doc.addPage();
      pageNumber += 1;
      drawHeader();
      y = 140;
    }
    drawRraDetails(y + 12);

    // Finalize: draw footer on last page then end
    drawFooter(pageNumber);
    doc.end();
  } catch (error) {
    next(error);
  }
};

// @desc    Send invoice via email
// @route   POST /api/invoices/:id/send-email
// @access  Private (admin, stock_manager, sales)
exports.sendInvoiceEmail = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const invoice = await Invoice.findOne({
      _id: req.params.id,
      company: companyId,
    }).select({ client: 1, customerEmail: 1, referenceNo: 1, invoiceNumber: 1, status: 1, totalAmount: 1, lines: 1 }).lean();
    await hydrateInvoiceRelations(invoice);

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: "Invoice not found",
      });
    }

    const company = await Company.findById(companyId);
    const clientData = await Client.findById(invoice.client);

    // Check if client has email
    const clientEmail = clientData?.contact?.email || invoice.customerEmail;
    if (!clientEmail) {
      return res.status(400).json({
        success: false,
        message: "Client does not have an email address",
      });
    }

    // Send the invoice email
    await emailService.sendInvoiceEmail(invoice, company, clientData);

    // Notify invoice sent
    try {
      await notifyInvoiceSent(companyId, invoice);
    } catch (e) {
      console.error("notifyInvoiceSent failed", e);
    }

    res.json({
      success: true,
      message: "Invoice sent to " + clientEmail,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Write off invoice as bad debt (AR decreases)
// @route   POST /api/invoices/:id/write-off
// @access  Private (admin)
exports.writeOffInvoiceBadDebt = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const { id } = req.params;
    const { amount, reason, writeoffDate, notes } = req.body;

    // Validate invoice exists and is eligible
const Invoice = require('../models/Invoice');
    const invoice = await Invoice.findOne({ _id: id, company: companyId });
    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }
    if (invoice.status === 'cancelled' || invoice.status === 'fully_paid') {
      return res.status(400).json({ success: false, message: 'Cannot write off a cancelled or fully paid invoice' });
    }
    const outstanding = parseFloat(invoice.amountOutstanding) || parseFloat(invoice.balance) || 0;
    if (outstanding <= 0) {
      return res.status(400).json({ success: false, message: 'Invoice has no outstanding balance to write off' });
    }

    const ARService = require('../services/arService');
    const writeoffAmount = amount && parseFloat(amount) > 0 ? parseFloat(amount) : outstanding;
    if (writeoffAmount > outstanding) {
      return res.status(400).json({ success: false, message: 'Write-off amount cannot exceed outstanding balance' });
    }

    // Create the write-off record
    const writeoff = await ARService.writeOffBadDebt(companyId, userId, {
      invoiceId: id,
      amount: writeoffAmount,
      reason: reason || 'Bad debt write-off',
      writeoffDate: writeoffDate || new Date(),
      notes: notes || null,
    });

    // Immediately post it (no draft state for source-document actions)
    await ARService.postBadDebtWriteoff(companyId, userId, writeoff._id);

    res.json({
      success: true,
      message: 'Invoice written off as bad debt',
      data: writeoff,
    });
  } catch (error) {
    next(error);
  }
};
