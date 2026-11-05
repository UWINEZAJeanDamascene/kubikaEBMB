'use strict';

const POLICY_ACTIONS = Object.freeze([
  'DISCOUNT_OVER_LIMIT',
  'PRICE_OVERRIDE',
  'VOID_LINE',
  'VOID_SALE',
  'REFUND',
  'NO_SALE',
  'SHIFT_REOPEN',
  'SHIFT_CLOSE_VARIANCE',
  'CASH_IN',
  'CASH_OUT',
  'GIFT_CARD_ISSUE',
  'GIFT_CARD_REISSUE',
  'SAFE_DROP',
  'CANCEL_PAID_SALE',
  'REMOVE_PAYMENT',
  'MANUAL_PAYMENT_CONFIRM',
  'CREDIT_OVER_LIMIT',
  'CREDIT_ADJUST',
  'CREDIT_WRITEOFF',
  'CREDIT_REFUND',
  'discount',
  'void',
  'refund',
  'no_sale',
  'till_force_close',
  'till_large_variance_close',
  'checkout_recovery',
  'FISCAL_RECEIPT_ENTRY',
  'CLOSE_WITH_UNSENT_RECEIPTS',
]);

function defaultApprovalPolicy(action) {
  const discountAction = String(action).toLowerCase().includes('discount');
  return {
    action: String(action),
    enabled: true,
    requestTtlSeconds: 600,
    pinApprovalTtlSeconds: 60,
    managerApprovalTtlSeconds: discountAction ? 600 : 300,
  };
}

async function getApprovalPolicy(client, companyId, action) {
  const policy = await client.posApprovalPolicy.findUnique({
    where: { companyId_action: { companyId: String(companyId), action: String(action) } },
  });
  return policy || defaultApprovalPolicy(action);
}

function validatePolicyDuration(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

module.exports = {
  POLICY_ACTIONS,
  defaultApprovalPolicy,
  getApprovalPolicy,
  validatePolicyDuration,
};
