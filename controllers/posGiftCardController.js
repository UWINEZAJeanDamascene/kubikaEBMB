'use strict';

const { randomBytes } = require('crypto');
const { dbClient } = require('../lib/prisma');
const { runInTransaction } = require('../services/transactionService');
const JournalService = require('../services/journalService');
const posPaymentService = require('../services/posPaymentService');
const { DEFAULT_ACCOUNTS } = require('../constants/chartOfAccounts');
const { generateObjectId } = require('../utils/objectId');
const { requestIp, writePosAuditLog } = require('../services/posAuditService');
const {
  hashStoredValueCode,
  generateStoredValueCode,
} = require('../services/posStoredValueCodeService');

const IDEMPOTENCY_KEY_PATTERN = /^[a-zA-Z0-9_-]{8,100}$/;
const MAX_AMOUNT = Number.MAX_SAFE_INTEGER;

function authContext(req) {
  const auth = req.posAuthContext;
  return {
    companyId: String(auth?.company?.id || ''),
    register: auth?.register,
    user: auth?.user,
  };
}

function invalid(res, status, code, message) {
  return res.status(status).json({ success: false, code, message });
}

function requestKey(req) {
  return String(req.get?.('Idempotency-Key') || req.headers?.['idempotency-key'] || '').trim();
}

function validAmount(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_AMOUNT;
}

function validReason(value) {
  const reason = typeof value === 'string' ? value.trim() : '';
  return reason && reason.length <= 500 ? reason : null;
}

function mapPriorLedger(row, operation, amount, codeHash, reason) {
  if (!row) return { found: false };
  const same = row.operationType === operation
    && row.kind === 'gift_card'
    && Number(row.amount) === amount
    && String(row.notes || '') === reason
    && (operation !== 'LOAD' || row.codeHash === codeHash);
  if (!same) return { found: true, conflict: true };
  return {
    found: true,
    replay: {
      kind: 'gift_card',
      amount,
      balance: Number(row.balanceAfter),
      codeSuffix: row.codeSuffix || null,
    },
  };
}

async function findPriorLedger(tx, companyId, key) {
  const rows = await tx.$queryRawUnsafe(
    'SELECT l.id, l.account_id AS "accountId", l.kind, l.operation_type::text AS "operationType", l.amount::text AS amount, l.balance_after::text AS "balanceAfter", l.notes, a.code_hash AS "codeHash", a.code_suffix AS "codeSuffix" FROM pos_stored_value_ledger l LEFT JOIN pos_stored_value_accounts a ON a.id = l.account_id AND a.company_id = l.company_id WHERE l.company_id = $1 AND l.idempotency_key = $2 LIMIT 1',
    companyId,
    key,
  );
  return rows[0] || null;
}

async function lockOpenShift(tx, companyId, registerId) {
  const rows = await tx.$queryRawUnsafe(
    'SELECT id FROM pos_shifts WHERE company_id = $1 AND register_id = $2 AND status IN (\'open\', \'reopened\') FOR UPDATE',
    companyId,
    registerId,
  );
  return rows[0] || null;
}

async function insertLedger(tx, {
  companyId,
  accountId,
  key,
  operation,
  entryType,
  amount,
  balanceAfter,
  suffix,
  reason,
  userId,
}) {
  await tx.$executeRawUnsafe(
    'INSERT INTO pos_stored_value_ledger (id, company_id, account_id, idempotency_key, operation_type, kind, entry_type, amount, balance_after, reference, notes, created_by_id, created_at) VALUES ($1, $2, $3, $4, $5::"PosStoredValueOperation", \'gift_card\', $6, $7, $8, $9, $10, $11, CURRENT_TIMESTAMP)',
    generateObjectId(),
    companyId,
    accountId,
    key,
    operation,
    entryType,
    amount,
    balanceAfter,
    suffix,
    reason,
    userId,
  );
}

exports.balance = async (req, res, next) => {
  const { companyId } = authContext(req);
  const code = String(req.params.code || '').replace(/\s+/g, '').toUpperCase();
  if (code.length < 8 || code.length > 80) {
    return invalid(res, 400, 'POS_GIFT_CARD_CODE_INVALID', 'Enter a valid gift card code.');
  }
  try {
    const rows = await dbClient().$queryRawUnsafe(
      'SELECT balance::text AS balance, currency_code AS "currencyCode", code_suffix AS "codeSuffix", expires_at AS "expiresAt" FROM pos_stored_value_accounts WHERE company_id = $1 AND code_hash = $2 AND kind = \'gift_card\' AND is_active = TRUE LIMIT 1',
      companyId,
      hashStoredValueCode(code),
    );
    const card = rows[0];
    if (!card || (card.expiresAt && new Date(card.expiresAt) <= new Date())) {
      return invalid(res, 404, 'POS_GIFT_CARD_UNAVAILABLE', 'This gift card could not be found or has expired. Check the code or ask a manager for help.');
    }
    return res.json({
      success: true,
      data: {
        kind: 'gift_card',
        balance: Number(card.balance),
        currencyCode: card.currencyCode,
        codeSuffix: card.codeSuffix,
        expiresAt: card.expiresAt || null,
      },
    });
  } catch (error) {
    return next(error);
  }
};

exports.issueOrLoad = async (req, res, next) => {
  const { companyId, register, user } = authContext(req);
  const operation = String(req.body?.operation || '').trim().toUpperCase();
  const amount = req.body?.amount;
  const reason = validReason(req.body?.reason);
  const key = requestKey(req);
  const suppliedCode = String(req.body?.code || '').replace(/\s+/g, '').toUpperCase();
  const expiresAt = req.body?.expiresAt ? new Date(req.body.expiresAt) : null;
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    return invalid(res, 400, 'POS_IDEMPOTENCY_KEY_INVALID', 'Provide a valid Idempotency-Key before issuing or loading a gift card.');
  }
  if (!['ISSUE', 'LOAD'].includes(operation)
    || !validAmount(amount)
    || !reason
    || (operation === 'LOAD' && (suppliedCode.length < 8 || suppliedCode.length > 80))
    || (operation === 'ISSUE' && suppliedCode)
    || (operation === 'LOAD' && expiresAt)
    || (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date()))) {
    return invalid(res, 400, 'POS_GIFT_CARD_REQUEST_INVALID', 'Choose issue or load, enter a positive whole-RWF amount, and provide a reason. Loading also requires the gift card code.');
  }

  const codeHash = operation === 'LOAD' ? hashStoredValueCode(suppliedCode) : null;
  const actorId = String(user?.id || '');
  let newCode = null;
  try {
    await posPaymentService.assertPaymentMethodEnabled({
      companyId,
      registerId: String(register?.id || ''),
      method: 'CASH',
    });
    const cashAccount = await JournalService.getMappedAccountCode(
      companyId,
      'cash',
      'cashOnHand',
      DEFAULT_ACCOUNTS.cashOnHand || '1000',
    );
    const liabilityAccount = await JournalService.getMappedAccountCode(
      companyId,
      'sales',
      'giftCardLiability',
      DEFAULT_ACCOUNTS.deferredRevenue || '2850',
    );

    const result = await runInTransaction(async (tx) => {
      await tx.$queryRawUnsafe(
        'SELECT pg_advisory_xact_lock(hashtext($1))::text AS locked',
        `${companyId}:${key}`,
      );
      const prior = await findPriorLedger(tx, companyId, key);
      if (prior) {
        const replay = mapPriorLedger(prior, operation, amount, codeHash, reason);
        if (replay.conflict) return { error: 'POS_IDEMPOTENCY_KEY_CONFLICT' };
        if (replay.replay) return { ...replay.replay, replayed: true };
      }

      const shift = await lockOpenShift(tx, companyId, String(register.id));
      if (!shift) return { error: 'POS_SHIFT_NOT_OPEN' };

      let accountId;
      let suffix;
      let balanceAfter;
      let currencyCode = 'RWF';
      if (operation === 'ISSUE') {
        newCode = generateStoredValueCode();
        accountId = generateObjectId();
        suffix = newCode.slice(-4);
        const accountRows = await tx.$queryRawUnsafe(
          'INSERT INTO pos_stored_value_accounts (id, company_id, kind, code_hash, code_suffix, currency_code, balance, is_active, expires_at, created_by_id, created_at, updated_at) VALUES ($1, $2, \'gift_card\', $3, $4, $5, $6, TRUE, $7, $8, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id, balance::text AS balance, currency_code AS "currencyCode"',
          accountId,
          companyId,
          hashStoredValueCode(newCode),
          suffix,
          currencyCode,
          amount,
          expiresAt,
          actorId,
        );
        if (!accountRows.length) throw new Error('The gift card account could not be created.');
        balanceAfter = Number(accountRows[0].balance);
        currencyCode = accountRows[0].currencyCode;
        await insertLedger(tx, {
          companyId, accountId, key, operation, entryType: 'issue', amount,
          balanceAfter, suffix, reason, userId: actorId,
        });
      } else {
        const accountRows = await tx.$queryRawUnsafe(
          'SELECT id, balance::text AS balance, currency_code AS "currencyCode", code_suffix AS "codeSuffix", expires_at AS "expiresAt" FROM pos_stored_value_accounts WHERE company_id = $1 AND code_hash = $2 AND kind = \'gift_card\' AND is_active = TRUE FOR UPDATE',
          companyId,
          codeHash,
        );
        const account = accountRows[0];
        if (!account || (account.expiresAt && new Date(account.expiresAt) <= new Date())) {
          return { error: 'POS_GIFT_CARD_UNAVAILABLE' };
        }
        accountId = String(account.id);
        suffix = String(account.codeSuffix || '');
        currencyCode = String(account.currencyCode || '');
        if (currencyCode !== 'RWF') return { error: 'POS_GIFT_CARD_CURRENCY_UNAVAILABLE' };
        const newBalance = Number(account.balance) + amount;
        if (!Number.isSafeInteger(newBalance)) return { error: 'POS_GIFT_CARD_BALANCE_INVALID' };
        const updated = await tx.$queryRawUnsafe(
          'UPDATE pos_stored_value_accounts SET balance = balance + $1::numeric, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND company_id = $3 AND is_active = TRUE RETURNING balance::text AS balance',
          amount,
          accountId,
          companyId,
        );
        if (!updated.length) return { error: 'POS_GIFT_CARD_UNAVAILABLE' };
        balanceAfter = Number(updated[0].balance);
        await insertLedger(tx, {
          companyId, accountId, key, operation, entryType: 'issue', amount,
          balanceAfter, suffix, reason, userId: actorId,
        });
      }

      const entryId = generateObjectId();
      const journalEntries = await JournalService.createEntriesAtomic(companyId, actorId, [{
        date: new Date(),
        description: operation === 'ISSUE' ? 'Gift card issued' : 'Gift card loaded',
        sourceType: operation === 'ISSUE' ? 'pos_stored_value_issue' : 'pos_stored_value_load',
        sourceId: operation === 'ISSUE' ? accountId : entryId,
        sourceReference: `Gift card ••••${suffix}`,
        lines: [
          JournalService.createDebitLine(cashAccount, amount, `Cash received for gift card ••••${suffix}`),
          JournalService.createCreditLine(liabilityAccount, amount, `Gift card liability ••••${suffix}`),
        ],
        isAutoGenerated: true,
        notes: reason,
      }], { session: tx });
      const journalEntryId = journalEntries?.[0]?._id;
      if (!journalEntryId) throw new Error('The gift card accounting entry was not confirmed.');
      await tx.posCashMovement.create({
        data: {
          id: generateObjectId(),
          companyId,
          shiftId: String(shift.id),
          registerId: String(register.id),
          type: 'cash_in',
          amount,
          reasonCode: operation === 'ISSUE' ? 'GIFT_CARD_SALE' : 'GIFT_CARD_LOAD',
          note: `Gift card ••••${suffix}: ${reason}`,
          performedById: actorId,
          journalEntryId: String(journalEntryId),
          idempotencyKey: key,
        },
      });
      await writePosAuditLog({
        companyId,
        registerId: String(register.id),
        userId: actorId,
        event: operation === 'ISSUE' ? 'GIFT_CARD_ISSUED' : 'GIFT_CARD_LOADED',
        metadata: { accountId, codeSuffix: suffix, amount, currencyCode, journalEntryId },
        ip: requestIp(req),
      }, tx);
      return { kind: 'gift_card', amount, balance: balanceAfter, currencyCode, codeSuffix: suffix, replayed: false };
    });

    if (result.error === 'POS_IDEMPOTENCY_KEY_CONFLICT') {
      return invalid(res, 409, result.error, 'This Idempotency-Key was already used for a different gift card action.');
    }
    if (result.error === 'POS_SHIFT_NOT_OPEN') {
      return invalid(res, 409, result.error, 'Open a shift on this register before taking cash for a gift card.');
    }
    if (result.error === 'POS_GIFT_CARD_UNAVAILABLE') {
      return invalid(res, 404, result.error, 'This gift card could not be found, is disabled, or has expired.');
    }
    if (result.error === 'POS_GIFT_CARD_CURRENCY_UNAVAILABLE') {
      return invalid(res, 409, result.error, 'This gift card is not in RWF and cannot be loaded at this register.');
    }
    if (result.error === 'POS_GIFT_CARD_BALANCE_INVALID') {
      return invalid(res, 409, result.error, 'The gift card balance is outside the supported RWF amount range.');
    }
    return res.status(result.replayed ? 200 : 201).json({
      success: true,
      replayed: result.replayed,
      message: result.replayed
        ? 'This gift card action was already completed. The card code is only shown when first issued.'
        : operation === 'ISSUE' ? 'Gift card issued.' : 'Gift card loaded.',
      data: {
        ...result,
        ...(operation === 'ISSUE' && !result.replayed ? { code: newCode } : { code: null }),
      },
    });
  } catch (error) {
    if (error?.code === 'POS_PAYMENT_METHOD_DISABLED') {
      return invalid(res, 409, error.code, error.message);
    }
    return next(error);
  }
};
