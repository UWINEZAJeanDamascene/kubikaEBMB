ALTER TABLE restaurant_menu_items
  ADD COLUMN bar_stock_product_id CHAR(24),
  ADD COLUMN bar_purchase_unit_code VARCHAR(24),
  ADD COLUMN bar_serving_volume NUMERIC(19, 6),
  ADD COLUMN bar_serving_unit VARCHAR(32);

ALTER TABLE restaurant_menu_items
  ADD CONSTRAINT restaurant_menu_items_bar_measure_check
    CHECK (
      (bar_stock_product_id IS NULL AND bar_purchase_unit_code IS NULL AND bar_serving_volume IS NULL AND bar_serving_unit IS NULL)
      OR (
        bar_stock_product_id IS NOT NULL
        AND bar_purchase_unit_code IS NOT NULL
        AND bar_serving_volume > 0
        AND bar_serving_unit IS NOT NULL
        AND length(trim(bar_serving_unit)) > 0
      )
    );

CREATE TABLE restaurant_recipe_ingredients (
  id CHAR(24) PRIMARY KEY,
  company_id CHAR(24) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  menu_item_id CHAR(24) NOT NULL,
  product_id CHAR(24) NOT NULL,
  quantity NUMERIC(19, 6) NOT NULL CHECK (quantity > 0),
  unit_code VARCHAR(24) NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT restaurant_recipe_ingredients_company_item_product_key
    UNIQUE (company_id, menu_item_id, product_id)
);
CREATE INDEX restaurant_recipe_ingredients_company_product_idx
  ON restaurant_recipe_ingredients(company_id, product_id);

CREATE TABLE restaurant_happy_hour_promotions (
  id CHAR(24) PRIMARY KEY,
  company_id CHAR(24) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  menu_item_id CHAR(24) NOT NULL,
  name VARCHAR(120) NOT NULL,
  kind VARCHAR(16) NOT NULL CHECK (kind IN ('fixed_price', 'percent')),
  value NUMERIC(19, 4) NOT NULL CHECK (value >= 0),
  weekdays INTEGER[] NOT NULL DEFAULT '{}',
  start_minute INTEGER NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute INTEGER NOT NULL CHECK (end_minute BETWEEN 1 AND 1440),
  starts_at TIMESTAMPTZ(3),
  ends_at TIMESTAMPTZ(3),
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT restaurant_happy_hour_time_range_check CHECK (start_minute < end_minute),
  CONSTRAINT restaurant_happy_hour_date_range_check CHECK (ends_at IS NULL OR starts_at IS NULL OR starts_at < ends_at),
  CONSTRAINT restaurant_happy_hour_value_check CHECK (kind <> 'percent' OR value <= 100),
  CONSTRAINT restaurant_happy_hour_weekdays_check
    CHECK (array_position(weekdays, NULL) IS NULL AND weekdays <@ ARRAY[0, 1, 2, 3, 4, 5, 6])
);
CREATE INDEX restaurant_happy_hour_company_item_enabled_idx
  ON restaurant_happy_hour_promotions(company_id, menu_item_id, is_enabled);

CREATE TABLE restaurant_inventory_settings (
  company_id CHAR(24) PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  recipe_shortage_mode VARCHAR(16) NOT NULL DEFAULT 'warn'
    CHECK (recipe_shortage_mode IN ('warn', 'require_manager', 'block')),
  station_warehouse_overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by_id CHAR(24),
  updated_at TIMESTAMPTZ(3) NOT NULL
);

CREATE TABLE restaurant_stock_commitments (
  id CHAR(24) PRIMARY KEY,
  company_id CHAR(24) NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  order_id CHAR(24) NOT NULL,
  order_item_id CHAR(24) NOT NULL,
  product_id CHAR(24) NOT NULL,
  warehouse_id CHAR(24) NOT NULL,
  quantity NUMERIC(19, 6) NOT NULL CHECK (quantity > 0),
  source_type VARCHAR(16) NOT NULL DEFAULT 'recipe' CHECK (source_type IN ('recipe', 'bar_measure')),
  serving_count INTEGER NOT NULL DEFAULT 0 CHECK (serving_count >= 0),
  purchase_unit_code VARCHAR(24),
  purchase_unit_volume NUMERIC(19, 6),
  status VARCHAR(16) NOT NULL DEFAULT 'committed'
    CHECK (status IN ('committed', 'deducted', 'waste', 'returned')),
  unit_cost NUMERIC(19, 6),
  total_cost NUMERIC(19, 4),
  committed_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at TIMESTAMPTZ(3),
  voided_at TIMESTAMPTZ(3),
  void_decision VARCHAR(16),
  CONSTRAINT restaurant_stock_commitments_company_item_product_warehouse_key
    UNIQUE (company_id, order_item_id, product_id, warehouse_id)
);
CREATE INDEX restaurant_stock_commitments_available_idx
  ON restaurant_stock_commitments(company_id, product_id, warehouse_id, status);
CREATE INDEX restaurant_stock_commitments_order_status_idx
  ON restaurant_stock_commitments(company_id, order_id, status);

ALTER TYPE "StockMovementReason" ADD VALUE IF NOT EXISTS 'restaurant_recipe';
