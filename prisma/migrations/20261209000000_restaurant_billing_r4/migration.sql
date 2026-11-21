CREATE TABLE IF NOT EXISTS restaurant_bills (
  id CHAR(24) PRIMARY KEY,
  company_id CHAR(24) NOT NULL REFERENCES companies(id) ON UPDATE CASCADE ON DELETE CASCADE,
  order_id CHAR(24) NOT NULL,
  invoice_id CHAR(24),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  status VARCHAR(24) NOT NULL DEFAULT 'issued'
    CHECK (status IN ('issued', 'pending_payment', 'paid', 'closed', 'cancelled')),
  split_type VARCHAR(16) NOT NULL
    CHECK (split_type IN ('single', 'item', 'equal', 'amount')),
  subtotal NUMERIC(19, 2) NOT NULL,
  tax_amount NUMERIC(19, 2) NOT NULL,
  total_amount NUMERIC(19, 2) NOT NULL,
  line_snapshot JSONB NOT NULL,
  payer_allocations JSONB NOT NULL,
  created_by_id CHAR(24) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT restaurant_bills_company_id_id_key UNIQUE (company_id, id),
  CONSTRAINT restaurant_bills_company_order_key UNIQUE (company_id, order_id),
  CONSTRAINT restaurant_bills_company_invoice_key UNIQUE (company_id, invoice_id),
  CONSTRAINT restaurant_bills_invoice_id_key UNIQUE (invoice_id),
  CONSTRAINT restaurant_bills_order_company_fkey
    FOREIGN KEY (company_id, order_id)
    REFERENCES restaurant_orders(company_id, id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT restaurant_bills_invoice_company_fkey
    FOREIGN KEY (company_id, invoice_id)
    REFERENCES invoices(company_id, id)
    ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS restaurant_bill_payments (
  id CHAR(24) PRIMARY KEY,
  company_id CHAR(24) NOT NULL,
  bill_id CHAR(24) NOT NULL,
  payment_id CHAR(24) NOT NULL,
  payer_number INTEGER NOT NULL CHECK (payer_number BETWEEN 1 AND 20),
  amount INTEGER NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT restaurant_bill_payments_company_payment_key UNIQUE (company_id, payment_id),
  CONSTRAINT restaurant_bill_payments_payment_id_key UNIQUE (payment_id),
  CONSTRAINT restaurant_bill_payments_payer_payment_key
    UNIQUE (company_id, bill_id, payer_number, payment_id),
  CONSTRAINT restaurant_bill_payments_bill_company_fkey
    FOREIGN KEY (company_id, bill_id)
    REFERENCES restaurant_bills(company_id, id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT restaurant_bill_payments_payment_company_fkey
    FOREIGN KEY (company_id, payment_id)
    REFERENCES pos_payments(company_id, id)
    ON UPDATE CASCADE ON DELETE RESTRICT
);

ALTER TABLE restaurant_order_events
  DROP CONSTRAINT IF EXISTS restaurant_order_events_type_check;

ALTER TABLE restaurant_order_events
  ADD CONSTRAINT restaurant_order_events_type_check
  CHECK (event_type IN (
    'ORDER_OPENED',
    'ITEM_ADDED',
    'ITEM_VOIDED',
    'ROUND_SENT',
    'ORDER_CANCELLED',
    'TABLE_TRANSFERRED',
    'TABLE_MERGED',
    'TAB_CARRIED',
    'TAB_WRITTEN_OFF',
    'ITEMS_UPDATED',
    'TICKET_STATUS_UPDATED',
    'SENT_ITEM_VOIDED',
    'BILL_ISSUED',
    'BILL_PAID'
  ));
