-- Keep the durable remote-approval request and its one-use approval token
-- compatible with every action accepted by posManagerApprovalController.
ALTER TABLE "pos_manager_approvals"
  ALTER COLUMN "action" TYPE VARCHAR(32),
  DROP CONSTRAINT "pos_manager_approvals_action_check",
  ADD CONSTRAINT "pos_manager_approvals_action_check"
    CHECK ("action" IN (
      'discount',
      'void',
      'refund',
      'no_sale',
      'till_force_close',
      'till_large_variance_close',
      'checkout_recovery',
      'CANCEL_PAID_SALE',
      'FISCAL_RECEIPT_ENTRY',
      'CLOSE_WITH_UNSENT_RECEIPTS',
      'CREDIT_WRITEOFF',
      'CREDIT_ADJUST',
      'CREDIT_REFUND'
    ));

ALTER TABLE "pos_approval_requests"
  ALTER COLUMN "action" TYPE VARCHAR(32),
  ADD CONSTRAINT "pos_approval_requests_action_check"
    CHECK ("action" IN (
      'discount',
      'void',
      'refund',
      'no_sale',
      'till_force_close',
      'till_large_variance_close',
      'checkout_recovery',
      'CANCEL_PAID_SALE',
      'FISCAL_RECEIPT_ENTRY',
      'CLOSE_WITH_UNSENT_RECEIPTS',
      'CREDIT_WRITEOFF',
      'CREDIT_ADJUST',
      'CREDIT_REFUND'
    ));
