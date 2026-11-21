const { AsyncLocalStorage } = require('async_hooks');
const { createHash } = require('crypto');
const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
const { GENESIS_HASH, hashAuditRow, streamIdFor } = require('./posAuditIntegrityService');
const { redisClient, isRedisConfigured } = require('../config/redis');

const POS_AUDIT_EVENTS = new Set([
  // Route-level outcomes cover rejected/failed attempts that do not reach a
  // domain transaction. Successful mutations retain their domain event.
  'POS_ACTION_DENIED',
  'POS_ACTION_FAILED',
  'POS_IDEMPOTENCY_RESOLVED',
  'POS_DUPLICATE_REQUEST_ATTEMPT',
  'POS_SECURITY_SETTINGS_UPDATED',
  'POS_SCANNER_SETTINGS_UPDATED',
  'POS_SCANNER_OPEN_PRICE_PRODUCT_UPDATED',
  'POS_AUDIT_INTEGRITY_VERIFIED',
  'POS_AUDIT_READ',
  'POS_AUDIT_EXPORTED',
  'PIN_LOGIN_SUCCESS',
  'PIN_LOGIN_FAILED',
  'PIN_LOCKOUT',
  'SESSION_LOCKED',
  'SESSION_UNLOCKED',
  'SESSION_TOKEN_REFRESHED',
  'CASHIER_SWITCHED',
  'SESSION_ENDED',
  'POS_SESSION_COMPANY_MISMATCH',
  'APPROVAL_GRANTED',
  'APPROVAL_DENIED',
  'APPROVAL_USED',
  'APPROVAL_REQUESTED',
  'PIN_CHANGED',
  'PIN_RESET',
  'REGISTER_ACTIVATED',
  'REGISTER_DELETED',
  'REGISTER_DEVICE_PAIRED',
  'REGISTER_DEVICE_REVOKED',
  'REGISTER_DEVICE_CREDENTIAL_RECOVERED',
  'REGISTER_DEVICE_WIPE_REQUESTED',
  'REGISTER_PAIRING_CODE_ISSUED',
  'REGISTER_BRANCH_UPDATED',
  'REGISTER_TRAINING_MODE_UPDATED',
  'REGISTER_ACCESS_UPDATED',
  'REGISTER_DISCOUNT_SETTINGS_UPDATED',
  'SHIFT_OPENED',
  'SHIFT_REOPENED',
  'SHIFT_RECLOSED',
  'SHIFT_HANDED_OVER',
  'SHIFT_HISTORY_VIEWED',
  'SHIFT_DELETED',
  'CASH_MOVEMENT_RECORDED',
  'BANK_SLIP_REFERENCE_RECORDED',
  'SHIFT_CLOSED',
  'POS_ACCOUNTING_POSTING_RETRY_REQUESTED',
  'PAYMENT_SETTINGS_UPDATED',
  'TILL_SETTINGS_UPDATED',
  'RESTAURANT_SETUP_UPDATED',
  'POS_OFFLINE_ACTION_CAPS_UPDATED',
  'POS_OFFLINE_POLICY_UPDATED',
  'POS_OFFLINE_ACTION_USAGE_IDEMPOTENCY_CONFLICT',
  'POS_OFFLINE_EXCEPTION_RETRY_AUTHORIZED',
  'POS_OFFLINE_EXCEPTION_RESOLVED',
  'DISCOUNT_SETTINGS_UPDATED',
  'PAYMENT_RECORDED',
  'PAYMENT_MANUAL_MOBILE_MONEY_RESEND_REQUESTED',
  'PAYMENT_CANCELLED',
  'POS_SALE_COMPLETED',
  'POS_SALE_PAYMENT_PENDING',
  'POS_WHOLESALE_STOCK_RESERVED',
  'POS_REFUND_COMPLETED',
  'POS_REFUND_PAYOUT_RECORDED',
  'POS_REFUND_DRAFT_CREATED',
  'POS_STORED_VALUE_ISSUED',
  'APPROVAL_POLICY_UPDATED',
  'PAYMENT_REMOVED',
  'PENDING_SALE_AUTO_CANCELLED',
  'PAYMENT_REFUND_AND_CANCELLED',
  'PAYMENT_REFUND_MANUAL_DUE',
  'PAYMENT_REFUND_RESOLVED',
  'PAYMENT_UNMATCHED_SUCCESS',
  'PAYMENT_PROVIDER_STATUS_RECHECKED',
  'PAYMENT_PROVIDER_SUCCESS',
  'PAYMENT_PROVIDER_REQUESTED',
  'PAYMENT_PROVIDER_REQUEST_UNCERTAIN',
  'PAYMENT_PROVIDER_REQUEST_FAILED',
  'PAYMENT_PROVIDER_STATUS_UPDATED',
  'PAYMENT_MANUAL_MOBILE_MONEY_RECORDED',
  'PAYMENT_MANUAL_MOBILE_MONEY_CONFIRMED',
  'PAYMENT_MANUAL_MOBILE_MONEY_RECONCILED',
  'GIFT_CARD_ISSUED',
  'GIFT_CARD_LOADED',
  'GIFT_CARD_REPLACED',
  'GIFT_CARD_DELIVERED',
  'GIFT_CARD_REDEEMED',
  'GIFT_CARD_REFUNDED',
  'PRINT_AGENT_PAIRING_CREATED',
  'PRINT_AGENT_PAIRED',
  'PRINT_AGENT_REVOKED',
  'PRINT_AGENT_REBOUND',
  'PRINT_AGENT_PAIRING_REBIND_DENIED',
  'PRINT_DRAWER_AUTHORIZATION_ISSUED',
  'PRINT_DRAWER_AUTHORIZATION_CONSUMED',
  'PRINT_DRAWER_KICK_DENIED',
  'PRINT_DRAWER_KICK_OUTCOME_RECORDED',
  'PRINT_DRAWER_SETTINGS_UPDATED',
  'PRINT_HARDWARE_DEVICE_CONFIGURED',
  'PRINT_DOCUMENT_STORED',
  'PRINT_PRINTER_CONFIGURED',
  'PRINT_JOB_CREATED',
  'PRINT_ATTEMPT_STARTED',
  'PRINT_JOB_TRANSMITTED',
  'PRINT_JOB_CONFIRMED',
  'PRINT_JOB_FAILED',
  'PRINT_JOB_UNCERTAIN',
  'PRINT_JOB_DEFERRED',
  'PRINT_JOB_CANCELLED',
  'PRINT_JOB_EXPIRED',
  'POS_RECEIPT_REPRINTED',
  'POS_RECEIPT_LINK_CREATED',
  'POS_RECEIPT_LINK_REVOKED',
  'POS_RECEIPT_LINK_SHARED',
  'EBM_V2_SIGNED',
  'EBM_V2_REFUND_QUEUED',
  'EBM_V2_LATE_SIGNED_RESPONSE',
  'EBM_V2_NEEDS_REVIEW',
  'EBM_V2_PERMANENT_REJECTION',
  'EBM_V2_RETRY_SCHEDULED',
  'EBM_V2_RESOLVED_NOT_RECEIVED',
  'EBM_V2_RESOLVED_SIGNED_MANUAL',
  'EBM_V2_RESEND_AUTHORIZED',
  'EBM_V2_RETRY_REQUESTED',
  'EBM_V2_RECEIPT_LOOKED_UP',
  'POS_EBM_SETTINGS_UPDATED',
  'SHIFT_FISCAL_CLOSE_APPROVED',
  'CUSTOMER_CREATED',
  'CUSTOMER_UPDATED',
  'CUSTOMER_LOYALTY_ADJUSTED',
  'CUSTOMER_LOYALTY_REDEEMED',
  'CUSTOMER_CONSENT_UPDATED',
  'CUSTOMER_MARKETING_MESSAGE_SENT',
  'CUSTOMER_DEACTIVATED',
  'CUSTOMER_MERGED',
  'POS_CREDIT_ACCOUNT_UPDATED',
  'POS_CREDIT_ADJUSTED',
  'POS_CREDIT_WRITTEN_OFF',
  'POS_CREDIT_PAYMENT_RECORDED',
  'POS_CREDIT_PAYMENT_REFUNDED',
  'POS_CHEQUE_DEPOSIT_RECORDED',
  'POS_CHEQUE_BOUNCED',
  'POS_LOYALTY_SETTINGS_UPDATED',
  'POS_LOYALTY_CREDIT_REVERSED',
  'VOUCHER_CREATED',
  'VOUCHER_UPDATED',
  'VOUCHER_BULK_GENERATED',
  'VOUCHER_PAUSED',
  'VOUCHER_CANCELLED',
  'VOUCHER_ACTIVATED',
  'VOUCHER_RESERVED',
  'VOUCHER_RESERVATION_RELEASED',
  'VOUCHER_REDEEMED',
  'VOUCHER_RESTORED',
  'VOUCHER_INVALID_ATTEMPT',
  'VOUCHER_SETTINGS_UPDATED',
]);
const REDACTED = '[REDACTED]';
const TRUNCATED = '[TRUNCATED]';
const MAX_METADATA_DEPTH = 12;
const MAX_METADATA_STRING_LENGTH = 4000;
const MAX_METADATA_ARRAY_LENGTH = 500;
const MAX_METADATA_KEYS = 200;
const RWANDA_PHONE_PATTERN = /(?:\+?250|0)7(?:[\s().-]*\d){8}\b/g;
const LABELED_TIN_PATTERN = /\b(TIN|taxpayer(?:\s+identification)?(?:\s+number)?)\s*[:#]?\s*[A-Z0-9-]{8,16}\b/gi;
const BEARER_CREDENTIAL_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]{14,}[A-Za-z0-9_~+/=-]/gi;
const posAuditCorrelation = new AsyncLocalStorage();
const DENIAL_AUDIT_WINDOW_SECONDS = 60;
const DENIAL_AUDIT_TTL_SECONDS = 24 * 60 * 60;
const denialCounters = new Map();
let denialCounterWarningAt = 0;

function shouldSampleDenial(count) {
  // Preserve the first five attempts, then sample at powers of two. This keeps
  // ordinary failures individually visible while bounding audit writes during
  // floods. The counter remains exact within its window.
  return count <= 5 || (count & (count - 1)) === 0;
}

function boundedLocalCounter(key, now) {
  const expiresAt = now + DENIAL_AUDIT_WINDOW_SECONDS * 1000;
  let record = denialCounters.get(key);
  if (!record || record.expiresAt <= now) record = { count: 0, expiresAt };
  record.count += 1;
  denialCounters.set(key, record);
  if (denialCounters.size > 10000) {
    for (const [candidate, item] of denialCounters) {
      if (item.expiresAt <= now || denialCounters.size > 9000) denialCounters.delete(candidate);
    }
  }
  return record.count;
}

async function denialAttemptCount(entry) {
  const event = String(entry.event || 'POS_ACTION_DENIED');
  const windowStart = Math.floor(Date.now() / (DENIAL_AUDIT_WINDOW_SECONDS * 1000)) * DENIAL_AUDIT_WINDOW_SECONDS;
  const identity = [entry.companyId, entry.registerId || 'none', entry.userId || 'unknown', event,
    entry.metadata?.operation || entry.metadata?.flow || 'unknown'].join(':');
  const digest = createHash('sha256').update(identity).digest('hex');
  const key = `pos:denial-audit:${windowStart}:${digest}`;
  if (isRedisConfigured() && redisClient && typeof redisClient.incr === 'function') {
    try {
      const count = Number(await redisClient.incr(key));
      if (count === 1 && typeof redisClient.expire === 'function') {
        await redisClient.expire(key, DENIAL_AUDIT_TTL_SECONDS);
      }
      if (Number.isSafeInteger(count) && count > 0) return { count, windowStart, distributed: true };
    } catch (error) {
      const now = Date.now();
      if (now - denialCounterWarningAt >= 60_000) {
        denialCounterWarningAt = now;
        console.error('[pos-audit] Denial counter unavailable; using process-local counter:', error.message || error);
      }
    }
  }
  return { count: boundedLocalCounter(key, Date.now()), windowStart, distributed: false };
}

async function writePosDenialAudit(entry, client = prisma) {
  const sampled = await denialAttemptCount(entry);
  if (!shouldSampleDenial(sampled.count)) return { sampled: false, count: sampled.count };
  return writePosAuditLog({
    ...entry,
    metadata: {
      ...(entry.metadata || {}),
      attemptCountInWindow: sampled.count,
      attemptWindowStartedAt: new Date(sampled.windowStart * 1000).toISOString(),
      attemptScope: String(entry.metadata?.operation || entry.metadata?.flow || entry.event || 'unknown').slice(0, 180),
      counterScope: sampled.distributed ? 'shared' : 'instance',
    },
  }, client);
}

const AUDIT_OUTCOMES = new Set(['COMMITTED', 'DENIED', 'FAILED', 'OBSERVED']);
const OBSERVATION_EVENTS = new Set([
  'SHIFT_HISTORY_VIEWED', 'EBM_V2_RECEIPT_LOOKED_UP', 'POS_AUDIT_READ',
  'POS_AUDIT_EXPORTED',
]);

function inferAuditEntity(metadata = {}) {
  const candidates = [
    ['submissionId', 'EBM_SUBMISSION'], ['creditNoteId', 'CREDIT_NOTE'],
    ['reservationId', 'STOCK_RESERVATION'],
    ['reprintId', 'RECEIPT_REPRINT'], ['receiptId', 'RECEIPT'], ['invoiceId', 'INVOICE'],
    ['saleId', 'SALE'], ['voucherId', 'VOUCHER'], ['batchId', 'VOUCHER_BATCH'],
    ['customerId', 'CUSTOMER'], ['clientId', 'CUSTOMER'], ['registerId', 'REGISTER'],
    ['deviceId', 'DEVICE'], ['shiftId', 'SHIFT'], ['linkId', 'RECEIPT_LINK'],
    ['settingsId', 'SETTINGS'],
  ];
  for (const [key, type] of candidates) {
    const value = metadata?.[key];
    if (typeof value === 'string' && value.trim()) return { entityType: type, entityId: value.trim() };
  }
  const ids = metadata?.voucherIds;
  if (Array.isArray(ids) && ids.length) return { entityType: 'VOUCHER_BATCH', entityId: String(metadata.batchId || ids[0]) };
  return { entityType: null, entityId: null };
}

function inferAuditOutcome(event) {
  if (event === 'POS_ACTION_DENIED' || event === 'VOUCHER_INVALID_ATTEMPT') return 'DENIED';
  if (event === 'POS_ACTION_FAILED') return 'FAILED';
  if (OBSERVATION_EVENTS.has(event)) return 'OBSERVED';
  return 'COMMITTED';
}

function withPosAuditCorrelation(correlationId, callback) {
  const normalized = String(correlationId || '').trim();
  if (!normalized) return callback();
  return posAuditCorrelation.run({ correlationId: normalized }, callback);
}

function sanitizeText(value) {
  return value
    .replace(RWANDA_PHONE_PATTERN, '[MASKED PHONE]')
    .replace(LABELED_TIN_PATTERN, '$1: [MASKED TIN]')
    .replace(BEARER_CREDENTIAL_PATTERN, 'Bearer [REDACTED]');
}

// Match semantic field names rather than arbitrary substrings. For example,
// `errorCode` and `approvalId` are useful audit facts and must not disappear,
// while `voucherCode`, `accessToken`, and `customerTin` must never be stored.
function normalizedMetadataKey(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function metadataRedaction(key) {
  const words = normalizedMetadataKey(key);
  const normalized = words.join('');
  if (!normalized) return null;

  if (words.some((word) => [
    'pin', 'password', 'passwd', 'passphrase', 'secret', 'credential', 'credentials',
    'authorization', 'token', 'hash', 'apikey', 'privatekey', 'cvv', 'cvc', 'pan',
  ].includes(word)) || normalized.includes('cardnumber') || normalized.includes('primaryaccountnumber')) {
    return REDACTED;
  }
  if (words.some((word) => [
    'phone', 'mobile', 'telephone', 'tin', 'taxpayer',
  ].includes(word)) || normalized.includes('contactnumber')) {
    return '[MASKED]';
  }
  if (normalized === 'code'
    || (/(voucher|giftcard|pairing|enrollment|verification|onetime)/.test(normalized)
      && normalized.endsWith('code'))) {
    return REDACTED;
  }
  return null;
}

function sanitizeMetadata(value) {
  const seen = new WeakSet();

  function visit(current, key, depth) {
    const replacement = key == null ? null : metadataRedaction(key);
    if (replacement) return replacement;
    if (current == null || typeof current === 'boolean' || typeof current === 'number') {
      return Number.isFinite(current) || typeof current !== 'number' ? current : null;
    }
    if (typeof current === 'bigint') return current.toString();
    if (typeof current === 'string') {
      return sanitizeText(current.length > MAX_METADATA_STRING_LENGTH
        ? `${current.slice(0, MAX_METADATA_STRING_LENGTH)}${TRUNCATED}`
        : current);
    }
    if (current instanceof Date) return Number.isNaN(current.getTime()) ? null : current.toISOString();
    if (typeof current !== 'object') return String(current);
    if (depth >= MAX_METADATA_DEPTH) return TRUNCATED;
    if (seen.has(current)) return '[CIRCULAR]';
    seen.add(current);

    if (Array.isArray(current)) {
      const result = current.slice(0, MAX_METADATA_ARRAY_LENGTH)
        .map((item) => visit(item, null, depth + 1));
      if (current.length > MAX_METADATA_ARRAY_LENGTH) result.push(TRUNCATED);
      return result;
    }

    const result = {};
    const entries = Object.entries(current);
    for (const [childKey, childValue] of entries.slice(0, MAX_METADATA_KEYS)) {
      result[childKey] = visit(childValue, childKey, depth + 1);
    }
    if (entries.length > MAX_METADATA_KEYS) result._truncated = TRUNCATED;
    return result;
  }

  return visit(value, null, 0);
}

function requestIp(req) {
  const ip = req?.ip || req?.connection?.remoteAddress;
  return ip ? String(ip).slice(0, 45) : null;
}

async function writePosAuditLog(entry, client = prisma) {
  const event = String(entry.event || '');
  if (!POS_AUDIT_EVENTS.has(event)) {
    throw new Error(`Unsupported POS audit event: ${event}`);
  }
  if (!entry.companyId) {
    throw new Error('A company is required to write a POS audit event.');
  }

  const companyId = String(entry.companyId).trim();
  const registerId = entry.registerId ? String(entry.registerId).trim() : null;
  const streamId = streamIdFor({ companyId, registerId });
  const persist = async (tx) => {
    // Advisory-lock functions return PostgreSQL `void`; cast it before using
    // $queryRaw so Prisma can deserialize the result while retaining the lock.
    const lockRows = await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${streamId}))::text AS "locked", current_setting('app.pos_approval_correlation_id', true) AS "correlationId"`;
    const latest = await tx.posAuditLog.findFirst({
      where: { companyId, streamId, hash: { not: null } },
      orderBy: { streamSequence: 'desc' },
      select: { streamSequence: true, hash: true },
    });
    const streamSequence = latest ? BigInt(latest.streamSequence) + 1n : 1n;
    const createdAt = new Date();
    const metadata = entry.metadata == null ? null : sanitizeMetadata(entry.metadata);
    const correlationId = posAuditCorrelation.getStore()?.correlationId
      || lockRows?.[0]?.correlationId
      || entry.correlationId
      || entry.metadata?.correlationId
      || null;
    const inferredEntity = inferAuditEntity(entry.metadata || {});
    const outcome = String(entry.outcome || inferAuditOutcome(event)).toUpperCase();
    if (!AUDIT_OUTCOMES.has(outcome)) throw new Error(`Unsupported POS audit outcome: ${outcome}`);
    if (correlationId && metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      && !metadata.correlationId) {
      metadata.correlationId = correlationId;
    }
    const data = {
      id: generateObjectId(),
      companyId,
      registerId,
      userId: entry.userId ? String(entry.userId).trim() : null,
      event,
      actionId: entry.actionId ? String(entry.actionId).trim() : generateObjectId(),
      correlationId: correlationId ? String(correlationId).slice(0, 128) : null,
      outcome,
      entityType: entry.entityType ? String(entry.entityType).slice(0, 64) : inferredEntity.entityType,
      entityId: entry.entityId ? String(entry.entityId).slice(0, 128) : inferredEntity.entityId,
      metadata,
      ip: entry.ip ? String(entry.ip).slice(0, 45) : null,
      streamId,
      streamSequence,
      prevHash: latest ? String(latest.hash).trim() : GENESIS_HASH,
      hashVersion: 2,
      createdAt,
    };
    const hash = hashAuditRow({ ...data, hash: null });
    return tx.posAuditLog.create({ data: { ...data, hash } });
  };

  // If a transaction client is supplied by the caller, audit insertion shares
  // that business transaction. Standalone audit events get their own atomic
  // transaction so lock, sequence selection, hash and insert cannot split.
  return client === prisma ? prisma.$transaction(persist) : persist(client);
}

module.exports = {
  POS_AUDIT_EVENTS,
  AUDIT_OUTCOMES,
  inferAuditEntity,
  sanitizeMetadata,
  requestIp,
  writePosDenialAudit,
  shouldSampleDenial,
  withPosAuditCorrelation,
  writePosAuditLog,
};
