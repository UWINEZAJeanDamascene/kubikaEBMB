const Client = require('../models/Client');
const Invoice = require('../models/Invoice');
const CreditNote = require('../models/CreditNote');
const ARReceipt = require('../models/ARReceipt');
const EBMBranchService = require('../services/ebmBranchService');
function sanitizeClientBody(body = {}) {
  const {
    registerWithEbmBranch,
    autoSaveEbmBranchCustomer,
    ebmBranchId,
    branchId,
    bhfId,
    ...clientData
  } = body;
  return clientData;
}

function shouldRegisterBranchCustomer(body = {}) {
  return body.registerWithEbmBranch === true
    || body.registerWithEbmBranch === 'true'
    || body.autoSaveEbmBranchCustomer === true
    || body.autoSaveEbmBranchCustomer === 'true'
    || process.env.EBM_AUTO_SAVE_BRANCH_CUSTOMERS === 'true';
}

function getRequestedBranchId(body = {}) {
  return body.ebmBranchId || body.branchId || body.bhfId || '00';
}

async function trySaveClientBranchCustomer({ companyId, clientId, body, user }) {
  if (!shouldRegisterBranchCustomer(body)) return null;
  const branchId = getRequestedBranchId(body);
  try {
    const result = await EBMBranchService.saveBranchCustomer(companyId, clientId, branchId, user);
    return {
      success: true,
      branchId,
      vsdc: {
        resultCd: result.response?.resultCd,
        resultMsg: result.response?.resultMsg,
        resultDt: result.response?.resultDt,
        mode: result.response?.mode,
        requestId: result.response?.requestId,
      },
    };
  } catch (error) {
    return {
      success: false,
      branchId,
      message: error.message || 'Client saved, but RRA EBM branch customer registration failed',
      code: error.code,
    };
  }
}

// @desc    Get all clients
// @route   GET /api/clients
// @access  Private
exports.getClients = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { page = 1, limit = 20, search, type, isActive } = req.query;
    const query = { company: companyId };

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { code: { $regex: search, $options: 'i' } },
        { 'contact.email': { $regex: search, $options: 'i' } }
      ];
    }

    if (type) {
      query.type = type;
    }

    if (isActive !== undefined) {
      query.isActive = isActive === 'true';
    }

    const CLIENT_LIST_SELECT = req.query.forPicker === '1'
      ? '_id name code contact type isActive taxId paymentTerms creditLimit outstandingBalance'
      : '_id name code type contact isActive creditLimit outstandingBalance totalPurchases lastPurchaseDate taxId paymentTerms createdAt updatedAt';

    const total = await Client.countDocuments(query);
    const clients = await Client.find(query)
      .select(CLIENT_LIST_SELECT)
      .sort({ name: 1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    res.json({
      success: true,
      count: clients.length,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page,
      data: clients
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single client
// @route   GET /api/clients/:id
// @access  Private
exports.getClient = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const client = await Client.findOne({ _id: req.params.id, company: companyId })
      .populate('createdBy', 'name email');

    if (!client) {
      return res.status(404).json({
        success: false,
        message: 'Client not found'
      });
    }

    res.json({
      success: true,
      data: client
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create new client
// @route   POST /api/clients
// @access  Private (admin, stock_manager, sales)
exports.createClient = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const clientData = sanitizeClientBody(req.body);
    clientData.createdBy = req.user.id;
    clientData.company = companyId;

    let client = await Client.create(clientData);
    const ebmBranchCustomer = await trySaveClientBranchCustomer({
      companyId,
      clientId: client._id,
      body: req.body,
      user: req.user,
    });
    if (ebmBranchCustomer) {
      client = await Client.findOne({ _id: client._id, company: companyId });
    }

    res.status(201).json({
      success: true,
      data: client,
      ...(ebmBranchCustomer ? { ebmBranchCustomer } : {})
    });
  } catch (error) {
    // Handle duplicate key error more gracefully
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      return res.status(400).json({
        success: false,
        message: `A client with this ${field} already exists`
      });
    }
    // Handle validation errors from pre-save hook
    if (error.message && error.message.includes('already exists')) {
      return res.status(400).json({
        success: false,
        message: error.message
      });
    }
    next(error);
  }
};

// @desc    Update client
// @route   PUT /api/clients/:id
// @access  Private (admin, stock_manager, sales)
exports.updateClient = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const client = await Client.findOneAndUpdate(
      { _id: req.params.id, company: companyId },
      sanitizeClientBody(req.body),
      {
        new: true,
        runValidators: true
      }
    );

    if (!client) {
      return res.status(404).json({
        success: false,
        message: 'Client not found'
      });
    }

    const ebmBranchCustomer = await trySaveClientBranchCustomer({
      companyId,
      clientId: client._id,
      body: req.body,
      user: req.user,
    });
    const responseClient = ebmBranchCustomer
      ? await Client.findOne({ _id: client._id, company: companyId })
      : client;

    res.json({
      success: true,
      data: responseClient,
      ...(ebmBranchCustomer ? { ebmBranchCustomer } : {})
    });
  } catch (error) {
    next(error);
  }
};


// @desc    Save client as an RRA EBM branch customer
// @route   POST /api/clients/:id/ebm/branch-customer
// @access  Private (admin, stock_manager, sales)
exports.saveClientBranchCustomer = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const branchId = req.body.branchId || req.body.bhfId || '00';
    const result = await EBMBranchService.saveBranchCustomer(
      companyId,
      req.params.id,
      branchId,
      req.user,
    );

    res.json({
      success: true,
      data: result.client,
      vsdc: {
        resultCd: result.response?.resultCd,
        resultMsg: result.response?.resultMsg,
        resultDt: result.response?.resultDt,
        mode: result.response?.mode,
        requestId: result.response?.requestId,
      },
      message: result.response?.mode === 'production'
        ? 'Client accepted by RRA as a branch customer'
        : result.response?.mode === 'mock'
          ? 'Mock request succeeded; the client is not registered with RRA'
          : 'Client accepted by the RRA VSDC environment',
    });
  } catch (error) {
    next(error);
  }
};

exports.getClientBranchCustomerStatus = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const data = await EBMBranchService.getBranchCustomerStatus(companyId, req.params.id);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};
// @desc    Verify client TIN with RRA VSDC
// @route   POST /api/clients/:id/ebm/verify-tin
// @access  Private (admin, stock_manager, sales)
exports.verifyClientTin = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const EBMTinService = require('../services/ebmCustomerTinService');
    const result = await EBMTinService.verifyClientTin(companyId, req.params.id, {
      branchId: req.body.branchId || req.body.bhfId || '00',
    });

    res.json({
      success: true,
      data: result.client,
      verification: result.verification,
      message: 'Client TIN verified with RRA',
    });
  } catch (error) {
    next(error);
  }
};
// @desc    Delete client
// @route   DELETE /api/clients/:id
// @access  Private (admin)
exports.deleteClient = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    // Check if client has invoices before deleting
    const Invoice = require('../models/Invoice');
    const invoiceCount = await Invoice.countDocuments({ client: req.params.id, company: companyId });
    
    if (invoiceCount > 0) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete client with existing invoices'
      });
    }
    
    const client = await Client.findOneAndDelete({ _id: req.params.id, company: companyId });

    if (!client) {
      return res.status(404).json({
        success: false,
        message: 'Client not found'
      });
    }

    res.json({
      success: true,
      message: 'Client deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get client purchase history
// @route   GET /api/clients/:id/purchase-history
// @access  Private
exports.getClientPurchaseHistory = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { page = 1, limit = 20, startDate, endDate } = req.query;
    const query = { 
      client: req.params.id,
      company: companyId,
      status: { $in: ['paid', 'partial'] }
    };

    if (startDate || endDate) {
      query.invoiceDate = {};
      if (startDate) query.invoiceDate.$gte = new Date(startDate);
      if (endDate) query.invoiceDate.$lte = new Date(endDate);
    }

    const total = await Invoice.countDocuments(query);
    const invoices = await Invoice.find(query)
      .populate('createdBy', 'name email')
      .sort({ invoiceDate: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    // Calculate totals
    const allInvoices = await Invoice.find(query);
    const totalAmount = allInvoices.reduce((sum, invoice) => sum + invoice.grandTotal, 0);
    const totalPaid = allInvoices.reduce((sum, invoice) => sum + invoice.amountPaid, 0);

    res.json({
      success: true,
      count: invoices.length,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page,
      summary: {
        totalAmount,
        totalPaid,
        totalInvoices: total
      },
      data: invoices
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get client outstanding invoices
// @route   GET /api/clients/:id/outstanding-invoices
// @access  Private
exports.getClientOutstandingInvoices = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const invoices = await Invoice.find({
      client: req.params.id,
      company: companyId,
      status: { $in: ['pending', 'partial', 'overdue'] }
    })
      .populate('createdBy', 'name email')
      .sort({ dueDate: 1 });

    const totalOutstanding = invoices.reduce((sum, invoice) => sum + invoice.balance, 0);

    res.json({
      success: true,
      count: invoices.length,
      totalOutstanding,
      data: invoices
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Toggle client status (activate/deactivate)
// @route   PUT /api/clients/:id/toggle-status
// @access  Private (admin, stock_manager)
exports.toggleClientStatus = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const client = await Client.findOne({ _id: req.params.id, company: companyId });

    if (!client) {
      return res.status(404).json({
        success: false,
        message: 'Client not found'
      });
    }

    client.isActive = !client.isActive;
    await client.save();

    res.json({
      success: true,
      data: client
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get client with invoice stats (for list view)
// @route   GET /api/clients/with-stats
// @access  Private
exports.getClientsWithStats = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { page = 1, limit = 50, search, type, isActive } = req.query;
    const query = { company: companyId };

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { code: { $regex: search, $options: 'i' } },
        { 'contact.email': { $regex: search, $options: 'i' } }
      ];
    }

    if (type) {
      query.type = type;
    }

    if (isActive !== undefined) {
      query.isActive = isActive === 'true';
    }

    const CLIENT_LIST_SELECT = req.query.forPicker === '1'
      ? '_id name code contact type isActive taxId paymentTerms creditLimit outstandingBalance'
      : '_id name code type contact isActive creditLimit outstandingBalance totalPurchases lastPurchaseDate taxId paymentTerms createdAt updatedAt';

    const total = await Client.countDocuments(query);
    const clients = await Client.find(query)
      .select(CLIENT_LIST_SELECT)
      .sort({ name: 1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    // Get outstanding invoice counts for each client
    const clientIds = clients.map(c => c._id);
    const invoiceStats = await Invoice.aggregate([
      {
        $match: {
          client: { $in: clientIds },
          company: companyId,
          status: { $in: ['draft', 'confirmed', 'partially_paid'] }
        }
      },
      {
        $group: {
          _id: '$client',
          outstandingCount: { $sum: 1 },
          totalOutstanding: { $sum: '$amountOutstanding' }
        }
      }
    ]);

    // Get overdue amounts (invoices with due date in the past, not fully paid or cancelled)
    const overdueStats = await Invoice.aggregate([
      {
        $match: {
          client: { $in: clientIds },
          company: companyId,
          status: { $nin: ['fully_paid', 'cancelled'] },
          dueDate: { $lt: new Date() }
        }
      },
      {
        $group: {
          _id: '$client',
          overdueAmount: { $sum: '$amountOutstanding' }
        }
      }
    ]);

    const statsMap = {};
    const overdueMap = {};
    invoiceStats.forEach(stat => {
      statsMap[stat._id.toString()] = {
        outstandingCount: stat.outstandingCount,
        totalOutstanding: stat.totalOutstanding
      };
    });
    overdueStats.forEach(stat => {
      overdueMap[stat._id.toString()] = stat.overdueAmount;
    });

    // Add outstanding count to each client
    const clientsWithStats = clients.map(client => {
      const stats = statsMap[client._id.toString()] || { outstandingCount: 0, totalOutstanding: 0 };
      const overdueRaw = overdueMap[client._id.toString()] || 0;
      const overdue = typeof overdueRaw === 'object' && overdueRaw !== null 
        ? parseFloat(overdueRaw.toString()) 
        : overdueRaw;
      const totalOut = typeof stats.totalOutstanding === 'object' && stats.totalOutstanding !== null 
        ? parseFloat(stats.totalOutstanding.toString()) 
        : stats.totalOutstanding;
      return {
        ...client.toObject(),
        outstandingInvoices: stats.outstandingCount,
        totalOutstanding: totalOut,
        overdueAmount: overdue
      };
    });

    res.json({
      success: true,
      count: clients.length,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page,
      data: clientsWithStats
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Export clients to PDF
// @route   GET /api/clients/export/pdf
// @access  Private
exports.exportClientsToPDF = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const PDFDocument = require('pdfkit');
    const { type, isActive } = req.query;
    
    const query = { company: companyId };
    if (type) query.type = type;
    if (isActive !== undefined) query.isActive = isActive === 'true';

    const clients = await Client.find(query).sort({ name: 1 });

    // Get invoice stats
    const clientIds = clients.map(c => c._id);
    const invoiceStats = await Invoice.aggregate([
      {
        $match: {
          client: { $in: clientIds },
          company: companyId,
          status: { $in: ['paid', 'partial'] }
        }
      },
      {
        $group: {
          _id: '$client',
          totalPurchases: { $sum: '$grandTotal' }
        }
      }
    ]);

    const statsMap = {};
    invoiceStats.forEach(stat => {
      statsMap[stat._id.toString()] = stat.totalPurchases;
    });

    const doc = new PDFDocument({ margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=clients-report.pdf');
    doc.pipe(res);

    doc.fontSize(20).text('CLIENTS REPORT', { align: 'center' });
    doc.moveDown();
    doc.fontSize(10).text(`Generated on: ${new Date().toLocaleString()}`, { align: 'center' });
    doc.moveDown(2);

    // Table headers
    const startX = 50;
    let y = 150;
    doc.fontSize(10).text('Code', startX, y);
    doc.text('Name', startX + 50, y);
    doc.text('Type', startX + 150, y);
    doc.text('Email', startX + 210, y);
    doc.text('Phone', startX + 320, y);
    doc.text('Total Purchases', startX + 410, y);
    doc.text('Status', startX + 510, y);

    y += 20;
    doc.fontSize(9);

    clients.forEach(client => {
      if (y > 700) {
        doc.addPage();
        y = 50;
      }
      
      const totalPurchases = statsMap[client._id.toString()] || 0;
      
      doc.text(client.code || '-', startX, y);
      doc.text((client.name || '').substring(0, 25), startX + 50, y);
      doc.text(client.type || 'individual', startX + 150, y);
      doc.text((client.contact?.email || '-').substring(0, 20), startX + 210, y);
      doc.text(client.contact?.phone || '-', startX + 320, y);
      doc.text(`${totalPurchases.toFixed(2)}`, startX + 410, y);
      doc.text(client.isActive ? 'Active' : 'Inactive', startX + 510, y);
      
      y += 18;
    });

    doc.end();
  } catch (error) {
    next(error);
  }
};

// @desc    Get client invoices
// @route   GET /api/clients/:id/invoices
// @access  Private
exports.getClientInvoices = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { page = 1, limit = 20, status } = req.query;
    const query = { 
      client: req.params.id,
      company: companyId
    };

    if (status) {
      query.status = status;
    }

    const total = await Invoice.countDocuments(query);
    const invoices = await Invoice.find(query)
      .populate('createdBy', 'name email')
      .sort({ invoiceDate: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    // Calculate totals
    const allInvoices = await Invoice.find(query);
    const getVal = (value) => {
      if (value && typeof value === 'object' && value.toString) {
        return parseFloat(value.toString()) || 0;
      }
      return Number(value) || 0;
    };
    const invoiceAmounts = allInvoices.map((inv) => {
      const raw = inv._doc || inv;
      const lines = Array.isArray(raw.lines) ? raw.lines : [];
      const lineTotal = lines.reduce((sum, line) => {
        const quantity = getVal(line.qty || line.quantity);
        const subtotal = getVal(line.lineSubtotal || line.subtotal) || quantity * getVal(line.unitPrice);
        const tax = getVal(line.lineTax || line.taxAmount);
        return sum + (getVal(line.lineTotal || line.totalWithTax) || subtotal + tax);
      }, 0);
      const total = getVal(raw.totalAmount) || getVal(raw.grandTotal) || lineTotal;
      const paid = getVal(raw.amountPaid) || (Array.isArray(raw.payments)
        ? raw.payments.reduce((sum, payment) => sum + getVal(payment.amount), 0)
        : 0);
      const balance = getVal(raw.amountOutstanding) || Math.max(0, total - paid);
      return { total, paid, balance };
    });
    const totalAmount = invoiceAmounts.reduce((sum, amounts) => sum + amounts.total, 0);
    const totalPaid = invoiceAmounts.reduce((sum, amounts) => sum + amounts.paid, 0);
    const totalBalance = invoiceAmounts.reduce((sum, amounts) => sum + amounts.balance, 0);

    res.json({
      success: true,
      count: invoices.length,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page,
      summary: {
        totalAmount,
        totalPaid,
        totalBalance
      },
      data: invoices
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get client receipts (payments)
// @route   GET /api/clients/:id/receipts
// @access  Private
exports.getClientReceipts = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { page = 1, limit = 20, startDate, endDate } = req.query;
    const query = { 
      company: companyId
    };
    const getVal = (value) => {
      if (value && typeof value === 'object' && value.toString) {
        return parseFloat(value.toString()) || 0;
      }
      return Number(value) || 0;
    };

    // Find receipts that have allocations to this client's invoices
    const receipts = await ARReceipt.find(query)
      .populate('createdBy', 'name email')
      .sort({ receiptDate: -1 })
      .limit(1000);

    // Filter receipts that have allocations to this client
    const ARReceiptAllocation = require('../models/ARReceiptAllocation');
    const clientReceipts = [];
    
    for (const receipt of receipts) {
      const allocations = await ARReceiptAllocation.find({ receipt: receipt._id })
        .populate({
          path: 'invoice',
          match: { client: req.params.id }
        });
      
      if (allocations.some(a => a.invoice)) {
        clientReceipts.push(receipt);
      }
    }

    const clientInvoices = await Invoice.find({ client: req.params.id, company: companyId });
    const invoicePayments = clientInvoices.flatMap((invoice) => {
      const rawInvoice = invoice._doc || invoice;
      return (Array.isArray(rawInvoice.payments) ? rawInvoice.payments : []).map((payment, index) => ({
        _id: payment._id || `${rawInvoice._id}-payment-${index}`,
        referenceNo: payment.reference || rawInvoice.referenceNo || rawInvoice.invoiceNumber,
        receiptDate: payment.paidDate || payment.recordedAt || rawInvoice.invoiceDate,
        amount: getVal(payment.amount),
        paymentMethod: payment.paymentMethod || 'unknown',
        status: 'posted',
      }));
    });
    const allClientReceipts = [...clientReceipts, ...invoicePayments]
      .filter((receipt, index, values) => values.findIndex((candidate) => String(candidate._id) === String(receipt._id)) === index)
      .sort((a, b) => new Date(b.receiptDate || 0) - new Date(a.receiptDate || 0));
    const total = allClientReceipts.length;
    const offset = (Number(page) - 1) * Number(limit);
    const pagedReceipts = allClientReceipts.slice(offset, offset + Number(limit));
    const totalAmount = allClientReceipts.reduce((sum, r) => sum + getVal(r.amount), 0);

    res.json({
      success: true,
      count: pagedReceipts.length,
      total,
      summary: {
        totalAmount
      },
      data: pagedReceipts
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get client credit notes
// @route   GET /api/clients/:id/credit-notes
// @access  Private
exports.getClientCreditNotes = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { page = 1, limit = 20 } = req.query;
    const query = { 
      client: req.params.id,
      company: companyId
    };

    const total = await CreditNote.countDocuments(query);
    const creditNotes = await CreditNote.find(query)
      .populate('createdBy', 'name email')
      // Model uses `creditDate`; sort by that to get expected ordering
      .sort({ creditDate: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    // Normalize returned docs to ensure a numeric `grandTotal` is present (fall back to totalAmount)
    // and provide `creditNoteDate` for frontend consumers (fallback to `creditDate` or createdAt)
    const normalizedNotes = creditNotes.map(cnDoc => {
      const cn = (typeof cnDoc.toObject === 'function') ? cnDoc.toObject() : { ...cnDoc };
      const fallback = (cn.totalAmount !== undefined && cn.totalAmount !== null) ? Number(cn.totalAmount) : 0;
      // Support legacy or differing field names for total
      cn.grandTotal = (cn.grandTotal !== undefined && cn.grandTotal !== null) ? Number(cn.grandTotal) : fallback;
      // Normalize date field expected by frontend: `creditNoteDate`
      cn.creditNoteDate = cn.creditNoteDate || cn.creditDate || cn.createdAt || null;
      return cn;
    });

    const totalAmount = normalizedNotes.reduce((sum, cn) => sum + (Number(cn.grandTotal) || 0), 0);

    res.json({
      success: true,
      count: creditNotes.length,
      total,
      pages: Math.ceil(total / limit),
      currentPage: page,
      summary: {
        totalAmount
      },
      data: normalizedNotes
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Generate client statement PDF
// @route   GET /api/clients/:id/statement
// @access  Private
exports.getClientStatementPDF = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { startDate, endDate } = req.query;
    
    const client = await Client.findOne({ _id: req.params.id, company: companyId });
    if (!client) {
      return res.status(404).json({
        success: false,
        message: 'Client not found'
      });
    }

    // Get invoices for the period
    const invoiceQuery = { 
      client: req.params.id,
      company: companyId
    };

    if (startDate || endDate) {
      invoiceQuery.invoiceDate = {};
      if (startDate) invoiceQuery.invoiceDate.$gte = new Date(startDate);
      if (endDate) invoiceQuery.invoiceDate.$lte = new Date(endDate);
    }

    const invoices = await Invoice.find(invoiceQuery).sort({ invoiceDate: 1 });
    
    // Get receipts
    const ARReceipt = require('../models/ARReceipt');
    const receiptQuery = { company: companyId };
    if (startDate || endDate) {
      receiptQuery.receiptDate = {};
      if (startDate) receiptQuery.receiptDate.$gte = new Date(startDate);
      if (endDate) receiptQuery.receiptDate.$lte = new Date(endDate);
    }
    const receipts = await ARReceipt.find(receiptQuery).sort({ receiptDate: 1 });

    // Generate PDF
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ margin: 50 });
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=statement-${client.code || client.name}-${new Date().toISOString().split('T')[0]}.pdf`);
    doc.pipe(res);

    // Header
    doc.fontSize(20).text('ACCOUNT STATEMENT', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(12).text(`Client: ${client.name}`, { align: 'center' });
    doc.fontSize(10).text(`Period: ${startDate || 'Start'} to ${endDate || 'Today'}`, { align: 'center' });
    doc.moveDown(2);

    // Outstanding Summary
    doc.fontSize(12).text('Account Summary', { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(10);
    doc.text(`Current Outstanding: ${(client.outstandingBalance || 0).toFixed(2)}`);
    doc.text(`Total Purchases: ${(client.totalPurchases || 0).toFixed(2)}`);
    doc.moveDown(2);

    // Invoices Table
    if (invoices.length > 0) {
      doc.fontSize(12).text('Invoices', { underline: true });
      doc.moveDown(0.5);
      
      const startX = 50;
      let y = doc.y;
      
      doc.fontSize(9).text('Date', startX, y);
      doc.text('Invoice #', startX + 70, y);
      doc.text('Due Date', startX + 170, y);
      doc.text('Amount', startX + 250, y);
      doc.text('Paid', startX + 330, y);
      doc.text('Balance', startX + 400, y);
      
      y += 15;
      doc.fontSize(8);

      invoices.forEach(inv => {
        if (y > 700) {
          doc.addPage();
          y = 50;
        }
        
        const invDate = inv.invoiceDate ? new Date(inv.invoiceDate).toLocaleDateString() : '-';
        const dueDate = inv.dueDate ? new Date(inv.dueDate).toLocaleDateString() : '-';
        
        doc.text(invDate, startX, y);
        doc.text((inv.referenceNo || inv.invoiceNumber || '-').substring(0, 15), startX + 70, y);
        doc.text(dueDate, startX + 170, y);
        doc.text(inv.grandTotal.toFixed(2), startX + 250, y);
        doc.text(inv.amountPaid.toFixed(2), startX + 330, y);
        doc.text(inv.balance.toFixed(2), startX + 400, y);
        
        y += 12;
      });

      // Totals
      y += 5;
      const totalAmount = invoices.reduce((sum, inv) => sum + inv.grandTotal, 0);
      const totalPaid = invoices.reduce((sum, inv) => sum + inv.amountPaid, 0);
      const totalBalance = invoices.reduce((sum, inv) => sum + inv.balance, 0);
      
      doc.fontSize(9).text('Totals:', startX + 170, y);
      doc.text(totalAmount.toFixed(2), startX + 250, y);
      doc.text(totalPaid.toFixed(2), startX + 330, y);
      doc.text(totalBalance.toFixed(2), startX + 400, y);
    }

    doc.end();
  } catch (error) {
    next(error);
  }
};
