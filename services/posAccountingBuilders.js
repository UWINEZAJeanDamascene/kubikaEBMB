'use strict';

function toCents(value, field) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || amount > Number.MAX_SAFE_INTEGER / 100) {
    throw new TypeError(`${field} must be a non-negative RWF amount.`);
  }
  return Math.round(amount * 100);
}

function fromCents(value) {
  return value / 100;
}

function requiredAccount(accounts, key) {
  const code = accounts?.[key];
  if (code == null || String(code).trim() === '') {
    throw new TypeError(`POS accounting account ${key} is not configured.`);
  }
  return String(code);
}

function addLine(lines, accountCode, debit, credit, description) {
  if (debit === 0 && credit === 0) return;
  lines.push({ accountCode, debit, credit, description });
}

function assertBalanced(lines, label) {
  const debits = lines.reduce((total, line) => total + Math.round(line.debit * 100), 0);
  const credits = lines.reduce((total, line) => total + Math.round(line.credit * 100), 0);
  if (debits !== credits) {
    throw new TypeError(`${label} journal lines are not balanced (debits ${debits}, credits ${credits}).`);
  }
  if (lines.length < 2) throw new TypeError(`${label} must produce at least two journal lines.`);
  return lines;
}

function tenderAccount(tender, accounts) {
  const method = String(tender.paymentMethod || tender.method || '').toLowerCase();
  if (method === 'cash') return requiredAccount(accounts, 'posRegisterCash');
  if (method === 'card') return requiredAccount(accounts, 'cardClearing');
  if (method === 'mobile_money') {
    const provider = String(tender.provider || '').toLowerCase();
    if (!provider && tender.accountCode) return String(tender.accountCode);
    if (provider === 'airtel' || provider === 'airtel_money') return requiredAccount(accounts, 'airtelMoney');
    if (provider === 'momo' || provider === 'mtn' || provider === 'mtn_momo') {
      return requiredAccount(accounts, 'mtnMoMo');
    }
    throw new TypeError('A mobile money tender must identify its provider as MTN MoMo or Airtel.');
  }
  if (method === 'bank_transfer') {
    const accountCode = tender.accountCode || accounts?.cashAtBank;
    if (!accountCode) throw new TypeError(`${method} tender has no mapped bank account code.`);
    return String(accountCode);
  }
  if (method === 'cheque') return requiredAccount(accounts, 'chequesInHand');
  if (method === 'gift_card') return requiredAccount(accounts, 'giftCardLiability');
  if (method === 'store_credit') return requiredAccount(accounts, 'storeCreditLiability');
  if (method === 'loyalty_wallet') return requiredAccount(accounts, 'loyaltyWalletLiability');
  if (method === 'loyalty_points') return requiredAccount(accounts, 'loyaltyPointsLiability');
  if (method === 'loyalty') return requiredAccount(accounts, 'customerAdvances');
  if (method === 'customer_credit' || method === 'credit') return requiredAccount(accounts, 'accountsReceivable');
  throw new TypeError(`Unsupported POS payment method: ${method || '(empty)'}.`);
}

function buildSaleJournalEntries({ invoice, tenders, accounts }) {
  if (!invoice || typeof invoice !== 'object') throw new TypeError('A stored invoice is required.');
  const reference = String(invoice.referenceNo || invoice.reference || invoice.id || 'POS sale');
  const total = toCents(invoice.totalAmount, 'invoice.totalAmount');
  const tax = toCents(invoice.taxAmount || 0, 'invoice.taxAmount');
  const outstanding = toCents(invoice.amountOutstanding || 0, 'invoice.amountOutstanding');
  const amountPaid = toCents(invoice.amountPaid || 0, 'invoice.amountPaid');
  const invoiceId = invoice.id || invoice._id;
  if (!invoiceId) throw new TypeError('The stored invoice must include its ID.');
  if (tax > total) throw new TypeError('invoice.taxAmount cannot exceed invoice.totalAmount.');

  const paymentRows = Array.isArray(tenders) ? tenders : invoice.payments;
  if (!Array.isArray(paymentRows)) throw new TypeError('Stored invoice tenders must be an array.');
  const paymentTotal = paymentRows.reduce((sum, tender, index) => (
    sum + toCents(tender.amountRwf ?? tender.amount, `tenders[${index}].amount`)
  ), 0);
  if (paymentTotal !== amountPaid) {
    throw new TypeError(`Stored tender total ${paymentTotal} does not match invoice.amountPaid ${amountPaid}.`);
  }
  if (amountPaid + outstanding !== total) {
    throw new TypeError('invoice.amountPaid plus invoice.amountOutstanding must equal invoice.totalAmount.');
  }

  const revenueLines = [];
  for (let index = 0; index < paymentRows.length; index += 1) {
    const tender = paymentRows[index];
    const amount = toCents(tender.amountRwf ?? tender.amount, `tenders[${index}].amount`);
    addLine(revenueLines, tenderAccount(tender, accounts), fromCents(amount), 0, `POS payment - ${reference}`);
  }
  if (outstanding > 0) {
    addLine(revenueLines, requiredAccount(accounts, 'accountsReceivable'), fromCents(outstanding), 0, `Receivable - ${reference}`);
  }
  const netSales = total - tax;
  const storedNetSales = invoice.subtotal == null
    ? netSales
    : toCents(invoice.subtotal, 'invoice.subtotal') - toCents(invoice.totalDiscount || 0, 'invoice.totalDiscount');
  if (storedNetSales !== netSales) {
    throw new TypeError('Stored subtotal less discounts does not match invoice total less VAT.');
  }
  // POS discounts, including voucher allocations, reduce revenue; do not post a second discount journal line.
  if (netSales > 0) addLine(revenueLines, requiredAccount(accounts, 'salesRevenue'), 0, fromCents(netSales), `Sales revenue - ${reference}`);
  if (tax > 0) addLine(revenueLines, requiredAccount(accounts, 'vatOutput'), 0, fromCents(tax), `VAT output - ${reference}`);

  const sourceLines = Array.isArray(invoice.lines) ? invoice.lines : [];
  const lineTaxTotal = sourceLines.reduce((sum, line, index) => (
    sum + toCents(line.lineTax ?? line.taxAmount ?? 0, `invoice.lines[${index}].lineTax`)
  ), 0);
  const lineTotal = sourceLines.reduce((sum, line, index) => (
    sum + toCents(line.lineTotal ?? 0, `invoice.lines[${index}].lineTotal`)
  ), 0);
  if (sourceLines.length && (lineTaxTotal !== tax || lineTotal !== total)) {
    throw new TypeError('Stored invoice line totals do not reconcile with the invoice header.');
  }
  if (sourceLines.length && sourceLines.every((line) => line.lineSubtotal != null)) {
    const lineSubtotal = sourceLines.reduce((sum, line, index) => (
      sum + toCents(line.lineSubtotal, `invoice.lines[${index}].lineSubtotal`)
    ), 0);
    const lineDiscount = sourceLines.reduce((sum, line, index) => (
      sum + toCents(line.lineSubtotal, `invoice.lines[${index}].lineSubtotal`)
      - toCents(line.lineTotal ?? 0, `invoice.lines[${index}].lineTotal`)
      + toCents(line.lineTax ?? line.taxAmount ?? 0, `invoice.lines[${index}].lineTax`)
    ), 0);
    if (invoice.subtotal != null && lineSubtotal !== toCents(invoice.subtotal, 'invoice.subtotal')) {
      throw new TypeError('Stored invoice line subtotals do not reconcile with the invoice subtotal.');
    }
    if (lineDiscount !== toCents(invoice.totalDiscount || 0, 'invoice.totalDiscount')) {
      throw new TypeError('Stored invoice line discounts do not reconcile with the invoice discount total.');
    }
  }
  const hasStoredLineCosts = sourceLines.length > 0
    && sourceLines.every((line) => line.cogsAmount != null);
  const cogs = hasStoredLineCosts
    ? sourceLines.reduce((sum, line, index) => (
      sum + toCents(line.cogsAmount, `invoice.lines[${index}].cogsAmount`)
    ), 0)
    : invoice.cogsAmount != null
      ? toCents(invoice.cogsAmount, 'invoice.cogsAmount')
      : sourceLines.reduce((sum, line, index) => (
        sum + toCents(line.cogsAmount || 0, `invoice.lines[${index}].cogsAmount`)
      ), 0);
  const cogsLines = cogs > 0 ? [{
    accountCode: requiredAccount(accounts, 'costOfGoodsSold'),
    debit: fromCents(cogs),
    credit: 0,
    description: `COGS - ${reference}`,
  }, {
    accountCode: requiredAccount(accounts, 'inventory'),
    debit: 0,
    credit: fromCents(cogs),
    description: `Inventory reduction - ${reference}`,
  }] : [];
  const combinesCogs = invoice.ebm?.paymentFlow === 'PAYMENTS_V2';
  if (combinesCogs) revenueLines.push(...cogsLines);
  const entries = [{
    sourceType: 'invoice',
    sourceId: String(invoiceId),
    sourceReference: reference,
    lines: assertBalanced(revenueLines, 'Invoice revenue'),
  }];
  if (cogsLines.length && !combinesCogs) {
    entries.push({
      sourceType: 'invoice_cogs',
      sourceId: String(invoiceId),
      sourceReference: reference,
      lines: assertBalanced(cogsLines, 'Invoice COGS'),
    });
  }
  return entries;
}

function buildCashMovementJournalLines({ movement, registerCashAccount, counterpartAccount }) {
  if (!movement || typeof movement !== 'object') throw new TypeError('A stored POS cash movement is required.');
  const amount = fromCents(toCents(movement.amount, 'movement.amount'));
  if (amount === 0) throw new TypeError('movement.amount must be greater than zero.');
  const registerCash = String(registerCashAccount || '').trim();
  if (!registerCash) throw new TypeError('Register cash account is not configured.');

  let debitAccount;
  let creditAccount;
  if (movement.type === 'cash_in') {
    debitAccount = registerCash;
    creditAccount = String(counterpartAccount || '').trim();
  } else if (movement.type === 'cash_out') {
    debitAccount = String(counterpartAccount || '').trim();
    creditAccount = registerCash;
  } else if (movement.type === 'safe_drop') {
    debitAccount = String(counterpartAccount || '').trim();
    creditAccount = registerCash;
  } else {
    throw new TypeError(`Unsupported POS cash movement type: ${movement.type}.`);
  }
  if (!debitAccount || !creditAccount) throw new TypeError('A counterpart account is required for this movement.');
  return assertBalanced([{
    accountCode: debitAccount,
    debit: amount,
    credit: 0,
    description: `POS ${movement.type}`,
  }, {
    accountCode: creditAccount,
    debit: 0,
    credit: amount,
    description: `POS ${movement.type}`,
  }], 'POS cash movement');
}

module.exports = { buildSaleJournalEntries, buildCashMovementJournalLines };
