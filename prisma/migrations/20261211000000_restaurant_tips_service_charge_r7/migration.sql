ALTER TABLE restaurant_menu_items
  ADD COLUMN service_charge_exempt BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE invoice_lines
  ADD COLUMN is_service_line BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN service_charge_exempt BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE restaurant_bills
  ADD COLUMN service_charge_amount NUMERIC(19, 2) NOT NULL DEFAULT 0,
  ADD COLUMN service_charge_tax_amount NUMERIC(19, 2) NOT NULL DEFAULT 0,
  ADD COLUMN service_charge_rate_pct NUMERIC(7, 4),
  ADD COLUMN service_charge_mode VARCHAR(16) NOT NULL DEFAULT 'off',
  ADD COLUMN service_charge_taxable BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN service_charge_tax_rate_id CHAR(24),
  ADD COLUMN service_charge_override_reason VARCHAR(500),
  ADD COLUMN service_charge_overridden_by_id CHAR(24),
  ADD COLUMN service_charge_overridden_at TIMESTAMPTZ(3);

ALTER TABLE restaurant_bills
  ADD CONSTRAINT restaurant_bills_service_charge_amount_check
    CHECK (service_charge_amount >= 0),
  ADD CONSTRAINT restaurant_bills_service_charge_tax_amount_check
    CHECK (service_charge_tax_amount >= 0),
  ADD CONSTRAINT restaurant_bills_service_charge_mode_check
    CHECK (service_charge_mode IN ('off', 'income', 'pass-through'));

CREATE TABLE restaurant_billing_settings (
  company_id CHAR(24) PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  tips_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  service_charge_mode VARCHAR(16) NOT NULL DEFAULT 'off'
    CHECK (service_charge_mode IN ('off', 'income', 'pass-through')),
  service_charge_rate_pct NUMERIC(7, 4),
  service_charge_rate_by_till_type JSONB NOT NULL DEFAULT '{}'::jsonb,
  service_charge_rate_by_register JSONB NOT NULL DEFAULT '{}'::jsonb,
  service_charge_taxable BOOLEAN,
  service_charge_tax_rate_id CHAR(24),
  updated_by_id CHAR(24),
  updated_at TIMESTAMPTZ(3) NOT NULL
);

ALTER TABLE restaurant_billing_settings
  ADD CONSTRAINT restaurant_billing_settings_rate_check
    CHECK (service_charge_rate_pct IS NULL OR service_charge_rate_pct BETWEEN 0 AND 100);

CREATE TABLE restaurant_tips (
  id CHAR(24) PRIMARY KEY,
  company_id CHAR(24) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bill_id CHAR(24) NOT NULL,
  order_id CHAR(24) NOT NULL,
  waiter_id CHAR(24) NOT NULL,
  register_id CHAR(24) NOT NULL,
  shift_id CHAR(24),
  cashier_id CHAR(24) NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  payment_method VARCHAR(32) NOT NULL,
  provider VARCHAR(32),
  reference VARCHAR(160),
  idempotency_key VARCHAR(160) NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT restaurant_tips_company_idempotency_key UNIQUE (company_id, idempotency_key)
);

CREATE INDEX restaurant_tips_company_waiter_created_idx
  ON restaurant_tips(company_id, waiter_id, created_at);
CREATE INDEX restaurant_tips_company_bill_created_idx
  ON restaurant_tips(company_id, bill_id, created_at);

CREATE TABLE restaurant_tip_payouts (
  id CHAR(24) PRIMARY KEY,
  company_id CHAR(24) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  waiter_id CHAR(24) NOT NULL,
  register_id CHAR(24) NOT NULL,
  shift_id CHAR(24),
  amount INTEGER NOT NULL CHECK (amount > 0),
  payment_method VARCHAR(16) NOT NULL CHECK (payment_method IN ('CASH', 'BANK_TRANSFER')),
  account_code VARCHAR(64) NOT NULL,
  reference VARCHAR(160),
  reason VARCHAR(500) NOT NULL,
  approved_by_id CHAR(24) NOT NULL,
  idempotency_key VARCHAR(160) NOT NULL,
  journal_entry_id CHAR(24),
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT restaurant_tip_payouts_company_idempotency_key UNIQUE (company_id, idempotency_key)
);

CREATE INDEX restaurant_tip_payouts_company_waiter_created_idx
  ON restaurant_tip_payouts(company_id, waiter_id, created_at);
