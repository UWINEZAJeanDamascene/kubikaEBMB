const ARTransactionLedger = require('../models/ARTransactionLedger');
const ARTrackingService = require('../services/arTrackingService');
const { getARTransactions } = require('../services/ledgerReadService');
const { dbClient } = require('../lib/prisma');

/**
 * AR Reconciliation Controller
 * 
 * Provides endpoints for:
 * - Viewing AR transaction history
 * - Verifying data integrity
 * - Running reconciliation and corrections
 * - AR summary reports
 */

/**
 * @desc    Get AR transaction history for a company
 * @route   GET /api/ar-reconciliation/transactions
 * @access  Private (admin, accountant)
 */
exports.getTransactions = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { 
      page = 1, 
      limit = 50, 
      clientId, 
      invoiceId, 
      transactionType,
      startDate, 
      endDate,
      reconciliationStatus
    } = req.query;

    const { items, total, pages, currentPage } = await getARTransactions(
      companyId,
      {
        clientId,
        invoiceId,
        transactionType,
        startDate,
        endDate,
        reconciliationStatus,
      },
      { page, limit },
    );

    res.json({
      success: true,
      count: items.length,
      total,
      pages,
      currentPage,
      data: items,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get AR transaction details
 * @route   GET /api/ar-reconciliation/transactions/:id
 * @access  Private (admin, accountant)
 */
exports.getTransactionById = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const transaction = await ARTransactionLedger.findOne({
      _id: req.params.id,
      company: companyId
    })
      .populate('client', 'name code')
      .populate('invoice', 'referenceNo invoiceNumber amountOutstanding')
      .populate('receipt', 'referenceNo amountReceived')
      .populate('createdBy', 'name email')
      .populate('reversedFrom')
      .populate('reversedBy');

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found'
      });
    }

    res.json({
      success: true,
      data: transaction
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Verify AR data integrity
 * @route   POST /api/ar-reconciliation/verify
 * @access  Private (admin, accountant)
 */
exports.verifyIntegrity = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { clientId, invoiceId, startDate, endDate } = req.body;

    const result = await ARTrackingService.verifyIntegrity(companyId, {
      clientId,
      invoiceId,
      startDate,
      endDate
    });

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Run reconciliation and auto-correct discrepancies
 * @route   POST /api/ar-reconciliation/reconcile
 * @access  Private (admin)
 */
exports.reconcileAndCorrect = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;
    const { clientId, invoiceId, startDate, endDate } = req.body;

    const result = await ARTrackingService.reconcileAndCorrect(companyId, userId, {
      clientId,
      invoiceId,
      startDate,
      endDate
    });

    res.json({
      success: true,
      message: result.message,
      corrected: result.corrected
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get AR summary for a client
 * @route   GET /api/ar-reconciliation/clients/:clientId/summary
 * @access  Private (admin, accountant, sales)
 */
exports.getClientARSummary = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { clientId } = req.params;

    const summary = await ARTrackingService.getClientARSummary(companyId, clientId);

    if (!summary) {
      return res.status(404).json({
        success: false,
        message: 'Client not found or no AR data'
      });
    }

    res.json({
      success: true,
      data: summary
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get AR aging report with ledger verification
 * @route   GET /api/ar-reconciliation/aging
 * @access  Private (admin, accountant)
 */
exports.getAgingWithVerification = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { clientId, asOfDate } = req.query;

    // Get aging from ARService
    const ARService = require('../services/arService');
    const agingReport = await ARService.getAgingReport(companyId, { clientId, asOfDate });

    // Verify against ledger
    const verification = await ARTrackingService.verifyIntegrity(companyId, { clientId });

    res.json({
      success: true,
      data: {
        aging: agingReport,
        verification: {
          verified: verification.verified,
          discrepancyCount: verification.discrepancies?.length || 0
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get client statement with full transaction history
 * @route   GET /api/ar-reconciliation/clients/:clientId/statement
 * @access  Private (admin, accountant, sales)
 */
exports.getClientStatementWithHistory = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { clientId } = req.params;
    const { startDate, endDate, page = 1, limit = 50 } = req.query;

    // Get standard client statement
    const ARService = require('../services/arService');
    const statement = await ARService.getClientStatement(companyId, clientId, { startDate, endDate });

    // Get transaction history
    const query = { 
      company: companyId,
      client: clientId
    };
    
    if (startDate || endDate) {
      query.transactionDate = {};
      if (startDate) query.transactionDate.$gte = new Date(startDate);
      if (endDate) query.transactionDate.$lte = new Date(endDate);
    }

    const transactions = await ARTransactionLedger.find(query)
      .populate('invoice', 'referenceNo')
      .populate('receipt', 'referenceNo')
      .sort({ transactionDate: -1, createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await ARTransactionLedger.countDocuments(query);

    res.json({
      success: true,
      data: {
        statement: statement.data,
        transactions: {
          data: transactions,
          total,
          pages: Math.ceil(total / limit),
          currentPage: page
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Find discrepancies in AR data
 * @route   GET /api/ar-reconciliation/discrepancies
 * @access  Private (admin, accountant)
 */
exports.findDiscrepancies = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { clientId, startDate, endDate } = req.query;

    const discrepancies = await ARTransactionLedger.findDiscrepancies(companyId, {
      clientId,
      startDate,
      endDate
    });

    res.json({
      success: true,
      count: discrepancies.length,
      data: discrepancies
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get current receivables (outstanding invoices)
 * @route   GET /api/ar-reconciliation/current-receivables
 * @access  Private (admin, accountant, sales)
 */
exports.getCurrentReceivables = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const { clientId, page = 1, limit = 50 } = req.query;

    const Invoice = require('../models/Invoice');

    // Build query for outstanding invoices
    // Note: amountOutstanding is Decimal128, so we need special handling
    const query = {
      company: companyId,
      status: { $in: ['sent', 'confirmed', 'partially_paid'] },
      // Filter in SQL rather than pulling every confirmed invoice into Node.
      // `amountOutstanding` is a non-nullable Decimal defaulting to 0, so this
      // is exactly equivalent to the in-memory `parseFloat(...) > 0` below.
      amountOutstanding: { $gt: 0 }
    };

    if (clientId) query.client = clientId;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    const skip = (pageNum - 1) * limitNum;

    // The response contract is unchanged, but the list is now paged by
    // PostgreSQL. Do not fetch a tenant's whole invoice history to display one
    // 50-row page.
    const [total, invoices] = await Promise.all([
      Invoice.countDocuments(query),
      Invoice.find(query)
        .populate('client', 'name code')
        .sort({ invoiceDate: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
    ]);

    // Summary and the top-client panel describe the complete filtered set, so
    // aggregate them in Postgres instead of deriving them from the page.
    const { dbClient } = require('../lib/prisma');
    const params = [String(companyId)];
    if (clientId) params.push(String(clientId));
    const clientPredicate = clientId ? `AND c.id = $2` : '';
    const invoiceClientPredicate = clientId ? `AND i.client_id = $2` : '';
    const receivablesCte = `
      WITH invoice_totals AS (
        SELECT i.client_id,
               COALESCE(SUM(i.amount_outstanding), 0) AS invoice_outstanding,
               COUNT(*)::int AS invoice_count,
               COALESCE(SUM(CASE WHEN i.due_date < NOW() THEN i.amount_outstanding ELSE 0 END), 0) AS overdue_amount,
               COUNT(*) FILTER (WHERE i.due_date < NOW())::int AS overdue_count
          FROM invoices i
         WHERE i.company_id = $1
           AND i.status IN ('sent', 'confirmed', 'partially_paid')
           AND i.amount_outstanding > 0
           ${invoiceClientPredicate}
         GROUP BY i.client_id
      ), client_balances AS (
        SELECT c.id AS "_id", c.name, c.code,
               COALESCE(i.invoice_outstanding, 0) + GREATEST(
                 COALESCE(c.outstanding_balance, 0) - COALESCE(i.invoice_outstanding, 0),
                 0
               ) AS total_outstanding,
               COALESCE(i.invoice_count, 0)::int AS invoice_count,
               COALESCE(i.overdue_amount, 0) AS overdue_amount,
               COALESCE(i.overdue_count, 0)::int AS overdue_count
          FROM clients c
          LEFT JOIN invoice_totals i ON i.client_id = c.id
         WHERE c.company_id = $1
           ${clientPredicate}
           AND (COALESCE(i.invoice_outstanding, 0) > 0 OR COALESCE(c.outstanding_balance, 0) > 0)
      )`;
    const [summaryRows, clientRows] = await Promise.all([
      dbClient().$queryRawUnsafe(
        `${receivablesCte}
         SELECT COALESCE(SUM(total_outstanding), 0)::text AS "totalOutstanding",
                COALESCE(SUM(invoice_count), 0)::int AS "totalInvoices",
                COALESCE(SUM(overdue_amount), 0)::text AS "overdueAmount",
                COALESCE(SUM(overdue_count), 0)::int AS "overdueCount"
           FROM client_balances`,
        ...params,
      ),
      dbClient().$queryRawUnsafe(
        `${receivablesCte}
         SELECT "_id", name, code,
                total_outstanding::text AS "totalOutstanding",
                invoice_count AS "invoiceCount"
           FROM client_balances
          ORDER BY total_outstanding DESC, "_id"
          LIMIT 10`,
        ...params,
      ),
    ]);
    const aggregate = summaryRows[0] || {};
    const summary = {
      totalOutstanding: Number(aggregate.totalOutstanding || 0),
      totalInvoices: Number(aggregate.totalInvoices || 0),
      overdueAmount: Number(aggregate.overdueAmount || 0),
      overdueCount: Number(aggregate.overdueCount || 0),
    };
    const sortedClientSummary = clientRows.map((client) => ({
      _id: client._id,
      client: { _id: client._id, name: client.name, code: client.code },
      totalOutstanding: Number(client.totalOutstanding || 0),
      invoiceCount: Number(client.invoiceCount || 0),
    }));
    const paginatedInvoices = invoices;
    // Convert Decimal128 fields in invoices to plain numbers for JSON serialization
    const serializedInvoices = paginatedInvoices.map(inv => ({
      ...inv,
      totalAmount: inv.totalAmount ? parseFloat(inv.totalAmount.toString()) : 0,
      amountPaid: inv.amountPaid ? parseFloat(inv.amountPaid.toString()) : 0,
      amountOutstanding: inv.amountOutstanding ? parseFloat(inv.amountOutstanding.toString()) : 0,
      balance: inv.balance ? parseFloat(inv.balance.toString()) : (inv.amountOutstanding ? parseFloat(inv.amountOutstanding.toString()) : 0)
    }));

    res.json({
      success: true,
      data: {
        invoices: serializedInvoices,
        summary,
        clientSummary: sortedClientSummary,
        pagination: {
          total,
          pages: Math.ceil(total / limitNum),
          currentPage: pageNum,
          limit: limitNum
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get AR summary dashboard data
 * @route   GET /api/ar-reconciliation/dashboard
 * @access  Private (admin, accountant)
 */
exports.getDashboard = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;

    // Get summary stats
    const today = new Date();
    const thirtyDaysAgo = new Date(today);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [
      totalTransactions,
      recentTransactions,
      pendingReconciliation,
      discrepancyCount
    ] = await Promise.all([
      ARTransactionLedger.countDocuments({ company: companyId }),
      ARTransactionLedger.countDocuments({ 
        company: companyId,
        transactionDate: { $gte: thirtyDaysAgo }
      }),
      ARTransactionLedger.countDocuments({ 
        company: companyId,
        reconciliationStatus: 'pending'
      }),
      ARTransactionLedger.countDocuments({ 
        company: companyId,
        reconciliationStatus: 'discrepancy'
      })
    ]);

    // Group in PostgreSQL instead of materialising the full tenant ledger in
    // the compatibility aggregation executor.
    const typeBreakdown = await dbClient().$queryRaw`
      SELECT transaction_type AS "_id",
             COUNT(*)::int AS count,
             COALESCE(SUM(amount), 0)::double precision AS "totalAmount"
        FROM ar_transaction_ledger
       WHERE company_id = ${String(companyId)}
       GROUP BY transaction_type
       ORDER BY transaction_type`;


    // Get recent activity
    const recentActivity = await ARTransactionLedger.find({ company: companyId })
      .populate('client', 'name')
      .sort({ createdAt: -1 })
      .limit(10);

    res.json({
      success: true,
      data: {
        stats: {
          totalTransactions,
          recentTransactions,
          pendingReconciliation,
          discrepancyCount
        },
        typeBreakdown,
        recentActivity
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Verify all pending transactions (force update)
 * @route   POST /api/ar-reconciliation/verify-all
 * @access  Private (admin)
 */
exports.verifyAllPending = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const userId = req.user.id;

    const ARTransactionLedger = require('../models/ARTransactionLedger');

    // Update all pending transactions to verified
    const result = await ARTransactionLedger.updateMany(
      {
        company: companyId,
        reconciliationStatus: 'pending'
      },
      {
        $set: {
          reconciliationStatus: 'verified',
          verifiedAt: new Date()
        }
      }
    );

    // Log the action
    const ActionLog = require('../models/ActionLog');
    await ActionLog.create({
      company: companyId,
      user: userId,
      action: 'verify_all_pending_transactions',
      module: 'ar_reconciliation',
      details: { count: result.modifiedCount },
      status: 'success'
    });

    res.json({
      success: true,
      message: `${result.modifiedCount} transactions marked as verified`,
      count: result.modifiedCount
    });
  } catch (error) {
    next(error);
  }
};
