const ARTransactionLedger = require('../models/ARTransactionLedger');
const Invoice = require('../models/Invoice');
const Client = require('../models/Client');
const ARReceipt = require('../models/ARReceipt');
const ARReceiptAllocation = require('../models/ARReceiptAllocation');

/**
 * AR Tracking Service
 * 
 * Centralized service for tracking all Accounts Receivable movements.
 * Ensures complete audit trail and data integrity for all AR transactions.
 */
class ARTrackingService {

  /**
   * Record an invoice creation (when invoice is confirmed)
   * This INCREASES AR
   */
  static async recordInvoiceCreated(invoice, userId, options = {}) {
    try {
      const { session } = options;
      
      const client = await Client.findById(invoice.client).session(session || null);
      if (!client) {
        throw new Error('Client not found for invoice');
      }

      const invoiceAmount = parseFloat(invoice.roundedAmount || invoice.totalAmount || invoice.total || 0);
      const currentClientBalance = parseFloat(client.outstandingBalance) || 0;
      const newClientBalance = currentClientBalance + invoiceAmount;

      const transaction = new ARTransactionLedger({
        company: invoice.company,
        client: invoice.client,
        invoice: invoice._id,
        transactionType: 'invoice_created',
        transactionDate: invoice.confirmedDate || invoice.invoiceDate || new Date(),
        referenceNo: invoice.referenceNo || invoice.invoiceNumber,
        description: `Invoice ${invoice.referenceNo || invoice.invoiceNumber} created - Amount: ${invoiceAmount.toFixed(2)}`,
        amount: invoiceAmount,
        direction: 'increase',
        invoiceBalanceAfter: invoiceAmount,
        clientBalanceAfter: newClientBalance,
        sourceType: 'invoice',
        sourceId: invoice._id,
        sourceReference: invoice.referenceNo || invoice.invoiceNumber,
        createdBy: userId,
        fiscalYear: new Date().getFullYear(),
        accountingPeriod: this._getAccountingPeriod(invoice.invoiceDate)
      });

      if (session) {
        await transaction.save({ session });
      } else {
        await transaction.save();
      }

      return transaction;
    } catch (error) {
      console.error('ARTrackingService.recordInvoiceCreated error:', error);
      // Don't throw - we don't want to block the main operation
      return null;
    }
  }

  /**
   * Record an invoice cancellation
   * This DECREASES AR
   */
  static async recordInvoiceCancelled(invoice, userId, reason, options = {}) {
    try {
      const { session } = options;
      
      const client = await Client.findById(invoice.client).session(session || null);
      if (!client) return null;

      const invoiceAmount = parseFloat(invoice.roundedAmount || invoice.totalAmount || invoice.total || 0);
      const currentClientBalance = parseFloat(client.outstandingBalance) || 0;
      const newClientBalance = Math.max(0, currentClientBalance - invoiceAmount);

      const transaction = new ARTransactionLedger({
        company: invoice.company,
        client: invoice.client,
        invoice: invoice._id,
        transactionType: 'invoice_cancelled',
        transactionDate: new Date(),
        referenceNo: invoice.referenceNo || invoice.invoiceNumber,
        description: `Invoice ${invoice.referenceNo || invoice.invoiceNumber} cancelled - Reason: ${reason || 'Not specified'}`,
        amount: invoiceAmount,
        direction: 'decrease',
        invoiceBalanceAfter: 0,
        clientBalanceAfter: newClientBalance,
        sourceType: 'invoice',
        sourceId: invoice._id,
        sourceReference: invoice.referenceNo || invoice.invoiceNumber,
        createdBy: userId,
        metadata: {
          adjustmentReason: reason
        }
      });

      if (session) {
        await transaction.save({ session });
      } else {
        await transaction.save();
      }

      return transaction;
    } catch (error) {
      console.error('ARTrackingService.recordInvoiceCancelled error:', error);
      return null;
    }
  }

  /**
   * Record a receipt posting
   * This DECREASES AR
   */
  static async recordReceiptPosted(receipt, allocations, userId, options = {}) {
    try {
      const { session } = options;
      
      const client = await Client.findById(receipt.client).session(session || null);
      if (!client) return null;

      const receiptAmount = parseFloat(receipt.amountReceived) || 0;
      const currentClientBalance = parseFloat(client.outstandingBalance) || 0;
      const newClientBalance = Math.max(0, currentClientBalance - receiptAmount);

      // Create main receipt transaction
      const transaction = new ARTransactionLedger({
        company: receipt.company,
        client: receipt.client,
        transactionType: 'receipt_posted',
        transactionDate: receipt.receiptDate || new Date(),
        referenceNo: receipt.referenceNo || receipt.reference,
        description: `Receipt ${receipt.referenceNo || receipt.reference} posted - Payment: ${receiptAmount.toFixed(2)}`,
        amount: receiptAmount,
        direction: 'decrease',
        clientBalanceAfter: newClientBalance,
        sourceType: 'ar_receipt',
        sourceId: receipt._id,
        sourceReference: receipt.referenceNo || receipt.reference,
        createdBy: userId,
        reconciliationStatus: 'verified', // Auto-verified since posted through normal workflow
        metadata: {
          paymentMethod: receipt.paymentMethod
        }
      });

      if (session) {
        await transaction.save({ session });
      } else {
        await transaction.save();
      }

      // Create allocation transactions for each invoice
      if (allocations && allocations.length > 0) {
        // Invoices for every allocation in one query; the ledger writes below
        // stay per-allocation because each records its own transaction.
        const allocInvoiceRows = await Invoice.find({
          _id: { $in: allocations.map((a) => a.invoice).filter(Boolean) },
        });
        const allocInvoicesById = new Map(
          (allocInvoiceRows || []).map((i) => [String(i._id), i]),
        );
        for (const allocation of allocations) {
          const invoice = allocation.invoice
            ? allocInvoicesById.get(String(allocation.invoice))
            : null;
          if (invoice) {
            const allocAmount = parseFloat(allocation.amountAllocated) || 0;
            const currentInvoiceBalance = parseFloat(invoice.amountOutstanding) || parseFloat(invoice.balance) || 0;
            const newInvoiceBalance = Math.max(0, currentInvoiceBalance - allocAmount);

            const allocTransaction = new ARTransactionLedger({
              company: receipt.company,
              client: receipt.client,
              invoice: invoice._id,
              transactionType: 'allocation_made',
              transactionDate: receipt.receiptDate || new Date(),
              referenceNo: receipt.referenceNo || receipt.reference,
              description: `Allocation to Invoice ${invoice.referenceNo || invoice.invoiceNumber}: ${allocAmount.toFixed(2)}`,
              amount: allocAmount,
              direction: 'decrease',
              invoiceBalanceAfter: newInvoiceBalance,
              clientBalanceAfter: newClientBalance,
              sourceType: 'ar_receipt',
              sourceId: receipt._id,
              sourceReference: receipt.referenceNo || receipt.reference,
              createdBy: userId,
              reconciliationStatus: 'verified' // Auto-verified since posted through normal workflow
            });

            if (session) {
              await allocTransaction.save({ session });
            } else {
              await allocTransaction.save();
            }
          }
        }
      }

      return transaction;
    } catch (error) {
      console.error('ARTrackingService.recordReceiptPosted error:', error);
      return null;
    }
  }

  /**
   * Record a receipt reversal
   * This INCREASES AR
   */
  static async recordReceiptReversed(receipt, allocations, userId, reason, options = {}) {
    try {
      const { session } = options;
      
      const client = await Client.findById(receipt.client).session(session || null);
      if (!client) return null;

      const receiptAmount = parseFloat(receipt.amountReceived) || 0;
      const currentClientBalance = parseFloat(client.outstandingBalance) || 0;
      const newClientBalance = currentClientBalance + receiptAmount;

      const transaction = new ARTransactionLedger({
        company: receipt.company,
        client: receipt.client,
        transactionType: 'receipt_reversed',
        transactionDate: new Date(),
        referenceNo: receipt.referenceNo || receipt.reference,
        description: `Receipt ${receipt.referenceNo || receipt.reference} reversed - Reason: ${reason || 'Not specified'}`,
        amount: receiptAmount,
        direction: 'increase',
        clientBalanceAfter: newClientBalance,
        sourceType: 'ar_receipt',
        sourceId: receipt._id,
        sourceReference: receipt.referenceNo || receipt.reference,
        createdBy: userId,
        metadata: {
          adjustmentReason: reason
        }
      });

      if (session) {
        await transaction.save({ session });
      } else {
        await transaction.save();
      }

      // Record allocation removals
      if (allocations && allocations.length > 0) {
        // Invoices for every allocation in one query; the ledger writes below
        // stay per-allocation because each records its own transaction.
        const allocInvoiceRows = await Invoice.find({
          _id: { $in: allocations.map((a) => a.invoice).filter(Boolean) },
        });
        const allocInvoicesById = new Map(
          (allocInvoiceRows || []).map((i) => [String(i._id), i]),
        );
        for (const allocation of allocations) {
          const invoice = allocation.invoice
            ? allocInvoicesById.get(String(allocation.invoice))
            : null;
          if (invoice) {
            const allocAmount = parseFloat(allocation.amountAllocated) || 0;
            const currentInvoiceBalance = parseFloat(invoice.amountOutstanding) || parseFloat(invoice.balance) || 0;
            const newInvoiceBalance = currentInvoiceBalance + allocAmount;

            const allocTransaction = new ARTransactionLedger({
              company: receipt.company,
              client: receipt.client,
              invoice: invoice._id,
              transactionType: 'allocation_removed',
              transactionDate: new Date(),
              referenceNo: receipt.referenceNo || receipt.reference,
              description: `Allocation reversed for Invoice ${invoice.referenceNo || invoice.invoiceNumber}: ${allocAmount.toFixed(2)}`,
              amount: allocAmount,
              direction: 'increase',
              invoiceBalanceAfter: newInvoiceBalance,
              clientBalanceAfter: newClientBalance,
              sourceType: 'ar_receipt',
              sourceId: receipt._id,
              sourceReference: receipt.referenceNo || receipt.reference,
              createdBy: userId
            });

            if (session) {
              await allocTransaction.save({ session });
            } else {
              await allocTransaction.save();
            }
          }
        }
      }

      return transaction;
    } catch (error) {
      console.error('ARTrackingService.recordReceiptReversed error:', error);
      return null;
    }
  }

  /**
   * Record a credit note application
   * This DECREASES AR
   */
  static async recordCreditNoteApplied(creditNote, invoice, amount, userId, options = {}) {
    try {
      const { session } = options;
      
      const client = await Client.findById(creditNote.client).session(session || null);
      if (!client) return null;

      const creditAmount = parseFloat(amount) || 0;
      const currentClientBalance = parseFloat(client.outstandingBalance) || 0;
      const newClientBalance = options.clientBalanceAfter == null
        ? Math.max(0, currentClientBalance - creditAmount)
        : Number(options.clientBalanceAfter);

      const currentInvoiceBalance = parseFloat(invoice.amountOutstanding) || parseFloat(invoice.balance) || 0;
      const newInvoiceBalance = options.invoiceBalanceAfter == null
        ? Math.max(0, currentInvoiceBalance - creditAmount)
        : Number(options.invoiceBalanceAfter);

      const transaction = new ARTransactionLedger({
        company: creditNote.company,
        client: creditNote.client,
        invoice: invoice._id,
        transactionType: 'credit_note_applied',
        transactionDate: new Date(),
        referenceNo: creditNote.creditNoteNumber || creditNote.referenceNo,
        description: `Credit Note ${creditNote.creditNoteNumber || creditNote.referenceNo} applied to Invoice ${invoice.referenceNo || invoice.invoiceNumber}: ${creditAmount.toFixed(2)}`,
        amount: creditAmount,
        direction: 'decrease',
        invoiceBalanceAfter: newInvoiceBalance,
        clientBalanceAfter: newClientBalance,
        sourceType: options.sourceId ? 'credit_note_application' : 'credit_note',
        sourceId: options.sourceId || creditNote._id,
        sourceReference: creditNote.creditNoteNumber || creditNote.referenceNo,
        journalEntryId: options.journalEntryId || null,
        createdBy: userId,
        metadata: {
          creditNoteNumber: creditNote.creditNoteNumber || creditNote.referenceNo
        }
      });

      if (session) {
        await transaction.save({ session });
      } else {
        await transaction.save();
      }

      return transaction;
    } catch (error) {
      console.error('ARTrackingService.recordCreditNoteApplied error:', error);
      if (options.required) throw error;
      return null;
    }
  }

  static async recordCreditNoteRefund(creditNote, invoice, amount, userId, options = {}) {
    try {
      const { session } = options;
      const refundAmount = Number(amount) || 0;
      if (refundAmount <= 0) return null;
      const transaction = new ARTransactionLedger({
        company: creditNote.company,
        client: creditNote.client,
        invoice: invoice._id,
        transactionType: 'credit_note_refund',
        transactionDate: new Date(),
        referenceNo: creditNote.referenceNo || creditNote.creditNoteNumber,
        description: `Credit note refund reinstated receivable on Invoice ${invoice.referenceNo || invoice.invoiceNumber}`,
        amount: refundAmount,
        direction: 'increase',
        invoiceBalanceAfter: Number(options.invoiceBalanceAfter ?? invoice.amountOutstanding ?? 0),
        clientBalanceAfter: Number(options.clientBalanceAfter ?? 0),
        sourceType: 'credit_note_refund',
        sourceId: options.sourceId || creditNote._id,
        sourceReference: creditNote.referenceNo || creditNote.creditNoteNumber,
        journalEntryId: options.journalEntryId || null,
        createdBy: userId,
        metadata: { creditNoteId: String(creditNote._id), refundAmount },
      });
      await transaction.save(session ? { session } : {});
      return transaction;
    } catch (error) {
      console.error('ARTrackingService.recordCreditNoteRefund error:', error);
      if (options.required) throw error;
      return null;
    }
  }

  /**
   * Record a bad debt write-off
   * This DECREASES AR
   */
  static async recordBadDebtWriteoff(writeoff, invoice, userId, options = {}) {
    try {
      const { session } = options;
      
      const client = await Client.findById(writeoff.client).session(session || null);
      if (!client) return null;

      const writeoffAmount = parseFloat(writeoff.amount) || 0;
      const currentClientBalance = parseFloat(client.outstandingBalance) || 0;
      const newClientBalance = Math.max(0, currentClientBalance - writeoffAmount);

      const currentInvoiceBalance = parseFloat(invoice.amountOutstanding) || parseFloat(invoice.balance) || 0;
      const newInvoiceBalance = Math.max(0, currentInvoiceBalance - writeoffAmount);

      const transaction = new ARTransactionLedger({
        company: writeoff.company,
        client: writeoff.client,
        invoice: invoice._id,
        transactionType: 'bad_debt_writeoff',
        transactionDate: writeoff.writeoffDate || new Date(),
        referenceNo: writeoff.reference || writeoff.referenceNo,
        description: `Bad Debt Write-off for Invoice ${invoice.referenceNo || invoice.invoiceNumber}: ${writeoffAmount.toFixed(2)}`,
        amount: writeoffAmount,
        direction: 'decrease',
        invoiceBalanceAfter: newInvoiceBalance,
        clientBalanceAfter: newClientBalance,
        sourceType: 'bad_debt_writeoff',
        sourceId: writeoff._id,
        sourceReference: writeoff.reference || writeoff.referenceNo,
        createdBy: userId,
        metadata: {
          badDebtReason: writeoff.reason
        }
      });

      if (session) {
        await transaction.save({ session });
      } else {
        await transaction.save();
      }

      return transaction;
    } catch (error) {
      console.error('ARTrackingService.recordBadDebtWriteoff error:', error);
      return null;
    }
  }

  /**
   * Record a bad debt reversal
   * This INCREASES AR
   */
  static async recordBadDebtReversed(writeoff, invoice, userId, reason, options = {}) {
    try {
      const { session } = options;
      
      const client = await Client.findById(writeoff.client).session(session || null);
      if (!client) return null;

      const amount = parseFloat(writeoff.amount) || 0;
      const currentClientBalance = parseFloat(client.outstandingBalance) || 0;
      const newClientBalance = currentClientBalance + amount;

      const transaction = new ARTransactionLedger({
        company: writeoff.company,
        client: writeoff.client,
        invoice: invoice._id,
        transactionType: 'bad_debt_reversed',
        transactionDate: new Date(),
        referenceNo: writeoff.reference || writeoff.referenceNo,
        description: `Bad Debt Reversal for Invoice ${invoice.referenceNo || invoice.invoiceNumber} - Reason: ${reason || 'Not specified'}`,
        amount: amount,
        direction: 'increase',
        invoiceBalanceAfter: amount, // Invoice is restored to this amount
        clientBalanceAfter: newClientBalance,
        sourceType: 'bad_debt_writeoff',
        sourceId: writeoff._id,
        sourceReference: writeoff.reference || writeoff.referenceNo,
        createdBy: userId,
        metadata: {
          adjustmentReason: reason
        }
      });

      if (session) {
        await transaction.save({ session });
      } else {
        await transaction.save();
      }

      return transaction;
    } catch (error) {
      console.error('ARTrackingService.recordBadDebtReversed error:', error);
      return null;
    }
  }

  /**
   * Record a legacy payment (from invoiceController.recordPayment)
   * This DECREASES AR
   */
  static async recordPayment(invoice, amount, paymentMethod, userId, options = {}) {
    try {
      const { session } = options;
      
      const client = await Client.findById(invoice.client).session(session || null);
      if (!client) return null;

      const paymentAmount = parseFloat(amount) || 0;
      const currentClientBalance = parseFloat(client.outstandingBalance) || 0;
      const newClientBalance = Math.max(0, currentClientBalance - paymentAmount);

      const currentInvoiceBalance = parseFloat(invoice.amountOutstanding) || parseFloat(invoice.balance) || 0;
      const newInvoiceBalance = Math.max(0, currentInvoiceBalance - paymentAmount);

      const transaction = new ARTransactionLedger({
        company: invoice.company,
        client: invoice.client,
        invoice: invoice._id,
        transactionType: 'payment_recorded',
        transactionDate: new Date(),
        referenceNo: invoice.referenceNo || invoice.invoiceNumber,
        description: `Payment recorded for Invoice ${invoice.referenceNo || invoice.invoiceNumber}: ${paymentAmount.toFixed(2)}`,
        amount: paymentAmount,
        direction: 'decrease',
        invoiceBalanceAfter: newInvoiceBalance,
        clientBalanceAfter: newClientBalance,
        sourceType: 'invoice',
        sourceId: invoice._id,
        sourceReference: invoice.referenceNo || invoice.invoiceNumber,
        createdBy: userId,
        metadata: {
          paymentMethod: paymentMethod
        }
      });

      if (session) {
        await transaction.save({ session });
      } else {
        await transaction.save();
      }

      return transaction;
    } catch (error) {
      console.error('ARTrackingService.recordPayment error:', error);
      return null;
    }
  }

  /**
   * Get AR summary for a client
   */
  static async getClientARSummary(companyId, clientId) {
    try {
      const { dbClient } = require('../lib/prisma');
      const summary = await dbClient().$queryRaw`
        SELECT transaction_type AS "_id",
               COUNT(*)::int AS count,
               COALESCE(SUM(amount), 0)::double precision AS "totalAmount",
               MAX(transaction_date) AS "lastTransaction"
          FROM ar_transaction_ledger
         WHERE company_id = ${String(companyId)} AND client_id = ${String(clientId)}
         GROUP BY transaction_type
         ORDER BY transaction_type`;
      const currentBalance = await this.getCurrentClientBalance(companyId, clientId);

      return {
        currentBalance,
        transactionSummary: summary,
        totalTransactions: summary.reduce((sum, row) => sum + Number(row.count || 0), 0),
      };
    } catch (error) {
      console.error('ARTrackingService.getClientARSummary error:', error);
      return null;
    }
  }

  /**
   * Get current client balance from ledger
   */
  static async getCurrentClientBalance(companyId, clientId) {
    try {
      const lastTransaction = await ARTransactionLedger.findOne({
        company: companyId,
        client: clientId
      }).sort({ transactionDate: -1, createdAt: -1 });

      return lastTransaction ? parseFloat(lastTransaction.clientBalanceAfter) || 0 : 0;
    } catch (error) {
      console.error('ARTrackingService.getCurrentClientBalance error:', error);
      return 0;
    }
  }

  /**
   * Get current invoice balance from ledger
   */
  static async getCurrentInvoiceBalance(companyId, invoiceId) {
    try {
      const lastTransaction = await ARTransactionLedger.findOne({
        company: companyId,
        invoice: invoiceId
      }).sort({ transactionDate: -1, createdAt: -1 });

      return lastTransaction ? parseFloat(lastTransaction.invoiceBalanceAfter) || 0 : 0;
    } catch (error) {
      console.error('ARTrackingService.getCurrentInvoiceBalance error:', error);
      return 0;
    }
  }

  /**
   * Verify data integrity - compare ledger balances with actual document balances
   */
  static async verifyIntegrity(companyId, options = {}) {
    const { clientId, invoiceId, startDate, endDate } = options;
    
    const discrepancies = [];

    try {
      const { dbClient } = require('../lib/prisma');
      const params = [String(companyId)];
      const where = ['atl.company_id = $1'];
      if (clientId) {
        params.push(String(clientId));
        where.push(`atl.client_id = $${params.length}`);
      }
      if (invoiceId) {
        params.push(String(invoiceId));
        where.push(`atl.invoice_id = $${params.length}`);
      }
      if (startDate) {
        params.push(new Date(startDate));
        where.push(`atl.transaction_date >= $${params.length}`);
      }
      if (endDate) {
        params.push(new Date(endDate));
        where.push(`atl.transaction_date <= $${params.length}`);
      }
      const whereSql = where.join(' AND ');

      // Compare the latest ledger balance with live balances in set-based SQL.
      // DISTINCT ON selects the same (date, createdAt) winner as the legacy
      // findOne().sort() call, without one query per invoice/client.
      const [invoiceRows, clientRows] = await Promise.all([
        dbClient().$queryRawUnsafe(`
          WITH latest AS (
            SELECT DISTINCT ON (invoice_id) invoice_id,
                   invoice_balance_after AS ledger_balance
              FROM ar_transaction_ledger atl
             WHERE ${whereSql} AND invoice_id IS NOT NULL
             ORDER BY invoice_id, transaction_date DESC, created_at DESC, id DESC
          )
          SELECT l.invoice_id AS id, i.reference_no AS reference,
                 COALESCE(l.ledger_balance, 0)::double precision AS "ledgerBalance",
                 COALESCE(i.amount_outstanding, 0)::double precision AS "actualBalance"
            FROM latest l JOIN invoices i ON i.id = l.invoice_id
           WHERE i.company_id = $1`, ...params),
        dbClient().$queryRawUnsafe(`
          WITH latest AS (
            SELECT DISTINCT ON (client_id) client_id,
                   client_balance_after AS ledger_balance
              FROM ar_transaction_ledger atl
             WHERE ${whereSql}
             ORDER BY client_id, transaction_date DESC, created_at DESC, id DESC
          )
          SELECT l.client_id AS id, c.name,
                 COALESCE(l.ledger_balance, 0)::double precision AS "ledgerBalance",
                 COALESCE(c.outstanding_balance, 0)::double precision AS "actualBalance"
            FROM latest l JOIN clients c ON c.id = l.client_id
           WHERE c.company_id = $1`, ...params),
      ]);

      for (const invoice of invoiceRows) {
        const ledgerBalance = Number(invoice.ledgerBalance || 0);
        const actualBalance = Number(invoice.actualBalance || 0);
        if (Math.abs(ledgerBalance - actualBalance) > 0.01) {
          discrepancies.push({
            type: 'invoice',
            id: invoice.id,
            reference: invoice.reference,
            ledgerBalance,
            actualBalance,
            difference: ledgerBalance - actualBalance,
          });
        }
      }
      for (const client of clientRows) {
        const ledgerBalance = Number(client.ledgerBalance || 0);
        const actualBalance = Number(client.actualBalance || 0);
        if (Math.abs(ledgerBalance - actualBalance) > 0.01) {
          discrepancies.push({
            type: 'client',
            id: client.id,
            name: client.name,
            ledgerBalance,
            actualBalance,
            difference: ledgerBalance - actualBalance,
          });
        }
      }

      return {
        verified: discrepancies.length === 0,
        discrepancies,
        totalChecked: invoiceRows.length + clientRows.length
      };
    } catch (error) {
      console.error('ARTrackingService.verifyIntegrity error:', error);
      return {
        verified: false,
        error: error.message,
        discrepancies: []
      };
    }
  }

  /**
   * Reconcile and correct discrepancies
   */
  static async reconcileAndCorrect(companyId, userId, options = {}) {
    const verification = await this.verifyIntegrity(companyId, options);
    
    if (verification.verified) {
      // No discrepancies found - mark all pending transactions as verified
      const updateResult = await ARTransactionLedger.updateMany(
        { 
          company: companyId,
          reconciliationStatus: 'pending'
        },
        {
          reconciliationStatus: 'verified',
          $set: { verifiedAt: new Date() }
        }
      );
      return { 
        corrected: 0, 
        verified: updateResult.modifiedCount || 0,
        message: `No discrepancies found. ${updateResult.modifiedCount || 0} transactions marked as verified.` 
      };
    }

    let corrected = 0;

    for (const disc of verification.discrepancies) {
      try {
        if (disc.type === 'client') {
          // Update client balance to match ledger
          await Client.findByIdAndUpdate(disc.id, {
            outstandingBalance: disc.ledgerBalance
          });
          corrected++;
        } else if (disc.type === 'invoice') {
          // Create a correction transaction
          const correction = new ARTransactionLedger({
            company: companyId,
            client: (await Invoice.findById(disc.id))?.client,
            invoice: disc.id,
            transactionType: 'system_correction',
            transactionDate: new Date(),
            referenceNo: disc.reference,
            description: `System correction: Balance adjusted from ${disc.actualBalance.toFixed(2)} to ${disc.ledgerBalance.toFixed(2)}`,
            amount: Math.abs(disc.difference),
            direction: disc.difference > 0 ? 'increase' : 'decrease',
            invoiceBalanceAfter: disc.ledgerBalance,
            sourceType: 'system',
            sourceId: disc.id,
            createdBy: userId,
            reconciliationStatus: 'corrected',
            discrepancyDetails: {
              expectedBalance: disc.ledgerBalance,
              actualBalance: disc.actualBalance,
              difference: disc.difference,
              detectedAt: new Date(),
              resolvedAt: new Date(),
              resolutionNotes: 'Auto-corrected by system reconciliation'
            }
          });
          await correction.save();
          corrected++;
        }
      } catch (error) {
        console.error('Error correcting discrepancy:', error);
      }
    }

    return { corrected, message: `Corrected ${corrected} discrepancies` };
  }

  /**
   * Helper: Get accounting period string (YYYY-MM)
   */
  static _getAccountingPeriod(date) {
    const d = date ? new Date(date) : new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
}

module.exports = ARTrackingService;
