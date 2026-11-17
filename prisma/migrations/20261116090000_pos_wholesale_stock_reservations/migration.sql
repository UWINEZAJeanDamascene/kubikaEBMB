CREATE TABLE IF NOT EXISTS pos_stock_reservations (
  id CHAR(24) PRIMARY KEY,
  company_id CHAR(24) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  register_id CHAR(24) NOT NULL,
  shift_id CHAR(24),
  cashier_id CHAR(24) NOT NULL,
  warehouse_id CHAR(24) NOT NULL REFERENCES warehouses(id),
  client_id CHAR(24),
  reference_no VARCHAR(48) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'reserved',
  lines JSONB NOT NULL DEFAULT '[]'::jsonb,
  backorder_lines JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes TEXT,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pos_stock_reservations_status_check CHECK (status IN ('reserved', 'partial', 'backorder', 'fulfilled', 'cancelled')),
  CONSTRAINT pos_stock_reservations_company_reference_unique UNIQUE (company_id, reference_no)
);

CREATE INDEX IF NOT EXISTS pos_stock_reservations_till_open_idx
  ON pos_stock_reservations(company_id, register_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS pos_stock_reservations_customer_idx
  ON pos_stock_reservations(company_id, client_id, created_at DESC);
