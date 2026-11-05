'use strict';

const { randomBytes, createHash } = require('crypto');
const { dbClient } = require('../lib/prisma');
const { runInTransaction } = require('../services/transactionService');
const JournalService = require('../services/journalService');
const posPaymentService = require('../services/posPaymentService');
const { DEFAULT_ACCOUNTS } = require('../constants/chartOfAccounts');
const { generateObjectId } = require('../utils/objectId');
const { requestIp, writePosAuditLog } = require('../services/posAuditService');
const { normalizePosGiftCardSettings, resolvePosGiftCardLimits } = require('../services/posGiftCardSettingsService');
const QRCode = require('qrcode');
const smsService = require('../services/smsService');
const { sendEmail } = require('../services/emailService');
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

function invalidWithDetails(res, status, code, message, details) {
  return res.status(status).json({ success: false, code, message, ...details });
}

function requestKey(req) {
  return String(req.get?.('Idempotency-Key') || req.headers?.['idempotency-key'] || '').trim();
}

function approvalTokenFrom(req) {
  return String(req.get?.('X-Pos-Approval-Token')
    || req.headers?.['x-pos-approval-token']
    || req.body?.approvalToken
    || '').trim();
}

function kigaliBusinessDayRange(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Kigali',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const start = new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day)) - (2 * 60 * 60 * 1000));
  return { start, end: new Date(start.getTime() + (24 * 60 * 60 * 1000)) };
}

function validAmount(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_AMOUNT;
}

function validReason(value) {
  const reason = typeof value === 'string' ? value.trim() : '';
  return reason && reason.length <= 500 ? reason : null;
}

function validGiftCardDestination(channel, destination) {
  const value = typeof destination === 'string' ? destination.trim() : '';
  if (!value || value.length > 254) return false;
  return channel === 'SMS'
    ? Boolean(smsService.normalizePhoneNumber(value))
    : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function insertUniqueGiftCard(tx, {
  companyId, clientId, code, balance, currencyCode, expiresAt, userId, replacementKey, replacesAccountId,
}) {
  let newCode = code;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (!newCode) newCode = generateStoredValueCode();
    const accountId = generateObjectId();
    const rows = replacementKey
      ? await tx.$queryRawUnsafe(
        `INSERT INTO pos_stored_value_accounts
          (id, company_id, client_id, kind, code_hash, code_suffix, currency_code, balance, is_active, expires_at, created_by_id,
           replacement_key, replaces_account_id, created_at, updated_at)
         VALUES ($1, $2, $3, 'gift_card', $4, $5, $6, $7, TRUE, $8, $9, $10, $11, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT (company_id, code_hash) DO NOTHING
         RETURNING id, balance::text AS balance, currency_code AS "currencyCode"`,
        accountId, companyId, clientId, hashStoredValueCode(newCode), newCode.slice(-4),
        currencyCode, balance, expiresAt, userId, replacementKey, replacesAccountId,
      )
      : await tx.$queryRawUnsafe(
        `INSERT INTO pos_stored_value_accounts
          (id, company_id, client_id, kind, code_hash, code_suffix, currency_code, balance, is_active, expires_at, created_by_id, created_at, updated_at)
         VALUES ($1, $2, $3, 'gift_card', $4, $5, $6, $7, TRUE, $8, $9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT (company_id, code_hash) DO NOTHING
         RETURNING id, balance::text AS balance, currency_code AS "currencyCode"`,
        accountId, companyId, clientId, hashStoredValueCode(newCode), newCode.slice(-4),
        currencyCode, balance, expiresAt, userId,
      );
    if (rows.length) return { code: newCode, row: rows[0] };
    newCode = null;
  }
  throw new Error('Could not generate a unique gift-card code.');
}

async function shopNameFor(companyId, req) {
  const contextName = req.posAuthContext?.company?.name;
  if (typeof contextName === 'string' && contextName.trim()) return contextName.trim();
  const company = await dbClient().company?.findUnique({
    where: { id: companyId },
    select: { name: true },
  });
  return String(company?.name || 'KUBIKA');
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

async function lockCashierShift(tx, companyId, registerId, userId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT shift.id
       FROM pos_shifts shift
       JOIN pos_registers register
         ON register.id = shift.register_id AND register.company_id = shift.company_id
       JOIN till_sessions till
         ON till.company_id = shift.company_id
        AND till.register_id = register.code
        AND till.opened_by = shift.opened_by
        AND till.opened_at = shift.opened_at
        AND till.status = 'open'
      WHERE shift.company_id = $1 AND shift.register_id = $2
        AND shift.opened_by = $3 AND shift.status IN ('open', 'reopened')
      FOR UPDATE OF shift, till`,
    companyId,
    registerId,
    userId,
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
        balance: Number(card.balance),
        currencyCode: card.currencyCode,
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
  const clientId = req.body?.clientId == null ? null : String(req.body.clientId).trim();
  const approvalToken = approvalTokenFrom(req);
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    return invalid(res, 400, 'POS_IDEMPOTENCY_KEY_INVALID', 'Provide a valid Idempotency-Key before issuing or loading a gift card.');
  }
  if (!['ISSUE', 'LOAD'].includes(operation)
    || !validAmount(amount)
    || !reason
    || (operation === 'ISSUE' && req.body?.paymentCaptured !== true)
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
    const savedSettings = await dbClient().systemSettings.findUnique({
      where: { companyId },
      select: { posGiftCardSettings: true, posCashOutApprovalLimit: true },
    });
    const giftCardSettings = normalizePosGiftCardSettings(savedSettings?.posGiftCardSettings);
    const limits = resolvePosGiftCardLimits(giftCardSettings, register?.systemTillType);
    const approvalThreshold = Number(savedSettings?.posCashOutApprovalLimit ?? 50000);
    if (operation === 'ISSUE' && amount > limits.maxPerCard) {
      return invalid(res, 409, 'POS_GIFT_CARD_MAX_VALUE_EXCEEDED',
        `The maximum gift-card value at this till is RWF ${limits.maxPerCard.toLocaleString('en-US')}. Larger cards must be issued from Back Office.`);
    }
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

      const shift = operation === 'ISSUE'
        ? await lockCashierShift(tx, companyId, String(register.id), actorId)
        : await lockOpenShift(tx, companyId, String(register.id));
      if (!shift) return { error: 'POS_SHIFT_NOT_OPEN' };

      let approvedById = null;
      if (operation === 'ISSUE') {
        const { start, end } = kigaliBusinessDayRange();
        await tx.$queryRawUnsafe(
          'SELECT pg_advisory_xact_lock(hashtext($1))::text AS locked',
          `${companyId}:gift-card-daily:${actorId}:${start.toISOString()}`,
        );
        const dailyRows = await tx.$queryRawUnsafe(
          `SELECT COALESCE(SUM(amount), 0)::text AS total
             FROM pos_stored_value_ledger
            WHERE company_id = $1 AND created_by_id = $2
              AND kind = 'gift_card' AND entry_type = 'issue'
              AND created_at >= $3 AND created_at < $4`,
          companyId,
          actorId,
          start,
          end,
        );
        const dailyTotal = Number(dailyRows[0]?.total || 0);
        const approvalRequired = amount > approvalThreshold
          || dailyTotal + amount > limits.dailyLimitPerCashier;
        const approvalContext = {
          shiftId: String(shift.id),
          amount,
          reasonCode: 'GIFT_CARD_SALE',
          dailyTotal,
          dailyLimit: limits.dailyLimitPerCashier,
        };
        if (approvalRequired && !approvalToken) {
          return { error: 'POS_APPROVAL_REQUIRED', approvalContext };
        }
        if (approvalRequired) {
          const approval = await tx.posApproval.findFirst({
            where: {
              companyId,
              registerId: String(register.id),
              requestedBy: actorId,
              action: 'GIFT_CARD_ISSUE',
              tokenHash: createHash('sha256').update(approvalToken, 'utf8').digest('hex'),
              usedAt: null,
              expiresAt: { gt: new Date() },
              context: { equals: approvalContext },
            },
          });
          if (!approval) return { error: 'POS_APPROVAL_INVALID' };
          const now = new Date();
          const consumed = await tx.posApproval.updateMany({
            where: {
              id: approval.id,
              companyId,
              registerId: String(register.id),
              requestedBy: actorId,
              action: 'GIFT_CARD_ISSUE',
              usedAt: null,
              expiresAt: { gt: now },
            },
            data: { usedAt: now },
          });
          if (consumed.count !== 1) return { error: 'POS_APPROVAL_INVALID' };
          approvedById = approval.approvedBy;
          await writePosAuditLog({
            companyId,
            registerId: String(register.id),
            userId: actorId,
            event: 'APPROVAL_USED',
            metadata: { approvalId: approval.id, action: 'GIFT_CARD_ISSUE', approvedBy: approvedById, shiftId: String(shift.id) },
            ip: requestIp(req),
          }, tx);
        }
        if (clientId) {
          const customers = await tx.$queryRawUnsafe(
            'SELECT id FROM clients WHERE id = $1 AND company_id = $2 LIMIT 1',
            clientId,
            companyId,
          );
          if (!customers.length) return { error: 'POS_GIFT_CARD_CUSTOMER_NOT_FOUND' };
        }
      }

      let accountId;
      let suffix;
      let balanceAfter;
      let currencyCode = 'RWF';
      if (operation === 'ISSUE') {
        const inserted = await insertUniqueGiftCard(tx, {
          companyId, clientId, balance: amount, currencyCode, expiresAt, userId: actorId,
        });
        newCode = inserted.code;
        const accountRows = [inserted.row];
        if (!accountRows.length) throw new Error('The gift card account could not be created.');
        accountId = String(accountRows[0].id);
        suffix = newCode.slice(-4);
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
        metadata: {
          accountId,
          codeSuffix: suffix,
          amount,
          currencyCode,
          journalEntryId,
          cashierId: actorId,
          registerId: String(register.id),
          shiftId: String(shift.id),
          customerId: operation === 'ISSUE' ? clientId : null,
          approvedById: operation === 'ISSUE' ? approvedById : null,
          paymentMethod: 'cash',
          idempotencyKey: key,
        },
        ip: requestIp(req),
      }, tx);
      return {
        kind: 'gift_card', amount, balance: balanceAfter, currencyCode, codeSuffix: suffix,
        expiresAt: operation === 'ISSUE' ? expiresAt : null,
        terms: operation === 'ISSUE' ? giftCardSettings.terms : '',
        replayed: false,
      };
    });

    if (result.error === 'POS_IDEMPOTENCY_KEY_CONFLICT') {
      return invalid(res, 409, result.error, 'This Idempotency-Key was already used for a different gift card action.');
    }
    if (result.error === 'POS_SHIFT_NOT_OPEN') {
      return invalid(res, 409, result.error, 'Open a shift to issue gift cards. Use your own open till on this register.');
    }
    if (result.error === 'POS_APPROVAL_REQUIRED') {
      return invalidWithDetails(res, 403, result.error, 'Manager approval is required for this gift-card issue.', {
        approvalContext: result.approvalContext,
      });
    }
    if (result.error === 'POS_APPROVAL_INVALID') {
      return invalid(res, 403, result.error, 'The manager approval is invalid, expired, already used, or does not match this gift-card issue.');
    }
    if (result.error === 'POS_GIFT_CARD_CUSTOMER_NOT_FOUND') {
      return invalid(res, 404, result.error, 'The selected customer does not belong to this company.');
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
    const shopName = await shopNameFor(companyId, req);
    const qrDataUrl = operation === 'ISSUE' && !result.replayed ? await QRCode.toDataURL(newCode) : null;
    return res.status(result.replayed ? 200 : 201).json({
      success: true,
      replayed: result.replayed,
      message: result.replayed
        ? 'This gift card action was already completed. The card code is only shown when first issued.'
        : operation === 'ISSUE' ? 'Gift card issued.' : 'Gift card loaded.',
      data: {
        ...result,
        ...(operation === 'ISSUE' && !result.replayed
          ? { code: newCode, qrDataUrl, shopName }
          : { code: null, qrDataUrl: null }),
      },
    });
  } catch (error) {
    if (error?.code === 'POS_PAYMENT_METHOD_DISABLED') {
      return invalid(res, 409, error.code,
        'Cash is turned off for this register. Ask a manager to enable it, or take another enabled payment method.');
    }
    return next(error);
  }
};

exports.issueCashier = (req, res, next) => {
  req.body = { ...(req.body || {}), operation: 'ISSUE' };
  return exports.issueOrLoad(req, res, next);
};

exports.deliver = async (req, res, next) => {
  const { companyId, register, user } = authContext(req);
  const channel = String(req.body?.channel || '').trim().toUpperCase();
  const code = String(req.body?.code || '').replace(/\s+/g, '').toUpperCase();
  const destination = String(req.body?.destination || '').trim();
  if (!['SMS', 'EMAIL'].includes(channel)
    || code.length < 8 || code.length > 80
    || !validGiftCardDestination(channel, destination)) {
    return invalid(res, 400, 'POS_GIFT_CARD_DELIVERY_INVALID', 'Enter a valid gift-card code and recipient for SMS or email delivery.');
  }
  try {
    const cards = await dbClient().$queryRawUnsafe(
      'SELECT id, balance::text AS balance, currency_code AS "currencyCode", code_suffix AS "codeSuffix", expires_at AS "expiresAt" FROM pos_stored_value_accounts WHERE company_id = $1 AND code_hash = $2 AND kind = \'gift_card\' AND is_active = TRUE LIMIT 1',
      companyId,
      hashStoredValueCode(code),
    );
    const card = cards[0];
    if (!card || (card.expiresAt && new Date(card.expiresAt) <= new Date())) {
      return invalid(res, 404, 'POS_GIFT_CARD_UNAVAILABLE', 'This gift card could not be found or has expired.');
    }

    const shopName = await shopNameFor(companyId, req);
    const expiry = card.expiresAt ? ` It expires on ${new Date(card.expiresAt).toLocaleDateString()}.` : '';
    const message = `Your ${shopName} gift card has a balance of ${card.currencyCode} ${Number(card.balance).toLocaleString('en-US')}. Code: ${code}.${expiry}`;
    const sent = channel === 'SMS'
      ? (await smsService.sendSMS(destination, message))?.success === true
      : await sendEmail(
        destination,
        `${shopName} gift card`,
        `<p>${shopName} gift card balance: ${card.currencyCode} ${Number(card.balance).toLocaleString('en-US')}</p><p>Code: <strong>${code}</strong></p>${expiry ? `<p>${expiry.trim()}</p>` : ''}`,
        { text: message },
      );
    if (!sent) {
      return invalid(res, 502, 'POS_GIFT_CARD_DELIVERY_FAILED', `The ${channel === 'SMS' ? 'SMS' : 'email'} service did not accept the gift-card message.`);
    }
    await writePosAuditLog({
      companyId,
      registerId: String(register?.id || ''),
      userId: String(user?.id || ''),
      event: 'GIFT_CARD_DELIVERED',
      metadata: {
        accountId: String(card.id),
        codeSuffix: card.codeSuffix,
        channel,
        currencyCode: card.currencyCode,
      },
      ip: requestIp(req),
    });
    return res.json({ success: true, data: { channel } });
  } catch (error) {
    return next(error);
  }
};

exports.reissue = async (req, res, next) => {
  const { companyId, register, user } = authContext(req);
  const actorId = String(user?.id || '');
  const oldCode = String(req.body?.code || '').replace(/\s+/g, '').toUpperCase();
  const reason = validReason(req.body?.reason);
  const key = requestKey(req);
  const approvalToken = approvalTokenFrom(req);
  if (!IDEMPOTENCY_KEY_PATTERN.test(key) || oldCode.length < 8 || oldCode.length > 80 || !reason) {
    return invalid(res, 400, 'POS_GIFT_CARD_REISSUE_INVALID', 'Provide a valid gift-card code, a reason, and an Idempotency-Key to request a replacement.');
  }
  try {
    const result = await runInTransaction(async (tx) => {
      await tx.$queryRawUnsafe(
        'SELECT pg_advisory_xact_lock(hashtext($1))::text AS locked',
        `${companyId}:gift-card-reissue:${key}`,
      );
      const oldCards = await tx.$queryRawUnsafe(
        'SELECT id, client_id AS "clientId", balance::text AS balance, currency_code AS "currencyCode", code_suffix AS "codeSuffix", expires_at AS "expiresAt", is_active AS "isActive", replaced_by_account_id AS "replacedByAccountId" FROM pos_stored_value_accounts WHERE company_id = $1 AND code_hash = $2 AND kind = \'gift_card\' FOR UPDATE',
        companyId,
        hashStoredValueCode(oldCode),
      );
      const oldCard = oldCards[0];
      if (!oldCard) return { error: 'POS_GIFT_CARD_UNAVAILABLE' };
      if (!oldCard.isActive && oldCard.replacedByAccountId) {
        const replacements = await tx.$queryRawUnsafe(
          'SELECT id, code_suffix AS "codeSuffix", balance::text AS balance, currency_code AS "currencyCode", expires_at AS "expiresAt" FROM pos_stored_value_accounts WHERE company_id = $1 AND id = $2 AND replaces_account_id = $3 AND replacement_key = $4 LIMIT 1',
          companyId,
          oldCard.replacedByAccountId,
          oldCard.id,
          key,
        );
        if (replacements.length) return { replayed: true };
      }
      if (!oldCard.isActive || (oldCard.expiresAt && new Date(oldCard.expiresAt) <= new Date())) {
        return { error: 'POS_GIFT_CARD_UNAVAILABLE' };
      }

      const shift = await lockCashierShift(tx, companyId, String(register?.id || ''), actorId);
      if (!shift) return { error: 'POS_SHIFT_NOT_OPEN' };
      const approvalContext = {
        accountId: String(oldCard.id),
        shiftId: String(shift.id),
        balance: Number(oldCard.balance),
        reason,
      };
      if (!approvalToken) return { error: 'POS_APPROVAL_REQUIRED', approvalContext };
      const approval = await tx.posApproval.findFirst({
        where: {
          companyId,
          registerId: String(register.id),
          requestedBy: actorId,
          action: 'GIFT_CARD_REISSUE',
          tokenHash: createHash('sha256').update(approvalToken, 'utf8').digest('hex'),
          usedAt: null,
          expiresAt: { gt: new Date() },
          context: { equals: approvalContext },
        },
      });
      if (!approval) return { error: 'POS_APPROVAL_INVALID' };
      const now = new Date();
      const consumed = await tx.posApproval.updateMany({
        where: {
          id: approval.id,
          companyId,
          registerId: String(register.id),
          requestedBy: actorId,
          action: 'GIFT_CARD_REISSUE',
          usedAt: null,
          expiresAt: { gt: now },
        },
        data: { usedAt: now },
      });
      if (consumed.count !== 1) return { error: 'POS_APPROVAL_INVALID' };

      const inserted = await insertUniqueGiftCard(tx, {
        companyId,
        clientId: oldCard.clientId,
        balance: Number(oldCard.balance),
        currencyCode: String(oldCard.currencyCode),
        expiresAt: oldCard.expiresAt,
        userId: actorId,
        replacementKey: key,
        replacesAccountId: String(oldCard.id),
      });
      await tx.$executeRawUnsafe(
        'UPDATE pos_stored_value_accounts SET is_active = FALSE, replaced_by_account_id = $1, replaced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE company_id = $2 AND id = $3 AND is_active = TRUE',
        String(inserted.row.id),
        companyId,
        String(oldCard.id),
      );
      await writePosAuditLog({
        companyId,
        registerId: String(register.id),
        userId: actorId,
        event: 'GIFT_CARD_REPLACED',
        metadata: {
          oldAccountId: String(oldCard.id),
          oldCodeSuffix: oldCard.codeSuffix,
          newAccountId: String(inserted.row.id),
          newCodeSuffix: inserted.code.slice(-4),
          balance: Number(oldCard.balance),
          currencyCode: oldCard.currencyCode,
          reason,
          approvedById: approval.approvedBy,
          shiftId: String(shift.id),
          idempotencyKey: key,
        },
        ip: requestIp(req),
      }, tx);
      await writePosAuditLog({
        companyId,
        registerId: String(register.id),
        userId: actorId,
        event: 'APPROVAL_USED',
        metadata: { approvalId: approval.id, action: 'GIFT_CARD_REISSUE', approvedBy: approval.approvedBy },
        ip: requestIp(req),
      }, tx);
      return {
        code: inserted.code,
        codeSuffix: inserted.code.slice(-4),
        balance: Number(inserted.row.balance),
        currencyCode: inserted.row.currencyCode,
        expiresAt: oldCard.expiresAt || null,
        replayed: false,
      };
    });
    if (result.error === 'POS_GIFT_CARD_UNAVAILABLE') {
      return invalid(res, 404, result.error, 'This gift card could not be found, is expired, or has already been replaced.');
    }
    if (result.error === 'POS_SHIFT_NOT_OPEN') {
      return invalid(res, 409, result.error, 'Open your assigned shift before replacing a gift card.');
    }
    if (result.error === 'POS_APPROVAL_REQUIRED') {
      return invalidWithDetails(res, 403, result.error, 'Manager approval is required to replace a lost gift card.', {
        approvalContext: result.approvalContext,
      });
    }
    if (result.error === 'POS_APPROVAL_INVALID') {
      return invalid(res, 403, result.error, 'The manager approval is invalid, expired, already used, or does not match this replacement.');
    }
    const savedSettings = await dbClient().systemSettings.findUnique({
      where: { companyId },
      select: { posGiftCardSettings: true },
    });
    const giftCardTerms = normalizePosGiftCardSettings(savedSettings?.posGiftCardSettings).terms;
    const shopName = await shopNameFor(companyId, req);
    const qrDataUrl = result.replayed ? null : await QRCode.toDataURL(result.code);
    return res.status(result.replayed ? 200 : 201).json({
      success: true,
      replayed: result.replayed,
      data: {
        ...result,
        ...(result.replayed
          ? { code: null, qrDataUrl: null, shopName, terms: giftCardTerms }
          : { qrDataUrl, shopName, terms: giftCardTerms }),
      },
    });
  } catch (error) {
    return next(error);
  }
};
