'use strict';

const JournalService = require('./journalService');
const { DEFAULT_ACCOUNTS } = require('../constants/chartOfAccounts');
const { generateObjectId } = require('../utils/objectId');
const { buildPosReceiptDocument } = require('./posReceiptDocumentService');
const { findRegisterForShift, recordTillCashMovement } = require('./posShiftLinkService');

const money = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

function allocatePayment(amount, invoices, requested = null) {
  const remainingById = new Map(invoices.map((invoice) => [String(invoice.id), money(invoice.amountOutstanding)]));
  let allocations;
  if (requested) {
    if (!Array.isArray(requested)) throw Object.assign(new Error('Allocations must be a list.'), { code: 'AR_ALLOCATION_INVALID' });
    allocations = requested.map((item) => ({ invoiceId: String(item.invoiceId || ''), amount: money(item.amount) }));
    if (allocations.some((item) => !item.invoiceId || !Number.isFinite(item.amount) || item.amount <= 0)
      || new Set(allocations.map((item) => item.invoiceId)).size !== allocations.length) {
      throw Object.assign(new Error('Each invoice allocation must have a distinct invoice and a positive amount.'), { code: 'AR_ALLOCATION_INVALID' });
    }
    for (const item of allocations) {
      const balance = remainingById.get(item.invoiceId);
      if (balance == null || item.amount > balance + 0.009) {
        throw Object.assign(new Error('An allocation is larger than that invoice’s outstanding balance.'), { code: 'AR_ALLOCATION_EXCEEDS_INVOICE' });
      }
    }
    if (money(allocations.reduce((sum, item) => sum + item.amount, 0)) > amount + 0.009) {
      throw Object.assign(new Error('Invoice allocations cannot exceed the payment amount.'), { code: 'AR_ALLOCATION_EXCEEDS_PAYMENT' });
    }
  } else {
    let unallocated = amount;
    allocations = [];
    for (const invoice of invoices) {
      const balance = remainingById.get(String(invoice.id));
      if (balance <= 0 || unallocated <= 0) continue;
      const applied = money(Math.min(balance, unallocated));
      allocations.push({ invoiceId: String(invoice.id), amount: applied });
      unallocated = money(unallocated - applied);
    }
  }
  const allocated = money(allocations.reduce((sum, item) => sum + item.amount, 0));
  return { allocations, allocated, unapplied: money(amount - allocated) };
}

function refundedInvoiceBalance(invoice, allocationAmount) {
  const applied = money(allocationAmount);
  const paidAfter = Math.max(0, money(invoice.amountPaid) - applied);
  return {
    amountPaid: paidAfter,
    amountOutstanding: money(Number(invoice.amountOutstanding) + applied),
    status: paidAfter <= 0.009 ? 'confirmed' : 'partially_paid',
  };
}

function buildCreditPaymentReceipt({ receipt, client, company, register, cashier, amount, currencyCode = 'RWF' }) {
  return buildPosReceiptDocument({
    id: receipt.id,
    receiptType: 'CREDIT_PAYMENT',
    referenceNo: receipt.referenceNo,
    invoiceNumber: receipt.referenceNo,
    createdAt: receipt.receiptDate,
    currencyCode,
    subtotal: 0,
    discountAmount: 0,
    totalTax: 0,
    grandTotal: amount,
    amountPaid: amount,
    changeGiven: 0,
    client: { name: client.name, taxId: client.taxId || null },
    customerName: client.name,
    cashier: { name: cashier.name || cashier.email || 'Cashier' },
    registerName: register.name,
    companyReceipt: { name: company.legalName || company.name || 'Company', tin: company.taxIdentificationNumber || null },
    receiptLines: [],
    paymentReceipt: { methods: [{ method: 'cash', amountRwf: amount, kind: 'CREDIT_PAYMENT' }], amountPaidRwf: amount, changeGivenRwf: 0 },
    receiptSettings: { showCustomer: true, showCashier: true },
  }, { registerName: register.name, tillType: 'retail' });
}

async function replayCreditPayment({ tx, prior, companyId, registerId, userId }) {
  const [client, company, register, cashier, movement] = await Promise.all([
    tx.client.findFirst({ where: { id: prior.clientId, companyId } }),
    tx.company.findUnique({ where: { id: companyId } }),
    tx.posRegister.findFirst({ where: { id: registerId, companyId } }),
    tx.user.findFirst({ where: { id: userId, companyId } }),
    tx.posCashMovement.findFirst({ where: { companyId, idempotencyKey: `CREDITPAY:${prior.posIdempotencyKey}` } }),
  ]);
  if (!client || !company || !register || !cashier || !movement) {
    throw Object.assign(new Error('The saved account-payment receipt could not be reloaded.'), { code: 'POS_CREDIT_RECEIPT_RELOAD_FAILED' });
  }
  const amount = Number(prior.amountReceived);
  // The receipt's unallocated amount also lets us replay payments applied to
  // legacy customer balances that do not have an invoice row to allocate to.
  const allocated = money(Math.max(0, amount - Number(prior.unallocatedAmount || 0)));
  return {
    receipt: prior,
    movement,
    balanceAfter: Number(client.outstandingBalance || 0),
    allocated,
    unapplied: Number(prior.unallocatedAmount || Math.max(0, amount - allocated)),
    receiptDocument: buildCreditPaymentReceipt({ receipt: prior, client, company, register, cashier, amount, currencyCode: prior.currencyCode || 'RWF' }),
    replayed: true,
  };
}

async function postCreditPayment({ tx, companyId, userId, clientId, registerId, key, amount, requestedAllocations, note, ip }) {
  const prior = await tx.aRReceipt.findFirst({ where: { companyId, posIdempotencyKey: key }, include: { allocations: true } });
  if (prior) {
    if (Number(prior.amountReceived) !== amount || prior.clientId !== clientId || prior.paymentMethod !== 'cash') {
      throw Object.assign(new Error('This payment key was already used for a different account payment.'), { code: 'POS_IDEMPOTENCY_KEY_REUSED' });
    }
    return replayCreditPayment({ tx, prior, companyId, registerId, userId });
  }

  const customerRows = await tx.$queryRawUnsafe(
    'SELECT "id" FROM "clients" WHERE "id" = $1 AND "company_id" = $2 FOR UPDATE', clientId, companyId,
  );
  if (!customerRows.length) throw Object.assign(new Error('Customer not found in this workspace.'), { code: 'POS_CREDIT_CUSTOMER_NOT_FOUND' });
  const lockedPrior = await tx.aRReceipt.findFirst({ where: { companyId, posIdempotencyKey: key }, include: { allocations: true } });
  if (lockedPrior) {
    if (Number(lockedPrior.amountReceived) !== amount || lockedPrior.clientId !== clientId || lockedPrior.paymentMethod !== 'cash') {
      throw Object.assign(new Error('This payment key was already used for a different account payment.'), { code: 'POS_IDEMPOTENCY_KEY_REUSED' });
    }
    return replayCreditPayment({ tx, prior: lockedPrior, companyId, registerId, userId });
  }
  const shiftRows = await tx.$queryRawUnsafe(
    'SELECT "id" FROM "pos_shifts" WHERE "company_id" = $1 AND "register_id" = $2 AND "status" IN (\'open\', \'reopened\') ORDER BY "opened_at" DESC FOR UPDATE',
    companyId, registerId,
  );
  const shiftId = String(shiftRows[0]?.id || '').trim();
  if (!shiftId) throw Object.assign(new Error('An open shift is required to receive an account payment.'), { code: 'POS_SHIFT_NOT_OPEN' });
  const client = await tx.client.findFirst({ where: { id: clientId, companyId, isActive: true, mergedIntoClientId: null, isWalkIn: false } });
  if (!client) throw Object.assign(new Error('Choose an active named customer account.'), { code: 'POS_CREDIT_CUSTOMER_INELIGIBLE' });
  const invoices = await tx.invoice.findMany({
    where: { companyId, clientId, status: { in: ['sent', 'confirmed', 'partially_paid'] }, amountOutstanding: { gt: 0 } },
    orderBy: [{ invoiceDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  });
  if (invoices.length) {
    await tx.$queryRawUnsafe(
      'SELECT "id" FROM "invoices" WHERE "company_id" = $1 AND "client_id" = $2 AND "id" = ANY($3::char(24)[]) ORDER BY "id" FOR UPDATE',
      companyId, clientId, invoices.map((invoice) => invoice.id),
    );
  }
  const { allocations, allocated: invoiceAllocated, unapplied: afterInvoiceAllocation } = allocatePayment(amount, invoices, requestedAllocations);
  // Some existing AR balances predate invoice-level allocations. Preserve and
  // settle those balances after applying the oldest explicit invoices first.
  const invoiceOutstanding = money(invoices.reduce((sum, invoice) => sum + Number(invoice.amountOutstanding || 0), 0));
  const legacyOutstanding = money(Math.max(0, Number(client.outstandingBalance || 0) - invoiceOutstanding));
  const legacyAllocated = money(Math.min(afterInvoiceAllocation, legacyOutstanding));
  const allocated = money(invoiceAllocated + legacyAllocated);
  const unapplied = money(amount - allocated);
  const selectedInvoiceIds = allocations.map((item) => item.invoiceId);
  if (selectedInvoiceIds.some((id) => !invoices.some((invoice) => invoice.id === id))) {
    throw Object.assign(new Error('An allocated invoice does not belong to this customer or has no balance due.'), { code: 'AR_INVOICE_NOT_ALLOCATABLE' });
  }

  const register = await tx.posRegister.findFirst({ where: { id: registerId, companyId, isActive: true } });
  const shift = await tx.posShift.findFirst({ where: { id: shiftId, companyId, registerId, status: { in: ['open', 'reopened'] } } });
  const company = await tx.company.findUnique({ where: { id: companyId }, select: { id: true, name: true, legalName: true, taxIdentificationNumber: true } });
  const cashier = await tx.user.findFirst({ where: { id: userId, companyId }, select: { id: true, name: true, email: true } });
  if (!register || !shift || !company || !cashier) throw Object.assign(new Error('The active till context could not be verified.'), { code: 'POS_TILL_CONTEXT_INVALID' });

  const referenceNo = `CP-${generateObjectId().slice(-12).toUpperCase()}`;
  const receiptDate = new Date();
  const receipt = await tx.aRReceipt.create({ data: {
    id: generateObjectId(), companyId, clientId, referenceNo, receiptDate, paymentMethod: 'cash',
    amountReceived: amount, currencyCode: 'RWF', exchangeRate: 1, reference: `POS:${register.code}`,
    posIdempotencyKey: key, status: 'posted', unallocatedAmount: unapplied,
    postedById: userId, postedAt: receiptDate, createdById: userId, notes: note || null,
  } });
  if (allocations.length) await tx.aRReceiptAllocation.createMany({ data: allocations.map((item) => ({
    id: generateObjectId(), companyId, receiptId: receipt.id, invoiceId: item.invoiceId,
    amountAllocated: item.amount, createdById: userId,
  })) });

  const registerCash = await JournalService.getMappedAccountCode(companyId, 'cash', 'posRegisterCash', DEFAULT_ACCOUNTS.posRegisterCash);
  const arCode = await JournalService.getMappedAccountCode(companyId, 'sales', 'accountsReceivable', DEFAULT_ACCOUNTS.accountsReceivable);
  const advanceCode = await JournalService.getMappedAccountCode(companyId, 'sales', 'customerAdvances', DEFAULT_ACCOUNTS.customerAdvances);
  const description = `POS credit account payment ${referenceNo} - ${client.name}`;
  const lines = [JournalService.createDebitLine(registerCash, amount, description)];
  if (allocated > 0) lines.push(JournalService.createCreditLine(arCode, allocated, `${description} applied to customer balance`));
  if (unapplied > 0) lines.push(JournalService.createCreditLine(advanceCode, unapplied, `${description} customer advance`));
  const journal = await JournalService.createEntry(companyId, userId, {
    date: receiptDate, description, sourceType: 'ar_receipt', sourceId: receipt.id,
    sourceReference: referenceNo, lines, isAutoGenerated: true,
    sourceData: { customerId: clientId, amount, allocated, unapplied, receiptType: 'CREDIT_PAYMENT' },
    session: tx, skipBankTransactions: true,
  });
  const journalEntryId = String(journal?._id || journal?.id || '');
  if (!journalEntryId) throw new Error('The account payment journal was not created.');
  await tx.aRReceipt.update({ where: { id: receipt.id }, data: { journalEntryId } });

  for (const item of allocations) {
    const invoice = invoices.find((entry) => entry.id === item.invoiceId);
    const changed = await tx.invoice.updateMany({
      where: { id: invoice.id, companyId, clientId, amountOutstanding: { gte: item.amount } },
      data: { amountPaid: { increment: item.amount }, amountOutstanding: { decrement: item.amount } },
    });
    if (changed.count !== 1) throw Object.assign(new Error('An invoice balance changed while applying this payment.'), { code: 'AR_INVOICE_BALANCE_CHANGED' });
    const updated = await tx.invoice.findUnique({ where: { id: invoice.id }, select: { amountOutstanding: true } });
    const remaining = money(updated.amountOutstanding);
    await tx.invoice.update({ where: { id: invoice.id }, data: { status: remaining <= 0.009 ? 'fully_paid' : 'partially_paid', ...(remaining <= 0.009 ? { paidDate: receiptDate } : {}) } });
    await tx.arTransactionLedger.create({ data: {
      id: generateObjectId(), companyId, clientId, invoiceId: invoice.id, receiptId: receipt.id,
      transactionType: 'allocation_made', transactionDate: receiptDate, referenceNo,
      description: `POS account payment ${referenceNo} allocated to ${invoice.referenceNo}`,
      amount: item.amount, direction: 'decrease', invoiceBalanceAfter: remaining,
      sourceType: 'ar_receipt', sourceId: receipt.id, sourceReference: referenceNo,
      journalEntryId, reconciliationStatus: 'verified', createdById: userId,
    } });
  }
  const balanceAfter = money(Math.max(0, Number(client.outstandingBalance || 0) - allocated));
  await tx.client.update({ where: { id: clientId, companyId }, data: { outstandingBalance: balanceAfter } });
  const movement = await tx.posCashMovement.create({ data: {
    id: generateObjectId(), companyId, registerId, shiftId, type: 'cash_in', amount: Math.round(amount),
    reasonCode: 'CREDIT_PAYMENT', note: `AR receipt ${referenceNo}`, performedById: userId,
    journalEntryId, idempotencyKey: `CREDITPAY:${key}`,
  } });
  const recordedMovement = await tx.posCashMovement.update({ where: { id: movement.id }, data: { journalEntryId } });
  await recordTillCashMovement(tx, { companyId, registerCode: register.code, shift, movement: { companyId, registerId, shiftId, performedById: userId, type: 'cash_in', amount: Math.round(amount), reasonCode: 'CREDIT_PAYMENT', note: `AR receipt ${referenceNo}`, id: recordedMovement.id } });
  if (allocated > 0) {
    await tx.posCustomerCreditLedger.create({ data: {
      id: generateObjectId(), companyId, clientId, entryType: 'PAYMENT', direction: 'DECREASE',
      amount: allocated, balanceAfter, receiptId: receipt.id,
      createdById: userId, idempotencyKey: `CREDITPAY:${key}`, requestHash: require('crypto').createHash('sha256').update(JSON.stringify({ clientId, amount, allocations, legacyAllocated })).digest('hex'),
    } });
  }
  const { writePosAuditLog } = require('./posAuditService');
  await writePosAuditLog({ companyId, registerId, userId, event: 'POS_CREDIT_PAYMENT_RECORDED', metadata: { receiptId: receipt.id, referenceNo, amount, allocated, unapplied, shiftId, movementId: movement.id } }, tx);
  const receiptDocument = buildCreditPaymentReceipt({ receipt, client, company, register, cashier, amount });
  return {
    receipt: { ...receipt, journalEntryId }, movement: recordedMovement, receiptDocument,
    balanceAfter, allocated, invoiceAllocated, legacyAllocated, unapplied, replayed: false,
  };
}

module.exports = { allocatePayment, refundedInvoiceBalance, buildCreditPaymentReceipt, postCreditPayment };
