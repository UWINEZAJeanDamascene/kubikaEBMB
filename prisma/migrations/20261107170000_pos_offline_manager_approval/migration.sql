ALTER TABLE "pos_offline_action_usage"
  DROP CONSTRAINT "pos_offline_action_usage_action_check";

ALTER TABLE "pos_offline_action_usage"
  ADD CONSTRAINT "pos_offline_action_usage_action_check"
  CHECK ("action" IN (
    'mobile_money',
    'card',
    'paid_in',
    'paid_out',
    'manager_mobile_money',
    'manager_card',
    'manager_paid_in',
    'manager_paid_out'
  ));
