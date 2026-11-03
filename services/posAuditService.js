const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');

const POS_AUDIT_EVENTS = new Set([
  'PIN_LOGIN_SUCCESS',
  'PIN_LOGIN_FAILED',
  'PIN_LOCKOUT',
  'SESSION_LOCKED',
  'SESSION_UNLOCKED',
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
  'REGISTER_DEVICE_REVOKED',
  'REGISTER_PAIRING_CODE_ISSUED',
  'REGISTER_BRANCH_UPDATED',
  'REGISTER_TRAINING_MODE_UPDATED',
  'REGISTER_ACCESS_UPDATED',
  'SHIFT_OPENED',
  'SHIFT_REOPENED',
  'SHIFT_RECLOSED',
  'SHIFT_HANDED_OVER',
  'SHIFT_HISTORY_VIEWED',
  'SHIFT_DELETED',
  'CASH_MOVEMENT_RECORDED',
  'SHIFT_CLOSED',
  'PAYMENT_SETTINGS_UPDATED',
  'TILL_SETTINGS_UPDATED',
  'PAYMENT_RECORDED',
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
  'GIFT_CARD_REDEEMED',
  'GIFT_CARD_REFUNDED',
  'PRINT_AGENT_PAIRING_CREATED',
  'PRINT_AGENT_PAIRED',
  'PRINT_AGENT_REVOKED',
  'PRINT_PRINTER_CONFIGURED',
  'PRINT_JOB_CREATED',
  'PRINT_JOB_TRANSMITTED',
  'PRINT_JOB_CONFIRMED',
  'PRINT_JOB_FAILED',
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
  'POS_LOYALTY_SETTINGS_UPDATED',
  'POS_LOYALTY_CREDIT_REVERSED',
]);
const SENSITIVE_METADATA_KEY = /(pin|token|password|secret|credential|hash|authorization)/i;

function sanitizeMetadata(value) {
  if (Array.isArray(value)) return value.map(sanitizeMetadata);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SENSITIVE_METADATA_KEY.test(key))
      .map(([key, item]) => [key, sanitizeMetadata(item)]),
  );
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

  const metadata = entry.metadata == null ? null : sanitizeMetadata(entry.metadata);
  return client.posAuditLog.create({
    data: {
      id: generateObjectId(),
      companyId: String(entry.companyId),
      registerId: entry.registerId ? String(entry.registerId) : null,
      userId: entry.userId ? String(entry.userId) : null,
      event,
      metadata,
      ip: entry.ip ? String(entry.ip).slice(0, 45) : null,
    },
  });
}

module.exports = {
  POS_AUDIT_EVENTS,
  sanitizeMetadata,
  requestIp,
  writePosAuditLog,
};
