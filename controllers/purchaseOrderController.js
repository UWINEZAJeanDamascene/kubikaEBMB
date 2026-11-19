const PurchaseOrder = require('../models/PurchaseOrder');
const GoodsReceivedNote = require('../models/GoodsReceivedNote');
const BudgetService = require('../services/budgetService');
const { parsePagination, paginationMeta } = require('../utils/pagination');
const emailService = require('../services/emailService');
const Company = require('../models/Company');
const Supplier = require('../models/Supplier');
const Product = require('../models/Product');
const { emitDataChanged } = require('../lib/realtimeEvents');
const { runInTransaction } = require('../services/transactionService');
const {
  normalizePurchaseUnitSnapshot,
  resolvePurchaseUnit,
} = require('../utils/purchaseUnitRules');

async function snapshotPurchaseOrderLines(lines, companyId, existingLines = []) {
  if (!Array.isArray(lines)) {
    throw Object.assign(new Error('Purchase order lines must be a list'), { status: 400 });
  }
  const productIds = [...new Set(lines.map((line) => String(line.product?._id || line.product || '')).filter(Boolean))];
  const products = productIds.length
    ? await Product.find({ _id: { $in: productIds }, company: companyId })
    : [];
  const productsById = new Map(products.map((product) => [String(product._id), product]));

  return lines.map((line, index) => {
    const productId = String(line.product?._id || line.product || '');
    const product = productsById.get(productId);
    if (!product) {
      throw Object.assign(new Error(`Line ${index + 1}: select a product available in this company`), { status: 400 });
    }

    const existing = line._id
      ? existingLines.find((candidate) => String(candidate._id || candidate.id) === String(line._id))
      : null;
    const existingSnapshot = existing?.purchaseUnitSnapshot || existing?.unitSnapshot;
    const code = String(line.purchaseUnitCode || line.purchaseUnitSnapshot?.code || existingSnapshot?.code || 'base').toLowerCase();
    const snapshot = existingSnapshot && existingSnapshot.code === code
      ? normalizePurchaseUnitSnapshot(existingSnapshot, product.unit || 'unit')
      : resolvePurchaseUnit(product, code);
    return { ...line, purchaseUnitSnapshot: snapshot };
  });
}

const sendPOEmail = async (po, action, companyId) => {
  try {
    const config = require('../src/config/environment').getConfig();
    if (!config.features?.emailNotifications) {
      console.log('[PO Email] Email notifications disabled');
      return;
    }

    const company = await Company.findById(companyId);
    const supplier = await Supplier.findById(po.supplier);
    
    // Populate product data for email
    const poWithProducts = await PurchaseOrder.findById(po._id).populate('lines.product', 'name');
    
    if (supplier?.contact?.email || supplier?.email) {
      await emailService.sendPurchaseOrderEmail(poWithProducts, company, supplier, action);
    }
  } catch (err) {
    console.error('[PO Email] Failed to send email:', err.message);
  }
};

exports.createPurchaseOrder = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const payload = req.body;
    payload.company = companyId;
    payload.createdBy = req.user.id;
    payload.lines = await snapshotPurchaseOrderLines(payload.lines || payload.items || [], companyId);
    // Orders must enter the approval workflow as drafts; accepting an incoming
    // status here would allow callers to bypass approval and commitment checks.
    payload.status = 'draft';

    // Normalize freight defaults if provided
    if (payload.freight) {
      payload.freight.account = payload.freight.account || '5110';
      payload.freight.paymentMethod = payload.freight.paymentMethod || 'on_account';
    }
    const po = await PurchaseOrder.create(payload);
    
    const sendEmailOnCreate = req.body.sendEmail || false;
    if (sendEmailOnCreate && po.status !== 'draft') {
      sendPOEmail(po, 'created', companyId);
    }
    
    res.status(201).json({ success: true, data: po });
  } catch (err) { next(err); }
};

exports.updatePurchaseOrder = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const po = await PurchaseOrder.findOne({ _id: req.params.id, company: companyId });
    if (!po) return res.status(404).json({ success: false, message: 'PO not found' });
    if (po.status !== 'draft') return res.status(409).json({ success: false, message: 'Only draft POs can be edited' });
    if (req.body.lines !== undefined) {
      req.body.lines = await snapshotPurchaseOrderLines(req.body.lines, companyId, po.lines || []);
    }

    // Update fields individually to ensure Mongoose tracks changes properly
    const allowedFields = ['supplier', 'warehouse', 'orderDate', 'expectedDeliveryDate', 'currencyCode', 'exchangeRate', 'notes', 'lines', 'freight'];
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        po[field] = req.body[field];
      }
    }

    await po.save();
    res.json({ success: true, data: po });
  } catch (err) { next(err); }
};

exports.approvePurchaseOrder = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const po = await PurchaseOrder.findOne({ _id: req.params.id, company: companyId });
    if (!po) return res.status(404).json({ success: false, message: 'PO not found' });
    if (po.status !== 'draft') return res.status(409).json({ success: false, message: 'Only draft POs can be approved' });

    const BudgetLine = require('../models/BudgetLine');
    const resolvedLines = [];
    // Validate every budget coding before creating commitments. Budgeted PO
    // lines must point to one exact line; account-only lookups are ambiguous
    // when projects or cost centres share an account.
    for (let index = 0; index < (po.lines || []).length; index += 1) {
      const line = po.lines[index];
      if (!line.budgetId && !line.budget_line_id) continue;
      if (!line.budgetId || !line.budget_line_id) {
        return res.status(400).json({ success: false, message: `Line ${index + 1}: select both a budget and a budget line` });
      }
      const budgetLine = await BudgetLine.findOne({
        _id: line.budget_line_id,
        budget_id: line.budgetId,
        company_id: companyId,
      });
      if (!budgetLine) {
        return res.status(400).json({ success: false, message: `Line ${index + 1}: budget line does not belong to the selected budget` });
      }
      const lineAccountId = line.accountId && String(line.accountId);
      if (lineAccountId && lineAccountId !== String(budgetLine.account_id)) {
        return res.status(400).json({ success: false, message: `Line ${index + 1}: account does not match the selected budget line` });
      }
      const refs = line.budgetRefs && typeof line.budgetRefs === 'object' ? line.budgetRefs : {};
      const projectId = budgetLine.project_id?._id || budgetLine.project_id || refs.projectId || null;
      let projectSnapshot = null;
      if (projectId) {
        const Project = require('../models/Project');
        projectSnapshot = await Project.findOne({ _id: projectId, company_id: companyId });
        if (!projectSnapshot) {
          return res.status(400).json({ success: false, message: `Line ${index + 1}: linked project is unavailable in this company` });
        }
      }
      line.budgetId = String(line.budgetId);
      line.budget_line_id = String(budgetLine._id);
      line.accountId = String(budgetLine.account_id);
      line.project_id = projectId ? String(projectId) : null;
      line.projectName = projectSnapshot?.name || null;
      line.projectCode = projectSnapshot?.project_code || projectSnapshot?.wbs_code || null;
      resolvedLines.push({ line, index, budgetLine });
    }

    await runInTransaction(async () => {
      for (const { line, index, budgetLine } of resolvedLines) {
        const subtotal = (Number(line.qtyOrdered) || 0) * (Number(line.unitCost) || 0);
        const calculatedTotal = subtotal + subtotal * ((Number(line.taxRate) || 0) / 100);
        const amount = Number(line.lineTotal) > 0
          ? Number(Number(line.lineTotal).toFixed(2))
          : Number(calculatedTotal.toFixed(2));
        if (amount <= 0) throw new Error(`Line ${index + 1}: amount must be greater than zero to encumber a budget`);
        const encumbrance = await BudgetService.createEncumbrance(companyId, {
          budget_id: line.budgetId,
          budget_line_id: budgetLine._id,
          account_id: budgetLine.account_id,
          source_type: 'purchase_order',
          source_id: po._id.toString(),
          source_number: po.referenceNo || po._id.toString(),
          description: `PO ${po.referenceNo || ''} - ${line.product?.name || 'Item'}`,
          amount,
          expected_liquidation_date: po.expectedDeliveryDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          notes: 'Commitment created on purchase order approval',
        }, userId);
        line.encumbrance_id = String(encumbrance._id);
      }

      po.status = 'approved';
      po.approvedBy = userId;
      po.approvedAt = new Date();
      await po.save();
    }, { isolationLevel: 'Serializable' });

    emitDataChanged(companyId, 'purchaseOrders');
    if (req.body.sendEmail) sendPOEmail(po, 'approved', companyId);

    res.json({ success: true, data: po });
  } catch (err) {
    if (err.code === 'P2034') {
      return res.status(409).json({ success: false, message: 'Another transaction used this budget balance first. Refresh and retry approval.' });
    }
    if (err.message === 'INSUFFICIENT_BUDGET') {
      return res.status(409).json({ success: false, message: 'This purchase order exceeds the remaining budget available for one or more lines.' });
    }
    next(err);
  }
};

exports.cancelPurchaseOrder = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const po = await PurchaseOrder.findOne({ _id: req.params.id, company: companyId });
    if (!po) return res.status(404).json({ success: false, message: 'PO not found' });

    // Block cancellation if any GRN exists
    const grn = await GoodsReceivedNote.findOne({ purchaseOrder: po._id, company: companyId });
    if (grn) return res.status(409).json({ success: false, message: 'Cannot cancel PO with existing GRN' });

    if (!['draft', 'approved'].includes(po.status)) {
      return res.status(409).json({ success: false, message: 'Only draft or approved purchase orders can be cancelled' });
    }
    if (Number(po.amountPaid || 0) > 0) {
      return res.status(409).json({ success: false, message: 'This order has recorded payments. Resolve the supplier advance or refund before cancelling it.' });
    }

    if (po.status === 'approved') {
      const Encumbrance = require('../models/Encumbrance');
      const commitments = await Encumbrance.find({
        source_type: 'purchase_order', source_id: po._id.toString(), company_id: companyId,
        status: { $in: ['active', 'partially_liquidated'] },
      });
      for (const commitment of commitments) {
        await BudgetService.releaseEncumbrance(companyId, 'purchase_order', po._id.toString(),
          `Purchase order ${po.referenceNo} cancelled`, req.user.id, commitment._id);
      }
    }

    po.status = 'cancelled';
    await po.save();

    // Send email notification for cancelled PO
    const sendEmailOnCancel = req.body.sendEmail || false;
    if (sendEmailOnCancel) {
      sendPOEmail(po, 'cancelled', companyId);
    }

    emitDataChanged(companyId, 'purchaseOrders');
    res.json({ success: true, data: po });
  } catch (err) { next(err); }
};

exports.getPurchaseOrders = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { supplier_id, status, ebmPurchaseMatchStatus, date_from, date_to, search } = req.query;
    const q = { company: companyId };
    if (supplier_id) q.supplier = supplier_id;
    if (status) q.status = status;
    if (ebmPurchaseMatchStatus) q["ebm.ebmPurchaseMatchStatus"] = ebmPurchaseMatchStatus;
    if (date_from || date_to) q.orderDate = {};
    if (date_from) q.orderDate.$gte = new Date(date_from);
    if (date_to) q.orderDate.$lte = new Date(date_to);
    if (search) {
      q.referenceNo = { $regex: search, $options: 'i' };
    }

    const { page, limit, skip } = parsePagination(req.query);
    const total = await PurchaseOrder.countDocuments(q);
    const list = await PurchaseOrder.find(q)
      .populate('supplier', 'name code contact email')
      .populate('warehouse', 'name code')
      .populate('-lines')
      .select({ supplier: 1, warehouse: 1, referenceNo: 1, orderDate: 1, expectedDeliveryDate: 1, status: 1, source: 1, currencyCode: 1, exchangeRate: 1, subtotal: 1, taxAmount: 1, totalAmount: 1, amountPaid: 1, balance: 1, paymentStatus: 1, freight: 1, ebm: 1, notes: 1, approvedBy: 1, approvedAt: 1, createdBy: 1, createdAt: 1, updatedAt: 1, linesCount: 1 })
      .sort({ orderDate: -1, _id: -1 })
      .skip(skip)
      .limit(limit);

    // Add computed linesCount to each PO and backfill totals if needed
    const data = list.map(po => {
      const obj = po.toObject ? po.toObject() : { ...po };
      const lines = Array.isArray(obj.lines) ? obj.lines : [];
      const lineCount = Number(obj._count?.lines || obj.linesCount || lines.length);
      // Backfill: compute totals on the fly if they're zero but lines exist
      if (lines.length > 0 && (!obj.totalAmount || Number(obj.totalAmount) === 0)) {
        let subtotal = 0;
        let taxAmount = 0;
        lines.forEach(line => {
          const lineSubtotal = (Number(line.qtyOrdered) || 0) * (Number(line.unitCost) || 0);
          const lineTax = Number(line.taxAmount) > 0
            ? Number(line.taxAmount)
            : lineSubtotal * ((Number(line.taxRate) || 0) / 100);
          subtotal += lineSubtotal;
          taxAmount += lineTax;
        });
        obj.subtotal = subtotal;
        obj.taxAmount = taxAmount;
        obj.totalAmount = subtotal + taxAmount;
        if (obj.balance == null || Number(obj.balance) === 0) {
          obj.balance = Math.max(0, obj.totalAmount - (Number(obj.amountPaid) || 0));
        }
      }
      obj.linesCount = lineCount;
      return obj;
    });

    res.json({
      success: true,
      data,
      pagination: paginationMeta(page, limit, total),
    });
  } catch (err) { next(err); }
};

exports.getPurchaseOrder = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const po = await PurchaseOrder.findOne({ _id: req.params.id, company: companyId })
      .populate('supplier', 'name code contact')
      .populate('warehouse', 'name code')
      .populate('createdBy', 'name email')
      .populate('approvedBy', 'name email')
      .populate('lines.product', 'name sku unit trackingType')
      .populate('lines.budgetId', 'name fiscalYear')
      .populate('lines.accountId', 'code name');
    
    if (!po) return res.status(404).json({ success: false, message: 'PO not found' });

    // Backfill: if totals are zero but lines exist, compute on the fly and persist
    if (po.lines && po.lines.length > 0 && po.totalAmount === 0) {
      let subtotal = 0;
      let taxAmount = 0;
      const lineUpdates = [];
      po.lines.forEach(line => {
        const lineSubtotal = (Number(line.qtyOrdered) || 0) * (Number(line.unitCost) || 0);
        const lineTax = lineSubtotal * ((Number(line.taxRate) || 0) / 100);
        const lineTotal = lineSubtotal + lineTax;
        line.taxAmount = lineTax;
        line.lineTotal = lineTotal;
        subtotal += lineSubtotal;
        taxAmount += lineTax;
        lineUpdates.push({ updateOne: { filter: { _id: po._id, 'lines._id': line._id }, update: { $set: { 'lines.$.taxAmount': lineTax, 'lines.$.lineTotal': lineTotal } } } });
      });
      po.subtotal = subtotal;
      po.taxAmount = taxAmount;
      po.totalAmount = subtotal + taxAmount;
      // Persist totals and line-level values asynchronously — don't block the response
      const bulkOps = [
        { updateOne: { filter: { _id: po._id }, update: { $set: { subtotal, taxAmount, totalAmount: subtotal + taxAmount } } } },
        ...lineUpdates
      ];
      PurchaseOrder.bulkWrite(bulkOps).catch(err => console.error('Backfill save error:', err));
    }

    // Fetch related GRNs for the GRNs tab
    const grns = await GoodsReceivedNote.find({ purchaseOrder: po._id, company: companyId })
      .populate('createdBy', 'name email')
      .populate('confirmedBy', 'name email')
      .sort({ createdAt: -1 });

    res.json({ 
      success: true, 
      data: po,
      grns: grns
    });
  } catch (err) { next(err); }
};

// Record payment against a PO
exports.recordPOPayment = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const po = await PurchaseOrder.findOne({ _id: req.params.id, company: companyId });
    if (!po) return res.status(404).json({ success: false, message: 'PO not found' });
    if (po.status === 'cancelled') return res.status(409).json({ success: false, message: 'Cannot pay a cancelled PO' });

    const { amount, paymentMethod, reference, notes, bankAccountId } = req.body;
    const resolvedPaymentMethod = paymentMethod || 'bank_transfer';
    const paymentCurrency = String(req.body.currencyCode || po.currencyCode || 'RWF').toUpperCase();
    const enteredAmount = Number(amount);
    if (!Number.isFinite(enteredAmount) || enteredAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Amount must be greater than 0' });
    }

    // The UI accepts payment amounts in the selected display currency. PO
    // balances are stored in the PO currency, while journals use company base
    // currency and bank transactions use the bank account currency.
    const CurrencyService = require('../services/CurrencyService');
    const baseCurrency = await CurrencyService.getCompanyBase(companyId);
    const poCurrency = String(po.currencyCode || baseCurrency).toUpperCase();
    // Payments are entered in the current display/payment currency. Convert
    // both sides of that payment using the same current PO-to-base rate;
    // using the PO's historical order rate can leave a false open balance.
    const poRate = await CurrencyService.getRate(companyId, poCurrency, baseCurrency, new Date());
    const amountInBase = paymentCurrency === poCurrency
      ? Math.round(enteredAmount * poRate * 100) / 100
      : await CurrencyService.convert(companyId, enteredAmount, paymentCurrency, new Date());
    const payAmount = paymentCurrency === poCurrency
      ? Math.round(enteredAmount * 100) / 100
      : Math.round((amountInBase / poRate) * 100) / 100;

    const remaining = (po.totalAmount || 0) - (po.amountPaid || 0);
    if (payAmount > remaining) return res.status(400).json({ success: false, message: `Amount exceeds remaining balance (${remaining})` });

    const bankPaymentMethods = ['bank_transfer', 'cheque', 'mobile_money'];
    let selectedBankAccount = null;
    let bankAmount = amountInBase;
    let bankCurrency = baseCurrency;
    if (bankPaymentMethods.includes(resolvedPaymentMethod) && bankAccountId) {
      const { BankAccount } = require('../models/BankAccount');
      selectedBankAccount = await BankAccount.findOne({
        _id: bankAccountId,
        company: companyId,
        isActive: true,
      });
      if (!selectedBankAccount) {
        return res.status(400).json({ success: false, message: 'Select an active bank account' });
      }
      bankCurrency = String(selectedBankAccount.currencyCode || baseCurrency).toUpperCase();
      const bankRate = bankCurrency === baseCurrency
        ? 1
        : await CurrencyService.getRate(companyId, bankCurrency, baseCurrency, new Date());
      bankAmount = paymentCurrency === bankCurrency
        ? Math.round(enteredAmount * 100) / 100
        : Math.round((amountInBase / bankRate) * 100) / 100;
    }

    po.payments.push({
      amount: payAmount,
      currencyCode: poCurrency,
      amountInBase,
      baseCurrency,
      bankAmount: bankPaymentMethods.includes(resolvedPaymentMethod) && bankAccountId ? bankAmount : null,
      bankCurrencyCode: bankPaymentMethods.includes(resolvedPaymentMethod) && bankAccountId ? bankCurrency : null,
      paymentMethod: resolvedPaymentMethod,
      reference: reference || null,
      notes: notes || null,
      bankAccountId: bankAccountId || null,
      paidDate: new Date(),
      createdBy: req.user.id
    });

    po.amountPaid = Number(po.amountPaid || 0) + payAmount;
    po.balance = po.totalAmount - po.amountPaid;
    po.paymentStatus = po.balance <= 0 ? 'paid' : 'partial';

    await po.save();

    // Create journal entry: Dr AP, Cr Cash/Bank
    try {
      const JournalService = require('../services/journalService');
      let bankAccountCode;
      // Use specific bank account if provided
      if (selectedBankAccount?.ledgerAccountId) {
        bankAccountCode = selectedBankAccount.ledgerAccountId;
      }

      await JournalService.createPurchasePaymentEntry(companyId, req.user.id, {
        purchaseNumber: po.referenceNo,
        date: new Date(),
        amount: amountInBase,
        paymentMethod: resolvedPaymentMethod,
        bankAccountCode: bankAccountCode,
        vatAmount: (Number(po.taxAmount) || 0) * poRate,
        netAmount: (Number(po.subtotal) || 0) * poRate || (amountInBase - ((Number(po.taxAmount) || 0) * poRate)),
      });
    } catch (jeErr) {
      console.error('Failed to create journal entry for PO payment:', jeErr);
      // Don't fail the payment if journal entry fails
    }

    // Create bank transaction for bank-based payment methods (withdrawal reduces balance)
    if (bankPaymentMethods.includes(resolvedPaymentMethod) && bankAccountId && selectedBankAccount) {
      console.log('[PO Payment] Creating bank transaction - bankAccountId:', bankAccountId, 'amount:', bankAmount);
      try {
        const tx = await selectedBankAccount.addTransaction({
            type: 'withdrawal',
            amount: bankAmount,
            currencyCode: bankCurrency,
            description: `Payment for PO ${po.referenceNo}`,
            date: new Date(),
            referenceNumber: reference || po.referenceNo,
            paymentMethod: resolvedPaymentMethod,
            status: 'completed',
            reference: po._id,
            referenceType: 'PurchaseOrder',
            createdBy: req.user.id,
            notes: notes || `Payment for purchase order ${po.referenceNo}`,
          });
        console.log('[PO Payment] Bank transaction created:', tx._id);
      } catch (bankErr) {
        console.error('[PO Payment] Error creating bank transaction:', bankErr);
        // Non-fatal — journal entry already posted
      }
    }

    // Update linked GRNs payment status
    try {
      const GoodsReceivedNote = require('../models/GoodsReceivedNote');
      const grns = await GoodsReceivedNote.find({ purchaseOrder: po._id, company: companyId });
      if (grns.length > 0) {
        const paidRatio = po.totalAmount > 0 ? po.amountPaid / po.totalAmount : 0;
        for (const grn of grns) {
          // Calculate GRN total from lines if totalAmount is 0
          let grnTotal = Number(grn.totalAmount) || 0;
          if (grnTotal === 0 && grn.lines && grn.lines.length > 0) {
            grnTotal = grn.lines.reduce((sum, l) => sum + (Number(l.qtyReceived) * Number(l.unitCost || 0)), 0);
          }
          const grnPaid = grnTotal * paidRatio;
          grn.totalAmount = grnTotal;
          grn.amountPaid = grnPaid;
          grn.balance = grnTotal - grnPaid;
          grn.paymentStatus = grn.balance <= 0.01 ? 'paid' : (grnPaid > 0 ? 'partially_paid' : 'pending');
          await grn.save();
        }
      }
    } catch (grnErr) {
      console.error('Failed to update GRN payment status:', grnErr);
    }

    // Budget actuals are recognized when goods/services are received, not when
    // cash is paid. Payment settles AP and must not consume the same budget a
    // second time.

    res.json({ success: true, data: po });
  } catch (err) { next(err); }
};
