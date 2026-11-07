'use strict';

function amountInCents(value, label) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new TypeError(`${label} must be a non-negative amount.`);
  }
  return Math.round(amount * 100);
}

function accountCodesForLines(lines, predicate) {
  return [...new Set((lines || [])
    .filter(predicate)
    .map((line) => String(line.accountCode || '').trim())
    .filter(Boolean))];
}

function findOriginalVatAccountCode(entry, taxAmount) {
  const expectedCents = amountInCents(taxAmount, 'Original sale tax');
  if (expectedCents === 0) return null;
  const vatLines = (entry?.lines || []).filter((line) => (
    Number(line.credit || 0) > 0
    && /\b(vat|tax output|output tax)\b/i.test(`${line.description || ''} ${line.accountName || ''}`)
  ));
  const accountCodes = accountCodesForLines(vatLines, () => true);
  const creditedCents = vatLines.reduce((sum, line) => sum + amountInCents(line.credit, 'VAT journal credit'), 0);
  if (accountCodes.length !== 1 || creditedCents !== expectedCents) {
    throw new Error('The original POS sale journal does not contain a matching VAT output account. The credit note was not posted.');
  }
  return accountCodes[0];
}

function findOriginalSaleCostAccounts(entry) {
  const lines = entry?.lines || [];
  const cogsCodes = accountCodesForLines(lines, (line) => (
    Number(line.debit || 0) > 0
    && /\b(cogs|cost of goods sold)\b/i.test(`${line.description || ''} ${line.accountName || ''}`)
  ));
  const inventoryCodes = accountCodesForLines(lines, (line) => (
    Number(line.credit || 0) > 0
    && /\binventory\b/i.test(`${line.description || ''} ${line.accountName || ''}`)
  ));
  if (cogsCodes.length > 1 || inventoryCodes.length > 1) {
    throw new Error('The original POS sale uses multiple COGS or Inventory accounts. The credit note requires an explicit account mapping.');
  }
  return {
    cogsAccountCode: cogsCodes[0] || null,
    inventoryAccountCode: inventoryCodes[0] || null,
  };
}

function findOriginalLoyaltyAccounts(entry) {
  const lines = entry?.lines || [];
  const expenseLines = lines.filter((line) => (
    Number(line.debit || 0) > 0
    && /\bloyalty credit earned\b/i.test(`${line.description || ''} ${line.accountName || ''}`)
  ));
  const liabilityLines = lines.filter((line) => (
    Number(line.credit || 0) > 0
    && /\bloyalty credit liability\b/i.test(`${line.description || ''} ${line.accountName || ''}`)
  ));
  const expenseAccountCodes = accountCodesForLines(expenseLines, () => true);
  const liabilityAccountCodes = accountCodesForLines(liabilityLines, () => true);
  const debitCents = expenseLines.reduce((sum, line) => sum + amountInCents(line.debit, 'Loyalty expense debit'), 0);
  const creditCents = liabilityLines.reduce((sum, line) => sum + amountInCents(line.credit, 'Loyalty liability credit'), 0);
  if (expenseAccountCodes.length !== 1 || liabilityAccountCodes.length !== 1
    || debitCents <= 0 || debitCents !== creditCents) {
    throw new Error('The original POS sale journal does not contain a matching loyalty reward expense and liability pair.');
  }
  return {
    expenseAccountCode: expenseAccountCodes[0],
    liabilityAccountCode: liabilityAccountCodes[0],
  };
}

function buildCreditNoteCostLines({ lines, writeOffAccountCode }) {
  const restockLines = [];
  const writeOffLines = [];
  let writeOffAmountCents = 0;

  for (const line of lines || []) {
    const quantity = Number(line.quantity || 0);
    const unitCost = Number(line.unitCost || 0);
    if (!Number.isFinite(quantity) || quantity < 0 || !Number.isFinite(unitCost) || unitCost < 0) {
      throw new TypeError('Credit note quantity and original unit cost must be non-negative numbers.');
    }
    const amountCents = Math.round(quantity * unitCost * 100);
    if (amountCents === 0) continue;

    const disposition = line.returnDisposition || 'restock';
    const inventoryAccountCode = String(line.inventoryAccountCode || '').trim();
    const cogsAccountCode = String(line.cogsAccountCode || '').trim();
    if (!cogsAccountCode) throw new TypeError('The original sale COGS account is required to reverse returned goods.');

    const narration = line.description || 'Credit note inventory disposition';
    if (disposition === 'write_off') {
      const writeOffCode = String(writeOffAccountCode || '').trim();
      if (!writeOffCode) throw new TypeError('The stock write-off loss account is not configured.');
      writeOffAmountCents += amountCents;
      writeOffLines.push({
        accountCode: writeOffCode,
        accountName: 'Stock Adjustment Loss',
        debit: amountCents / 100,
        credit: 0,
        description: narration,
      }, {
        accountCode: cogsAccountCode,
        accountName: 'Cost of Goods Sold',
        debit: 0,
        credit: amountCents / 100,
        description: narration,
      });
      continue;
    }
    if (disposition !== 'restock') {
      throw new TypeError(`Unsupported returned-goods disposition: ${disposition}.`);
    }
    if (!inventoryAccountCode) throw new TypeError('The original sale Inventory account is required to restock returned goods.');
    restockLines.push({
      accountCode: inventoryAccountCode,
      accountName: 'Inventory',
      debit: amountCents / 100,
      credit: 0,
      description: narration,
    }, {
      accountCode: cogsAccountCode,
      accountName: 'Cost of Goods Sold',
      debit: 0,
      credit: amountCents / 100,
      description: narration,
    });
  }

  return {
    restockLines,
    writeOffLines,
    writeOffAmount: writeOffAmountCents / 100,
  };
}

module.exports = {
  buildCreditNoteCostLines,
  findOriginalLoyaltyAccounts,
  findOriginalSaleCostAccounts,
  findOriginalVatAccountCode,
};
