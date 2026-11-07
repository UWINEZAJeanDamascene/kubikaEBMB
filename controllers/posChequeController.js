'use strict';

const { createHash } = require('crypto');
const { prisma } = require('../lib/prisma');
const { runInTransaction } = require('../services/transactionService');
const { generateObjectId } = require('../utils/objectId');
const { requestIp, writePosAuditLog } = require('../services/posAuditService');
const posAccountingPostingService = require('../services/posAccountingPostingService');
const JournalService = require('../services/journalService');
const { DEFAULT_ACCOUNTS } = require('../constants/chartOfAccounts');

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,100}$/;
const MAX_DATABASE_INT = 2147483647;
const MAX_BATCH_SIZE = 100;

function fail(status, code, message) {
  return Object.assign(new Error(message), { status, statusCode: status, code });
}

function companyOf(req) {
  return String(req.posAuthContext.session.companyId);
}

function registerOf(req) {
  return String(req.posAuthContext.session.registerId);
}

function userOf(req) {
  return String(req.posAuthContext.session.userId);
}

function keyOf(req) {
  return String(req.get?.('Idempotency-Key') || req.headers?.['idempotency-key'] || '').trim();
}

function approvalTokenOf(req) {
  return String(req.get?.('X-Pos-Approval-Token')
    || req.headers?.['x-pos-approval-token']
    || req.body?.approvalToken
    || '').trim();
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function hashApprovalToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function amountOf(cheques) {
  return cheques.reduce((total, cheque) => total + Number(cheque.amount), 0);
}

function accountLinesForDeposit(cheques, bankAccountCode, totalAmount, description, reference) {
  const amountsByAccount = new Map();
  for (const cheque of cheques) {
    const accountCode = cheque.chequesInHandAccountCode || '1130';
    amountsByAccount.set(accountCode, (amountsByAccount.get(accountCode) || 0) + Number(cheque.amount));
  }
  return [
    JournalService.createDebitLine(bankAccountCode, totalAmount, description, reference),
    ...Array.from(amountsByAccount, ([accountCode, amount]) => (
      JournalService.createCreditLine(accountCode, amount, description, reference)
    )),
  ];
}

async function consumeApproval(tx, req, { action, context }) {
  const token = approvalTokenOf(req);
  if (!token) throw fail(403, 'POS_MANAGER_APPROVAL_REQUIRED', 'A manager approval is required for this cheque action.');
  const companyId = companyOf(req);
  const registerId = registerOf(req);
  const userId = userOf(req);
  const approval = await tx.posApproval.findFirst({
    where: {
      companyId,
      registerId,
      requestedBy: userId,
      action,
      tokenHash: hashApprovalToken(token),
      usedAt: null,
      expiresAt: { gt: new Date() },
      context: { equals: context },
    },
  });
  if (!approval) throw fail(403, 'POS_MANAGER_APPROVAL_INVALID', 'The manager approval is invalid, expired, used, or does not match this cheque action.');

  const now = new Date();
  const consumed = await tx.posApproval.updateMany({
    where: {
      id: approval.id,
      companyId,
      registerId,
      requestedBy: userId,
      action,
      usedAt: null,
      expiresAt: { gt: now },
    },
    data: { usedAt: now },
  });
  if (consumed.count !== 1) throw fail(409, 'POS_MANAGER_APPROVAL_INVALID', 'The manager approval was already used or expired.');

  await writePosAuditLog({
    companyId,
    registerId,
    userId,
    event: 'APPROVAL_USED',
    metadata: { approvalId: approval.id, action, approvedBy: approval.approvedBy },
    ip: requestIp(req),
  }, tx);
  return approval.approvedBy;
}

async function approvalLimit(companyId) {
  const settings = await prisma.systemSettings.findUnique({
    where: { companyId },
    select: { posCashOutApprovalLimit: true },
  });
  const limit = Number(settings?.posCashOutApprovalLimit ?? 50000);
  return Number.isSafeInteger(limit) && limit >= 0 ? limit : 50000;
}

async function lockCheques(tx, companyId, chequeIds) {
  const placeholders = chequeIds.map((_, index) => `$${index + 2}`).join(', ');
  return tx.$queryRawUnsafe(
    `SELECT "id", "amount", "status", "reference", "invoice_id" AS "invoiceId",
            "cheques_in_hand_account_code" AS "chequesInHandAccountCode",
            "sale_posting_status" AS "salePostingStatus", "deposit_id" AS "depositId"
     FROM "pos_cheques"
     WHERE "company_id" = $1 AND "id" IN (${placeholders})
     ORDER BY "id"
     FOR UPDATE`,
    companyId,
    ...chequeIds,
  );
}

exports.list = async (req, res, next) => {
  try {
    const companyId = companyOf(req);
    const status = String(req.query.status || '').trim().toLowerCase();
    if (status && !['in_hand', 'deposited', 'bounced'].includes(status)) {
      throw fail(400, 'POS_CHEQUE_STATUS_INVALID', 'Choose in_hand, deposited, or bounced.');
    }
    const cheques = await prisma.posCheque.findMany({
      where: { companyId, ...(status ? { status } : {}) },
      include: {
        invoice: { select: { id: true, referenceNo: true, clientId: true, customerName: true } },
        deposit: { select: { id: true, depositDate: true, bankSlipReference: true, postingStatus: true } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return res.json({ success: true, data: { cheques } });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, code: error.code, message: error.message });
    return next(error);
  }
};

exports.deposit = async (req, res, next) => {
  const companyId = companyOf(req);
  const registerId = registerOf(req);
  const userId = userOf(req);
  const key = keyOf(req);
  const bankAccountId = String(req.body?.bankAccountId || '').trim();
  const chequeIds = Array.isArray(req.body?.chequeIds)
    ? [...new Set(req.body.chequeIds.map((id) => String(id || '').trim()))].sort()
    : [];
  const bankSlipReference = typeof req.body?.bankSlipReference === 'string'
    ? req.body.bankSlipReference.trim()
    : '';
  const rawDepositDate = req.body?.depositDate;
  const depositDateSupplied = rawDepositDate != null && rawDepositDate !== '';
  const depositDate = rawDepositDate == null || rawDepositDate === '' ? new Date() : new Date(rawDepositDate);
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    return res.status(400).json({ success: false, code: 'POS_IDEMPOTENCY_KEY_INVALID', message: 'Provide an Idempotency-Key between 8 and 100 supported characters.' });
  }
  if (!bankAccountId || !bankSlipReference || bankSlipReference.length > 100 || /[\r\n]/.test(bankSlipReference) || Number.isNaN(depositDate.getTime())
    || chequeIds.length === 0 || chequeIds.length > MAX_BATCH_SIZE
    || chequeIds.some((id) => !/^[a-f\d]{24}$/i.test(id))) {
    return res.status(400).json({ success: false, code: 'POS_CHEQUE_DEPOSIT_INVALID', message: 'Select 1 to 100 cheques, an active bank account, a valid deposit date, and a bank-slip reference.' });
  }
  const normalizedDepositDate = depositDateSupplied ? depositDate.toISOString() : null;
  const payloadHash = hash({ bankAccountId, chequeIds, bankSlipReference, depositDate: normalizedDepositDate });

  try {
    const limit = await approvalLimit(companyId);
    const result = await runInTransaction(async (tx) => {
      const prior = await tx.posChequeDeposit.findFirst({ where: { companyId, idempotencyKey: key } });
      if (prior) return prior.payloadHash === payloadHash
        ? { deposit: prior, replayed: true }
        : { code: 'POS_IDEMPOTENCY_KEY_REUSED' };

      const bankAccount = await tx.bankAccount.findFirst({
        where: { id: bankAccountId, companyId, isActive: true },
        select: { id: true, ledgerAccountId: true, name: true },
      });
      if (!bankAccount) return { code: 'POS_CHEQUE_BANK_ACCOUNT_INVALID' };

      const lockedCheques = await lockCheques(tx, companyId, chequeIds);
      if (lockedCheques.length !== chequeIds.length) return { code: 'POS_CHEQUE_NOT_FOUND' };
      if (lockedCheques.some((cheque) => cheque.status !== 'in_hand')) return { code: 'POS_CHEQUE_NOT_IN_HAND' };
      if (lockedCheques.some((cheque) => cheque.salePostingStatus !== 'posted')) return { code: 'POS_CHEQUE_SALE_NOT_POSTED' };

      const totalAmount = amountOf(lockedCheques);
      if (!Number.isSafeInteger(totalAmount) || totalAmount <= 0 || totalAmount > MAX_DATABASE_INT) {
        return { code: 'POS_CHEQUE_DEPOSIT_AMOUNT_INVALID' };
      }
      const approvalContext = {
        bankAccountId,
        chequeIds,
        amount: totalAmount,
        bankSlipReference,
        depositDate: normalizedDepositDate,
      };
      let approvedById = null;
      if (totalAmount > limit) approvedById = await consumeApproval(tx, req, { action: 'CHEQUE_DEPOSIT', context: approvalContext });

      const id = generateObjectId();
      const description = `POS cheque deposit ${bankSlipReference}`;
      const posting = await posAccountingPostingService.postOrQueue({
        tx,
        companyId,
        userId,
        sourceType: 'pos_cheque_deposit',
        sourceId: id,
        metadata: { chequeIds, bankAccountId },
        entries: [{
          date: depositDate,
          description,
          sourceType: 'pos_cheque_deposit',
          sourceId: id,
          sourceReference: bankSlipReference,
          lines: accountLinesForDeposit(
            lockedCheques,
            bankAccount.ledgerAccountId || DEFAULT_ACCOUNTS.cashAtBank,
            totalAmount,
            description,
            bankSlipReference,
          ),
          isAutoGenerated: true,
          notes: `Bank account: ${bankAccount.name}`,
          skipBankTransactions: true,
        }],
      });
      const deposit = await tx.posChequeDeposit.create({
        data: {
          id,
          companyId,
          bankAccountId,
          bankAccountCode: bankAccount.ledgerAccountId || DEFAULT_ACCOUNTS.cashAtBank,
          idempotencyKey: key,
          payloadHash,
          depositDate,
          bankSlipReference,
          totalAmount,
          postingStatus: posting.status,
          journalEntryId: posting.journalEntryIds[0] || null,
          createdById: userId,
          approvedById,
        },
      });
      const changedCheques = await tx.posCheque.updateMany({
        where: { companyId, id: { in: chequeIds }, status: 'in_hand' },
        data: { status: 'deposited', depositId: id, depositedAt: depositDate },
      });
      if (changedCheques.count !== chequeIds.length) {
        throw fail(409, 'POS_CHEQUE_NOT_IN_HAND', 'One or more selected cheques changed while recording the deposit.');
      }
      const depositWithCheques = await tx.posChequeDeposit.findFirst({
        where: { id, companyId },
        include: { cheques: true },
      });
      await writePosAuditLog({
        companyId,
        registerId,
        userId,
        event: 'POS_CHEQUE_DEPOSIT_RECORDED',
        metadata: { depositId: id, chequeIds, amount: totalAmount, bankAccountId, bankSlipReference, approvedById, postingStatus: posting.status },
        ip: requestIp(req),
      }, tx);
      return { deposit: depositWithCheques, replayed: false };
    });
    if (result.code) {
      const messages = {
        POS_IDEMPOTENCY_KEY_REUSED: [409, 'This Idempotency-Key was already used for a different cheque deposit.'],
        POS_CHEQUE_BANK_ACCOUNT_INVALID: [400, 'Select an active bank account belonging to this company.'],
        POS_CHEQUE_NOT_FOUND: [404, 'One or more selected cheques do not belong to this company.'],
        POS_CHEQUE_NOT_IN_HAND: [409, 'Only cheques still in hand can be deposited.'],
        POS_CHEQUE_SALE_NOT_POSTED: [409, 'Wait for the original sale posting to complete before depositing these cheques.'],
        POS_CHEQUE_DEPOSIT_AMOUNT_INVALID: [400, 'The total cheque amount is outside the supported range.'],
      };
      const [status, message] = messages[result.code] || [409, 'The cheque deposit could not be completed.'];
      return res.status(status).json({ success: false, code: result.code, message });
    }
    return res.status(result.replayed ? 200 : 201).json({
      success: true,
      replayed: result.replayed,
      data: { deposit: result.deposit },
    });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, code: error.code, message: error.message });
    if (error.code === 'P2002') {
      const prior = await prisma.posChequeDeposit.findFirst({ where: { companyId, idempotencyKey: key } });
      if (prior) {
        if (prior.payloadHash === payloadHash) return res.status(200).json({ success: true, replayed: true, data: { deposit: prior } });
        return res.status(409).json({ success: false, code: 'POS_IDEMPOTENCY_KEY_REUSED', message: 'This Idempotency-Key was already used for a different cheque deposit.' });
      }
    }
    return next(error);
  }
};

exports.bounce = async (req, res, next) => {
  const companyId = companyOf(req);
  const registerId = registerOf(req);
  const userId = userOf(req);
  const chequeId = String(req.params.chequeId || '');
  const key = keyOf(req);
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    return res.status(400).json({ success: false, code: 'POS_IDEMPOTENCY_KEY_INVALID', message: 'Provide an Idempotency-Key between 8 and 100 supported characters.' });
  }
  if (!/^[a-f\d]{24}$/i.test(chequeId) || reason.length < 10 || reason.length > 500) {
    return res.status(400).json({ success: false, code: 'POS_CHEQUE_BOUNCE_INVALID', message: 'Provide a cheque ID and a bounce reason between 10 and 500 characters.' });
  }

  try {
    const limit = await approvalLimit(companyId);
    const result = await runInTransaction(async (tx) => {
      const lockedRows = await lockCheques(tx, companyId, [chequeId]);
      const cheque = lockedRows[0];
      if (!cheque) return { code: 'POS_CHEQUE_NOT_FOUND' };
      const payloadHash = hash({ chequeId, reason });
      const keyOwner = await tx.posCheque.findFirst({
        where: { companyId, bounceIdempotencyKey: key },
        select: { id: true },
      });
      if (keyOwner && keyOwner.id !== chequeId) return { code: 'POS_IDEMPOTENCY_KEY_REUSED' };
      if (cheque.status === 'bounced') {
        const existing = await tx.posCheque.findFirst({ where: { id: chequeId, companyId } });
        if (existing.bounceIdempotencyKey === key && existing.bouncePayloadHash === payloadHash) {
          return { cheque: existing, replayed: true };
        }
        return { code: existing.bounceIdempotencyKey === key ? 'POS_IDEMPOTENCY_KEY_REUSED' : 'POS_CHEQUE_ALREADY_BOUNCED' };
      }
      if (!['in_hand', 'deposited'].includes(cheque.status)) return { code: 'POS_CHEQUE_STATUS_INVALID' };
      if (cheque.salePostingStatus !== 'posted') return { code: 'POS_CHEQUE_SALE_NOT_POSTED' };

      let deposit = null;
      if (cheque.status === 'deposited') {
        deposit = await tx.posChequeDeposit.findFirst({ where: { id: cheque.depositId, companyId } });
        if (!deposit || deposit.postingStatus !== 'posted') return { code: 'POS_CHEQUE_DEPOSIT_NOT_POSTED' };
      }

      const amount = Number(cheque.amount);
      if (!Number.isSafeInteger(amount) || amount <= 0) return { code: 'POS_CHEQUE_AMOUNT_INVALID' };
      const approvalContext = { chequeId, amount, reason };
      let approvedById = null;
      if (amount > limit) approvedById = await consumeApproval(tx, req, { action: 'CHEQUE_BOUNCE', context: approvalContext });

      const invoiceRows = await tx.$queryRawUnsafe(
        'SELECT "id" FROM "invoices" WHERE "id" = $1 AND "company_id" = $2 FOR UPDATE',
        cheque.invoiceId,
        companyId,
      );
      if (!invoiceRows.length) return { code: 'POS_CHEQUE_INVOICE_NOT_FOUND' };
      const invoice = await tx.invoice.findFirst({
        where: { id: cheque.invoiceId, companyId, posOrigin: true },
        select: { id: true, clientId: true, referenceNo: true, amountPaid: true, amountOutstanding: true, status: true },
      });
      if (!invoice || !['fully_paid', 'partially_paid'].includes(invoice.status)
        || Number(invoice.amountPaid) < amount) return { code: 'POS_CHEQUE_INVOICE_BALANCE_INVALID' };
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "clients" WHERE "id" = $1 AND "company_id" = $2 FOR UPDATE',
        invoice.clientId,
        companyId,
      );
      const updatedInvoice = await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          amountPaid: { decrement: amount },
          amountOutstanding: { increment: amount },
          status: Number(invoice.amountPaid) === amount ? 'confirmed' : 'partially_paid',
          paidDate: null,
        },
      });
      const openInvoices = await tx.invoice.aggregate({
        where: {
          companyId,
          clientId: invoice.clientId,
          status: { in: ['sent', 'confirmed', 'partially_paid'] },
        },
        _sum: { amountOutstanding: true },
      });
      const clientBalance = Number(openInvoices._sum.amountOutstanding || 0);
      await tx.client.update({
        where: { id: invoice.clientId, companyId },
        data: { outstandingBalance: clientBalance },
      });

      const description = `Bounced POS cheque ${cheque.reference} for invoice ${invoice.referenceNo}: ${reason}`;
      const receivableCode = await JournalService.getMappedAccountCode(
        companyId,
        'sales',
        'accountsReceivable',
        DEFAULT_ACCOUNTS.accountsReceivable,
      );
      const creditCode = deposit?.bankAccountCode || cheque.chequesInHandAccountCode || '1130';
      const id = generateObjectId();
      const posting = await posAccountingPostingService.postOrQueue({
        tx,
        companyId,
        userId,
        sourceType: 'pos_cheque_bounce',
        sourceId: chequeId,
        metadata: { chequeId, invoiceId: invoice.id, amount, reason, creditAccountCode: creditCode },
        entries: [{
          date: new Date(),
          description,
          sourceType: 'pos_cheque_bounce',
          sourceId: chequeId,
          sourceReference: invoice.referenceNo,
          lines: [
            JournalService.createDebitLine(receivableCode, amount, description, invoice.referenceNo),
            JournalService.createCreditLine(creditCode, amount, description, invoice.referenceNo),
          ],
          isAutoGenerated: true,
          notes: reason,
          skipBankTransactions: true,
          sourceData: { chequeId, invoiceId: invoice.id },
        }],
      });
      const updatedCheque = await tx.posCheque.update({
        where: { id: chequeId },
        data: {
          status: 'bounced',
          bouncedAt: new Date(),
          bouncedById: userId,
          bounceReason: reason,
          bounceIdempotencyKey: key,
          bouncePayloadHash: payloadHash,
          bouncePostingStatus: posting.status,
          bounceJournalEntryId: posting.journalEntryIds[0] || null,
        },
      });
      await tx.arTransactionLedger.create({
        data: {
          id,
          companyId,
          clientId: invoice.clientId,
          invoiceId: invoice.id,
          transactionType: 'cheque_bounced',
          transactionDate: new Date(),
          referenceNo: invoice.referenceNo,
          description,
          amount,
          direction: 'increase',
          invoiceBalanceAfter: updatedInvoice.amountOutstanding,
          clientBalanceAfter: clientBalance,
          sourceType: 'pos_cheque_bounce',
          sourceId: chequeId,
          sourceReference: cheque.reference,
          journalEntryId: posting.journalEntryIds[0] || null,
          metadata: { chequeId, reason, approvedById },
          reconciliationStatus: 'pending',
          createdById: userId,
        },
      });
      await writePosAuditLog({
        companyId,
        registerId,
        userId,
        event: 'POS_CHEQUE_BOUNCED',
        metadata: { chequeId, invoiceId: invoice.id, amount, reason, approvedById, postingStatus: posting.status },
        ip: requestIp(req),
      }, tx);
      return { cheque: updatedCheque, postingStatus: posting.status, replayed: false };
    });
    if (result.code) {
      const messages = {
        POS_CHEQUE_NOT_FOUND: [404, 'Cheque not found for this company.'],
        POS_IDEMPOTENCY_KEY_REUSED: [409, 'This Idempotency-Key was already used for a different bounce request.'],
        POS_CHEQUE_ALREADY_BOUNCED: [409, 'This cheque has already been bounced.'],
        POS_CHEQUE_STATUS_INVALID: [409, 'This cheque cannot be bounced in its current state.'],
        POS_CHEQUE_SALE_NOT_POSTED: [409, 'Wait for the original sale posting to complete before bouncing this cheque.'],
        POS_CHEQUE_DEPOSIT_NOT_POSTED: [409, 'Wait for the cheque deposit posting to complete before bouncing this cheque.'],
        POS_CHEQUE_INVOICE_NOT_FOUND: [404, 'The cheque invoice was not found for this company.'],
        POS_CHEQUE_INVOICE_BALANCE_INVALID: [409, 'The invoice balance no longer supports reversing this cheque.'],
        POS_CHEQUE_AMOUNT_INVALID: [409, 'The cheque has an invalid amount.'],
      };
      const [status, message] = messages[result.code] || [409, 'The cheque bounce could not be completed.'];
      return res.status(status).json({ success: false, code: result.code, message });
    }
    return res.status(result.replayed ? 200 : 201).json({
      success: true,
      replayed: result.replayed,
      data: { cheque: result.cheque, postingStatus: result.postingStatus },
    });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, code: error.code, message: error.message });
    if (error.code === 'P2002') {
      const prior = await prisma.posCheque.findFirst({
        where: { companyId, bounceIdempotencyKey: key },
      });
      if (prior) {
        const requestHash = hash({ chequeId, reason });
        if (prior.id === chequeId && prior.bouncePayloadHash === requestHash) {
          return res.status(200).json({ success: true, replayed: true, data: { cheque: prior, postingStatus: prior.bouncePostingStatus } });
        }
        return res.status(409).json({ success: false, code: 'POS_IDEMPOTENCY_KEY_REUSED', message: 'This Idempotency-Key was already used for a different bounce request.' });
      }
    }
    return next(error);
  }
};

exports.IDEMPOTENCY_KEY_PATTERN = IDEMPOTENCY_KEY_PATTERN;
