ALTER TABLE restaurant_billing_settings
  ADD COLUMN tip_attribution VARCHAR(24) NOT NULL DEFAULT 'closing_waiter',
  ADD COLUMN large_tip_confirmation_pct NUMERIC(7, 4) NOT NULL DEFAULT 100,
  ADD CONSTRAINT restaurant_billing_settings_tip_attribution_check
    CHECK (tip_attribution IN ('closing_waiter', 'table_waiter')),
  ADD CONSTRAINT restaurant_billing_settings_large_tip_pct_check
    CHECK (large_tip_confirmation_pct BETWEEN 1 AND 1000);

ALTER TABLE restaurant_tips
  ADD COLUMN capture_mode VARCHAR(20) NOT NULL DEFAULT 'cash_tip',
  ADD COLUMN tendered_amount INTEGER,
  ADD COLUMN posting_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  ADD COLUMN journal_entry_id CHAR(24),
  ADD CONSTRAINT restaurant_tips_payment_method_cash_check
    CHECK (payment_method = 'CASH'),
  ADD CONSTRAINT restaurant_tips_capture_mode_check
    CHECK (capture_mode IN ('cash_tip', 'keep_change')),
  ADD CONSTRAINT restaurant_tips_tendered_amount_check
    CHECK (tendered_amount IS NULL OR tendered_amount > 0),
  ADD CONSTRAINT restaurant_tips_posting_status_check
    CHECK (posting_status IN ('pending', 'posted', 'failed'));

ALTER TABLE restaurant_tip_payouts
  DROP CONSTRAINT restaurant_tip_payouts_payment_method_check,
  ADD CONSTRAINT restaurant_tip_payouts_payment_method_check
    CHECK (payment_method = 'CASH'),
  ADD COLUMN posting_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  ADD CONSTRAINT restaurant_tip_payouts_posting_status_check
    CHECK (posting_status IN ('pending', 'posted', 'failed'));

CREATE TABLE restaurant_tip_reversals (
  id CHAR(24) PRIMARY KEY,
  company_id CHAR(24) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tip_id CHAR(24) NOT NULL REFERENCES restaurant_tips(id) ON DELETE RESTRICT,
  register_id CHAR(24) NOT NULL,
  shift_id CHAR(24),
  amount INTEGER NOT NULL CHECK (amount > 0),
  reason VARCHAR(500) NOT NULL,
  approved_by_id CHAR(24) NOT NULL,
  idempotency_key VARCHAR(160) NOT NULL,
  posting_status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (posting_status IN ('pending', 'posted', 'failed')),
  journal_entry_id CHAR(24),
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT restaurant_tip_reversals_company_idempotency_key
    UNIQUE (company_id, idempotency_key)
);

CREATE INDEX restaurant_tip_reversals_company_tip_created_idx
  ON restaurant_tip_reversals(company_id, tip_id, created_at);
CREATE INDEX restaurant_tip_reversals_company_shift_created_idx
  ON restaurant_tip_reversals(company_id, shift_id, created_at);
