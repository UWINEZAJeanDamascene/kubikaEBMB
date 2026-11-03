'use strict';

const { createHash } = require('crypto');
const { generateObjectId } = require('../utils/objectId');

async function restoreGiftCardBalance(tx, {
  companyId,
  saleId,
  paymentId,
  refundAmount,
  idempotencyKey,
  reason,
  userId,
}) {
  const redemptionRows = await tx.$queryRawUnsafe(
    'SELECT l.account_id AS "accountId", l.reference, a.code_suffix AS "codeSuffix", a.is_active AS "isActive", a.expires_at AS "expiresAt" FROM pos_stored_value_ledger l JOIN pos_stored_value_accounts a ON a.id = l.account_id AND a.company_id = l.company_id WHERE l.company_id = $1 AND l.pos_payment_id = $2 AND l.invoice_id = $3 AND l.operation_type = \'REDEEM\'::"PosStoredValueOperation" AND l.kind = \'gift_card\' ORDER BY l.created_at ASC LIMIT 1 FOR UPDATE OF l',
    companyId,
    paymentId,
    saleId,
  );
  const redemption = redemptionRows[0];
  if (!redemption) {
    return { error: 'POS_GIFT_CARD_REDEMPTION_MISSING' };
  }

  const refundKey = `refund:${createHash('sha256')
    .update(`${companyId}:${idempotencyKey}:${paymentId}`)
    .digest('hex')}`;
  const priorRows = await tx.$queryRawUnsafe(
    'SELECT balance_after::text AS "balanceAfter", notes FROM pos_stored_value_ledger WHERE company_id = $1 AND idempotency_key = $2 AND operation_type = \'REFUND\'::"PosStoredValueOperation" LIMIT 1',
    companyId,
    refundKey,
  );
  if (priorRows[0]) {
    return {
      replayed: true,
      balanceAfter: Number(priorRows[0].balanceAfter),
      managerReviewRequired: String(priorRows[0].notes || '').includes('MANAGER_REVIEW_REQUIRED'),
      codeSuffix: String(redemption.codeSuffix || redemption.reference || ''),
    };
  }

  const accountRows = await tx.$queryRawUnsafe(
    'SELECT balance::text AS balance FROM pos_stored_value_accounts WHERE id = $1 AND company_id = $2 FOR UPDATE',
    String(redemption.accountId),
    companyId,
  );
  if (!accountRows[0]) return { error: 'POS_GIFT_CARD_UNAVAILABLE' };
  const currentBalance = Number(accountRows[0].balance);
  const expectedBalance = currentBalance + refundAmount;
  if (!Number.isSafeInteger(refundAmount) || refundAmount <= 0
    || !Number.isSafeInteger(currentBalance) || !Number.isSafeInteger(expectedBalance)) {
    return { error: 'POS_GIFT_CARD_BALANCE_INVALID' };
  }

  const updatedRows = await tx.$queryRawUnsafe(
    'UPDATE pos_stored_value_accounts SET balance = balance + $1::numeric, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND company_id = $3 RETURNING balance::text AS balance',
    refundAmount,
    String(redemption.accountId),
    companyId,
  );
  if (!updatedRows.length) return { error: 'POS_GIFT_CARD_BALANCE_CONFLICT' };

  const managerReviewRequired = !redemption.isActive
    || (redemption.expiresAt && new Date(redemption.expiresAt) <= new Date());
  const notes = managerReviewRequired
    ? `${reason}; CARD_DISABLED_OR_EXPIRED; MANAGER_REVIEW_REQUIRED`
    : reason;
  await tx.$executeRawUnsafe(
    'INSERT INTO pos_stored_value_ledger (id, company_id, account_id, pos_payment_id, idempotency_key, operation_type, invoice_id, kind, entry_type, amount, balance_after, reference, notes, created_by_id, created_at) VALUES ($1, $2, $3, $4, $5, \'REFUND\'::"PosStoredValueOperation", $6, \'gift_card\', \'refund\', $7, $8, $9, $10, $11, CURRENT_TIMESTAMP)',
    generateObjectId(),
    companyId,
    String(redemption.accountId),
    paymentId,
    refundKey,
    saleId,
    refundAmount,
    Number(updatedRows[0].balance),
    String(redemption.codeSuffix || redemption.reference || ''),
    notes,
    userId,
  );

  return {
    replayed: false,
    balanceAfter: Number(updatedRows[0].balance),
    managerReviewRequired: Boolean(managerReviewRequired),
    codeSuffix: String(redemption.codeSuffix || redemption.reference || ''),
  };
}

module.exports = { restoreGiftCardBalance };
