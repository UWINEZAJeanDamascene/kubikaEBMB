const { dbClient } = require('../lib/prisma');
const ARReceipt = require("../models/ARReceipt");
const ARReceiptAllocation = require("../models/ARReceiptAllocation");
const ARBadDebtWriteoff = require("../models/ARBadDebtWriteoff");
const Invoice = require("../models/Invoice");
const Client = require("../models/Client");
const ARTransactionLedger = require("../models/ARTransactionLedger");
const JournalService = require("./journalService");
const periodService = require("./periodService");
const cacheService = require("./cacheService");
const ARTrackingService = require("./arTrackingService");
const { DEFAULT_ACCOUNTS } = require("../constants/chartOfAccounts");

/**
 * AR Service - Handles Accounts Receivable operations.
 * All reporting reads use PostgreSQL-backed models or set-based SQL.
 */

class ARService {
  /**
   * Get aging report without loading every invoice and allocation into Node.
   */
  static async getAgingReport(companyId, options = {}) {
    const { clientId, asOfDate } = options;
    const asOf = asOfDate ? new Date(asOfDate) : new Date();
    if (Number.isNaN(asOf.getTime())) throw new Error('Invalid asOfDate');
    const today = new Date(asOf.getFullYear(), asOf.getMonth(), asOf.getDate());
    const params = [String(companyId), today];
    const clientClause = clientId
      ? (() => { params.push(String(clientId)); return `AND c.id = $${params.length}`; })()
      : '';
    const invoiceClientClause = clientId ? `AND i.client_id = $${params.length}` : '';

    const rows = await dbClient().$queryRawUnsafe(`
      WITH invoice_balances AS (
        SELECT i.client_id,
               GREATEST(i.amount_outstanding, 0)::double precision AS balance,
               COALESCE(i.due_date, i.invoice_date)::date AS due_date
          FROM invoices i
          JOIN clients c ON c.id = i.client_id AND c.company_id = i.company_id
         WHERE i.company_id = $1
           AND i.status IN ('sent', 'confirmed', 'partially_paid')
           ${invoiceClientClause}
         GROUP BY i.id, i.client_id, i.amount_outstanding, i.due_date, i.invoice_date
      ), invoice_aging AS (
        SELECT client_id,
               COALESCE(SUM(CASE WHEN due_date >= $2::date THEN balance ELSE 0 END), 0)::double precision AS current,
               COALESCE(SUM(CASE WHEN due_date BETWEEN ($2::date - INTERVAL '30 days') AND ($2::date - INTERVAL '1 day') THEN balance ELSE 0 END), 0)::double precision AS "1-30",
               COALESCE(SUM(CASE WHEN due_date BETWEEN ($2::date - INTERVAL '60 days') AND ($2::date - INTERVAL '31 days') THEN balance ELSE 0 END), 0)::double precision AS "31-60",
               COALESCE(SUM(CASE WHEN due_date BETWEEN ($2::date - INTERVAL '90 days') AND ($2::date - INTERVAL '61 days') THEN balance ELSE 0 END), 0)::double precision AS "61-90",
               COALESCE(SUM(CASE WHEN due_date < ($2::date - INTERVAL '90 days') THEN balance ELSE 0 END), 0)::double precision AS "90+",
               COALESCE(SUM(balance), 0)::double precision AS invoice_total
          FROM invoice_balances
         WHERE balance > 0
         GROUP BY client_id
      )
      SELECT c.id AS "clientId",
             c.name AS "clientName",
             c.code AS "clientCode",
             COALESCE(a.current, 0) + GREATEST(
               COALESCE(c.outstanding_balance, 0)::double precision - COALESCE(a.invoice_total, 0),
               0::double precision
             ) AS current,
             COALESCE(a."1-30", 0) AS "1-30",
             COALESCE(a."31-60", 0) AS "31-60",
             COALESCE(a."61-90", 0) AS "61-90",
             COALESCE(a."90+", 0) AS "90+"
        FROM clients c
        LEFT JOIN invoice_aging a ON a.client_id = c.id
       WHERE c.company_id = $1
         ${clientClause}
         AND (COALESCE(a.invoice_total, 0) > 0 OR COALESCE(c.outstanding_balance, 0) > 0)
       ORDER BY (
         COALESCE(a.current, 0)
         + GREATEST(
           COALESCE(c.outstanding_balance, 0)::double precision - COALESCE(a.invoice_total, 0),
           0::double precision
         )
         + COALESCE(a."1-30", 0)
         + COALESCE(a."31-60", 0)
         + COALESCE(a."61-90", 0)
         + COALESCE(a."90+", 0)
       ) DESC, c.id`, ...params);

    const data = rows.map((row) => {
      const current = Number(row.current || 0);
      const oneToThirty = Number(row['1-30'] || 0);
      const thirtyOneToSixty = Number(row['31-60'] || 0);
      const sixtyOneToNinety = Number(row['61-90'] || 0);
      const overNinety = Number(row['90+'] || 0);
      return {
        client: { _id: row.clientId, name: row.clientName || 'Unknown', code: row.clientCode || '' },
        current: current.toFixed(2),
        '1-30': oneToThirty.toFixed(2),
        '31-60': thirtyOneToSixty.toFixed(2),
        '61-90': sixtyOneToNinety.toFixed(2),
        '90+': overNinety.toFixed(2),
        totalBalance: (current + oneToThirty + thirtyOneToSixty + sixtyOneToNinety + overNinety).toFixed(2),
      };
    });

    return {
      success: true,
      asOfDate: today,
      data,
    };
  }

  static async writeOffBadDebt(companyId, userId, data) {
    const { invoiceId, writeoffDate, amount, reason, notes } = data;

    const invoice = await Invoice.findOne({
      _id: invoiceId,
      company: companyId,
    });
    if (!invoice) {
      throw new Error("Invoice not found");
    }

    if (invoice.status === "cancelled") {
      throw new Error("Invoice is already written off as bad debt");
    }

    const amountNum = parseFloat(amount) || parseFloat(invoice.balance) || 0;
    if (amountNum <= 0) {
      throw new Error("Invalid write-off amount");
    }

    const targetDate = writeoffDate || new Date();
    if (await periodService.isDateInClosedPeriod(companyId, targetDate)) {
      throw new Error("Target accounting period is closed");
    }

    const client = await Client.findById(invoice.client);
    const clientName = client?.name || "Unknown Client";
    const invoiceRef = invoice.referenceNo || invoice.invoiceNumber || "N/A";

    const writeoff = new ARBadDebtWriteoff({
      invoice: invoiceId,
      client: invoice.client,
      writeoffDate: targetDate,
      amount: amountNum.toFixed(2),
      reason: reason || "Bad debt write-off",
      notes: notes || null,
      status: "draft",
      createdBy: userId,
      company: companyId,
    });

    await writeoff.save();

    try {
      await cacheService.bumpCompanyFinancialCaches(companyId);
    } catch (e) {
      console.error("Cache invalidation failed:", e);
    }

    return writeoff;
  }

  static async postBadDebtWriteoff(companyId, userId, writeoffId) {
    const writeoff = await ARBadDebtWriteoff.findOne({
      _id: writeoffId,
      company: companyId,
    });
    if (!writeoff) throw new Error("Bad debt write-off not found");
    if (writeoff.status !== "draft") {
      const err = new Error("INVALID_STATUS");
      err.status = 400;
      throw err;
    }

    const invoice = await Invoice.findById(writeoff.invoice);
    if (!invoice) throw new Error("Invoice not found");

    const amountNum = parseFloat(writeoff.amount) || 0;
    const client = await Client.findById(writeoff.client);
    const clientName = client?.name || "Unknown Client";
    const invoiceRef = invoice.referenceNo || invoice.invoiceNumber || "N/A";
    const narration = `Bad Debt Write-off - ${clientName} - INV#${invoiceRef}`;

    const bdDebitLine = JournalService.createDebitLine(
      DEFAULT_ACCOUNTS.badDebtExpense || "6100",
      amountNum,
      narration,
    );
    const bdCreditLine = JournalService.createCreditLine(
      await JournalService.getMappedAccountCode(
        companyId,
        "sales",
        "accountsReceivable",
        DEFAULT_ACCOUNTS.accountsReceivable,
      ),
      amountNum,
      narration,
    );

    const bdEntryA = {
      date: writeoff.writeoffDate || new Date(),
      description: narration,
      sourceType: "bad_debt_writeoff",
      sourceId: writeoff._id,
      sourceReference: writeoff.reference || writeoff.referenceNo,
      lines: [bdDebitLine, bdCreditLine],
      isAutoGenerated: true,
    };

    const bdEntries = await JournalService.createEntriesAtomic(companyId, userId, [bdEntryA]);
    const journalEntry = Array.isArray(bdEntries) && bdEntries.length > 0 ? bdEntries[0] : null;

    writeoff.status = "posted";
    if (journalEntry) writeoff.journalEntry = journalEntry._id;
    writeoff.postedBy = userId;
    await writeoff.save();

    const currentOutstanding = parseFloat(invoice.amountOutstanding) || parseFloat(invoice.balance) || 0;
    const newOutstanding = currentOutstanding - amountNum;
    invoice.amountOutstanding = Math.max(0, newOutstanding).toFixed(2);
    invoice.balance = Math.max(0, newOutstanding);

    if (newOutstanding <= 0.01) {
      invoice.status = "cancelled";
      invoice.badDebtWrittenOff = true;
      invoice.writtenOffAt = new Date();
      invoice.writtenOffBy = userId;
      invoice.badDebtReason = writeoff.reason || "Bad debt write-off";
    }
    await invoice.save();

    if (client) {
      client.outstandingBalance = Math.max(0, (client.outstandingBalance || 0) - amountNum);
      await client.save();
    }

    try {
      await cacheService.bumpCompanyFinancialCaches(companyId);
    } catch (e) {
      console.error("Cache invalidation failed:", e);
    }

    try {
      await ARTrackingService.recordBadDebtWriteoff(writeoff, invoice, userId);
    } catch (trackingError) {
      console.error("AR tracking error for bad debt write-off:", trackingError);
    }

    return writeoff;
  }

  static async getClientStatement(companyId, clientId, options = {}) {
    const { startDate, endDate } = options;

    const money = (value) => {
      if (value == null || value === '') return 0;
      if (typeof value === 'object' && value.toString) {
        const n = parseFloat(value.toString());
        return Number.isFinite(n) ? n : 0;
      }
      const n = parseFloat(value);
      return Number.isFinite(n) ? n : 0;
    };

    const invoiceTotal = (inv) => money(inv.totalAmount ?? inv.grandTotal ?? inv.roundedAmount ?? inv.total);
    const invoiceOutstanding = (inv) => money(inv.amountOutstanding ?? inv.balance ?? Math.max(0, invoiceTotal(inv) - money(inv.amountPaid)));

    const client = await Client.findOne({ _id: clientId, company: companyId });
    if (!client) {
      throw new Error("Client not found");
    }

    const dateFilter = {};
    if (startDate) dateFilter.$gte = new Date(startDate);
    if (endDate) {
      const inclusiveEnd = new Date(endDate);
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(endDate))) inclusiveEnd.setHours(23, 59, 59, 999);
      dateFilter.$lte = inclusiveEnd;
    }

    const invoiceQuery = {
      client: clientId,
      company: companyId,
      status: { $nin: ['draft'] },
    };
    if (startDate || endDate) invoiceQuery.invoiceDate = dateFilter;
    const invoices = await Invoice.find(invoiceQuery)
      .populate("createdBy", "name")
      .sort({ invoiceDate: 1 });

    const receiptQuery = {
      client: clientId,
      company: companyId,
      status: { $nin: ['draft', 'cancelled', 'reversed'] },
    };
    if (startDate || endDate) receiptQuery.receiptDate = dateFilter;
    const receipts = await ARReceipt.find(receiptQuery).sort({ receiptDate: 1 });
    const openingBalanceQuery = {
      client: clientId,
      company: companyId,
      transactionType: 'opening_balance',
      sourceType: 'opening_ar',
    };
    if (startDate || endDate) openingBalanceQuery.transactionDate = dateFilter;
    const openingBalances = await ARTransactionLedger.find(openingBalanceQuery)
      .sort({ transactionDate: 1, createdAt: 1 });

    const receiptIds = receipts.map((r) => r._id);
    const allocations = receiptIds.length
      ? await ARReceiptAllocation.find({
          receipt: { $in: receiptIds },
          company: companyId,
        }).populate("invoice", "invoiceNumber referenceNo")
      : [];

    const ledgerEvents = [];
    // New payments are represented by posted AR receipts and their allocations.
    // Older invoices can still have embedded-only payment history, so suppress
    // just the matching legacy entries rather than dropping historical activity.
    const receiptPaymentsByInvoice = new Map();
    for (const allocation of allocations) {
      const invoiceId = String(allocation.invoice?._id || allocation.invoice?.id || allocation.invoice || '');
      const receiptId = String(allocation.receipt?._id || allocation.receipt?.id || allocation.receipt || '');
      const receipt = receipts.find((item) => String(item._id) === receiptId);
      if (!invoiceId || !receipt || !['posted'].includes(receipt.status)) continue;
      const amounts = receiptPaymentsByInvoice.get(invoiceId) || [];
      amounts.push(money(allocation.amountAllocated));
      receiptPaymentsByInvoice.set(invoiceId, amounts);
    }
    let legacyPaymentTotal = 0;
    for (const inv of invoices) {
      const total = invoiceTotal(inv);
      if (total <= 0 && inv.status === 'cancelled') continue;
      ledgerEvents.push({
        sortDate: new Date(inv.invoiceDate || inv.date || 0),
        date: inv.invoiceDate || inv.date,
        reference: inv.referenceNo || inv.invoiceNumber || String(inv._id),
        description: `Invoice ${inv.referenceNo || inv.invoiceNumber || ''}`.trim(),
        debit: total,
        credit: 0,
        type: 'invoice',
        sourceId: String(inv._id),
      });

      const embeddedPayments = Array.isArray(inv.payments) ? inv.payments : [];
      for (const payment of embeddedPayments) {
        const amount = money(payment.amount ?? payment.amountReceived ?? payment.total);
        if (amount <= 0) continue;
        const representedAmounts = receiptPaymentsByInvoice.get(String(inv._id)) || [];
        const representedIndex = representedAmounts.findIndex((value) => Math.abs(value - amount) < 0.01);
        if (representedIndex >= 0) {
          representedAmounts.splice(representedIndex, 1);
          continue;
        }
        const payDate = payment.date || payment.paymentDate || payment.paidAt || inv.paidDate || inv.invoiceDate;
        const payDateValue = new Date(payDate || 0);
        if ((startDate && payDateValue < new Date(startDate)) || (endDate && payDateValue > dateFilter.$lte)) continue;
        legacyPaymentTotal += amount;
        ledgerEvents.push({
          sortDate: new Date(payDate || 0),
          date: payDate,
          reference: payment.reference || payment.referenceNo || inv.referenceNo || 'PAYMENT',
          description: payment.notes || payment.method
            ? `Payment${payment.method ? ` (${payment.method})` : ''} · ${inv.referenceNo || inv.invoiceNumber || ''}`
            : `Payment on ${inv.referenceNo || inv.invoiceNumber || 'invoice'}`,
          debit: 0,
          credit: amount,
          type: 'payment',
          sourceId: String(inv._id),
        });
      }
    }

    for (const rec of receipts) {
      const amount = money(rec.amountReceived ?? rec.amount);
      if (amount <= 0) continue;
      const recAllocs = allocations.filter((a) => String(a.receipt?._id || a.receipt) === String(rec._id));
      const allocLabel = recAllocs.length
        ? recAllocs.map((a) => a.invoice?.referenceNo || a.invoice?.invoiceNumber).filter(Boolean).join(', ')
        : null;
      ledgerEvents.push({
        sortDate: new Date(rec.receiptDate || 0),
        date: rec.receiptDate,
        reference: rec.referenceNo || rec.reference || String(rec._id),
        description: allocLabel ? `Receipt allocated to ${allocLabel}` : `Customer receipt`,
        debit: 0,
        credit: amount,
        type: 'receipt',
        sourceId: String(rec._id),
      });
    }

    for (const openingBalance of openingBalances) {
      const amount = money(openingBalance.amount);
      if (amount <= 0) continue;
      ledgerEvents.push({
        sortDate: new Date(openingBalance.transactionDate || openingBalance.createdAt || 0),
        date: openingBalance.transactionDate || openingBalance.createdAt,
        reference: openingBalance.referenceNo || openingBalance.sourceReference || 'OPENING BALANCE',
        description: openingBalance.description || `Opening AR balance for ${client.name}`,
        debit: openingBalance.direction === 'decrease' ? 0 : amount,
        credit: openingBalance.direction === 'decrease' ? amount : 0,
        type: 'opening_balance',
        sourceId: String(openingBalance._id),
      });
    }

    const invoiceOutstandingTotal = invoices.reduce((sum, invoice) => sum + invoiceOutstanding(invoice), 0);
    const representedOpeningBalance = openingBalances.reduce((sum, openingBalance) => (
      sum + (openingBalance.direction === 'decrease' ? -money(openingBalance.amount) : money(openingBalance.amount))
    ), 0);
    const unrepresentedOpeningBalance = startDate || endDate
      ? 0
      : Math.max(0, money(client.outstandingBalance) - invoiceOutstandingTotal - representedOpeningBalance);
    if (unrepresentedOpeningBalance > 0.005) {
      ledgerEvents.push({
        sortDate: new Date(client.createdAt || 0),
        date: client.createdAt || null,
        reference: 'OPENING BALANCE',
        description: `Imported opening balance for ${client.name}`,
        debit: unrepresentedOpeningBalance,
        credit: 0,
        type: 'opening_balance',
        sourceId: null,
      });
    }

    ledgerEvents.sort((a, b) => {
      const diff = a.sortDate.getTime() - b.sortDate.getTime();
      if (diff !== 0) return diff;
      if (a.type === 'opening_balance' && b.type !== 'opening_balance') return -1;
      if (b.type === 'opening_balance' && a.type !== 'opening_balance') return 1;
      if (a.type === 'invoice' && b.type !== 'invoice') return -1;
      if (b.type === 'invoice' && a.type !== 'invoice') return 1;
      return 0;
    });

    let running = 0;
    const transactions = ledgerEvents.map((event) => {
      running = Math.round((running + event.debit - event.credit) * 100) / 100;
      return {
        date: event.date,
        reference: event.reference,
        description: event.description,
        debit: event.debit > 0 ? Math.round(event.debit * 100) / 100 : 0,
        credit: event.credit > 0 ? Math.round(event.credit * 100) / 100 : 0,
        runningBalance: running,
        type: event.type,
      };
    });

    const mappedInvoices = invoices.map((inv) => ({
      id: inv._id,
      _id: inv._id,
      reference: inv.referenceNo || inv.invoiceNumber,
      invoiceNumber: inv.invoiceNumber || inv.referenceNo,
      date: inv.invoiceDate,
      invoiceDate: inv.invoiceDate,
      dueDate: inv.dueDate,
      total: invoiceTotal(inv),
      paid: money(inv.amountPaid),
      balance: invoiceOutstanding(inv),
      status: inv.status,
    }));

    const mappedReceipts = receipts.map((rec) => ({
      id: rec._id,
      _id: rec._id,
      reference: rec.referenceNo,
      date: rec.receiptDate,
      amount: money(rec.amountReceived ?? rec.amount),
      status: rec.status,
      allocations: allocations
        .filter((a) => String(a.receipt?._id || a.receipt) === String(rec._id))
        .map((a) => ({
          invoiceReference: a.invoice?.referenceNo || a.invoice?.invoiceNumber,
          amount: money(a.amountAllocated),
        })),
    }));

    const totalInvoiced = mappedInvoices.reduce((sum, inv) => sum + inv.total, 0);
    const totalPaidFromReceipts = mappedReceipts.reduce((sum, rec) => sum + rec.amount, 0);
    const totalPaidFromInvoices = mappedInvoices.reduce((sum, inv) => sum + inv.paid, 0);
    const totalPaid = totalPaidFromReceipts + (legacyPaymentTotal > 0 ? legacyPaymentTotal : (totalPaidFromReceipts > 0 ? 0 : totalPaidFromInvoices));
    const totalOutstanding = startDate || endDate
      ? mappedInvoices.reduce((sum, inv) => sum + inv.balance, 0)
      : Math.max(money(client.outstandingBalance), mappedInvoices.reduce((sum, inv) => sum + inv.balance, 0));

    return {
      success: true,
      data: {
        client: { _id: client._id, name: client.name, code: client.code },
        period: { startDate: startDate || null, endDate: endDate || null },
        invoices: mappedInvoices,
        receipts: mappedReceipts,
        transactions,
        summary: {
          totalInvoices: Math.round(totalInvoiced * 100) / 100,
          totalInvoiced: Math.round(totalInvoiced * 100) / 100,
          totalPaid: Math.round(totalPaid * 100) / 100,
          totalOutstanding: Math.round(totalOutstanding * 100) / 100,
          balance: Math.round(totalOutstanding * 100) / 100,
          invoiceCount: invoices.length,
        },
      },
    };
  }
}

module.exports = ARService;
