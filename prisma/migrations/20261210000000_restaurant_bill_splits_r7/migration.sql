ALTER TABLE restaurant_bills
  DROP CONSTRAINT IF EXISTS restaurant_bills_company_order_key;

ALTER TABLE restaurant_bills
  ADD COLUMN IF NOT EXISTS check_number INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS guest_number INTEGER,
  ADD COLUMN IF NOT EXISTS reallocation_key VARCHAR(100);

ALTER TABLE restaurant_bills
  DROP CONSTRAINT IF EXISTS restaurant_bills_status_check;

ALTER TABLE restaurant_bills
  ADD CONSTRAINT restaurant_bills_status_check
  CHECK (status IN ('issued', 'preparing', 'pending_payment', 'paid', 'closed', 'cancelled'));

ALTER TABLE restaurant_bills
  ADD CONSTRAINT restaurant_bills_check_number_check
  CHECK (check_number BETWEEN 1 AND 20);

ALTER TABLE restaurant_bills
  ADD CONSTRAINT restaurant_bills_guest_number_check
  CHECK (guest_number IS NULL OR guest_number BETWEEN 1 AND 20);

ALTER TABLE restaurant_bills
  ADD CONSTRAINT restaurant_bills_company_order_check_key
  UNIQUE (company_id, order_id, check_number);

CREATE INDEX IF NOT EXISTS restaurant_bills_company_order_status_idx
  ON restaurant_bills(company_id, order_id, status);

ALTER TABLE restaurant_bill_payments
  ADD COLUMN IF NOT EXISTS lock_released_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lock_release_reason VARCHAR(500),
  ADD COLUMN IF NOT EXISTS lock_released_by_id CHAR(24);

ALTER TABLE restaurant_bill_payments
  ADD CONSTRAINT restaurant_bill_payments_lock_released_by_fkey
  FOREIGN KEY (lock_released_by_id)
  REFERENCES users(id)
  ON UPDATE CASCADE ON DELETE SET NULL;
