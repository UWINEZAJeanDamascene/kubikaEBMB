const Purchase = require("../models/Purchase");
const Product = require("../models/Product");
const Supplier = require("../models/Supplier");
const StockMovement = require("../models/StockMovement");
const Company = require("../models/Company");
const APPayment = require("../models/APPayment");
const PDFDocument = require("pdfkit");
const {
  notifyStockReceived,
  notifyLowStock,
  notifyOutOfStock,
} = require("../services/notificationHelper");
const cacheService = require("../services/cacheService");
const { emitDataChanged } = require("../lib/realtimeEvents");
const { BankAccount, BankTransaction } = require("../models/BankAccount");
const JournalService = require("../services/journalService");
const inventoryService = require("../services/inventoryService");
const emailService = require("../services/emailService");
const mongoose = require("mongoose");
const { runInTransaction } = require("../services/transactionService");
const EBMPurchaseService = require("../services/ebmPurchaseService");
const EBMStockService = require("../services/ebmStockService");
const { parseBoundedPage } = require("../utils/querySafety");
const { nextReferenceNo } = require("../utils/referenceNumbers");

const sendPurchaseEmail = async (purchase, action, companyId) => {
  try {
    const config = require('../src/config/environment').getConfig();
    if (!config.features?.emailNotifications) {
      console.log('[Purchase Email] Email notifications disabled');
      return;
    }

    const company = await Company.findById(companyId);
    const supplier = await Supplier.findById(purchase.supplier);
    
    // Populate product data for email
    const purchaseWithProducts = await Purchase.findById(purchase._id).populate('items.product', 'name');
    
    if (supplier?.contact?.email || supplier?.email) {
      await emailService.sendPurchaseEmail(purchaseWithProducts, company, supplier, action);
    }
  } catch (err) {
    console.error('[Purchase Email] Failed to send email:', err.message);
  }
};

// @desc    Get all purchases
// @route   GET /api/purchases
// @access  Private
exports.getPurchases = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { page, limit, skip } = parseBoundedPage(req.query, { defaultLimit: 20, maxLimit: 100 });
    const {
      status,
      ebmPurchaseMatchStatus,
      supplierId,
      startDate,
      endDate,
    } = req.query;
    const query = { company: companyId };

    if (status) {
      query.status = status;
    }

    if (ebmPurchaseMatchStatus) {
      query["ebm.ebmPurchaseMatchStatus"] = ebmPurchaseMatchStatus;
    }

    if (supplierId) {
      query.supplier = supplierId;
    }

    if (startDate || endDate) {
      query.purchaseDate = {};
      if (startDate) query.purchaseDate.$gte = new Date(startDate);
      if (endDate) query.purchaseDate.$lte = new Date(endDate);
    }

    const total = await Purchase.countDocuments(query);
    const purchases = await Purchase.find(query)
      .populate("supplier", "name code contact")
      .populate("createdBy", "name email")
      .populate("-items")
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit)
      .skip(skip);

    res.json({
      success: true,
      count: purchases.length,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page,
      data: purchases,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single purchase
// @route   GET /api/purchases/:id
// @access  Private
exports.getPurchase = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const purchase = await Purchase.findOne({
      _id: req.params.id,
      company: companyId,
    })
      .populate("supplier", "name code contact type taxId")
      .populate("items.product", "name sku unit trackingType")
      .populate("createdBy", "name email")
      .populate("payments.recordedBy", "name email");

    if (!purchase) {
      return res.status(404).json({
        success: false,
        message: "Purchase not found",
      });
    }

    res.json({
      success: true,
      data: purchase,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create new purchase
// @route   POST /api/purchases
// @access  Private (admin, stock_manager, purchases)
exports.createPurchase = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const {
      items,
      supplier: supplierId,
      currency,
      paymentTerms,
      supplierTin,
      supplierAddress,
      supplierName,
      supplierInvoiceNumber,
      supplierInvoiceDate,
      budgetId,
      budget_line_id,
      accountId,
    } = req.body;

    // Get supplier details
    const supplier = await Supplier.findOne({
      _id: supplierId,
      company: companyId,
    });
    if (!supplier) {
      return res.status(404).json({
        success: false,
        message: "Supplier not found",
      });
    }

    // Resolve and validate project/budget coding before creating the purchase.
    const BudgetLine = require('../models/BudgetLine');
    const resolvedBudgetLines = new Map();
    for (let index = 0; index < (items || []).length; index += 1) {
      const item = items[index];
      item.budgetId = item.budgetId || budgetId;
      item.budget_line_id = item.budget_line_id || budget_line_id;
      item.accountId = item.accountId || accountId;
      if (!item.budgetId && !item.budget_line_id) continue;
      if (!item.budgetId || !item.budget_line_id) {
        return res.status(400).json({ success: false, message: `Item ${index + 1}: select both a budget and a budget line` });
      }
      const budgetLine = await BudgetLine.findOne({
        _id: item.budget_line_id,
        budget_id: item.budgetId,
        company_id: companyId,
      });
      if (!budgetLine) {
        return res.status(400).json({ success: false, message: `Item ${index + 1}: budget line does not belong to the selected budget` });
      }
      if (item.accountId && String(item.accountId) !== String(budgetLine.account_id)) {
        return res.status(400).json({ success: false, message: `Item ${index + 1}: account does not match the selected budget line` });
      }
      item.accountId = String(budgetLine.account_id);
      item.project_id = budgetLine.project_id?._id || budgetLine.project_id || null;
      if (item.project_id) {
        const Project = require('../models/Project');
        const project = await Project.findOne({ _id: item.project_id, company_id: companyId });
        if (!project) {
          return res.status(400).json({ success: false, message: `Item ${index + 1}: linked project is unavailable in this company` });
        }
        item.projectName = project.name;
        item.projectCode = project.project_code || project.wbs_code || null;
      }
      resolvedBudgetLines.set(index, budgetLine);
    }

    // Process items with tax codes - prefer product defaults when present
    const processedItems = [];
    let headerSubtotal = 0;
    let headerTax = 0;
    // Tax defaults are the only product data needed below. Resolve every
    // referenced product in one query rather than turning a 100-line purchase
    // into 100 sequential database round-trips.
    const itemProductIds = [...new Set(
      (items || []).map((item) => item.product?._id || item.product).filter(Boolean).map(String),
    )];
    const itemProducts = itemProductIds.length
      ? await Product.find({ _id: { $in: itemProductIds }, company: companyId })
      : [];
    const productsById = new Map(itemProducts.map((product) => [String(product._id), product]));
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const product = productsById.get(String(item.product?._id || item.product));
      const qty = Number(item.quantity ?? item.qty ?? 0) || 0;
      const unitCost = Number(item.unitCost ?? 0) || 0;
      const subtotal = qty * unitCost;
      const discount = Number(item.discount || 0) || 0;
      const netAmount = subtotal - discount;
      const taxRate =
        item.taxRate != null
          ? item.taxRate
          : product?.taxRate != null
            ? product.taxRate
            : 0;
      const taxCode = item.taxCode || product?.taxCode || "A";
      const taxAmount = netAmount * (taxRate / 100);
      const totalWithTax = netAmount + taxAmount;
      headerSubtotal += netAmount;
      headerTax += taxAmount;

      processedItems.push({
        ...item,
        quantity: qty,
        qty,
        unitCost,
        itemCode: item.itemCode || `ITEM-${i + 1}`,
        taxCode,
        taxRate,
        subtotal,
        taxAmount,
        totalWithTax,
        lineTotal: totalWithTax,
        budgetId: item.budgetId || budgetId,
        budget_line_id: item.budget_line_id || budget_line_id,
      });
    }

    const purchase = await Purchase.create({
      ...req.body,
      company: companyId,
      supplierInvoiceNumber: String(supplierInvoiceNumber || '').trim()
        || await nextReferenceNo(companyId, 'PINV', {
          field: 'supplierInvoiceNumber',
          model: 'purchase',
        }),
      items: processedItems,
      subtotal: headerSubtotal,
      taxAmount: headerTax,
      totalAmount: headerSubtotal + headerTax,
      roundedAmount: headerSubtotal + headerTax,
      grandTotal: headerSubtotal + headerTax,
      totalTax: headerTax,
      supplierTin: supplierTin || supplier.taxId,
      supplierName: supplierName || supplier.name,
      supplierAddress: supplierAddress || supplier.contact?.address,
      createdBy: req.user.id,
      budgetId,
      budget_line_id,
      accountId,
    });

    await purchase.populate("supplier items.product createdBy");

    // One commitment per coded line. Never silently approve/create a purchase
    // while dropping project budget tracking.
    const BudgetService = require('../services/budgetService');
    const createdEncumbrances = [];
    try {
      for (let i = 0; i < purchase.items.length; i += 1) {
        const item = purchase.items[i];
        const itemBudgetId = item.budgetId || budgetId;
        const itemBudgetLineId = item.budget_line_id || budget_line_id;
        if (!itemBudgetId || !itemBudgetLineId) continue;
        const itemTotal = Number(item.totalWithTax ?? item.lineTotal ?? 0) || 0;
        if (itemTotal <= 0) throw new Error(`Item ${i + 1}: budgeted purchase amount must be greater than zero`);
        const budgetLine = resolvedBudgetLines.get(i);
        const encumbrance = await BudgetService.createEncumbrance(companyId, {
          budget_id: itemBudgetId,
          budget_line_id: itemBudgetLineId,
          account_id: item.accountId || budgetLine?.account_id,
          source_type: 'purchase',
          source_id: purchase._id.toString(),
          source_number: purchase.purchaseNumber || purchase._id.toString(),
          description: `Direct purchase ${purchase.purchaseNumber || ''} - ${item.product?.name || 'Item'}`,
          amount: itemTotal,
          expected_liquidation_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          notes: 'Commitment created from direct purchase',
        }, req.user.id);
        item.encumbrance_id = String(encumbrance._id);
        createdEncumbrances.push(encumbrance);
      }
      if (createdEncumbrances.length) await purchase.save();
    } catch (encErr) {
      await Promise.allSettled(createdEncumbrances.map((encumbrance) =>
        BudgetService.releaseEncumbrance(companyId, 'purchase', purchase._id.toString(),
          'Direct purchase creation rolled back after a budget line failed', req.user.id, encumbrance._id)));
      await purchase.deleteOne();
      const conflict = encErr.code === 'P2034' || encErr.message === 'INSUFFICIENT_BUDGET';
      return res.status(conflict ? 409 : 400).json({
        success: false,
        message: encErr.code === 'P2034'
          ? 'Another transaction used this budget balance first. Refresh and retry.'
          : encErr.message === 'INSUFFICIENT_BUDGET'
            ? 'The purchase exceeds the remaining budget available for this line.'
            : encErr.message || 'Unable to reserve the selected budget lines',
      });
    }

    // Create journal entry for the purchase (Inventory + VAT Debit, Accounts Payable Credit)
    // This happens immediately when purchase is created (on credit/unpaid)
    try {
      await JournalService.createPurchaseEntry(companyId, req.user.id, {
        _id: purchase._id,
        purchaseNumber: purchase.purchaseNumber,
        date: purchase.purchaseDate,
        total: Number(purchase.roundedAmount ?? purchase.totalAmount ?? purchase.grandTotal ?? 0) || 0,
        vatAmount: Number(purchase.totalTax ?? purchase.taxAmount ?? 0) || 0,
      });
      // Record AP ledger entry for the purchase so AP ledger and reconciliation include direct purchases
      try {
        const APTransactionLedger = require('../models/APTransactionLedger');
        const APTrackingService = require('../services/apTrackingService');
        const amount = parseFloat(purchase.roundedAmount ?? purchase.totalAmount ?? purchase.grandTotal ?? 0) || 0;
        const currentBalance = await APTrackingService.getSupplierBalance(companyId, purchase.supplier);
        const newBalance = currentBalance + amount;

        await APTransactionLedger.create({
          company: companyId,
          supplier: purchase.supplier,
          transactionType: 'grn_received',
          transactionDate: purchase.purchaseDate || new Date(),
          referenceNo: purchase.purchaseNumber || purchase.supplierInvoiceNumber || undefined,
          description: `Purchase ${purchase.purchaseNumber || ''} created - Amount: ${amount.toFixed(2)}`,
          amount: amount,
          direction: 'increase',
          supplierBalanceAfter: newBalance,
          sourceType: 'manual',
          sourceId: purchase._id,
          sourceReference: purchase.purchaseNumber || purchase.supplierInvoiceNumber,
          createdBy: req.user.id,
          reconciliationStatus: 'verified'
        });

        await APTrackingService.invalidateSupplierBalanceCache(companyId, purchase.supplier);
      } catch (ledgerErr) {
        console.error('[Purchase] Failed to create AP ledger entry:', ledgerErr.message);
      }
    } catch (journalError) {
      console.error("Error creating journal entry for purchase:", journalError);
      // Don't fail the purchase creation if journal entry fails
    }

    // Send email notification
    const sendEmailOnCreate = req.body.sendEmail || false;
    if (sendEmailOnCreate) {
      await sendPurchaseEmail(purchase, 'created', companyId);
    }

    res.status(201).json({
      success: true,
      data: purchase,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update purchase
// @route   PUT /api/purchases/:id
// @access  Private (admin, stock_manager)
exports.updatePurchase = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    let purchase = await Purchase.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!purchase) {
      return res.status(404).json({
        success: false,
        message: "Purchase not found",
      });
    }

    // Only draft purchases can be updated
    if (purchase.status !== "draft") {
      return res.status(400).json({
        success: false,
        message: "Only draft purchases can be updated",
      });
    }

    // Recalculate item totals if items are updated
    if (req.body.items) {
      req.body.items = req.body.items.map((item, index) => {
        const subtotal = item.quantity * item.unitCost;
        const discount = item.discount || 0;
        const netAmount = subtotal - discount;
        const taxRate = item.taxRate || 0;
        const taxAmount = netAmount * (taxRate / 100);
        const totalWithTax = netAmount + taxAmount;
        return {
          ...item,
          itemCode: item.itemCode || `ITEM-${index + 1}`,
          subtotal,
          taxAmount,
          totalWithTax,
        };
      });
    }

    purchase = await Purchase.findOneAndUpdate(
      { _id: req.params.id, company: companyId },
      req.body,
      { new: true, runValidators: true },
    ).populate("supplier items.product createdBy");

    res.json({
      success: true,
      data: purchase,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete purchase
// @route   DELETE /api/purchases/:id
// @access  Private (admin)
exports.deletePurchase = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const purchase = await Purchase.findOne({
      _id: req.params.id,
      company: companyId,
    });

    if (!purchase) {
      return res.status(404).json({
        success: false,
        message: "Purchase not found",
      });
    }

    // Only draft purchases can be deleted (soft-delete)
    if (purchase.status !== "draft") {
      return res.status(400).json({
        success: false,
        message: "Only draft purchases can be deleted",
      });
    }

    // Soft-delete: mark as cancelled and inactive, record who cancelled
    purchase.status = "cancelled";
    purchase.cancelledDate = new Date();
    purchase.cancelledBy = req.user.id || req.user._id;
    // maintain backward-compatible fields
    purchase.cancellationReason =
      purchase.cancellationReason || "deleted by user";
    // if model supports isActive, set false, otherwise rely on status
    try {
      if (typeof purchase.isActive !== "undefined") purchase.isActive = false;
    } catch (e) {}

    await purchase.save();

    res.json({
      success: true,
      message: "Purchase cancelled (soft-deleted)",
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Receive purchase (add stock)
// @route   PUT /api/purchases/:id/receive
// @access  Private (admin, stock_manager)
exports.receivePurchase = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const purchase = await Purchase.findOne({
      _id: req.params.id,
      company: companyId,
    }).populate("items.product");

    if (!purchase) {
      return res.status(404).json({
        success: false,
        message: "Purchase not found",
      });
    }

    if (purchase.status !== "draft" && purchase.status !== "ordered") {
      return res.status(400).json({
        success: false,
        message: "Only draft or ordered purchases can be received",
      });
    }

    // Fetch supplier early (used in notifications) to avoid temporal-dead-zone errors
    const supplier = await Supplier.findOne({
      _id: purchase.supplier,
      company: companyId,
    });

    // Try to run receipt processing inside central transaction helper
    await runInTransaction(async (trx) => {
      const useSession = !!trx;
      const opts = useSession ? { session: trx } : {};

      for (const item of purchase.items) {
        const productId = item.product?._id || item.product;
        const qty = Number(item.quantity ?? item.qty ?? 0) || 0;
        const unitCost = Number(item.unitCost ?? 0) || 0;
        if (!productId || qty <= 0) continue;

        const productQuery = Product.findOne({
          _id: productId,
          company: companyId,
        });
        const product = useSession
          ? await productQuery.session(trx)
          : await productQuery;
        if (!product) continue;

        const previousStock = Number(product.currentStock || 0);
        const newStock = previousStock + qty;

        // Create inventory layer for received goods
        await inventoryService.createLayer(
          companyId,
          product._id,
          qty,
          unitCost,
          { sourceType: "purchase", sourceId: purchase._id },
          useSession
            ? { session: trx, userId: req.user.id }
            : { userId: req.user.id },
        );

        // Create stock movement (ledger entry)
        const sm = new StockMovement({
          company: companyId,
          product: product._id,
          type: "in",
          reason: "purchase",
          quantity: qty,
          previousStock,
          newStock,
          unitCost,
          totalCost: Number(item.totalWithTax ?? item.lineTotal ?? qty * unitCost) || 0,
          supplier: purchase.supplier,
          referenceType: "purchase",
          referenceNumber: purchase.purchaseNumber,
          referenceDocument: purchase._id,
          referenceModel: "Purchase",
          notes: `Purchase ${purchase.purchaseNumber} - ${product.name}`,
          performedBy: req.user.id,
        });
        await sm.save(opts);

        // Update product stock and average cost (ensure numeric coercion)
        product.currentStock = newStock;
        if (!product.averageCost) {
          product.averageCost = unitCost;
        } else {
          const totalValue =
            Number(product.averageCost || 0) * previousStock +
            unitCost * qty;
          product.averageCost = totalValue / newStock;
        }
        await product.save(opts);

        // Notifications (best-effort)
        try {
          await notifyStockReceived(
            companyId,
            product,
            qty,
            supplier,
          );
          if (product.reorderPoint && newStock <= product.reorderPoint) {
            await notifyLowStock(companyId, product, newStock);
          }
          if (newStock === 0) {
            await notifyOutOfStock(companyId, product);
          }
        } catch (notifError) {
          console.error("Failed to send stock notification:", notifError);
        }
      }

      // Update purchase status inside transaction/fallback
      purchase.status = "received";
      purchase.stockAdded = true;
      purchase.receivedDate = new Date();
      purchase.confirmedDate = new Date();
      purchase.confirmedBy = req.user.id;
      await purchase.save(useSession ? { session: trx } : {});

      // Liquidate encumbrances for received items
      if (purchase.items && purchase.items.length > 0) {
        try {
          const BudgetService = require('../services/budgetService');
          for (const item of purchase.items) {
            if (item.encumbrance_id) {
              try {
                await BudgetService.liquidateEncumbrance(
                  companyId,
                  'purchase',
                  purchase._id.toString(),
                  {
                    document_type: 'purchase_received',
                  document_id: purchase._id.toString(),
                  document_number: purchase.purchaseNumber,
                  amount: parseFloat(item.totalWithTax?.toString?.() || item.totalWithTax || 0),
                  encumbrance_id: item.encumbrance_id || undefined,
                  budget_line_id: item.budget_line_id || undefined,
                  notes: `Purchase received and confirmed`
                  },
                  req.user.id
                );
                console.log(`[Purchase] Liquidated encumbrance ${item.encumbrance_id} for item`);
              } catch (liqErr) {
                console.error('Error liquidating encumbrance:', liqErr);
              }
            }
          }
        } catch (encErr) {
          console.error('Error processing encumbrance liquidation:', encErr);
        }
      }

      // Ensure journal entry exists (idempotent)
      try {
        await JournalService.createPurchaseEntry(
          companyId,
          req.user.id,
          {
            _id: purchase._id,
            purchaseNumber: purchase.purchaseNumber,
            date: purchase.purchaseDate,
            total: Number(purchase.roundedAmount ?? purchase.totalAmount ?? purchase.grandTotal ?? 0) || 0,
            vatAmount: Number(purchase.totalTax ?? purchase.taxAmount ?? 0) || 0,
          },
          useSession ? { session: trx } : undefined,
        );
      } catch (je) {
        console.error(
          "JournalService.createPurchaseEntry failed while receiving purchase:",
          je,
        );
      }
    });

    // Note: Journal entry is created in createPurchase when purchase is created on credit
    // We don't create another one here to avoid duplication

    // Update supplier stats (supplier was fetched above)
    if (supplier) {
      const roundedAmount = parseFloat(purchase.roundedAmount ?? purchase.totalAmount ?? purchase.grandTotal ?? 0) || 0;
      supplier.totalPurchases += roundedAmount;
      supplier.outstandingBalance += roundedAmount;
      supplier.lastPurchaseDate = new Date();
      await supplier.save();
    }

    // Invalidate report cache - receiving purchase affects Balance Sheet (inventory, payables, VAT) and P&L
    try {
      await cacheService.invalidateByCompany(companyId, "report");
    } catch (e) {
      console.error("Cache invalidation failed:", e);
    }

    // Send email notification
    const sendEmailOnReceive = req.body.sendEmail || false;
    if (sendEmailOnReceive) {
      await sendPurchaseEmail(purchase, 'received', companyId);
    }

    let responsePurchase = purchase;
    try {
      responsePurchase = await EBMPurchaseService.processPurchaseDocument(companyId, purchase, "Purchase", {
        branchId: req.body.branchId || req.body.bhfId,
        operator: { id: req.user?._id || req.user?.id, name: req.user?.name },
      });
      if (responsePurchase?.ebm?.ebmStatus !== "failed") {
        await EBMStockService.submitStockForDirectPurchase(purchase._id, {
          companyId,
          branchId: req.body.branchId || req.body.bhfId,
        });
      }
    } catch (ebmErr) {
      console.error("EBM direct purchase pull/confirmation or stock reporting failed after receiving purchase:", ebmErr.message);
    }

    emitDataChanged(companyId, "purchases", { affectsStock: true });
    await cacheService.bumpCompanyStockCaches(companyId);
    res.json({
      success: true,
      message: "Purchase received and stock added",
      data: responsePurchase || purchase,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Record payment for purchase
// @route   POST /api/purchases/:id/payment
// @access  Private (admin, stock_manager, purchases)
exports.recordPayment = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const {
      amount: amountRaw,
      paymentMethod,
      reference,
      notes,
      bankAccountId,
    } = req.body;

    // Convert amount to number to prevent validation errors
    const amount = parseFloat(amountRaw);

    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment amount",
      });
    }

    const purchase = await Purchase.findOne({
      _id: req.params.id,
      company: companyId,
    }).populate("items.product");

    if (!purchase) {
      return res.status(404).json({
        success: false,
        message: "Purchase not found",
      });
    }

    if (purchase.status === "cancelled") {
      return res.status(400).json({
        success: false,
        message: "Cannot record payment for cancelled purchase",
      });
    }

    if (amount > purchase.balance) {
      return res.status(400).json({
        success: false,
        message: "Payment amount exceeds purchase balance",
      });
    }

    // Check sufficient balance using per-account BankTransaction sum (not shared ledgerAccountId)
    if (
      (paymentMethod === "bank_transfer" ||
        paymentMethod === "cheque" ||
        paymentMethod === "mobile_money") &&
      bankAccountId
    ) {
      const bankAccount = await BankAccount.findOne({
        _id: bankAccountId,
        company: companyId,
        isActive: true,
      });

      if (bankAccount) {
        // Use getBalance method which computes from journal entries per spec 3.3
        const JournalEntry = require('../models/JournalEntry');
        const balanceResult = await bankAccount.getBalance(JournalEntry);
        const availableBalance = balanceResult.balance;
        if (availableBalance < amount) {
          return res.status(400).json({
            success: false,
            message: `Insufficient funds in ${bankAccount.name}. Available: ${availableBalance}, Required: ${amount}`,
          });
        }
      }
    }

    const paymentReferenceNo = await nextReferenceNo(companyId, 'PAY', {
      field: 'referenceNo',
      model: 'aPPayment',
    });
    const paymentReference = String(reference || '').trim() || paymentReferenceNo;

    // Add payment
    const paymentDate = new Date();
    purchase.payments.push({
      amount,
      paymentMethod,
      reference: paymentReference,
      notes,
      paidDate: paymentDate,
      date: paymentDate,
      recordedBy: req.user.id,
    });

    purchase.amountPaid = Number(purchase.amountPaid || 0) + amount;

    // Explicitly recalculate balance to ensure it's correct
    purchase.balance = purchase.grandTotal - purchase.amountPaid;
    if (purchase.balance < 0) purchase.balance = 0;

    // Fetch supplier early (used in notifications and supplier updates)
    const supplier = await Supplier.findOne({
      _id: purchase.supplier,
      company: companyId,
    });

    // Auto-receive if stock not yet added and payment is made
    if (
      !purchase.stockAdded &&
      purchase.status === "draft" &&
      (paymentMethod === "cash" || paymentMethod === "card")
    ) {
      // Add stock
      for (const item of purchase.items) {
        const productId = item.product?._id || item.product;
        const qty = Number(item.quantity ?? item.qty ?? 0) || 0;
        if (!productId || qty <= 0) continue;

        const product = await Product.findOne({
          _id: productId,
          company: companyId,
        });

        if (product) {
          const previousStock = Number(product.currentStock || 0);
          const newStock = previousStock + qty;

          await StockMovement.create({
            company: companyId,
            product: product._id,
            type: "in",
            reason: "purchase",
            quantity: qty,
            previousStock,
            newStock,
            unitCost: item.unitCost,
            totalCost: item.totalWithTax ?? item.lineTotal,
            supplier: purchase.supplier,
            referenceType: "purchase",
            referenceNumber: purchase.purchaseNumber,
            referenceDocument: purchase._id,
            referenceModel: "Purchase",
            notes: `Purchase ${purchase.purchaseNumber}`,
            performedBy: req.user.id,
          });

          product.currentStock = newStock;
          if (product.averageCost === 0 || !product.averageCost) {
            product.averageCost = item.unitCost;
          }
          await product.save();

          // Send stock received notification
          try {
            await notifyStockReceived(
              companyId,
              product,
              qty,
              supplier,
            );

            // Check if stock is now low or out after adding
            if (product.reorderPoint && newStock <= product.reorderPoint) {
              await notifyLowStock(companyId, product, newStock);
            }
            if (newStock === 0) {
              await notifyOutOfStock(companyId, product);
            }
          } catch (notifError) {
            console.error("Failed to send stock notification:", notifError);
          }
        }
      }

      purchase.stockAdded = true;
      purchase.status = "received";
      purchase.receivedDate = new Date();
    }

    // Update supplier stats (supplier was fetched earlier)
    if (supplier) {
      supplier.outstandingBalance = Math.max(
        0,
        (parseFloat(supplier.outstandingBalance) || 0) - amount,
      );
      // Update last purchase date if this is the first payment or auto-received
      if (
        purchase.stockAdded ||
        (!purchase.stockAdded &&
          purchase.status === "draft" &&
          (paymentMethod === "cash" || paymentMethod === "card"))
      ) {
        supplier.lastPurchaseDate = new Date();
      }
      await supplier.save();
    }

    await purchase.save();

    // Create journal entry for payment (Accounts Payable Debit, Cash/Bank Credit)
    try {
      // Get bank account code if bank payment
      let bankAccountCode = null;
      if (
        (paymentMethod === "bank_transfer" ||
          paymentMethod === "cheque" ||
          paymentMethod === "mobile_money") &&
        bankAccountId
      ) {
        const bankAccount = await BankAccount.findOne({
          _id: bankAccountId,
          company: companyId,
          isActive: true,
        });
        if (bankAccount && bankAccount.accountCode) {
          bankAccountCode = bankAccount.accountCode;
        }
      }

      await JournalService.createPurchasePaymentEntry(companyId, req.user.id, {
        purchaseNumber: purchase.purchaseNumber,
        date: new Date(),
        amount: amount,
        paymentMethod: paymentMethod,
        bankAccountCode: bankAccountCode,
        bankAccountId: bankAccountId || null,
        vatAmount: purchase.totalTax || 0,
        netAmount: purchase.subtotal || (amount - (purchase.totalTax || 0)),
      });
    } catch (journalError) {
      console.error(
        "Error creating journal entry for purchase payment:",
        journalError,
      );
      // Don't fail the payment if journal entry fails
    }

    // Payment settles the supplier liability; budget actuals are recognized on
    // receipt and must not be counted again when cash is paid.

    // Auto-create APPayment for system-generated ledger record
    let autoPayment = null;
    try {
      autoPayment = new APPayment({
        company: companyId,
        supplier: purchase.supplier,
        paymentDate: new Date(),
        paymentMethod: paymentMethod === "mobile_money" || paymentMethod === "card"
          ? "bank_transfer"
          : ["bank_transfer", "cash", "cheque", "other"].includes(paymentMethod)
            ? paymentMethod
            : "other",
        bankAccount: bankAccountId || null,
        amountPaid: mongoose.Types.Decimal128.fromString(amount.toFixed(2)),
        currencyCode: purchase.currencyCode || "USD",
        exchangeRate: mongoose.Types.Decimal128.fromString("1"),
        referenceNo: paymentReferenceNo,
        reference: paymentReference,
        status: "posted",
        postedBy: req.user.id,
        postedAt: new Date(),
        notes: notes || `System-generated payment for purchase`,
        createdBy: req.user.id,
      });
      await autoPayment.save();

      // Create AP tracking transaction so Dashboard/Transactions tabs show data
      try {
        const APTrackingService = require("../services/apTrackingService");
        await APTrackingService.recordPaymentPosted(autoPayment, req.user.id);
      } catch (trackingErr) {
        console.error("AP tracking error for auto payment:", trackingErr);
      }
    } catch (apPaymentError) {
      console.error("Error auto-creating AP payment for purchase payment:", apPaymentError);
      // Non-fatal — purchase payment already recorded
    }

    // Invalidate report cache - payment affects Balance Sheet (cash, payables) and P&L
    try {
      await cacheService.invalidateByCompany(companyId, "report");
    } catch (e) {
      console.error("Cache invalidation failed:", e);
    }

    // Send email notification
    const sendEmailOnPayment = req.body.sendEmail || false;
    if (sendEmailOnPayment) {
      await sendPurchaseEmail(purchase, 'paid', companyId);
    }

    res.json({
      success: true,
      message: "Payment recorded successfully",
      data: purchase,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Cancel purchase (reverse stock if received)
// @route   PUT /api/purchases/:id/cancel
// @access  Private (admin)
exports.cancelPurchase = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { reason } = req.body;

    const purchase = await Purchase.findOne({
      _id: req.params.id,
      company: companyId,
    }).populate("items.product");

    if (!purchase) {
      return res.status(404).json({
        success: false,
        message: "Purchase not found",
      });
    }

    if (purchase.status === "paid") {
      return res.status(400).json({
        success: false,
        message:
          "Cannot cancel fully paid purchase. Please contact administrator",
      });
    }

    if (purchase.stockAdded) {
      return res.status(409).json({
        success: false,
        message: "Received purchases cannot be cancelled. Create a purchase return or supplier credit note so stock, accounts payable, and project actuals are reversed together.",
      });
    }
    if (Number(purchase.amountPaid || 0) > 0) {
      return res.status(409).json({
        success: false,
        message: "A purchase with payments cannot be cancelled. Record the supplier refund or credit note first.",
      });
    }
    if (!['draft', 'ordered'].includes(purchase.status)) {
      return res.status(409).json({ success: false, message: "Only unreceived draft or ordered purchases can be cancelled" });
    }

    const Encumbrance = require('../models/Encumbrance');
    const commitments = await Encumbrance.find({
      source_type: 'purchase', source_id: purchase._id.toString(), company_id: companyId,
      status: { $in: ['active', 'partially_liquidated'] },
    });
    const BudgetService = require('../services/budgetService');
    for (const commitment of commitments) {
      await BudgetService.releaseEncumbrance(companyId, 'purchase', purchase._id.toString(),
        `Direct purchase ${purchase.purchaseNumber} cancelled`, req.user.id, commitment._id);
    }

    // Update supplier outstanding balance
    const supplier = await Supplier.findOne({
      _id: purchase.supplier,
      company: companyId,
    });
    if (supplier) {
      const unpaidAmount = purchase.roundedAmount - purchase.amountPaid;
      supplier.outstandingBalance -= unpaidAmount;
      if (supplier.outstandingBalance < 0) supplier.outstandingBalance = 0;
      await supplier.save();
    }

    purchase.status = "cancelled";
    purchase.cancelledDate = new Date();
    purchase.cancelledBy = req.user.id;
    purchase.cancellationReason = reason;

    await purchase.save();

    // Invalidate report cache - cancellation affects Balance Sheet and P&L
    try {
      await cacheService.invalidateByCompany(companyId, "report");
    } catch (e) {
      console.error("Cache invalidation failed:", e);
    }

    // Send email notification
    const sendEmailOnCancel = req.body.sendEmail || false;
    if (sendEmailOnCancel) {
      await sendPurchaseEmail(purchase, 'cancelled', companyId);
    }

    emitDataChanged(companyId, "purchases", { affectsStock: true });
    await cacheService.bumpCompanyStockCaches(companyId);
    res.json({
      success: true,
      message: "Purchase cancelled and stock reversed",
      data: purchase,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get purchases for a specific supplier
// @route   GET /api/purchases/supplier/:supplierId
// @access  Private
exports.getSupplierPurchases = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const purchases = await Purchase.find({
      supplier: req.params.supplierId,
      company: companyId,
    })
      .populate("items.product", "name sku")
      .populate("createdBy", "name email")
      .sort({ purchaseDate: -1 });

    res.json({
      success: true,
      count: purchases.length,
      data: purchases,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Generate purchase PDF
// @route   GET /api/purchases/:id/pdf
// @access  Private
exports.generatePurchasePDF = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const purchase = await Purchase.findOne({
      _id: req.params.id,
      company: companyId,
    })
      .populate("supplier")
      .populate("items.product")
      .populate("createdBy");

    if (!purchase) {
      return res.status(404).json({
        success: false,
        message: "Purchase not found",
      });
    }

    // Create PDF document with pagination support
    const doc = new PDFDocument({ margin: 50, bufferPages: true });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=purchase-${purchase.purchaseNumber}.pdf`,
    );

    doc.pipe(res);

    const currency = purchase.currency || "FRW";
    const currencySymbol = currency === "USD" ? "$" : "";
    const fmt = (v) =>
      currencySymbol
        ? `${currencySymbol} ${Number(v || 0).toFixed(2)}`
        : Number(v || 0).toLocaleString();

    let page = 1;

    const drawHeader = () => {
      doc
        .font("Helvetica-Bold")
        .fontSize(20)
        .fillColor("#111827")
        .text("PURCHASE ORDER", 50, 48);
      doc.fontSize(9).font("Helvetica").fillColor("#6b7280");
      doc.text(`Purchase Number: ${purchase.purchaseNumber}`, 50, 74);
      doc.text(
        `Purchase Date: ${new Date(purchase.purchaseDate).toLocaleDateString()}`,
        50,
        88,
      );
      doc.text(`Status: ${purchase.status.toUpperCase()}`, 50, 102);
      doc.text(`Currency: ${currency}`, 50, 116);

      // Supplier box
      doc.rect(330, 74, 220, 70).fillAndStroke("#ffffff", "#e5e7eb");
      doc
        .fillColor("#374151")
        .font("Helvetica-Bold")
        .fontSize(10)
        .text("SUPPLIER", 340, 78);
      doc.font("Helvetica").fontSize(10).fillColor("#111827");
      doc.text(
        purchase.supplierName || purchase.supplier?.name || "N/A",
        340,
        96,
      );
      if (purchase.supplierTin)
        doc.text(`TIN: ${purchase.supplierTin}`, 340, 110);
      if (purchase.supplierAddress)
        doc.text(purchase.supplierAddress, 340, 124, { width: 200 });

      // horizontal rule
      doc
        .moveTo(50, 150)
        .lineTo(doc.page.width - 50, 150)
        .lineWidth(0.5)
        .strokeColor("#e5e7eb")
        .stroke();
    };

    const drawFooter = (p) => {
      const bottom = doc.page.height - 40;
      doc.fontSize(8).fillColor("#9ca3af").font("Helvetica");
      doc.text(`Generated: ${new Date().toLocaleString()}`, 50, bottom, {
        align: "left",
      });
      doc.text(`Page ${p}`, 0, bottom, { align: "right" });
    };

    const tableHeader = (y) => {
      doc.rect(50, y, doc.page.width - 100, 28).fill("#111827");
      doc.fillColor("#ffffff").fontSize(10).font("Helvetica-Bold");
      doc.text("#", 56, y + 8);
      doc.text("Item / Description", 80, y + 8);
      doc.text("Qty", 320, y + 8, { width: 30, align: "right" });
      doc.text("Unit Cost", 370, y + 8, { width: 70, align: "right" });
      doc.text("Tax", 450, y + 8, { width: 50, align: "right" });
      doc.text("Total", 510, y + 8, { width: 70, align: "right" });
    };

    // Begin page
    drawHeader();
    let y = 170;
    tableHeader(y);
    y += 36;
    doc.font("Helvetica").fontSize(9).fillColor("#111827");

    purchase.items.forEach((item, idx) => {
      if (y > doc.page.height - 150) {
        drawFooter(page);
        doc.addPage();
        page += 1;
        drawHeader();
        y = 170;
        tableHeader(y);
        y += 36;
        doc.font("Helvetica").fontSize(9).fillColor("#111827");
      }

      if (idx % 2 === 0) {
        doc.rect(50, y - 6, doc.page.width - 100, 18).fill("#f9fafb");
      }

      doc.fillColor("#111827");
      doc.text(`${idx + 1}`, 56, y);
      doc.text(item.product?.name || item.description || "N/A", 80, y, {
        width: 230,
      });
      doc.text((item.quantity || 0).toString(), 320, y, {
        width: 40,
        align: "right",
      });
      doc.text(fmt(item.unitCost), 370, y, { width: 70, align: "right" });
      doc.text(`${item.taxCode || "A"} (${item.taxRate}%)`, 450, y, {
        width: 50,
        align: "right",
      });
      doc.text(fmt(item.totalWithTax), 510, y, { width: 70, align: "right" });
      y += 20;
    });

    // Totals block
    if (y > doc.page.height - 200) {
      drawFooter(page);
      doc.addPage();
      page += 1;
      drawHeader();
      y = 170;
    }

    const totalsX = doc.page.width - 260;
    doc
      .rect(totalsX - 10, y, 230, 110)
      .fill("#ffffff")
      .stroke("#e5e7eb");
    let ty = y + 8;
    doc.fillColor("#6b7280").fontSize(10).font("Helvetica");
    doc.text("Subtotal", totalsX, ty, { width: 140, align: "left" });
    doc
      .fillColor("#111827")
      .text(fmt(purchase.subtotal), totalsX + 100, ty, {
        width: 120,
        align: "right",
      });
    ty += 18;

    doc.fillColor("#6b7280").text("Tax", totalsX, ty);
    doc
      .fillColor("#111827")
      .text(fmt(purchase.totalTax), totalsX + 100, ty, {
        width: 120,
        align: "right",
      });
    ty += 18;

    doc.rect(totalsX - 10, ty - 6, 230, 40).fill("#111827");
    doc.fillColor("#ffffff").fontSize(12).font("Helvetica-Bold");
    doc.text("TOTAL", totalsX, ty, { width: 140, align: "left" });
    doc.text(fmt(purchase.grandTotal), totalsX + 100, ty + 2, {
      width: 120,
      align: "right",
    });
    ty += 52;

    doc.fillColor("#10b981").fontSize(10).font("Helvetica");
    doc.text("Paid", totalsX, ty - 8, { width: 140, align: "left" });
    doc.text(fmt(purchase.amountPaid), totalsX + 100, ty - 8, {
      width: 120,
      align: "right",
    });
    ty += 18;

    doc.fillColor("#ef4444").fontSize(11).font("Helvetica-Bold");
    doc.text("BALANCE", totalsX, ty - 8, { width: 140, align: "left" });
    doc.text(fmt(purchase.balance), totalsX + 100, ty - 8, {
      width: 120,
      align: "right",
    });

    // Notes
    y += 140;
    if (purchase.notes) {
      if (y > doc.page.height - 120) {
        drawFooter(page);
        doc.addPage();
        page += 1;
        drawHeader();
        y = 170;
      }
      doc.moveDown(1);
      doc
        .fillColor("#374151")
        .fontSize(10)
        .font("Helvetica-Bold")
        .text("NOTES", 56, y);
      y += 14;
      doc
        .font("Helvetica")
        .fontSize(9)
        .fillColor("#6b7280")
        .text(purchase.notes, 56, y, { width: doc.page.width - 120 });
    }

    // Finalize
    drawFooter(page);
    doc.end();
  } catch (error) {
    next(error);
  }
};
