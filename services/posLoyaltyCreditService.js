'use strict';

const { generateObjectId } = require('../utils/objectId');

const money = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const toCents = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100);
const fromCents = (value) => value / 100;
const REVERSAL_MARKER = 'POS_LOYALTY_REWARD_REVERSAL:';
const CONSUMED_MARKER = 'POS_LOYALTY_REWARD_CONSUMED:';

function calculateSaleRewardState(events, saleId) {
  const lots = [];
  let earnedCents = 0;
  let reversedCents = 0;
  const orderedEvents = [...events].sort((left, right) => (
    new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
    || String(left.id).localeCompare(String(right.id))
  ));
  const consumeLots = (amountCents, predicate = () => true) => {
    let remaining = amountCents;
    for (const lot of lots) {
      if (remaining <= 0) break;
      if (!predicate(lot) || lot.remainingCents <= 0) continue;
      const consumed = Math.min(lot.remainingCents, remaining);
      lot.remainingCents -= consumed;
      remaining -= consumed;
    }
    return amountCents - remaining;
  };

  for (const event of orderedEvents) {
    const amountCents = toCents(event.amount);
    if (event.entryType === 'earn') {
      const lot = {
        invoiceId: String(event.invoiceId || ''),
        remainingCents: amountCents,
      };
      lots.push(lot);
      if (lot.invoiceId === String(saleId)) earnedCents += amountCents;
      continue;
    }
    if (event.entryType === 'redeem') {
      consumeLots(amountCents);
      continue;
    }
    if (event.entryType === 'refund' && String(event.notes || '').startsWith(REVERSAL_MARKER)) {
      if (String(event.invoiceId || '') === String(saleId)) {
        const reversed = consumeLots(amountCents, (lot) => lot.invoiceId === String(saleId));
        reversedCents += reversed;
      }
    }
  }

  const availableCents = lots
    .filter((lot) => lot.invoiceId === String(saleId))
    .reduce((sum, lot) => sum + lot.remainingCents, 0);
  return { earnedCents, availableCents, reversedCents };
}

function allocateCents(totalCents, balances) {
  const totalWeight = balances.reduce((sum, balance) => sum + balance.earnedCents, 0);
  if (totalWeight <= 0 || totalCents <= 0) return balances.map(() => 0);
  const allocations = balances.map((balance) => (
    Math.floor(totalCents * balance.earnedCents / totalWeight)
  ));
  let remainder = totalCents - allocations.reduce((sum, amount) => sum + amount, 0);
  for (const index of balances
    .map((balance, index) => ({
      index,
      fraction: totalCents * balance.earnedCents / totalWeight - allocations[index],
    }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index)) {
    if (remainder <= 0) break;
    allocations[index.index] += 1;
    remainder -= 1;
  }
  return allocations;
}

async function reverseSaleRewardForCreditNote(tx, {
  companyId, saleId, creditNoteId, actorId,
}) {
  if (!tx?.$queryRawUnsafe || !tx?.$executeRawUnsafe) {
    throw new TypeError('POS loyalty reversal requires the active PostgreSQL transaction client.');
  }
  const company = String(companyId || '');
  const sale = String(saleId || '');
  const creditNote = String(creditNoteId || '');
  const keyPrefix = `loyalty-credit-note:${creditNote}`;
  const currentRequestRows = await tx.$queryRawUnsafe(
    `SELECT entry_type AS "entryType", amount::text AS amount
       FROM pos_stored_value_ledger
      WHERE company_id = $1 AND invoice_id = $2 AND kind = 'loyalty'
        AND (idempotency_key = $3 OR idempotency_key LIKE $4 OR idempotency_key LIKE $5)
      ORDER BY created_at, id`,
    company,
    sale,
    keyPrefix,
    `${keyPrefix}:reversal:%`,
    `${keyPrefix}:consumed:%`,
  );
  if (currentRequestRows.length) {
    const amount = money(currentRequestRows
      .filter((row) => row.entryType === 'refund')
      .reduce((sum, row) => sum + Number(row.amount || 0), 0));
    const consumedAmount = money(currentRequestRows
      .filter((row) => row.entryType === 'credit_note_consumed')
      .reduce((sum, row) => sum + Number(row.amount || 0), 0));
    return {
      amount,
      consumedAmount,
      replayed: true,
      unreversedSpentAmount: consumedAmount,
    };
  }

  const earnedAccounts = await tx.$queryRawUnsafe(
    `SELECT account_id AS "accountId", SUM(amount)::text AS amount
       FROM pos_stored_value_ledger
      WHERE company_id = $1 AND invoice_id = $2 AND kind = 'loyalty' AND entry_type = 'earn'
      GROUP BY account_id ORDER BY account_id`,
    company,
    sale,
  );
  if (!earnedAccounts.length) {
    return { amount: 0, consumedAmount: 0, replayed: false, unreversedSpentAmount: 0 };
  }

  const invoiceRows = await tx.$queryRawUnsafe(
    'SELECT total_amount::text AS "totalAmount" FROM invoices WHERE id = $1 AND company_id = $2 FOR UPDATE',
    sale,
    company,
  );
  const originalTotal = Number(invoiceRows[0]?.totalAmount || 0);
  if (!(originalTotal > 0)) {
    return { amount: 0, consumedAmount: 0, replayed: false, unreversedSpentAmount: 0 };
  }

  const refundedRows = await tx.$queryRawUnsafe(
    `SELECT COALESCE(SUM(total_amount), 0)::text AS amount
       FROM credit_notes
      WHERE company_id = $1 AND invoice_id = $2
        AND status IN ('processing', 'confirmed', 'issued', 'applied', 'partially_refunded', 'refunded')`,
    company,
    sale,
  );
  const refundedTotal = Math.min(originalTotal, Number(refundedRows[0]?.amount || 0));
  const balances = [];
  for (const earned of earnedAccounts) {
    const accountId = String(earned.accountId);
    const accountRows = await tx.$queryRawUnsafe(
      `SELECT balance::text AS balance FROM pos_stored_value_accounts
        WHERE id = $1 AND company_id = $2 AND kind = 'loyalty' FOR UPDATE`,
      accountId,
      company,
    );
    if (!accountRows[0]) continue;
    const events = await tx.$queryRawUnsafe(
      `SELECT id, invoice_id AS "invoiceId", entry_type AS "entryType",
              amount::text AS amount, notes, created_at AS "createdAt"
         FROM pos_stored_value_ledger
        WHERE company_id = $1 AND account_id = $2 AND kind = 'loyalty'
          AND entry_type IN ('earn', 'redeem', 'refund')
        ORDER BY created_at ASC, id ASC`,
      company,
      accountId,
    );
    const state = calculateSaleRewardState(events, sale);
    balances.push({
      accountId,
      accountBalanceCents: toCents(accountRows[0].balance),
      ...state,
    });
  }

  const earnedCents = balances.reduce((sum, balance) => sum + balance.earnedCents, 0);
  if (earnedCents <= 0) {
    return { amount: 0, consumedAmount: 0, replayed: false, unreversedSpentAmount: 0 };
  }
  const targetCents = Math.round(earnedCents * Math.min(1, refundedTotal / originalTotal));
  const targetByAccount = allocateCents(targetCents, balances);
  let reversedCents = 0;
  let consumedCents = 0;

  for (const [index, balance] of balances.entries()) {
    const remainingTarget = Math.max(0, targetByAccount[index] - balance.reversedCents);
    if (remainingTarget <= 0) continue;
    const amountCents = Math.min(
      remainingTarget,
      balance.availableCents,
      balance.accountBalanceCents,
    );
    const consumedAmountCents = remainingTarget - amountCents;
    const accountBalanceAfterCents = balance.accountBalanceCents - amountCents;

    if (amountCents > 0) {
      const updated = await tx.$queryRawUnsafe(
        `UPDATE pos_stored_value_accounts
            SET balance = balance - $1::numeric, updated_at = CURRENT_TIMESTAMP
          WHERE id = $2 AND company_id = $3 AND kind = 'loyalty'
            AND balance >= $1::numeric
          RETURNING balance::text AS balance`,
        fromCents(amountCents),
        balance.accountId,
        company,
      );
      if (!updated.length) {
        throw Object.assign(new Error('The loyalty credit balance changed while processing the refund. Reload and try again.'), {
          code: 'POS_LOYALTY_REFUND_BALANCE_CONFLICT',
        });
      }
      await tx.$executeRawUnsafe(
        `INSERT INTO pos_stored_value_ledger
          (id, company_id, account_id, idempotency_key, invoice_id, kind, entry_type,
           amount, balance_after, reference, notes, created_by_id, created_at)
         VALUES ($1, $2, $3, $4, $5, 'loyalty', 'refund', $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)`,
        generateObjectId(),
        company,
        balance.accountId,
        `${keyPrefix}:reversal:${balance.accountId}`,
        sale,
        fromCents(amountCents),
        Number(updated[0].balance),
        creditNote,
        `${REVERSAL_MARKER} credit note ${creditNote}; cumulative target RWF ${fromCents(targetCents).toFixed(2)}`,
        actorId ? String(actorId) : null,
      );
    }
    if (consumedAmountCents > 0) {
      await tx.$executeRawUnsafe(
        `INSERT INTO pos_stored_value_ledger
          (id, company_id, account_id, idempotency_key, invoice_id, kind, entry_type,
           amount, balance_after, reference, notes, created_by_id, created_at)
         VALUES ($1, $2, $3, $4, $5, 'loyalty', 'credit_note_consumed', $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)`,
        generateObjectId(),
        company,
        balance.accountId,
        `${keyPrefix}:consumed:${balance.accountId}`,
        sale,
        fromCents(consumedAmountCents),
        fromCents(accountBalanceAfterCents),
        creditNote,
        `${CONSUMED_MARKER} credit note ${creditNote}; target RWF ${fromCents(remainingTarget).toFixed(2)}; reversed RWF ${fromCents(amountCents).toFixed(2)}`,
        actorId ? String(actorId) : null,
      );
    }
    reversedCents += amountCents;
    consumedCents += consumedAmountCents;
  }

  await require('./posAuditService').writePosAuditLog({
    companyId: company,
    userId: actorId ? String(actorId) : null,
    event: 'POS_LOYALTY_CREDIT_REVERSED',
    metadata: {
      saleId: sale,
      creditNoteId: creditNote,
      targetReversal: fromCents(targetCents),
      reversedAmount: fromCents(reversedCents),
      unreversedSpentAmount: fromCents(consumedCents),
    },
  }, tx);
  return {
    amount: fromCents(reversedCents),
    consumedAmount: fromCents(consumedCents),
    replayed: false,
    targetReversal: fromCents(targetCents),
    unreversedSpentAmount: fromCents(consumedCents),
  };
}

module.exports = {
  calculateSaleRewardState,
  money,
  reverseSaleRewardForCreditNote,
};
