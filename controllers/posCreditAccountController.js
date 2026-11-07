'use strict';

const { prisma } = require('../lib/prisma');
const { runInTransaction } = require('../services/transactionService');
const { generateObjectId } = require('../utils/objectId');
const { requestIp, writePosAuditLog } = require('../services/posAuditService');
const JournalService = require('../services/journalService');
const posAccountingPostingService = require('../services/posAccountingPostingService');
const { DEFAULT_ACCOUNTS } = require('../constants/chartOfAccounts');
const { postCreditPayment, refundedInvoiceBalance } = require('../services/posCreditAccountService');
const { lockOpenPosShiftForRegister, recordTillCashMovement } = require('../services/posShiftLinkService');

const fail = (status, code, message) => Object.assign(new Error(message), { status, statusCode: status, code });
const companyOf = (req) => String(req.posAuthContext.session.companyId);
const registerOf = (req) => String(req.posAuthContext.session.registerId);
const userOf = (req) => String(req.posAuthContext.session.userId);
const keyOf = (req) => String(req.get?.('Idempotency-Key') || req.headers?.['idempotency-key'] || '').trim();
const approvalTokenOf = (req) => String(req.get?.('X-Pos-Approval-Token') || req.headers?.['x-pos-approval-token'] || req.body?.approvalToken || '').trim();

async function consumeSensitiveApproval(tx, req, { action, subjectId, payload }) {
  const token = approvalTokenOf(req);
  if (!token) throw fail(403, 'POS_MANAGER_APPROVAL_REQUIRED', 'A separate manager approval is required for this action.');
  const companyId = companyOf(req); const registerId = registerOf(req); const cashierId = userOf(req);
  const tokenHash = require('crypto').createHash('sha256').update(token, 'utf8').digest('hex');
  const approval = await tx.posApproval.findFirst({ where: { companyId, registerId, requestedBy: cashierId, action, tokenHash, subjectId: String(subjectId), usedAt: null, expiresAt: { gt: new Date() }, context: { equals: payload } } });
  if (!approval) throw fail(403, 'POS_MANAGER_APPROVAL_INVALID', 'The manager approval is invalid, expired, used, or does not match this action.');
  const consumed = await tx.posApproval.updateMany({ where: { id: approval.id, companyId, registerId, requestedBy: cashierId, action, subjectId: String(subjectId), usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
  if (consumed.count !== 1) throw fail(409, 'POS_MANAGER_APPROVAL_INVALID', 'The manager approval was already used or expired.');
  await writePosAuditLog({ companyId, registerId, userId: cashierId, event: 'APPROVAL_USED', metadata: { approvalId: approval.id, action, approvedBy: approval.approvedBy }, ip: requestIp(req) }, tx);
  return approval;
}

exports.getAccount = async (req, res, next) => {
  try {
    const account = await prisma.client.findFirst({
      where: { id: String(req.params.clientId), companyId: companyOf(req) },
      select: { id: true, name: true, code: true, creditAccountStatus: true, paymentTerms: true, creditTermsDays: true, creditLimit: true, outstandingBalance: true, isActive: true, isWalkIn: true },
    });
    if (!account) throw fail(404, 'POS_CREDIT_CUSTOMER_NOT_FOUND', 'Customer account not found.');
    const invoices = await prisma.invoice.findMany({
      where: { companyId: companyOf(req), clientId: account.id, status: { in: ['sent', 'confirmed', 'partially_paid'] }, amountOutstanding: { gt: 0 } },
      select: { id: true, referenceNo: true, invoiceDate: true, dueDate: true, totalAmount: true, amountOutstanding: true },
      orderBy: [{ dueDate: 'asc' }, { invoiceDate: 'asc' }],
    });
    res.json({ success: true, data: { account, openInvoices: invoices } });
  } catch (error) { next(error); }
};

exports.updateAccount = async (req, res, next) => {
  try {
    const companyId = companyOf(req);
    const userId = userOf(req);
    const clientId = String(req.params.clientId);
    const reason = String(req.body.reason || '').trim();
    const creditLimit = Number(req.body.creditLimit);
    const creditTermsDays = Number(req.body.creditTermsDays);
    const status = String(req.body.status || '').toUpperCase();
    if (reason.length < 5 || !Number.isFinite(creditLimit) || creditLimit < 0 || !Number.isInteger(creditTermsDays) || creditTermsDays < 0 || creditTermsDays > 3650 || !['ACTIVE', 'ON_HOLD', 'CLOSED'].includes(status)) {
      throw fail(400, 'POS_CREDIT_ACCOUNT_INVALID', 'Set a valid status, non-negative limit, terms from 0 to 3650 days, and a reason of at least 5 characters.');
    }
    const saved = await runInTransaction(async (tx) => {
      const locked = await tx.$queryRawUnsafe('SELECT "id" FROM "clients" WHERE "id" = $1 AND "company_id" = $2 FOR UPDATE', clientId, companyId);
      if (!locked.length) throw fail(404, 'POS_CREDIT_CUSTOMER_NOT_FOUND', 'Customer account not found.');
      const before = await tx.client.findFirst({ where: { id: clientId, companyId } });
      if (!before || before.isWalkIn || before.mergedIntoClientId) throw fail(409, 'POS_CREDIT_CUSTOMER_INELIGIBLE', 'Walk-in and merged customer accounts cannot have credit terms.');
      const account = await tx.client.update({ where: { id: clientId, companyId }, data: { creditLimit, creditTermsDays, creditAccountStatus: status } });
      await writePosAuditLog({ companyId, registerId: registerOf(req), userId, event: 'POS_CREDIT_ACCOUNT_UPDATED', metadata: { clientId, reason, before: { status: before.creditAccountStatus, creditLimit: Number(before.creditLimit), creditTermsDays: before.creditTermsDays }, after: { status, creditLimit, creditTermsDays } }, ip: requestIp(req) }, tx);
      return account;
    });
    res.json({ success: true, data: { id: saved.id, creditAccountStatus: saved.creditAccountStatus, creditLimit: saved.creditLimit, creditTermsDays: saved.creditTermsDays } });
  } catch (error) { next(error); }
};

exports.takePayment = async (req, res, next) => {
  const companyId = companyOf(req);
  const registerId = registerOf(req);
  const userId = userOf(req);
  // The customer is part of the route (`/credit-accounts/:clientId/payments`);
  // keep the body fallback for older callers, but prefer the tenant-scoped path value.
  const clientId = String(req.params.clientId || req.body.clientId || '');
  const key = keyOf(req);
  const amount = Number(req.body.amount);
  const note = req.body.note == null ? null : String(req.body.note).trim();
  if (!/^[A-Za-z0-9._:-]{8,80}$/.test(key)) return res.status(400).json({ success: false, code: 'POS_IDEMPOTENCY_KEY_INVALID', message: 'Provide a valid Idempotency-Key for this account payment.' });
  if (!clientId || !Number.isSafeInteger(amount) || amount <= 0 || amount > 2147483647 || (note && note.length > 500)) {
    return res.status(400).json({ success: false, code: 'POS_CREDIT_PAYMENT_INVALID', message: 'Choose a customer and enter a positive whole-franc cash amount.' });
  }
  try {
    const result = await runInTransaction(async (tx) => {
      return postCreditPayment({ tx, companyId, registerId, userId, clientId, key, amount, requestedAllocations: req.body.allocations ?? null, note, ip: requestIp(req) });
    });
    res.status(result.replayed ? 200 : 201).json({ success: true, replayed: result.replayed, data: result });
  } catch (error) {
    if (error.code === 'POS_IDEMPOTENCY_KEY_REUSED') return res.status(409).json({ success: false, code: error.code, message: error.message });
    next(error);
  }
};

exports.refundPayment = async (req, res, next) => {
  try {
    const companyId = companyOf(req); const registerId = registerOf(req); const userId = userOf(req);
    const receiptId = String(req.params.receiptId); const key = keyOf(req); const reason = String(req.body.reason || '').trim();
    if (!/^[A-Za-z0-9._:-]{8,80}$/.test(key) || reason.length < 10 || !approvalTokenOf(req)) throw fail(400, 'POS_CREDIT_REFUND_INVALID', 'A valid refund key, a reason of at least 10 characters, and manager approval are required.');
    const result = await runInTransaction(async (tx) => {
      const replay = await tx.aRReceipt.findFirst({ where: { companyId, posRefundIdempotencyKey: key }, select: { id: true, referenceNo: true, amountReceived: true, status: true, reversalReason: true } });
      if (replay) {
        if (replay.id !== receiptId || replay.reversalReason !== reason) throw fail(409, 'POS_IDEMPOTENCY_KEY_REUSED', 'This refund key was already used for a different refund.');
        return { receipt: replay, replayed: true };
      }
      const locks = await tx.$queryRawUnsafe('SELECT "id" FROM "ar_receipts" WHERE "id" = $1 AND "company_id" = $2 FOR UPDATE', receiptId, companyId);
      if (!locks.length) throw fail(404, 'POS_CREDIT_RECEIPT_NOT_FOUND', 'Account payment receipt not found.');
      const receipt = await tx.aRReceipt.findFirst({ where: { id: receiptId, companyId }, include: { client: true, allocations: { include: { invoice: true } } } });
      if (!receipt || !receipt.posIdempotencyKey || receipt.paymentMethod !== 'cash') throw fail(409, 'POS_CREDIT_RECEIPT_NOT_REFUNDABLE', 'Only a POS cash account-payment receipt can be refunded here.');
      if (receipt.posRefundIdempotencyKey === key && receipt.reversalReason === reason) return { receipt, replayed: true };
      if (receipt.posRefundIdempotencyKey && receipt.posRefundIdempotencyKey !== key) throw fail(409, 'POS_CREDIT_RECEIPT_NOT_REFUNDABLE', 'This account payment has already been refunded.');
      if (receipt.status !== 'posted') throw fail(409, 'POS_CREDIT_RECEIPT_NOT_REFUNDABLE', 'This account payment has already been reversed or is not posted.');
      const clientLocks = await tx.$queryRawUnsafe('SELECT "id" FROM "clients" WHERE "id" = $1 AND "company_id" = $2 FOR UPDATE', receipt.clientId, companyId);
      if (!clientLocks.length) throw fail(409, 'POS_CREDIT_CUSTOMER_NOT_FOUND', 'The customer account no longer exists in this workspace.');
      const approval = await consumeSensitiveApproval(tx, req, { action: 'CREDIT_REFUND', subjectId: receiptId, payload: { receiptId, reason } });
      const approvalId = approval.id;
      const shiftId = await lockOpenPosShiftForRegister(tx, companyId, registerId);
      if (!shiftId) throw fail(409, 'POS_SHIFT_NOT_OPEN', 'An open shift is required to refund cash received at this till.');
      const shift = await tx.posShift.findFirst({ where: { id: shiftId, companyId, registerId, status: { in: ['open', 'reopened'] } } });
      const register = await tx.posRegister.findFirst({ where: { id: registerId, companyId, isActive: true } });
      if (!shift || !register) throw fail(409, 'POS_TILL_CONTEXT_INVALID', 'The active till context could not be verified.');
      const amount = Number(receipt.amountReceived);
      const allocated = receipt.allocations.reduce((sum, item) => sum + Number(item.amountAllocated), 0);
      const unapplied = Math.max(0, amount - allocated);
      for (const allocation of receipt.allocations) {
        const invoiceLock = await tx.$queryRawUnsafe('SELECT "id" FROM "invoices" WHERE "id" = $1 AND "company_id" = $2 FOR UPDATE', allocation.invoiceId, companyId);
        if (!invoiceLock.length || allocation.invoice.companyId !== companyId || allocation.invoice.clientId !== receipt.clientId) throw fail(409, 'POS_CREDIT_RECEIPT_ALLOCATION_INVALID', 'A receipt allocation is no longer valid for this customer.');
      }
      const registerCash = await JournalService.getMappedAccountCode(companyId, 'cash', 'posRegisterCash', DEFAULT_ACCOUNTS.posRegisterCash);
      const arCode = await JournalService.getMappedAccountCode(companyId, 'sales', 'accountsReceivable', DEFAULT_ACCOUNTS.accountsReceivable);
      const advanceCode = await JournalService.getMappedAccountCode(companyId, 'sales', 'customerAdvances', DEFAULT_ACCOUNTS.customerAdvances);
      const description = `Refund POS credit payment ${receipt.referenceNo}: ${reason}`;
      const lines = [];
      if (allocated > 0) lines.push(JournalService.createDebitLine(arCode, allocated, description));
      if (unapplied > 0) lines.push(JournalService.createDebitLine(advanceCode, unapplied, description));
      lines.push(JournalService.createCreditLine(registerCash, amount, description));
      const movementId = generateObjectId();
      const posting = await posAccountingPostingService.postOrQueue({
        tx,
        companyId,
        userId,
        sourceType: 'pos_credit_account_payment_refund',
        sourceId: receipt.id,
        metadata: { relatedCashMovementId: movementId },
        entries: [{
          date: new Date(),
          description,
          sourceType: 'ar_receipt_reversal',
          sourceId: receipt.id,
          sourceReference: receipt.referenceNo,
          lines,
          isAutoGenerated: true,
          notes: reason,
          sourceData: { originalReceiptId: receipt.id, refundKey: key },
          skipBankTransactions: true,
        }],
      });
      const journalEntryId = posting.journalEntryIds[0] || null;
      for (const allocation of receipt.allocations) {
        const invoice = allocation.invoice; const applied = Number(allocation.amountAllocated);
        const changed = await tx.invoice.updateMany({ where: { id: invoice.id, companyId, clientId: receipt.clientId, amountPaid: { gte: applied } }, data: { amountPaid: { decrement: applied }, amountOutstanding: { increment: applied } } });
        if (changed.count !== 1) throw fail(409, 'POS_CREDIT_REFUND_INVOICE_CHANGED', 'An invoice balance changed while refunding. Reload and try again.');
        const restored = refundedInvoiceBalance(invoice, applied);
        await tx.invoice.update({ where: { id: invoice.id }, data: { ...restored, paidDate: null } });
        await tx.arTransactionLedger.create({ data: { id: generateObjectId(), companyId, clientId: receipt.clientId, invoiceId: invoice.id, receiptId: receipt.id, transactionType: 'allocation_removed', transactionDate: new Date(), referenceNo: receipt.referenceNo, description, amount: applied, direction: 'increase', sourceType: 'ar_receipt_reversal', sourceId: receipt.id, sourceReference: receipt.referenceNo, journalEntryId, metadata: { reason, approvalId }, reconciliationStatus: 'verified', createdById: userId } });
      }
      const open = await tx.invoice.aggregate({ where: { companyId, clientId: receipt.clientId, status: { in: ['sent', 'confirmed', 'partially_paid'] } }, _sum: { amountOutstanding: true } });
      const balanceAfter = Number(open._sum.amountOutstanding || 0);
      await tx.client.update({ where: { id: receipt.clientId, companyId }, data: { outstandingBalance: balanceAfter } });
      await tx.aRReceipt.update({ where: { id: receipt.id }, data: { status: 'reversed', reversedAt: new Date(), reversedById: userId, reversalReason: reason, reverseJournalEntryId: journalEntryId, posRefundIdempotencyKey: key } });
      const movement = await tx.posCashMovement.create({ data: { id: movementId, companyId, shiftId, registerId, type: 'cash_out', amount: Math.round(amount), reasonCode: 'OTHER', note: `Account payment refund ${receipt.referenceNo}: ${reason}`, performedById: userId, approvedById: userId, journalEntryId, postingStatus: posting.status, idempotencyKey: `CREDITREFUND:${key}` } });
      await recordTillCashMovement(tx, { companyId, registerCode: register.code, shift, movement: { companyId, registerId, shiftId, performedById: userId, type: 'cash_out', amount: Math.round(amount), reasonCode: 'OTHER', note: movement.note, id: movement.id } });
      await tx.posCustomerCreditLedger.create({ data: { id: generateObjectId(), companyId, clientId: receipt.clientId, entryType: 'PAYMENT_REFUND', direction: 'increase', amount: allocated, balanceAfter, receiptId: receipt.id, reason, createdById: userId, idempotencyKey: `CREDITREFUND:${key}`, requestHash: require('crypto').createHash('sha256').update(JSON.stringify({ receiptId, amount, reason })).digest('hex') } });
      await writePosAuditLog({ companyId, registerId, userId, event: 'POS_CREDIT_PAYMENT_REFUNDED', metadata: { receiptId, amount, reason, approvalId, movementId: movement.id, journalEntryId }, ip: requestIp(req) }, tx);
      return { receiptId, amount, balanceAfter, journalEntryId, movement, postingStatus: posting.status, replayed: false };
    });
    res.status(result.replayed ? 200 : 201).json({ success: true, data: result });
  } catch (error) { next(error); }
};

exports.writeOff = async (req, res, next) => {
  try {
    const companyId = companyOf(req); const registerId = registerOf(req); const userId = userOf(req);
    const clientId = String(req.params.clientId); const invoiceId = String(req.body.invoiceId || '');
    const amount = Number(req.body.amount); const reason = String(req.body.reason || '').trim();
    if (!invoiceId || !Number.isSafeInteger(amount) || amount <= 0 || reason.length < 10 || !approvalTokenOf(req)) throw fail(400, 'POS_CREDIT_WRITEOFF_INVALID', 'Invoice, positive whole-franc amount, reason of at least 10 characters, and manager approval are required.');
    const result = await runInTransaction(async (tx) => {
      const approval = await consumeSensitiveApproval(tx, req, { action: 'CREDIT_WRITEOFF', subjectId: clientId, payload: { clientId, invoiceId, amount, reason } });
      const approvalId = approval.id;
      const rows = await tx.$queryRawUnsafe('SELECT "id" FROM "clients" WHERE "id" = $1 AND "company_id" = $2 FOR UPDATE', clientId, companyId);
      if (!rows.length) throw fail(404, 'POS_CREDIT_CUSTOMER_NOT_FOUND', 'Customer account not found.');
      const invoice = await tx.invoice.findFirst({ where: { id: invoiceId, companyId, clientId, status: { in: ['sent', 'confirmed', 'partially_paid'] } } });
      if (!invoice || amount > Number(invoice.amountOutstanding)) throw fail(409, 'POS_CREDIT_WRITEOFF_EXCEEDS_BALANCE', 'Write-off cannot exceed this customer invoice balance.');
      const referenceNo = `WO-${generateObjectId().slice(-12).toUpperCase()}`;
      const writeoff = await tx.arBadDebtWriteoff.create({ data: { id: generateObjectId(), companyId, referenceNo, invoiceId, clientId, amount, reason, status: 'posted', createdById: userId, postedById: userId } });
      const arCode = await JournalService.getMappedAccountCode(companyId, 'sales', 'accountsReceivable', DEFAULT_ACCOUNTS.accountsReceivable);
      const expenseCode = DEFAULT_ACCOUNTS.badDebtExpense || '6100';
      const description = `POS credit write-off ${referenceNo}: ${reason}`;
      const entry = await JournalService.createEntry(companyId, userId, { date: new Date(), description, sourceType: 'bad_debt_writeoff', sourceId: writeoff.id, sourceReference: referenceNo, lines: [JournalService.createDebitLine(expenseCode, amount, description), JournalService.createCreditLine(arCode, amount, description)], isAutoGenerated: true, notes: reason, session: tx });
      const journalEntryId = String(entry?._id || entry?.id || '');
      if (!journalEntryId) throw new Error('The write-off journal was not created.');
      await tx.arBadDebtWriteoff.update({ where: { id: writeoff.id }, data: { journalEntryId } });
      const newOutstanding = Math.max(0, Number(invoice.amountOutstanding) - amount);
      await tx.invoice.update({ where: { id: invoice.id }, data: { amountOutstanding: newOutstanding, ...(newOutstanding <= 0.009 ? { status: 'cancelled', badDebtWrittenOff: true, writtenOffAt: new Date(), writtenOffById: userId, badDebtReason: reason } : {}) } });
      const aggregate = await tx.invoice.aggregate({ where: { companyId, clientId, status: { in: ['sent', 'confirmed', 'partially_paid'] } }, _sum: { amountOutstanding: true } });
      const balanceAfter = Number(aggregate._sum.amountOutstanding || 0);
      await tx.client.update({ where: { id: clientId, companyId }, data: { outstandingBalance: balanceAfter } });
      await tx.arTransactionLedger.create({ data: { id: generateObjectId(), companyId, clientId, invoiceId, transactionType: 'bad_debt_writeoff', transactionDate: new Date(), referenceNo, description, amount, direction: 'decrease', invoiceBalanceAfter: newOutstanding, clientBalanceAfter: balanceAfter, sourceType: 'bad_debt_writeoff', sourceId: writeoff.id, sourceReference: referenceNo, journalEntryId, metadata: { reason, approvalId }, createdById: userId } });
      await tx.posCustomerCreditLedger.create({ data: { id: generateObjectId(), companyId, clientId, entryType: 'WRITEOFF', direction: 'decrease', amount, balanceAfter, invoiceId, reason, createdById: userId, idempotencyKey: `WRITEOFF:${approvalId}`, requestHash: require('crypto').createHash('sha256').update(JSON.stringify({ invoiceId, amount, reason })).digest('hex') } });
      await writePosAuditLog({ companyId, registerId, userId, event: 'POS_CREDIT_WRITTEN_OFF', metadata: { writeoffId: writeoff.id, invoiceId, clientId, amount, reason, approvalId, beforeBalance: Number(invoice.amountOutstanding), afterBalance: newOutstanding } , ip: requestIp(req) }, tx);
      return { writeoff, journalEntryId, balanceAfter };
    });
    res.status(201).json({ success: true, data: result });
  } catch (error) { next(error); }
};

exports.adjust = async (req, res, next) => {
  try {
    const companyId = companyOf(req); const registerId = registerOf(req); const userId = userOf(req);
    const clientId = String(req.params.clientId); const invoiceId = String(req.body.invoiceId || '');
    const amount = Number(req.body.amount); const reason = String(req.body.reason || '').trim();
    if (!invoiceId || !Number.isSafeInteger(amount) || amount <= 0 || reason.length < 10 || !approvalTokenOf(req)) throw fail(400, 'POS_CREDIT_ADJUSTMENT_INVALID', 'Invoice, positive whole-franc amount, reason of at least 10 characters, and manager approval are required.');
    const result = await runInTransaction(async (tx) => {
      const approval = await consumeSensitiveApproval(tx, req, { action: 'CREDIT_ADJUST', subjectId: clientId, payload: { clientId, invoiceId, amount, reason } });
      const approvalId = approval.id;
      const locked = await tx.$queryRawUnsafe('SELECT "id" FROM "clients" WHERE "id" = $1 AND "company_id" = $2 FOR UPDATE', clientId, companyId);
      if (!locked.length) throw fail(404, 'POS_CREDIT_CUSTOMER_NOT_FOUND', 'Customer account not found.');
      const invoice = await tx.invoice.findFirst({ where: { id: invoiceId, companyId, clientId, status: { in: ['sent', 'confirmed', 'partially_paid'] } } });
      if (!invoice || amount > Number(invoice.amountOutstanding)) throw fail(409, 'POS_CREDIT_ADJUSTMENT_EXCEEDS_BALANCE', 'A credit adjustment cannot exceed the outstanding invoice balance.');
      const referenceNo = `ADJ-${generateObjectId().slice(-12).toUpperCase()}`;
      const newOutstanding = Number(invoice.amountOutstanding) - amount;
      const entryId = generateObjectId();
      const arCode = await JournalService.getMappedAccountCode(companyId, 'sales', 'accountsReceivable', DEFAULT_ACCOUNTS.accountsReceivable);
      const returnsCode = await JournalService.getMappedAccountCode(companyId, 'sales', 'salesReturns', DEFAULT_ACCOUNTS.salesReturns);
      const description = `POS credit adjustment ${referenceNo}: ${reason}`;
      const entry = await JournalService.createEntry(companyId, userId, { date: new Date(), description, sourceType: 'pos_credit_adjustment', sourceId: entryId, sourceReference: referenceNo, lines: [JournalService.createDebitLine(returnsCode, amount, description), JournalService.createCreditLine(arCode, amount, description)], isAutoGenerated: true, notes: reason, session: tx });
      const journalEntryId = String(entry?._id || entry?.id || '');
      if (!journalEntryId) throw new Error('The credit adjustment journal was not created.');
      await tx.invoice.update({ where: { id: invoiceId }, data: { amountOutstanding: newOutstanding, ...(newOutstanding <= 0.009 ? { status: 'fully_paid', paidDate: new Date() } : {}) } });
      const aggregate = await tx.invoice.aggregate({ where: { companyId, clientId, status: { in: ['sent', 'confirmed', 'partially_paid'] } }, _sum: { amountOutstanding: true } });
      const balanceAfter = Number(aggregate._sum.amountOutstanding || 0);
      await tx.client.update({ where: { id: clientId, companyId }, data: { outstandingBalance: balanceAfter } });
      await tx.arTransactionLedger.create({ data: { id: generateObjectId(), companyId, clientId, invoiceId, transactionType: 'credit_adjustment', transactionDate: new Date(), referenceNo, description, amount, direction: 'decrease', invoiceBalanceAfter: newOutstanding, clientBalanceAfter: balanceAfter, sourceType: 'pos_credit_adjustment', sourceId: entryId, sourceReference: referenceNo, journalEntryId, metadata: { reason, approvalId }, createdById: userId } });
      await tx.posCustomerCreditLedger.create({ data: { id: generateObjectId(), companyId, clientId, entryType: 'ADJUSTMENT', direction: 'decrease', amount, balanceAfter, invoiceId, reason, createdById: userId, idempotencyKey: `ADJUST:${approvalId}`, requestHash: require('crypto').createHash('sha256').update(JSON.stringify({ invoiceId, amount, reason })).digest('hex') } });
      await writePosAuditLog({ companyId, registerId, userId, event: 'POS_CREDIT_ADJUSTED', metadata: { invoiceId, clientId, amount, reason, approvalId, beforeBalance: Number(invoice.amountOutstanding), afterBalance: newOutstanding }, ip: requestIp(req) }, tx);
      return { invoiceId, amount, balanceAfter, journalEntryId };
    });
    res.status(201).json({ success: true, data: result });
  } catch (error) { next(error); }
};
