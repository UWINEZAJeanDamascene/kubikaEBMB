const CreditNote = require("../models/CreditNote");
const Invoice = require("../models/Invoice");
const Product = require("../models/Product");
const { loadLineProducts, getLineProduct } = require("../utils/lineProducts");
const StockMovement = require("../models/StockMovement");
const Client = require("../models/Client");
const Company = require("../models/Company");
const SerialNumber = require("../models/SerialNumber");
const StockSerialNumber = require("../models/StockSerialNumber");
const JournalService = require("../services/journalService");
const TaxAutomationService = require("../services/taxAutomationService");
const emailService = require("../services/emailService");
const { BankAccount } = require("../models/BankAccount");
const { DEFAULT_ACCOUNTS } = require("../constants/chartOfAccounts");
const { normalizeCreditNoteLines } = require("../utils/creditNoteLineNormalization");
const { toIdString } = require("../utils/objectId");

const EBMSalesService = require("../services/ebmSalesService");
const { emitDataChanged } = require("../lib/realtimeEvents");
const PDFDocument = require("pdfkit");
const EBMCode = require("../models/EBMCode");
const { consumeApproval: consumePosManagerApproval } = require('./posManagerApprovalController');
const {
  drawEbmCertificationBlock,
  drawTaxBreakdown,
  formatReceiptDate,
  formatRwf,
  generateQrPng,
  lineTaxDetails,
} = require("../utils/pdfUtils");

const sendCreditNoteEmail = async (note, company, client, action) => {
  try {
    const config = require('../src/config/environment').getConfig();
    if (!config.features?.emailNotifications || !config.email?.gmailUser) {
      return;
    }

    const clientEmail = client?.contact?.email || client?.email;
    if (!clientEmail) {
      console.warn('[CreditNote] No client email found');
      return;
    }

    const noteWithProducts = await CreditNote.findById(note._id).populate('lines.product', 'name').populate('items.product', 'name');

    const actionText = { created: 'Created', confirmed: 'Confirmed', approved: 'Approved', refunded: 'Refunded' }[action] || 'Updated';
    const subject = `Credit Note ${note.creditNoteNumber || note.referenceNo} - ${actionText}`;

    const lines = noteWithProducts.lines || noteWithProducts.items || [];
    let itemsHtml = '';
    if (lines.length > 0) {
      itemsHtml = lines.map(line => `
        <tr>
          <td style="padding:10px; border-bottom:1px solid #ddd;">${line.product?.name || line.productName || line.description || 'Item'}</td>
          <td style="padding:10px; border-bottom:1px solid #ddd; text-align:center;">${line.quantity || 0}</td>
          <td style="padding:10px; border-bottom:1px solid #ddd; text-align:right;">${note.currencyCode || 'FRW'} ${(line.unitPrice || 0).toFixed(2)}</td>
        </tr>
      `).join('');
    }

    const html = `
      <div style="font-family:Arial,sans-serif; max-width:600px; margin:0 auto;">
        <div style="background:#f59e0b; padding:30px; border-radius:10px 10px 0 0;">
          <h1 style="color:white; margin:0; text-align:center;">📝 Credit Note ${actionText}</h1>
        </div>
        <div style="background:#f9f9f9; padding:30px; border:1px solid #ddd; border-top:none; border-radius:0 0 10px 10px;">
          <h2 style="color:#f59e0b; margin:0 0 5px;">${note.creditNoteNumber || note.referenceNo || ''}</h2>
          <p style="color:#666; margin:5px 0;">Date: ${new Date(note.creditDate || note.createdAt).toLocaleDateString()}</p>
          <p style="color:#666; margin:5px 0;">Status: <strong>${actionText}</strong></p>
          <p style="color:#666; margin:5px 0;">Type: <strong>${note.type === 'goods_return' ? 'Goods Return' : note.type || 'Credit Note'}</strong></p>
          <div style="background:white; padding:15px; border-radius:8px; margin:20px 0;">
            <strong>Customer:</strong><br/>${client?.name || 'Customer'}
          </div>
          <table style="width:100%; border-collapse:collapse; margin:20px 0;">
            <thead>
              <tr style="background:#f59e0b; color:white;">
                <th style="padding:12px; text-align:left;">Product</th>
                <th style="padding:12px; text-align:center;">Qty</th>
                <th style="padding:12px; text-align:right;">Unit Price</th>
              </tr>
            </thead>
            <tbody>${itemsHtml}</tbody>
          </table>
          <div style="text-align:right; margin:20px 0;">
            <p style="margin:5px 0; font-size:18px; font-weight:bold; color:#f59e0b;">Total: ${note.currencyCode || 'FRW'} ${(note.totalAmount || note.grandTotal || 0).toFixed(2)}</p>
          </div>
          ${note.reason ? `<div style="background:white; padding:15px; border-radius:8px; margin:20px 0;"><strong>Reason:</strong><br/>${note.reason}</div>` : ''}
          <div style="text-align:center; margin-top:30px;">
            <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/credit-notes/${note._id}" style="background:#f59e0b; color:white; padding:12px 30px; text-decoration:none; border-radius:8px; display:inline-block;">View Credit Note</a>
          </div>
          <hr style="border:none; border-top:1px solid #ddd; margin:30px 0;"/>
          <p style="font-size:12px; color:#888; text-align:center;">KUBIKA SYSTEM — Manage Your Stock From Supply to Final Sale</p>
        </div>
      </div>`;

    await emailService.sendEmail(clientEmail, subject, html);
  } catch (err) {
    console.error('[CreditNote] Email failed:', err.message);
  }
};

// List credit notes
exports.getCreditNotes = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const {
      status,
      client,
      invoiceId,
      type,
      dateFrom,
      dateTo,
      search,
      page = 1,
      limit = 50,
    } = req.query;

    // Build query filter
    let query = { company: companyId };

    // Status filter
    if (status && status !== "all") {
      query.status = status;
    }

    // Client filter
    if (client && client !== "all") {
      query.client = client;
    }

    if (invoiceId) {
      query.invoice = invoiceId;
    }

    // Type filter
    if (type && type !== "all") {
      query.type = type;
    }

    // Date range filter
    if (dateFrom || dateTo) {
      query.creditDate = {};
      if (dateFrom) query.creditDate.$gte = new Date(dateFrom);
      if (dateTo) query.creditDate.$lte = new Date(dateTo);
    }

    // Search filter (reference number or reason)
    if (search) {
      query.$or = [
        { referenceNo: { $regex: search, $options: "i" } },
        { creditNoteNumber: { $regex: search, $options: "i" } },
        { reason: { $regex: search, $options: "i" } },
      ];
    }

    const skip = (Number(page) - 1) * Number(limit);

    const [notes, total] = await Promise.all([
      CreditNote.find(query)
        .populate("invoice client createdBy")
        .sort({ creditDate: -1 })
        .skip(skip)
        .limit(Number(limit)),
      CreditNote.countDocuments(query),
    ]);

    res.json({
      success: true,
      count: notes.length,
      total,
      page: Number(page),
      pages: Math.ceil(total / Number(limit)),
      data: notes,
    });
  } catch (err) {
    next(err);
  }
};

// Get single
exports.getCreditNote = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const note = await CreditNote.findOne({
      _id: req.params.id,
      company: companyId,
    })
      .populate("invoice client createdBy")
      .populate("lines.product");
    if (!note)
      return res.status(404).json({ success: false, message: "Not found" });
    res.json({ success: true, data: note });
  } catch (err) {
    next(err);
  }
};

exports.generateCreditNotePDF = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const note = await CreditNote.findOne({ _id: req.params.id, company: companyId })
      .populate("invoice")
      .populate("client")
      .populate("lines.product")
      .populate("items.product")
      .populate("createdBy");

    if (!note) return res.status(404).json({ success: false, message: "Credit note not found" });

    const company = await Company.findById(companyId).lean();
    const refundCode = note.ebm?.rfdRsnCd || note.ebm?.refundRsnCd;
    const refundReason = refundCode
      ? await EBMCode.findOne({ company: companyId, code: refundCode, active: true }).lean()
      : null;
    const fiscalMode = String(note.ebm?.fiscalEnvironment || note.ebm?.mode || note.ebm?.environment || '').toLowerCase();
    const qrPng = fiscalMode === 'production' && note.ebm?.ebmStatus === 'submitted'
      ? await generateQrPng(note.ebm, { width: 110 })
      : null;
    const originalInvoice = note.invoice || {};
    const lineArray = note.lines?.length ? note.lines : note.items || [];

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

    const doc = new PDFDocument({ margin: 50, size: "A4", bufferPages: true });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=credit-note-${note.referenceNo || note.creditNoteNumber}.pdf`);
    doc.pipe(res);

    doc.fillColor("#111827").font("Helvetica-Bold").fontSize(22).text(company?.name || "Company", 50, 48);
    doc.font("Helvetica").fontSize(9).fillColor("#6b7280");
    let cy = 74;
    const companyAddress = formatAddress(company?.address);
    if (companyAddress) {
      doc.text(companyAddress, 50, cy, { width: 260 });
      cy += 12;
    }
    const tin = company?.tax_identification_number || company?.registration_number;
    if (tin) doc.text(`TIN: ${String(tin).replace(/\D/g, "").slice(0, 9)}`, 50, cy);

    doc.font("Helvetica-Bold").fontSize(26).fillColor("#991b1b").text("CREDIT NOTE", 0, 50, { align: "right" });
    doc.font("Helvetica").fontSize(10).fillColor("#6b7280").text(`# ${note.referenceNo || note.creditNoteNumber}`, 0, 82, { align: "right" });
    doc.moveTo(50, 120).lineTo(doc.page.width - 50, 120).strokeColor("#e5e7eb").stroke();

    doc.rect(50, 140, 230, 112).fillAndStroke("#ffffff", "#e5e7eb");
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#374151").text("CREDIT NOTE DETAILS", 60, 150);
    doc.font("Helvetica").fontSize(9).fillColor("#111827");
    doc.text(`Credit Note No: ${note.referenceNo || note.creditNoteNumber}`, 60, 170, { width: 205 });
    doc.text(`Credit Date: ${fmtDate(note.creditDate)}`, 60, 186, { width: 205 });
    doc.text(`Invoice No: ${originalInvoice.referenceNo || originalInvoice.invoiceNumber || note.relatedInvoice || "N/A"}`, 60, 202, { width: 205 });
    doc.text(`Original RRA Receipt No: ${note.ebm?.orgRcptNo || originalInvoice.ebm?.rcptNo || "N/A"}`, 60, 218, { width: 205 });
    doc.text(`Refund Reason: ${refundReason?.description || refundReason?.name || refundCode || note.reason}`, 60, 234, { width: 205 });

    doc.rect(300, 140, 250, 112).fillAndStroke("#ffffff", "#e5e7eb");
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#374151").text("CUSTOMER", 310, 150);
    doc.font("Helvetica").fontSize(10).fillColor("#111827").text(note.client?.name || "N/A", 310, 172, { width: 220 });
    doc.fontSize(9).fillColor("#6b7280");
    const customerTin = note.clientTIN || note.client?.taxId || originalInvoice.customerTin;
    doc.text(customerTin ? `Customer TIN: ${customerTin}` : "Individual", 310, 190, { width: 220 });
    const clientAddress = note.client?.contact?.address || originalInvoice.customerAddress;
    if (clientAddress) doc.text(clientAddress, 310, 206, { width: 220 });
    doc.text(`Issued against Invoice No: ${originalInvoice.referenceNo || originalInvoice.invoiceNumber || "N/A"}`, 310, 232, { width: 220 });

    let y = 278;
    doc.rect(50, y, doc.page.width - 100, 28).fill("#111827");
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(9);
    doc.text("#", 56, y + 8);
    doc.text("Returned Item / Tax Details", 80, y + 8);
    doc.text("Qty", 318, y + 8, { width: 35, align: "right" });
    doc.text("Unit Price", 365, y + 8, { width: 70, align: "right" });
    doc.text("VAT", 445, y + 8, { width: 55, align: "right" });
    doc.text("Refunded", 508, y + 8, { width: 72, align: "right" });
    y += 38;

    lineArray.forEach((line, index) => {
      if (y > doc.page.height - 190) {
        doc.addPage();
        y = 70;
      }
      const tax = lineTaxDetails(line);
      if (index % 2 === 0) doc.rect(50, y - 6, doc.page.width - 100, 40).fill("#f9fafb");
      doc.fillColor("#111827").font("Helvetica").fontSize(9);
      doc.text(String(index + 1), 56, y);
      doc.text(line.product?.name || line.productName || "Item", 80, y, { width: 220 });
      doc.fontSize(7).fillColor("#6b7280");
      doc.text(`Class: ${tax.itemClassCd}  Tax Type: ${tax.taxTypeLabel}  Taxable: ${tax.taxableAmount == null ? "Not recorded" : formatRwf(-tax.taxableAmount)}`, 80, y + 12, { width: 240 });
      doc.fontSize(9).fillColor("#111827");
      doc.text(String(line.quantity || 0), 318, y, { width: 35, align: "right" });
      doc.text(formatRwf(line.unitPrice), 365, y, { width: 70, align: "right" });
      doc.text(tax.vatAmount == null ? "Not recorded" : formatRwf(-tax.vatAmount), 445, y, { width: 55, align: "right" });
      doc.text(tax.lineTotal == null ? "Not recorded" : formatRwf(-tax.lineTotal), 508, y, { width: 72, align: "right" });
      y += 44;
    });

    if (y > doc.page.height - 290) {
      doc.addPage();
      y = 70;
    }
    const totalsY = drawTaxBreakdown(doc, {
      x: doc.page.width - 310,
      y,
      width: 260,
      ebm: note.ebm || {},
      fallback: note.toObject ? note.toObject({ virtuals: true }) : note,
      title: "AMOUNT REFUNDED",
      negative: true,
    });

    y = Math.max(totalsY + 24, y + 180);
    if (y > doc.page.height - 170) {
      doc.addPage();
      y = 70;
    }
    drawEbmCertificationBlock(doc, {
      y,
      ebm: note.ebm || {},
      qrPng,
      title: "RRA EBM CERTIFICATION - CREDIT NOTE",
      receiptDateFormatter: formatReceiptDate,
      originalReceiptNo: note.ebm?.orgRcptNo || originalInvoice.ebm?.rcptNo || null,
    });

    doc.end();
  } catch (err) {
    next(err);
  }
};

// Create credit note (draft)
exports.createCreditNote = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { invoice: invoiceId } = req.body;

    const invoice = await Invoice.findOne({
      _id: invoiceId,
      company: companyId,
    });
    if (!invoice)
      return res
        .status(404)
        .json({ success: false, message: "Invoice not found" });

    const payload = {
      ...req.body,
      company: companyId,
      client: invoice.client,
      currencyCode: req.body.currencyCode || invoice.currencyCode || 'FRW',
      createdBy: req.user.id,
    };
    const requestedLines =
      payload.lines && Array.isArray(payload.lines) && payload.lines.length > 0
        ? payload.lines
        : payload.items && Array.isArray(payload.items)
          ? payload.items
          : [];
    const lineArray = normalizeCreditNoteLines(invoice, requestedLines, payload.type || 'goods_return');
    payload.lines = lineArray;
    payload.subtotal = lineArray.reduce((sum, line) => sum + line.lineSubtotal, 0);
    payload.taxAmount = lineArray.reduce((sum, line) => sum + line.lineTax, 0);
    payload.totalAmount = lineArray.reduce((sum, line) => sum + line.lineTotal, 0);

    const note = await CreditNote.create(payload);

    // If model pre-save didn't compute totals for some reason, ensure totals persist
    try {
      const hasRootTax =
        note.taxAmount !== undefined &&
        note.taxAmount !== null &&
        Number(note.taxAmount) > 0;
      if (
        !hasRootTax &&
        payload.lines &&
        Array.isArray(payload.lines) &&
        payload.lines.length > 0
      ) {
        const computed = payload.lines.reduce(
          (acc, l) => {
            const ls = Number(
              l.lineSubtotal || l.lineSubtotal === 0
                ? l.lineSubtotal
                : Number(l.quantity || 0) * Number(l.unitPrice || 0),
            );
            const lt = Number(
              l.lineTax || l.lineTax === 0
                ? l.lineTax
                : ls * (Number(l.taxRate || 0) / 100),
            );
            return {
              subtotal: acc.subtotal + (isNaN(ls) ? 0 : ls),
              totalTax: acc.totalTax + (isNaN(lt) ? 0 : lt),
            };
          },
          { subtotal: 0, totalTax: 0 },
        );

        if (computed.totalTax > 0 || computed.subtotal > 0) {
          note.subtotal = computed.subtotal;
          note.taxAmount = computed.totalTax;
          note.totalAmount = computed.subtotal + computed.totalTax;
          await note.save();
        }
      }
    } catch (e) {
      console.error("Error ensuring credit note totals persisted:", e);
    }

    // Send email notification for create
    if (req.body.sendEmail && note.status !== 'draft') {
      const company = await Company.findById(companyId);
      const client = await Client.findById(note.client);
      await sendCreditNoteEmail(note, company, client, 'created');
    }

    res.status(201).json({ success: true, data: note });
  } catch (err) {
    next(err);
  }
};

// Approve credit note: apply client balance adjustment and optional stock reversal
exports.approveCreditNote = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const note = await CreditNote.findOne({
      _id: req.params.id,
      company: companyId,
    });
    if (!note)
      return res.status(404).json({ success: false, message: "Not found" });
    if (note.status !== "draft")
      return res
        .status(400)
        .json({ success: false, message: "Only draft notes can be approved" });

    const refundRsnCd = req.body.refundRsnCd || req.body.rfdRsnCd || note.ebm?.rfdRsnCd;
    if (!refundRsnCd) {
      return res.status(400).json({
        success: false,
        code: "ERR_EBM_REFUND_REASON_REQUIRED",
        message: "RRA refund reason code is required before confirming this credit note.",
      });
    }

    const originalInvoiceForEbm = await Invoice.findOne({
      _id: note.invoice,
      company: companyId,
    }).select("referenceNo invoiceNumber ebm");
    if (!originalInvoiceForEbm?.ebm?.rcptNo || originalInvoiceForEbm.ebm.ebmStatus !== "submitted") {
      return res.status(409).json({
        success: false,
        code: "ERR_EBM_ORIGINAL_INVOICE_NOT_SUBMITTED",
        message: originalInvoiceForEbm?.ebm?.ebmStatus === "pending"
          ? "Original invoice EBM submission is still pending. Wait until it is submitted before confirming this credit note."
          : "Original invoice has not been submitted to RRA. Submit the original invoice before confirming this credit note.",
      });
    }
    note.ebm = note.ebm || {};
    note.ebm.orgRcptNo = String(originalInvoiceForEbm.ebm.rcptNo);
    note.ebm.rfdRsnCd = refundRsnCd;

    const creditAmount = Number(note.totalAmount || note.grandTotal || note.total || 0);
    const creditTax = Number(note.taxAmount || note.totalTax || 0);

    // Update client balance
    const client = await Client.findOne({
      _id: note.client,
      company: companyId,
    });
    if (client) {
      client.outstandingBalance = Number(client.outstandingBalance || 0) - creditAmount;
      if (client.outstandingBalance < 0) client.outstandingBalance = 0;
      await client.save();
    }

    // Update original invoice with credit note reference
    if (note.invoice) {
      const invoice = await Invoice.findOne({
        _id: note.invoice,
        company: companyId,
      });
      if (invoice) {
        if (!invoice.creditNotes) invoice.creditNotes = [];
        invoice.creditNotes.push({
          creditNoteId: note._id,
          creditNoteNumber: note.creditNoteNumber,
          amount: creditAmount,
          appliedDate: new Date(),
        });

        // Reduce the invoice balance by the credit note amount
        invoice.balance = Math.max(0, (invoice.balance || 0) - creditAmount);

        // Update invoice status based on new balance - but keep 'paid' status if it was paid
        // A credit note is a reduction of the invoice, not a partial payment
        if (invoice.balance <= 0) {
          invoice.status = "paid";
          if (!invoice.paidDate) {
            invoice.paidDate = new Date();
          }
        } else if (
          invoice.amountPaid > 0 &&
          invoice.amountPaid < invoice.grandTotal
        ) {
          // Only change to partial if there's actual partial payment, not just credit note
          invoice.status = "partial";
        }
        // Don't reduce amountPaid - the invoice was paid, credit note is a separate adjustment
        if (invoice.balance <= 0) {
          invoice.status = "paid";
          if (!invoice.paidDate) {
            invoice.paidDate = new Date();
          }
        } else if (
          invoice.amountPaid > 0 &&
          invoice.amountPaid < invoice.grandTotal
        ) {
          invoice.status = "partial";
        }

        await invoice.save();
      }
    }

    // Optionally reverse stock if requested via body.flag
    const { reverseStock } = req.body;
    if (reverseStock && note.items && note.items.length > 0) {
      if (note.stockReversed) {
        // already reversed
      } else {
        const cnLineProducts = await loadLineProducts(Product, note.items, companyId);
        for (const item of note.items) {
          const product = getLineProduct(cnLineProducts, item);
          if (product) {
            const previousStock = product.currentStock || 0;
            // If serial numbers provided, update each serial record
            let serialsProcessed = [];
            if (
              item.serialNumbers &&
              Array.isArray(item.serialNumbers) &&
              item.serialNumbers.length > 0
            ) {
              for (const s of item.serialNumbers) {
                if (!s) continue;
                const serialDoc = await SerialNumber.findOne({
                  company: companyId,
                  serialNumber: s.toUpperCase(),
                });
                if (serialDoc) {
                  const prev = serialDoc.status;
                  serialDoc.status = "returned";
                  // clear sale references
                  serialDoc.client = null;
                  serialDoc.invoice = null;
                  serialDoc.saleDate = null;
                  serialDoc.salePrice = null;
                  serialDoc.warrantyEndDate = null;
                  serialDoc.warrantyStartDate = null;
                  if (req.body.warehouseId)
                    serialDoc.warehouse = req.body.warehouseId;
                  await serialDoc.save();
                  serialsProcessed.push(serialDoc.serialNumber);
                }
              }
            }

            const qtyToAdd =
              item.serialNumbers && item.serialNumbers.length > 0
                ? item.serialNumbers.length
                : item.quantity || 0;
            const newStock = previousStock + qtyToAdd;

            // include serials in notes when available
            const notes =
              serialsProcessed.length > 0
                ? `Credit Note ${note.creditNoteNumber} - Return. Serials: ${serialsProcessed.join(",")}`
                : `Credit Note ${note.creditNoteNumber} - Return`;

            await StockMovement.create({
              company: companyId,
              product: product._id,
              type: "in",
              reason: "return",
              quantity: qtyToAdd,
              previousStock,
              newStock,
              unitCost: item.unitPrice || 0,
              totalCost: item.totalWithTax || 0,
              referenceType: "credit_note",
              referenceNumber: note.creditNoteNumber,
              referenceDocument: note._id,
              referenceModel: "CreditNote",
              notes,
              performedBy: req.user.id,
            });

            product.currentStock = newStock;
            await product.save();
          }
        }
        note.stockReversed = true;
      }
    }

    note.status = "issued";
    await note.save();

    // Calculate inventory cost for stock reversal (cost of goods sold)
    let inventoryCost = 0;
    if (reverseStock && note.items && note.items.length > 0) {
      const cnCostProducts = await loadLineProducts(Product, note.items, companyId);
      for (const item of note.items) {
        const product = getLineProduct(cnCostProducts, item);
        if (product && product.averageCost) {
          const qty = item.quantity || 0;
          inventoryCost += product.averageCost * qty;
        }
      }
    }

    // Get refund method from request (bank_transfer, cash, mobile_money, or ar)
    const refundMethod = req.body.refundMethod || "ar";
    let bankAccountCode = null;
    let bankAccount = null;
    if (
      (refundMethod === "bank_transfer" ||
        refundMethod === "cheque" ||
        refundMethod === "mobile_money") &&
      req.body.bankAccountId
    ) {
      bankAccount = await BankAccount.findOne({
        _id: req.body.bankAccountId,
        company: companyId,
        isActive: true,
      });
      if (!bankAccount) {
        bankAccount = await BankAccount.findOne({
          accountCode: req.body.bankAccountId,
          company: companyId,
          isActive: true,
        });
      }
      if (bankAccount && bankAccount.accountCode) {
        bankAccountCode = bankAccount.accountCode;
      }
    }

    // Create journal entry for credit note
    let journalEntry = null;
    try {
      journalEntry = await JournalService.createCreditNoteEntry(companyId, req.user.id, {
        _id: note._id,
        creditNoteNumber: note.creditNoteNumber,
        date: note.date,
        total: creditAmount,
        vatAmount: creditTax,
        refundMethod: refundMethod,
        bankAccountCode: bankAccountCode,
        inventoryCost: inventoryCost,
      });
    } catch (journalError) {
      console.error(
        "Error creating journal entry for credit note:",
        journalError,
      );
    }

    // Create BankTransaction when refunding to a bank account
    if (bankAccount && journalEntry) {
      try {
        await bankAccount.addTransaction({
          type: 'withdrawal',
          amount: note.grandTotal,
          description: `Credit note refund: ${note.creditNoteNumber}`,
          date: note.date || new Date(),
          referenceNumber: note.creditNoteNumber,
          referenceType: 'CreditNote',
          reference: note._id,
          createdBy: req.user.id,
          notes: 'Credit note refund to customer',
          journalEntryId: journalEntry._id,
        });
      } catch (btErr) {
        console.error('BankTransaction creation failed for credit note refund:', btErr.message);
      }
    }

    let responseNote = note;
    if (journalEntry) {
      try {
        responseNote = await EBMSalesService.submitCreditNote(note._id, {
          companyId,
          refundRsnCd,
          modifierUserId: req.user.id || req.user._id,
        });
      } catch (ebmError) {
        console.error("EBM refund submission failed after credit note confirmation:", ebmError.message);
        responseNote = ebmError.creditNote || await CreditNote.findOne({
          _id: note._id,
          company: companyId,
        }).populate("invoice client lines.product items.product createdBy");
      }
    }

    // This legacy approve path mutates Product.currentStock directly above
    // (the reverseStock branch) whenever it runs, bypassing the /api/products
    // and /api/stock/* route-level cache invalidation. bumpCompanyStockCaches
    // is a no-op-cost safety call even when reverseStock was false.
    try {
      const cacheService = require('../services/cacheService');
      if (reverseStock) {
        await cacheService.bumpCompanyStockCaches(companyId);
      }
      if (journalEntry) {
        await cacheService.invalidateByCompany(companyId, 'report');
      }
    } catch (cacheErr) {
      console.error('Cache invalidation after credit note approve failed:', cacheErr);
    }

    res.json({ success: true, data: responseNote });
  } catch (err) {
    next(err);
  }
};

// Apply credit note to a new invoice
exports.applyCreditNote = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { invoiceId } = req.body;
    if (!invoiceId) return res.status(400).json({ success: false, message: 'Target invoice is required.' });
    const note = await CreditNote.findOne({ _id: req.params.id, company: companyId });
    if (!note) return res.status(404).json({ success: false, message: 'Credit note not found.' });
    if (!['confirmed', 'issued', 'applied', 'partially_refunded'].includes(note.status)) {
      return res.status(409).json({ success: false, message: 'Only issued credit notes with available customer credit can be allocated.' });
    }

    const targetInvoice = await Invoice.findOne({ _id: invoiceId, company: companyId });
    if (!targetInvoice) return res.status(404).json({ success: false, message: 'Target invoice not found.' });
    if (toIdString(targetInvoice.client) !== toIdString(note.client)) {
      return res.status(422).json({ success: false, message: 'A credit note can only be allocated to an invoice for the same customer.' });
    }
    if (String(targetInvoice.currencyCode || 'RWF').toUpperCase() !== String(note.currencyCode || 'RWF').toUpperCase()) {
      return res.status(422).json({ success: false, message: 'Credit note and invoice currencies must match.' });
    }

    const targetOutstanding = Math.max(0, Number(targetInvoice.amountOutstanding ?? targetInvoice.balance ?? 0));
    const creditAvailable = Math.max(0,
      Number(note.amountAvailableAsCredit || 0)
      - Number(note.amountAppliedToOtherInvoices || 0)
      - Number(note.amountRefundedFromCredit || 0),
    );
    const requestedAmount = req.body.amount == null ? Math.min(creditAvailable, targetOutstanding) : Number(req.body.amount);
    if (!Number.isFinite(requestedAmount) || requestedAmount <= 0 || requestedAmount > creditAvailable || requestedAmount > targetOutstanding) {
      return res.status(422).json({ success: false, message: `Allocation must be positive and no more than the available credit (${creditAvailable}) or invoice balance (${targetOutstanding}).` });
    }

    const { runInTransaction } = require('../services/transactionService');
    const { dbClient } = require('../lib/prisma');
    const { DEFAULT_ACCOUNTS } = require('../constants/chartOfAccounts');
    const appliedAt = new Date();
    await runInTransaction(async () => {
      const freshInvoice = await Invoice.findOne({ _id: invoiceId, company: companyId });
      const freshClient = await Client.findOne({ _id: note.client, company: companyId });
      if (!freshInvoice || !freshClient) throw new Error('The target invoice or customer no longer exists.');
      const updatedRows = await dbClient().$queryRaw`
        UPDATE credit_notes
        SET amount_applied_to_other_invoices = amount_applied_to_other_invoices + ${requestedAmount},
            applications = COALESCE(applications, '[]'::jsonb) || ${JSON.stringify([{ invoiceId: String(invoiceId), amount: requestedAmount, appliedAt, appliedBy: String(req.user.id) }])}::jsonb,
            status = 'applied',
            updated_at = NOW()
        WHERE id = ${String(note._id)}
          AND company_id = ${String(companyId)}
          AND status IN ('confirmed', 'issued', 'applied', 'partially_refunded')
          AND amount_applied_to_other_invoices + amount_refunded_from_credit + ${requestedAmount} <= amount_available_as_credit
        RETURNING id`;
      if (!updatedRows.length) {
        const conflict = new Error('This customer credit has already been allocated or refunded. Refresh and try again.');
        conflict.statusCode = 409;
        throw conflict;
      }

      freshInvoice.amountOutstanding = Math.max(0, targetOutstanding - requestedAmount);
      freshInvoice.status = freshInvoice.amountOutstanding <= 0
        ? 'fully_paid'
        : Number(freshInvoice.amountPaid || 0) > 0 ? 'partially_paid' : 'confirmed';
      if (freshInvoice.amountOutstanding <= 0) freshInvoice.paidDate = new Date();
      await freshInvoice.save();

      freshClient.outstandingBalance = Math.max(0, Number(freshClient.outstandingBalance || 0) - requestedAmount);
      await freshClient.save();

      const journalEntry = await JournalService.createEntry(companyId, req.user.id, {
        date: appliedAt,
        description: `Credit Note ${note.referenceNo || note.creditNoteNumber} allocated to Invoice ${freshInvoice.referenceNo || freshInvoice.invoiceNumber}`,
        sourceType: 'credit_note_application',
        sourceId: note._id,
        sourceReference: note.referenceNo || note.creditNoteNumber,
        lines: [
          JournalService.createDebitLine(DEFAULT_ACCOUNTS.customerAdvances, requestedAmount, 'Apply customer credit'),
          JournalService.createCreditLine(DEFAULT_ACCOUNTS.accountsReceivable, requestedAmount, 'Apply customer credit'),
        ],
        isAutoGenerated: true,
      });
      if (!journalEntry) throw new Error('The credit allocation journal entry could not be created.');

      await require('../services/arTrackingService').recordCreditNoteApplied(
        note,
        freshInvoice,
        requestedAmount,
        req.user.id,
        { required: true, invoiceBalanceAfter: freshInvoice.amountOutstanding, clientBalanceAfter: freshClient.outstandingBalance },
      );
    });

    const updatedNote = await CreditNote.findOne({ _id: req.params.id, company: companyId });
    res.json({ success: true, data: updatedNote, message: `Credit note allocated to invoice ${targetInvoice.referenceNo || targetInvoice.invoiceNumber}.` });
  } catch (err) {
    next(err);
  }
};

// Record refund (money returned to client)
exports.recordRefund = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { amount, paymentMethod, reference } = req.body;
    const note = await CreditNote.findOne({
      _id: req.params.id,
      company: companyId,
    });
    if (!note)
      return res.status(404).json({ success: false, message: "Not found" });
    if (
      note.status !== "confirmed" &&
      note.status !== "issued" &&
      note.status !== "applied" &&
      note.status !== "partially_refunded"
    )
      return res.status(400).json({
        success: false,
        message: "Only confirmed/issued/applied credit notes can be refunded",
      });

    const refundAmount = Number(amount);
    if (!Number.isFinite(refundAmount) || refundAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Refund amount must be a positive number.' });
    }
    const normalizedMethod = String(paymentMethod || '').trim().toLowerCase();
    const bankMethods = ['bank', 'bank_transfer', 'mobile_money', 'cheque'];
    if (!['cash', ...bankMethods].includes(normalizedMethod)) {
      return res.status(400).json({ success: false, message: 'Select a supported refund payment method.' });
    }

    const payments = Array.isArray(note.payments) ? note.payments : [];
    const previouslyRefunded = Number(note.amountRefunded)
      || payments.reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0);
    const creditTotal = Number(note.totalAmount || note.grandTotal || 0);
    const remaining = Math.max(0, creditTotal - previouslyRefunded);
    const customerCreditTotal = Number(note.amountAvailableAsCredit || 0);
    const arAppliedTotal = Number(note.amountAppliedToAR)
      || Math.max(0, creditTotal - customerCreditTotal - previouslyRefunded);
    const refundedFromCredit = Number(note.amountRefundedFromCredit || 0);
    const refundedFromAR = Number(note.amountRefundedFromAR || 0);
    const availableCustomerCredit = Math.max(0, customerCreditTotal - refundedFromCredit);
    const availableARCredit = Math.max(0, arAppliedTotal - refundedFromAR);
    const refundFromCustomerCredit = Math.min(refundAmount, availableCustomerCredit);
    const refundFromAR = refundAmount - refundFromCustomerCredit;
    if (refundAmount > remaining || refundFromAR > availableARCredit)
      return res.status(400).json({
        success: false,
        message: "Refund amount exceeds credit note balance",
      });

    let bankAccount = null;
    if (bankMethods.includes(normalizedMethod) && !req.body.bankAccountId) {
      return res.status(400).json({ success: false, message: 'Select the bank or mobile-money account used to pay this refund.' });
    }
    if (req.body.bankAccountId) {
      bankAccount = await BankAccount.findOne({
        _id: req.body.bankAccountId,
        company: companyId,
        isActive: true,
      });
      if (!bankAccount) return res.status(404).json({ success: false, message: 'The selected refund account was not found or is inactive.' });
    }

    let refundTill = null;
    if (note.posOrigin) {
      const { prisma } = require('../lib/prisma');
      refundTill = await prisma.tillSession.findFirst({
        where: { companyId: String(companyId), openedById: String(req.user.id), status: 'open' },
        orderBy: { openedAt: 'desc' },
        select: { id: true, registerId: true },
      });
      if (!refundTill) {
        return res.status(409).json({ success: false, code: 'POS_REFUND_TILL_REQUIRED', message: 'Open your POS till before recording a refund so the refund appears in the shift report.' });
      }
    }

    const { runInTransaction } = require('../services/transactionService');
    const { dbClient } = require('../lib/prisma');
    const { DEFAULT_ACCOUNTS } = require('../constants/chartOfAccounts');
    await runInTransaction(async () => {
      if (note.posOrigin) {
        await consumePosManagerApproval({
          approvalId: req.body.posManagerApprovalId,
          companyId,
          cashierId: req.user.id,
          action: 'refund',
          subjectId: String(note._id),
          payload: {
            creditNoteId: String(note._id),
            amount: refundAmount,
            paymentMethod: normalizedMethod,
            reference: String(reference || '').trim(),
          },
        });
      }

      const refundDate = new Date();
      const creditReference = note.creditNoteNumber || note.referenceNo;
      const cashAccount = bankAccount
        ? (bankAccount.ledgerAccountId || bankAccount.accountCode)
        : DEFAULT_ACCOUNTS.cashInHand;
      if (!cashAccount) throw new Error('The selected bank account has no linked general-ledger account.');

      // Settle customer advances first. Refunding the part that was applied
      // to open AR reopens that receivable; it never rewrites original cash.
      const journalEntry = await JournalService.createEntry(companyId, req.user.id, {
        date: new Date(),
        description: `Refund for Credit Note ${creditReference}`,
        sourceType: "credit_note_refund",
        sourceId: note._id,
        sourceReference: creditReference,
        lines: [
          ...(refundFromAR > 0 ? [JournalService.createDebitLine(
            DEFAULT_ACCOUNTS.accountsReceivable,
            refundFromAR,
            `Refund for Credit Note ${creditReference}`,
          )] : []),
          ...(refundFromCustomerCredit > 0 ? [JournalService.createDebitLine(
            DEFAULT_ACCOUNTS.customerAdvances,
            refundFromCustomerCredit,
            `Refund of customer credit for Credit Note ${creditReference}`,
          )] : []),
          JournalService.createCreditLine(
            cashAccount,
            refundAmount,
            `Refund for Credit Note ${creditReference}`,
          ),
        ],
        isAutoGenerated: true,
      });

      const refundPayment = {
        amount: refundAmount,
        paymentMethod: normalizedMethod,
        reference: String(reference || '').trim() || null,
        refundedBy: req.user.id,
        refundedAt: refundDate,
        bankAccountId: bankAccount?._id || null,
        tillSessionId: refundTill?.id || null,
        registerId: refundTill?.registerId || null,
        journalEntryId: journalEntry?._id || null,
        arAmount: refundFromAR,
        customerCreditAmount: refundFromCustomerCredit,
      };
      const appendedPayment = JSON.stringify([refundPayment]);
      const updatedRows = await dbClient().$queryRaw`
        UPDATE credit_notes
        SET amount_refunded = amount_refunded + ${refundAmount},
            amount_refunded_from_ar = amount_refunded_from_ar + ${refundFromAR},
            amount_refunded_from_credit = amount_refunded_from_credit + ${refundFromCustomerCredit},
            payments = COALESCE(payments, '[]'::jsonb) || ${appendedPayment}::jsonb,
            status = CASE
              WHEN amount_refunded + ${refundAmount} >= total_amount THEN 'refunded'
              ELSE 'partially_refunded'
            END,
            updated_at = NOW()
        WHERE id = ${String(note._id)}
          AND company_id = ${String(companyId)}
          AND status IN ('confirmed', 'issued', 'applied', 'partially_refunded')
          AND amount_refunded + ${refundAmount} <= total_amount
          AND amount_refunded_from_ar + ${refundFromAR} <= amount_applied_to_ar
          AND amount_refunded_from_credit + ${refundFromCustomerCredit} <= amount_available_as_credit
        RETURNING id`;
      if (!updatedRows.length) {
        const conflict = new Error('This credit note has already been refunded up to its available balance. Refresh and try again.');
        conflict.statusCode = 409;
        throw conflict;
      }

      if (normalizedMethod === 'cash' && refundTill) {
        const { dbClient } = require('../lib/prisma');
        const activity = {
          type: 'cash_refund',
          amount: refundAmount,
          creditNoteId: String(note._id),
          reference: creditReference,
          recordedBy: String(req.user.id),
          recordedAt: refundDate.toISOString(),
        };
        const updatedTill = await dbClient().$executeRawUnsafe(
          'UPDATE till_sessions SET expected_cash = expected_cash - $1::numeric, cash_activity = cash_activity || $2::jsonb, updated_at = CURRENT_TIMESTAMP WHERE company_id = $3 AND id = $4 AND opened_by = $5 AND status = \'open\'',
          refundAmount, JSON.stringify([activity]), String(companyId), String(refundTill.id), String(req.user.id),
        );
        if (updatedTill !== 1) {
          const error = new Error('The till closed while this refund was being recorded. No refund was completed.');
          error.code = 'POS_TILL_SESSION_CHANGED';
          error.statusCode = 409;
          throw error;
        }
      }

      if (refundFromAR > 0) {
        const invoice = await Invoice.findOne({ _id: note.invoice, company: companyId });
        if (!invoice) throw new Error('The original invoice for this credit note is missing.');
        invoice.amountOutstanding = Number(invoice.amountOutstanding || 0) + refundFromAR;
        invoice.status = Number(invoice.amountOutstanding) <= 0
          ? 'fully_paid'
          : Number(invoice.amountPaid || 0) > 0
            ? 'partially_paid'
            : 'confirmed';
        invoice.paidDate = null;
        await invoice.save();

        const client = await Client.findOne({ _id: note.client, company: companyId });
        if (!client) throw new Error('The customer account for this credit note is missing.');
        client.outstandingBalance = Number(client.outstandingBalance || 0) + refundFromAR;
        await client.save();
        await require('../services/arTrackingService').recordCreditNoteRefund(
          note,
          invoice,
          refundFromAR,
          req.user.id,
          { required: true, invoiceBalanceAfter: invoice.amountOutstanding, clientBalanceAfter: client.outstandingBalance },
        );
      }

      if (bankAccount) {
        await bankAccount.addTransaction({
          type: 'withdrawal',
          amount: refundAmount,
          description: `Credit note refund: ${creditReference}`,
          date: refundDate,
          referenceNumber: creditReference,
          referenceType: 'CreditNote',
          reference: note._id,
          createdBy: req.user.id,
          notes: 'Credit note refund to customer',
          journalEntryId: journalEntry._id,
        });
      }
    });

    const updatedNote = await CreditNote.findOne({ _id: req.params.id, company: companyId });
    res.json({ success: true, data: updatedNote });
  } catch (err) {
    next(err);
  }
};

// Delete (only drafts)
exports.deleteCreditNote = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const note = await CreditNote.findOne({
      _id: req.params.id,
      company: companyId,
    });
    if (!note)
      return res.status(404).json({ success: false, message: "Not found" });
    if (note.status !== "draft")
      return res
        .status(400)
        .json({ success: false, message: "Only draft notes can be deleted" });
    await note.deleteOne();
    res.json({ success: true, message: "Deleted" });
  } catch (err) {
    next(err);
  }
};

// =====================================================
// MODULE 8 - Credit Notes Confirmation Logic
// =====================================================

// Module 8 Error Codes
const ERR_CREDIT_NOT_FOUND = "ERR_CREDIT_NOT_FOUND";
const ERR_CREDIT_CONFIRMED = "ERR_CREDIT_CONFIRMED";
const ERR_CREDIT_CANCELLED = "ERR_CREDIT_CANCELLED";
const ERR_INVOICE_NOT_CONFIRMED = "ERR_INVOICE_NOT_CONFIRMED";
const ERR_EXCEEDS_INVOICE_QTY = "ERR_EXCEEDS_INVOICE_QTY";
const ERR_PRICE_MISMATCH = "ERR_PRICE_MISMATCH";
const ERR_SERIAL_NOT_DISPATCHED = "ERR_SERIAL_NOT_DISPATCHED";
const ERR_INVENTORY_UPDATE_FAILED = "ERR_INVENTORY_UPDATE_FAILED";

// Update credit note (draft only)
exports.updateCreditNote = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const note = await CreditNote.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!note) {
      return res.status(404).json({
        success: false,
        code: ERR_CREDIT_NOT_FOUND,
        message: "Credit note not found",
      });
    }

    // Only draft credit notes can be updated
    if (note.status !== "draft") {
      return res.status(409).json({
        success: false,
        code: ERR_CREDIT_CONFIRMED,
        message: "Cannot update credit note with status: " + note.status,
      });
    }

    const { reason, type, creditDate, notes, lines } = req.body;

    if (reason !== undefined) note.reason = reason;
    if (type) note.type = type;
    if (creditDate) note.creditDate = creditDate;
    if (notes !== undefined) note.notes = notes;

    // Update lines if provided - calculate line totals before saving
    if (lines && Array.isArray(lines)) {
      const sourceInvoice = await Invoice.findOne({ _id: note.invoice, company: companyId });
      if (!sourceInvoice) return res.status(404).json({ success: false, message: 'Original invoice not found.' });
      note.lines = normalizeCreditNoteLines(sourceInvoice, lines, note.type);
      note.subtotal = note.lines.reduce((sum, line) => sum + Number(line.lineSubtotal || 0), 0);
      note.taxAmount = note.lines.reduce((sum, line) => sum + Number(line.lineTax || 0), 0);
      note.totalAmount = note.lines.reduce((sum, line) => sum + Number(line.lineTotal || 0), 0);
    }

    await note.save();
    await note.populate("client lines.product createdBy invoice");
    await note.populate("lines.returnToWarehouse");

    res.json({ success: true, data: note });
  } catch (err) {
    next(err);
  }
};

// Confirm credit note - triggers dual journal reversal + stock return
exports.confirmCreditNote = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const creditNoteId = req.params.id;

    // Find credit note with populated data
    console.log("DEBUG: creditNoteId =", creditNoteId);
    let creditNote = await CreditNote.findOne({
      _id: creditNoteId,
      company: companyId,
    })
      .populate("lines.product")
      .populate("invoice")
      .populate("client")
      .populate("lines.returnToWarehouse");

    console.log("DEBUG: creditNote =", creditNote ? "found" : "not found");
    console.log("DEBUG: creditNote.invoice =", creditNote?.invoice);

    if (!creditNote) {
      return res.status(404).json({
        success: false,
        code: ERR_CREDIT_NOT_FOUND,
        message: "Credit note not found",
      });
    }

    // Validate status is draft
    if (creditNote.status !== "draft") {
      return res.status(400).json({
        success: false,
        code: ERR_CREDIT_CONFIRMED,
        message: "Cannot confirm credit note with status: " + creditNote.status,
      });
    }

    // ========== STEP 1: VALIDATION ==========
    const invoice = await Invoice.findById(creditNote.invoice).populate(
      "lines.product",
    );
    if (!invoice) {
      return res.status(404).json({
        success: false,
        code: ERR_CREDIT_NOT_FOUND,
        message: "Invoice not found",
      });
    }

    // Invoice must be confirmed, partially_paid, or fully_paid
    const validInvoiceStatuses = ["confirmed", "partially_paid", "fully_paid"];
    console.log("DEBUG: invoice.status =", invoice.status);
    console.log("DEBUG: validInvoiceStatuses =", validInvoiceStatuses);
    if (!invoice.status || !validInvoiceStatuses.includes(invoice.status)) {
      console.log("DEBUG: Invoice validation failed - returning 400");
      return res.status(400).json({
        success: false,
        code: ERR_INVOICE_NOT_CONFIRMED,
        message: "Invoice must be confirmed, partially paid, or fully paid",
      });
    }

    // Use lines array (Module 8) or items (legacy)
    const lineArray =
      creditNote.lines && creditNote.lines.length > 0
        ? creditNote.lines
        : creditNote.items;

    if (!lineArray || lineArray.length === 0) {
      return res.status(400).json({
        success: false,
        code: "ERR_EMPTY_CREDIT_NOTE",
        message: "Credit note has no line items. Please add products to the credit note before confirming.",
      });
    }

    const serialReturnPlans = new Map();
    const serialsReturnedByProduct = new Set();
    for (const line of lineArray) {
      // Find original invoice line
      const invoiceLine = invoice.lines.id(line.invoiceLineId);
      if (!invoiceLine) {
        return res.status(400).json({
          success: false,
          code: "ERR_INVALID_INVOICE_LINE",
          message: "Invoice line not found",
        });
      }

      // Validate qty doesn't exceed remaining
      const alreadyCredited = invoiceLine.qtyCredited || 0;
      const invoiceQty = invoiceLine.quantity || invoiceLine.qty || 0;
      const remainingQty = invoiceQty - alreadyCredited;
      if (!Number.isFinite(Number(line.quantity)) || Number(line.quantity) <= 0 || line.quantity > remainingQty) {
        return res.status(422).json({
          success: false,
          code: ERR_EXCEEDS_INVOICE_QTY,
          message:
            "Credit qty (" +
            line.quantity +
            ") exceeds remaining invoice qty (" +
            remainingQty +
            ")",
        });
      }

      // Validate unit price matches original
      if (line.unitPrice !== invoiceLine.unitPrice) {
        return res.status(400).json({
          success: false,
          code: ERR_PRICE_MISMATCH,
          message: "Unit price must match original invoice line",
        });
      }

      const product = line.product;
      const trackingType = product?.trackingType || 'none';
      if (creditNote.type === 'goods_return' && product?.isStockable !== false && !line.returnToWarehouse) {
        return res.status(422).json({ success: false, code: 'ERR_RETURN_WAREHOUSE_REQUIRED', message: `Select a return warehouse for ${product?.name || line.productName}.` });
      }
      if (trackingType === 'serial') {
        const serialNumbers = Array.isArray(line.serialNumbers)
          ? line.serialNumbers.map((serial) => String(serial || '').trim()).filter(Boolean)
          : [];
        if (serialNumbers.length !== Number(line.quantity)) {
          return res.status(422).json({ success: false, code: 'ERR_SERIAL_COUNT_MISMATCH', message: `Select exactly ${line.quantity} serial number(s) for ${product.name}.` });
        }
        const normalizedSerials = serialNumbers.map((serial) => serial.toUpperCase());
        if (new Set(normalizedSerials).size !== normalizedSerials.length) {
          return res.status(422).json({ success: false, code: 'ERR_DUPLICATE_RETURN_SERIAL', message: `Enter a different serial number for each returned ${product.name}.` });
        }

        const existingSerialIds = [];
        const missingSerialNumbers = [];
        for (const serialValue of serialNumbers) {
          const productId = toIdString(product);
          const productSerialKey = `${productId}:${serialValue.toUpperCase()}`;
          if (serialsReturnedByProduct.has(productSerialKey)) {
            return res.status(422).json({ success: false, code: 'ERR_DUPLICATE_RETURN_SERIAL', message: `Serial ${serialValue} is listed more than once for ${product.name}.` });
          }
          serialsReturnedByProduct.add(productSerialKey);

          let serial = null;
          if (/^[a-f\d]{24}$/i.test(serialValue)) {
            serial = await StockSerialNumber.findOne({
              _id: serialValue,
              company: companyId,
              product: productId,
            });
          }
          if (!serial) {
            serial = await StockSerialNumber.findOne({
              serialNo: serialValue.toUpperCase(),
              company: companyId,
              product: productId,
            });
          }

          if (!serial) {
            missingSerialNumbers.push(serialValue.toUpperCase());
          } else if (serial.status !== 'dispatched') {
            return res.status(400).json({
              success: false,
              code: ERR_SERIAL_NOT_DISPATCHED,
              message: `Serial ${serial.serialNo} is ${serial.status}; only dispatched serials can be returned.`,
            });
          } else {
            existingSerialIds.push(serial._id);
          }
        }
        serialReturnPlans.set(line, { existingSerialIds, missingSerialNumbers });
      }
      if (trackingType === 'batch' && !line.batchId) {
        return res.status(422).json({ success: false, code: 'ERR_BATCH_REQUIRED', message: `Select the returned batch for ${product.name}.` });
      }
    }

    // ========== STEP 2-5: Execute in transaction ==========
    const { runInTransaction } = require("../services/transactionService");
    const inventoryService = require("../services/inventoryService");
    const JournalService = require("../services/journalService");
    const Product = require("../models/Product");
    const StockMovement = require("../models/StockMovement");
    const StockBatch = require("../models/StockBatch");
    const StockLevel = require("../models/StockLevel");
    const Warehouse = require("../models/Warehouse");
    const ChartOfAccount = require("../models/ChartOfAccount");
    const { DEFAULT_ACCOUNTS } = require("../constants/chartOfAccounts");

    await runInTransaction(async (session) => {
      const { dbClient } = require('../lib/prisma');
      const claimed = await dbClient().$queryRaw`
        UPDATE credit_notes
        SET status = 'processing'
        WHERE id = ${String(creditNoteId)}
          AND company_id = ${String(companyId)}
          AND status = 'draft'
        RETURNING id`;
      if (!claimed.length) {
        const conflict = new Error('This credit note is already being processed or is no longer a draft. Refresh the page.');
        conflict.statusCode = 409;
        throw conflict;
      }
      if (creditNote.posOrigin) {
        const refundAmount = Number(creditNote.totalAmount || creditNote.grandTotal || creditNote.total || 0);
        await consumePosManagerApproval({
          approvalId: req.body.posManagerApprovalId,
          companyId,
          cashierId: req.user.id,
          action: 'refund',
          subjectId: String(creditNote._id),
          payload: { invoiceId: String(invoice._id), creditNoteId: String(creditNote._id), refundAmount },
        });
      }
      // Calculate totals for journal entries
      let totalSubtotal = 0;
      let totalTax = 0;
      let totalCogs = 0;

      const isGoodsReturn = creditNote.type === "goods_return";

      // Process each line from the immutable source invoice values.
      for (const line of lineArray) {
        const product = line.product;
        if (!product) throw new Error(`Product on credit note line ${line.productName || ''} is missing.`);

        // Get taxRate from credit note line or fall back to invoice line
        let taxRate = line.taxRate;
        if (!taxRate && line.invoiceLineId) {
          const invoiceLine = invoice.lines.id(line.invoiceLineId);
          if (invoiceLine) {
            taxRate = invoiceLine.taxRate;
          }
        }
        console.log(
          "DEBUG: line.taxRate =",
          line.taxRate,
          "taxRate from invoice =",
          taxRate,
          "line.quantity =",
          line.quantity,
          "line.unitPrice =",
          line.unitPrice,
        );
        const lineSubtotal = Number(line.lineSubtotal ?? ((line.quantity || 0) * (line.unitPrice || 0)));
        const lineTax = Number(line.lineTax ?? (lineSubtotal * ((taxRate || 0) / 100)));
        const lineCogs = (line.unitCost || 0) * (line.quantity || 0);

        console.log(
          "DEBUG: lineSubtotal =",
          lineSubtotal,
          "lineTax =",
          lineTax,
        );
        totalSubtotal += lineSubtotal;
        totalTax += lineTax;
        totalCogs += lineCogs;

        // ========== STEP 4: Return stock to warehouse (goods return only) ==========
        if (isGoodsReturn && product.isStockable) {
          const warehouseId = toIdString(line.returnToWarehouse);
          const warehouse = warehouseId
            ? await Warehouse.findOne({ _id: warehouseId, company: companyId, isActive: true }).session(session)
            : null;
          if (!warehouse) throw new Error(`Select an active return warehouse for ${product.name}.`);

          // Add stock using inventory service createLayer
          await inventoryService.createLayer(
            companyId,
            product._id,
            line.quantity,
            line.unitCost || 0,
            { type: 'credit_note', reference: creditNote.referenceNo },
            {
              warehouse: warehouse._id,
              session,
              userId: req.user.id,
            },
          );
          await StockLevel.recalculateWAC(companyId, product._id, warehouse._id, Number(line.quantity), Number(line.unitCost || 0));

          // Update batch if batch-tracked
          if (line.batchId) {
            const batchUpdate = await StockBatch.updateMany(
              { _id: line.batchId, company: companyId, product: product._id },
              { $inc: { qtyOnHand: Number(line.quantity) } },
            );
            if (batchUpdate.matchedCount !== 1) throw new Error(`The batch selected for ${product.name} could not be found.`);
          }

          // Update serial numbers if serial-tracked
          const serialReturnPlan = serialReturnPlans.get(line);
          if (serialReturnPlan?.existingSerialIds.length) {
            const serialUpdate = await StockSerialNumber.updateMany(
              { _id: { $in: serialReturnPlan.existingSerialIds }, company: companyId, product: product._id, status: 'dispatched' },
              {
                status: "in_stock",
                returnedVia: creditNote._id,
                returnedAt: new Date(),
                warehouse: warehouse._id,
                dispatchedVia: null,
                dispatchedAt: null,
              },
              { session },
            );
            if (serialUpdate.matchedCount !== serialReturnPlan.existingSerialIds.length) throw new Error(`One or more serial numbers for ${product.name} are not currently dispatched.`);
          }
          if (serialReturnPlan?.missingSerialNumbers.length) {
            for (const serialNo of serialReturnPlan.missingSerialNumbers) {
              await StockSerialNumber.create({
                company: companyId,
                product: product._id,
                warehouse: warehouse._id,
                serialNo,
                unitCost: line.unitCost || 0,
                status: 'in_stock',
                returnedVia: creditNote._id,
                returnedAt: new Date(),
                notes: `Serial record restored through credit note ${creditNote.referenceNo}.`,
              });
            }
          }

          // Create stock movement
          // Use Number() to avoid string concatenation (currentStock can be Decimal128 string)
          const previousStock = Number(product.currentStock) || 0;
          const newStock = previousStock + Number(line.quantity);

          await StockMovement.create(
            [
              {
                company: companyId,
                product: product._id,
              warehouse: warehouse._id,
                type: "in",
                reason: "return",
                quantity: line.quantity,
                previousStock,
                newStock,
                unitCost: line.unitCost || 0,
                totalCost: lineCogs,
                sourceType: "credit_note",
                sourceId: creditNote._id,
                referenceNumber:
                  creditNote.referenceNo || creditNote.creditNoteNumber,
                notes:
                  "CN#" +
                  (creditNote.referenceNo || creditNote.creditNoteNumber) +
                  " - Return",
                performedBy: req.user.id,
                movementDate: new Date(),
              },
            ],
            { session },
          );

          // Update product stock
          await Product.findByIdAndUpdate(product._id, { $inc: { currentStock: Number(line.quantity) } }, { session });
        }

        // ========== Track qty credited on invoice line ==========
        const invoiceLine = invoice.lines.id(line.invoiceLineId);
        if (invoiceLine) {
          invoiceLine.qtyCredited =
            (invoiceLine.qtyCredited || 0) + line.quantity;
          const invoiceLineUpdate = await dbClient().invoiceLine.updateMany({
            where: {
              id: String(invoiceLine._id || invoiceLine.id),
              companyId: String(companyId),
              qtyCredited: { lte: Number(invoiceLine.qty) - Number(line.quantity) },
            },
            data: { qtyCredited: { increment: Number(line.quantity) } },
          });
          if (invoiceLineUpdate.count !== 1) {
            const conflict = new Error(`The remaining quantity on invoice line ${line.productName || ''} changed while this credit note was being confirmed.`);
            conflict.statusCode = 409;
            throw conflict;
          }
        }
      }

      // ========== STEP 2: Post Revenue Reversal Journal Entry (Entry A) ==========
      const totalAmount = totalSubtotal + totalTax;
      const outstandingBeforeCredit = Math.max(0, Number(invoice.amountOutstanding ?? invoice.balance ?? 0));
      const amountAppliedToAR = Math.min(totalAmount, outstandingBeforeCredit);
      const amountAvailableAsCredit = Math.max(0, totalAmount - amountAppliedToAR);
      creditNote.amountAppliedToAR = amountAppliedToAR;
      creditNote.amountAvailableAsCredit = amountAvailableAsCredit;
      const narration =
        "Credit Note - " +
        (creditNote.client?.name || "Client") +
        " - CN#" +
        (creditNote.referenceNo || creditNote.creditNoteNumber) +
        " - Ref INV#" +
        (invoice.invoiceNumber || invoice._id);

      console.log(
        "DEBUG: Creating revenue + COGS entries with totalSubtotal =",
        totalSubtotal,
        "totalTax =",
        totalTax,
        "totalAmount =",
        totalAmount,
      );

      // Credit notes use Sales Returns account (4100), not Sales Revenue (4000)
      // Sales Returns is a contra-revenue account that increases with debit
      let salesReturnsAccount = DEFAULT_ACCOUNTS.salesReturns;
      if (lineArray[0] && lineArray[0].product) {
        const firstProduct = await Product.findById(
          lineArray[0].product._id,
        ).session(session);
        if (firstProduct && firstProduct.revenueAccount) {
          // revenueAccount might be an ObjectId or account code
          const revenueAccountId = firstProduct.revenueAccount;
          // Only query by _id if it looks like a valid ObjectId (24 hex chars)
          const isValidObjectId = /^[0-9a-fA-F]{24}$/.test(revenueAccountId);
          const revenueQuery = isValidObjectId
            ? { $or: [{ _id: revenueAccountId }, { accountCode: revenueAccountId }], company: companyId }
            : { accountCode: revenueAccountId, company: companyId };
          const revenueAcct = await ChartOfAccount.findOne(revenueQuery).session(session);
          if (revenueAcct && revenueAcct.accountCode) {
            // Map revenue account to corresponding returns account if possible
            // For now, default to salesReturns
            salesReturnsAccount = DEFAULT_ACCOUNTS.salesReturns;
          }
        }
      }

      // Build revenue reversal lines with proper debit/credit amounts
      // Credit the open invoice first. Any value beyond its receivable becomes
      // a customer advance liability that can later be refunded or allocated.
      const revenueLines = [
        {
          accountCode: salesReturnsAccount,
          accountName: 'Sales Returns',
          description: narration,
          debit: totalSubtotal,
          credit: 0,
        },
        ...(totalTax > 0 ? [{
          accountCode: DEFAULT_ACCOUNTS.vatOutput || '2220',
          accountName: 'VAT Output',
          description: narration,
          debit: totalTax,
          credit: 0,
        }] : []),
        ...(amountAppliedToAR > 0 ? [{
          accountCode: DEFAULT_ACCOUNTS.accountsReceivable,
          accountName: 'Accounts Receivable',
          description: narration,
          debit: 0,
          credit: amountAppliedToAR,
        }] : []),
        ...(amountAvailableAsCredit > 0 ? [{
          accountCode: DEFAULT_ACCOUNTS.customerAdvances,
          accountName: 'Customer Deposits and Advances',
          description: narration,
          debit: 0,
          credit: amountAvailableAsCredit,
        }] : []),
      ];

      // Build COGS lines if goods return
      let cogsLines = null;
      if (isGoodsReturn && totalCogs > 0) {
        let inventoryAccount = DEFAULT_ACCOUNTS.inventory;
        let cogsAccount = DEFAULT_ACCOUNTS.costOfGoodsSold;
        if (lineArray[0] && lineArray[0].product) {
          const firstProduct = await Product.findById(
            lineArray[0].product._id,
          ).session(session);
          if (firstProduct) {
            if (firstProduct.inventoryAccount) {
              const invId = firstProduct.inventoryAccount;
              const isValidInvId = /^[0-9a-fA-F]{24}$/.test(invId);
              const invQuery = isValidInvId
                ? { $or: [{ _id: invId }, { accountCode: invId }], company: companyId }
                : { accountCode: invId, company: companyId };
              const inventoryAcct = await ChartOfAccount.findOne(invQuery).session(session);
              if (inventoryAcct && inventoryAcct.accountCode) {
                inventoryAccount = inventoryAcct.accountCode;
              }
            }
            if (firstProduct.cogsAccount) {
              const cogsId = firstProduct.cogsAccount;
              const isValidCogsId = /^[0-9a-fA-F]{24}$/.test(cogsId);
              const cogsQuery = isValidCogsId
                ? { $or: [{ _id: cogsId }, { accountCode: cogsId }], company: companyId }
                : { accountCode: cogsId, company: companyId };
              const cogsAcct = await ChartOfAccount.findOne(cogsQuery).session(session);
              if (cogsAcct && cogsAcct.accountCode) {
                cogsAccount = cogsAcct.accountCode;
              }
            }
          }
        }
        const cogsNarration =
          "COGS Reversal - " +
          (creditNote.client?.name || "Client") +
          " - CN#" +
          (creditNote.referenceNo || creditNote.creditNoteNumber);
        cogsLines = [
          {
            accountCode: inventoryAccount,
            accountName: "Inventory",
            debit: totalCogs,
            credit: 0,
            description: cogsNarration,
          },
          {
            accountCode: cogsAccount,
            accountName: "Cost of Goods Sold",
            debit: 0,
            credit: totalCogs,
            description: cogsNarration,
          },
        ];
      }

      // Prepare entries array
      const entriesToCreate = [
        {
          date: new Date(),
          description: narration,
          sourceType: "credit_note",
          sourceId: creditNote._id,
          sourceReference:
            creditNote.referenceNo || creditNote.creditNoteNumber,
          lines: revenueLines,
          isAutoGenerated: true,
        },
      ];
      if (cogsLines) {
        entriesToCreate.push({
          date: new Date(),
          description: `COGS Reversal - ${creditNote.referenceNo || creditNote.creditNoteNumber}`,
          sourceType: "credit_note_cogs",
          sourceId: creditNote._id,
          sourceReference: `CN-COGS-${creditNote.referenceNo || creditNote.creditNoteNumber}`,
          lines: cogsLines,
          isAutoGenerated: true,
        });
      }

      const created = await JournalService.createEntriesAtomic(
        companyId,
        req.user.id,
        entriesToCreate,
        { session },
      );
      if (Array.isArray(created) && created.length > 0) {
        creditNote.revenueReversalEntry = created[0]._id;
        if (created[1]) creditNote.cogsReversalEntry = created[1]._id;
      }

      // ========== STEP 5: Update AR balance ==========
      invoice.amountOutstanding = outstandingBeforeCredit - amountAppliedToAR;
      if (invoice.amountOutstanding <= 0) {
        invoice.amountOutstanding = 0;
        invoice.status = "fully_paid";
        if (!invoice.paidDate) {
          invoice.paidDate = new Date();
        }
      }
      await invoice.save({ session });

      const client = await Client.findOne({ _id: creditNote.client, company: companyId }).session(session);
      const clientBalanceAfter = client
        ? Math.max(0, Number(client.outstandingBalance || 0) - amountAppliedToAR)
        : null;
      if (client) {
        client.outstandingBalance = clientBalanceAfter;
        await client.save({ session });
      }
      if (amountAppliedToAR > 0) {
        const ARTrackingService = require('../services/arTrackingService');
        await ARTrackingService.recordCreditNoteApplied(
          creditNote,
          invoice,
          amountAppliedToAR,
          req.user.id,
          { session, required: true, invoiceBalanceAfter: invoice.amountOutstanding, clientBalanceAfter },
        );
      }

      // Update credit note status
      console.log(
        "DEBUG: About to update status - current status:",
        creditNote.status,
      );
      creditNote.status = "confirmed";
      creditNote.confirmedBy = req.user.id;
      creditNote.confirmedAt = new Date();
      creditNote.stockReversed = isGoodsReturn && lineArray.some((line) => line.product?.isStockable === true);

      console.log(
        "DEBUG: Saving credit note with new status:",
        creditNote.status,
      );
      await creditNote.save({ session });
      console.log("DEBUG: Credit note saved successfully");
    });

    console.log(
      "DEBUG: Transaction completed, creditNote.status =",
      creditNote.status,
    );

    await creditNote.populate(
      "lines.product lines.returnToWarehouse createdBy confirmedBy invoice client revenueReversalEntry cogsReversalEntry",
    );

    const refundRsnCd =
      req.body.refundRsnCd || req.body.rfdRsnCd || creditNote.ebm?.rfdRsnCd;
    let responseNote = creditNote;
    if (refundRsnCd) {
      try {
        responseNote = await EBMSalesService.submitCreditNote(creditNote._id, {
          companyId,
          refundRsnCd,
          modifierUserId: req.user.id || req.user._id,
        });
        await responseNote.populate(
          "lines.product lines.returnToWarehouse createdBy confirmedBy invoice client revenueReversalEntry cogsReversalEntry",
        );
      } catch (ebmError) {
        console.error(
          "EBM credit note submission failed after confirmation:",
          ebmError.message,
        );
        responseNote =
          ebmError.creditNote ||
          (await CreditNote.findOne({
            _id: creditNote._id,
            company: companyId,
          }).populate(
            "lines.product lines.returnToWarehouse createdBy confirmedBy invoice client revenueReversalEntry cogsReversalEntry",
          ));
      }
    }

    // Send email notification for confirm
    if (req.body.sendEmail) {
      const company = await Company.findById(companyId);
      const client = await Client.findById(responseNote.client);
      await sendCreditNoteEmail(responseNote, company, client, 'confirmed');
    }

    console.log("DEBUG: Sending response with status:", responseNote.status);
    emitDataChanged(companyId, "creditNotes", { affectsStock: true });
    await require("../services/cacheService").bumpCompanyStockCaches(companyId);
    res.json({
      success: true,
      message: "Credit note confirmed successfully",
      data: responseNote,
    });
  } catch (err) {
    console.error("Error confirming credit note:", err);
    next(err);
  }
};

// Submit or retry RRA EBM for a confirmed credit note
exports.submitCreditNoteEbm = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const note = await CreditNote.findOne({
      _id: req.params.id,
      company: companyId,
    });
    if (!note) {
      return res.status(404).json({ success: false, message: "Credit note not found" });
    }
    if (note.status !== "confirmed" && note.status !== "issued") {
      return res.status(400).json({
        success: false,
        message: "Only confirmed or issued credit notes can be submitted to EBM",
      });
    }
    if (note.ebm?.ebmStatus === "submitted") {
      return res.json({ success: true, data: note, message: "Already submitted to EBM" });
    }

    const refundRsnCd =
      req.body.refundRsnCd || req.body.rfdRsnCd || note.ebm?.rfdRsnCd;
    if (!refundRsnCd) {
      return res.status(400).json({
        success: false,
        code: "ERR_EBM_REFUND_REASON_REQUIRED",
        message: "RRA refund reason code is required before submitting this credit note to EBM.",
      });
    }

    let responseNote;
    try {
      responseNote = await EBMSalesService.submitCreditNote(note._id, {
        companyId,
        refundRsnCd,
        modifierUserId: req.user.id || req.user._id,
      });
    } catch (ebmError) {
      console.error("EBM credit note submission failed:", ebmError.message);
      responseNote =
        ebmError.creditNote ||
        (await CreditNote.findOne({ _id: note._id, company: companyId })
          .populate("invoice client lines.product createdBy"));
      return res.status(502).json({
        success: false,
        message: ebmError.message || "EBM submission failed",
        data: responseNote,
      });
    }

    await responseNote.populate("invoice client lines.product createdBy");
    res.json({ success: true, data: responseNote });
  } catch (err) {
    next(err);
  }
};
