'use strict';

const { generateObjectId } = require('../utils/objectId');

function money(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

/**
 * Reverse the unused share of POS loyalty wallet credit as a POS credit note
 * is confirmed. The wallet cannot become negative, so already-spent rewards
 * are not clawed back from unrelated future funds. The difference is returned
 * to the caller for accounting/audit visibility.
 */
async function reverseSaleRewardForCreditNote(tx, {
  companyId, saleId, creditNoteId, actorId,
}) {
  const company = String(companyId || '');
  const sale = String(saleId || '');
  const creditNote = String(creditNoteId || '');
  const idempotencyKey = `loyalty-credit-note:${creditNote}`;
  const priorRequest = await tx.$queryRawUnsafe(
    'SELECT amount::text AS amount FROM pos_stored_value_ledger WHERE company_id = $1 AND idempotency_key = $2 LIMIT 1',
    company, idempotencyKey,
  );
  if (priorRequest[0]) return { amount: Number(priorRequest[0].amount), replayed: true, unreversedSpentAmount: 0 };

  const earnings = await tx.$queryRawUnsafe(
    'SELECT account_id AS "accountId", SUM(amount)::text AS amount FROM pos_stored_value_ledger WHERE company_id = $1 AND invoice_id = $2 AND kind = \'loyalty\' AND entry_type = \'earn\' GROUP BY account_id ORDER BY account_id',
    company, sale,
  );
  if (!earnings.length) return { amount: 0, replayed: false, unreversedSpentAmount: 0 };

  const invoiceRows = await tx.$queryRawUnsafe(
    'SELECT total_amount::text AS "totalAmount" FROM invoices WHERE id = $1 AND company_id = $2 FOR UPDATE',
    sale, company,
  );
  const originalTotal = Number(invoiceRows[0]?.totalAmount || 0);
  if (!(originalTotal > 0)) return { amount: 0, replayed: false, unreversedSpentAmount: 0 };

  // Credit notes are marked processing inside the same transaction before
  // this helper runs, so include that status in the cumulative return amount.
  const refundedRows = await tx.$queryRawUnsafe(
    'SELECT COALESCE(SUM(total_amount), 0)::text AS amount FROM credit_notes WHERE company_id = $1 AND invoice_id = $2 AND status IN (\'processing\', \'confirmed\', \'issued\', \'applied\', \'partially_refunded\', \'refunded\')',
    company, sale,
  );
  const refundedTotal = Math.min(originalTotal, Number(refundedRows[0]?.amount || 0));
  const earnedTotal = earnings.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const targetReversal = money(earnedTotal * Math.min(1, refundedTotal / originalTotal));
  const priorReversalRows = await tx.$queryRawUnsafe(
    'SELECT COALESCE(SUM(amount), 0)::text AS amount FROM pos_stored_value_ledger WHERE company_id = $1 AND invoice_id = $2 AND kind = \'loyalty\' AND entry_type = \'refund\' AND notes LIKE \'POS_LOYALTY_REWARD_REVERSAL:%\'',
    company, sale,
  );
  const alreadyReversed = Number(priorReversalRows[0]?.amount || 0);
  let remainingToReverse = money(Math.max(0, targetReversal - alreadyReversed));
  let reversedAmount = 0;
  let unreversedSpentAmount = 0;

  for (const earned of earnings) {
    if (remainingToReverse <= 0) break;
    const accountId = String(earned.accountId);
    const accountRows = await tx.$queryRawUnsafe(
      'SELECT balance::text AS balance FROM pos_stored_value_accounts WHERE id = $1 AND company_id = $2 AND kind = \'loyalty\' FOR UPDATE',
      accountId, company,
    );
    if (!accountRows[0]) continue;
    const available = Math.max(0, Number(accountRows[0].balance || 0));
    const amount = money(Math.min(available, remainingToReverse));
    if (amount <= 0) continue;

    const updated = await tx.$queryRawUnsafe(
      'UPDATE pos_stored_value_accounts SET balance = balance - $1::numeric, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND company_id = $3 AND balance >= $1::numeric RETURNING balance::text AS balance',
      amount, accountId, company,
    );
    if (!updated.length) throw Object.assign(new Error('The loyalty credit balance changed while processing the refund. Reload and try again.'), { code: 'POS_LOYALTY_REFUND_BALANCE_CONFLICT' });

    const entryId = generateObjectId();
    await tx.$executeRawUnsafe(
      'INSERT INTO pos_stored_value_ledger (id, company_id, account_id, idempotency_key, invoice_id, kind, entry_type, amount, balance_after, reference, notes, created_by_id, created_at) VALUES ($1, $2, $3, $4, $5, \'loyalty\', \'refund\', $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)',
      entryId, company, accountId, idempotencyKey, sale, amount, Number(updated[0].balance), creditNote,
      `POS_LOYALTY_REWARD_REVERSAL: credit note ${creditNote}; cumulative target RWF ${targetReversal.toFixed(2)}`,
      actorId ? String(actorId) : null,
    );
    reversedAmount = money(reversedAmount + amount);
    remainingToReverse = money(remainingToReverse - amount);
  }

  unreversedSpentAmount = money(remainingToReverse);
  await require('./posAuditService').writePosAuditLog({
    companyId: company,
    userId: actorId ? String(actorId) : null,
    event: 'POS_LOYALTY_CREDIT_REVERSED',
    metadata: {
      saleId: sale,
      creditNoteId: creditNote,
      targetReversal,
      reversedAmount,
      unreversedSpentAmount,
    },
  }, tx);
  return { amount: reversedAmount, replayed: false, unreversedSpentAmount, targetReversal };
}

module.exports = { reverseSaleRewardForCreditNote, money };
