CREATE TABLE IF NOT EXISTS restaurant_menu_categories (
  id CHAR(24) PRIMARY KEY,
  company_id CHAR(24) NOT NULL,
  category_id CHAR(24) NOT NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  display_order INTEGER NOT NULL DEFAULT 0,
  grid_columns INTEGER NOT NULL DEFAULT 4,
  button_color VARCHAR(24),
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT restaurant_menu_categories_company_id_id_key UNIQUE (company_id, id),
  CONSTRAINT restaurant_menu_categories_company_category_key UNIQUE (company_id, category_id)
);

CREATE INDEX IF NOT EXISTS restaurant_menu_categories_company_enabled_order_idx
  ON restaurant_menu_categories(company_id, is_enabled, display_order);

CREATE TABLE IF NOT EXISTS restaurant_menu_items (
  id CHAR(24) PRIMARY KEY,
  company_id CHAR(24) NOT NULL,
  product_id CHAR(24) NOT NULL,
  menu_name VARCHAR(180),
  menu_description TEXT,
  station VARCHAR(16) NOT NULL DEFAULT 'kitchen',
  stock_mode VARCHAR(16) NOT NULL DEFAULT 'none',
  is_available BOOLEAN NOT NULL DEFAULT true,
  display_order INTEGER NOT NULL DEFAULT 0,
  measure_name VARCHAR(32),
  measures_per_bottle DECIMAL(10, 4),
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT restaurant_menu_items_product_id_key UNIQUE (product_id),
  CONSTRAINT restaurant_menu_items_company_id_id_key UNIQUE (company_id, id),
  CONSTRAINT restaurant_menu_items_company_product_id_key UNIQUE (company_id, product_id)
);

CREATE INDEX IF NOT EXISTS restaurant_menu_items_company_available_order_idx
  ON restaurant_menu_items(company_id, is_available, display_order);

CREATE TABLE IF NOT EXISTS restaurant_modifier_groups (
  id CHAR(24) PRIMARY KEY,
  company_id CHAR(24) NOT NULL,
  name VARCHAR(120) NOT NULL,
  selection_mode VARCHAR(16) NOT NULL DEFAULT 'single',
  is_required BOOLEAN NOT NULL DEFAULT false,
  min_selections INTEGER NOT NULL DEFAULT 0,
  max_selections INTEGER NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT restaurant_modifier_groups_company_id_id_key UNIQUE (company_id, id),
  CONSTRAINT restaurant_modifier_groups_company_name_key UNIQUE (company_id, name)
);

CREATE INDEX IF NOT EXISTS restaurant_modifier_groups_company_active_name_idx
  ON restaurant_modifier_groups(company_id, is_active, name);

CREATE TABLE IF NOT EXISTS restaurant_modifier_options (
  id CHAR(24) PRIMARY KEY,
  company_id CHAR(24) NOT NULL,
  group_id CHAR(24) NOT NULL,
  name VARCHAR(120) NOT NULL,
  price_adjustment DECIMAL(19, 2) NOT NULL DEFAULT 0,
  is_available BOOLEAN NOT NULL DEFAULT true,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT restaurant_modifier_options_company_id_id_key UNIQUE (company_id, id),
  CONSTRAINT restaurant_modifier_options_company_group_name_key UNIQUE (company_id, group_id, name)
);

CREATE INDEX IF NOT EXISTS restaurant_modifier_options_company_group_available_order_idx
  ON restaurant_modifier_options(company_id, group_id, is_available, display_order);

CREATE TABLE IF NOT EXISTS restaurant_menu_item_modifier_groups (
  id CHAR(24) PRIMARY KEY,
  company_id CHAR(24) NOT NULL,
  menu_item_id CHAR(24) NOT NULL,
  modifier_group_id CHAR(24) NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT restaurant_menu_item_modifier_groups_company_item_group_key
    UNIQUE (company_id, menu_item_id, modifier_group_id)
);

CREATE INDEX IF NOT EXISTS restaurant_menu_item_modifier_groups_company_item_order_idx
  ON restaurant_menu_item_modifier_groups(company_id, menu_item_id, display_order);

CREATE TABLE IF NOT EXISTS restaurant_floor_areas (
  id CHAR(24) PRIMARY KEY,
  company_id CHAR(24) NOT NULL,
  name VARCHAR(80) NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT restaurant_floor_areas_company_id_id_key UNIQUE (company_id, id),
  CONSTRAINT restaurant_floor_areas_company_name_key UNIQUE (company_id, name)
);

CREATE INDEX IF NOT EXISTS restaurant_floor_areas_company_active_order_idx
  ON restaurant_floor_areas(company_id, is_active, display_order);

CREATE TABLE IF NOT EXISTS restaurant_tables (
  id CHAR(24) PRIMARY KEY,
  company_id CHAR(24) NOT NULL,
  area_id CHAR(24) NOT NULL,
  name VARCHAR(40) NOT NULL,
  capacity INTEGER NOT NULL DEFAULT 4,
  display_order INTEGER NOT NULL DEFAULT 0,
  color VARCHAR(24),
  state VARCHAR(24) NOT NULL DEFAULT 'free',
  guest_count INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  merged_into_table_id CHAR(24),
  last_changed_by_id CHAR(24),
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT restaurant_tables_company_id_id_key UNIQUE (company_id, id),
  CONSTRAINT restaurant_tables_company_area_name_key UNIQUE (company_id, area_id, name)
);

CREATE INDEX IF NOT EXISTS restaurant_tables_company_area_state_order_idx
  ON restaurant_tables(company_id, area_id, state, display_order);

CREATE INDEX IF NOT EXISTS restaurant_tables_company_merged_into_idx
  ON restaurant_tables(company_id, merged_into_table_id);

CREATE TABLE IF NOT EXISTS restaurant_orders (
  id CHAR(24) PRIMARY KEY,
  company_id CHAR(24) NOT NULL,
  register_id CHAR(24) NOT NULL,
  table_id CHAR(24),
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  version INTEGER NOT NULL DEFAULT 1,
  guest_count INTEGER NOT NULL DEFAULT 1,
  opened_by_id CHAR(24) NOT NULL,
  waiter_id CHAR(24),
  opened_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(3) NOT NULL,
  order_kind VARCHAR(16) NOT NULL DEFAULT 'dining',
  tab_name VARCHAR(120),
  CONSTRAINT restaurant_orders_company_id_id_key UNIQUE (company_id, id)
);

CREATE INDEX IF NOT EXISTS restaurant_orders_company_kind_status_opened_idx
  ON restaurant_orders(company_id, order_kind, status, opened_at);

CREATE INDEX IF NOT EXISTS restaurant_orders_company_status_updated_idx
  ON restaurant_orders(company_id, status, updated_at);

CREATE INDEX IF NOT EXISTS restaurant_orders_company_table_status_idx
  ON restaurant_orders(company_id, table_id, status);

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
