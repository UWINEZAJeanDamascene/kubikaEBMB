CREATE TABLE "pos_effective_prices" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "price_list_id" CHAR(24),
  "product_id" CHAR(24) NOT NULL,
  "price" DECIMAL(19,4) NOT NULL,
  "effective_from" TIMESTAMPTZ(3) NOT NULL,
  "effective_to" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_effective_prices_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "pos_effective_prices_company_product_from_idx"
  ON "pos_effective_prices" ("company_id", "product_id", "effective_from" DESC);
CREATE INDEX "pos_effective_prices_company_list_product_from_idx"
  ON "pos_effective_prices" ("company_id", "price_list_id", "product_id", "effective_from" DESC);
CREATE UNIQUE INDEX "pos_effective_prices_standard_open_key"
  ON "pos_effective_prices" ("company_id", "product_id")
  WHERE "price_list_id" IS NULL AND "effective_to" IS NULL;
CREATE UNIQUE INDEX "pos_effective_prices_list_open_key"
  ON "pos_effective_prices" ("company_id", "price_list_id", "product_id")
  WHERE "price_list_id" IS NOT NULL AND "effective_to" IS NULL;

INSERT INTO "pos_effective_prices" (
  "id", "company_id", "product_id", "price", "effective_from"
)
SELECT SUBSTRING(MD5(random()::text || clock_timestamp()::text || product."id"), 1, 24),
       product."company_id", product."id", product."selling_price",
       COALESCE(product."updated_at", product."created_at", CURRENT_TIMESTAMP)
  FROM "products" product;

INSERT INTO "pos_effective_prices" (
  "id", "company_id", "price_list_id", "product_id", "price", "effective_from"
)
SELECT SUBSTRING(MD5(random()::text || clock_timestamp()::text || item."id"), 1, 24),
       item."company_id", item."price_list_id", item."product_id", item."price",
       COALESCE(item."updated_at", item."created_at", CURRENT_TIMESTAMP)
  FROM "price_list_items" item;

CREATE FUNCTION maintain_pos_standard_price_history() RETURNS TRIGGER AS $$
DECLARE
  change_time TIMESTAMPTZ(3) := clock_timestamp();
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."selling_price" IS NOT DISTINCT FROM NEW."selling_price" THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    UPDATE "pos_effective_prices"
       SET "effective_to" = change_time
     WHERE "company_id" = OLD."company_id"
       AND "product_id" = OLD."id"
       AND "price_list_id" IS NULL
       AND "effective_to" IS NULL;
  END IF;
  INSERT INTO "pos_effective_prices" (
    "id", "company_id", "product_id", "price", "effective_from"
  ) VALUES (
    SUBSTRING(MD5(random()::text || clock_timestamp()::text || NEW."id"), 1, 24),
    NEW."company_id", NEW."id", NEW."selling_price", change_time
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "products_pos_standard_price_history"
  AFTER INSERT OR UPDATE ON "products"
  FOR EACH ROW EXECUTE FUNCTION maintain_pos_standard_price_history();

CREATE FUNCTION maintain_pos_list_price_history() RETURNS TRIGGER AS $$
DECLARE
  change_time TIMESTAMPTZ(3) := clock_timestamp();
  row_company_id CHAR(24);
  row_price_list_id CHAR(24);
  row_product_id CHAR(24);
  row_price DECIMAL(19,4);
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."price" IS NOT DISTINCT FROM NEW."price"
    AND OLD."price_list_id" IS NOT DISTINCT FROM NEW."price_list_id" THEN
    RETURN NEW;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    UPDATE "pos_effective_prices"
       SET "effective_to" = change_time
     WHERE "company_id" = OLD."company_id"
       AND "price_list_id" = OLD."price_list_id"
       AND "product_id" = OLD."product_id"
       AND "effective_to" IS NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  row_company_id := NEW."company_id";
  row_price_list_id := NEW."price_list_id";
  row_product_id := NEW."product_id";
  row_price := NEW."price";
  INSERT INTO "pos_effective_prices" (
    "id", "company_id", "price_list_id", "product_id", "price", "effective_from"
  ) VALUES (
    SUBSTRING(MD5(random()::text || clock_timestamp()::text || NEW."id"), 1, 24),
    row_company_id, row_price_list_id, row_product_id, row_price, change_time
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "price_list_items_pos_price_history"
  AFTER INSERT OR UPDATE OR DELETE ON "price_list_items"
  FOR EACH ROW EXECUTE FUNCTION maintain_pos_list_price_history();

CREATE TABLE "pos_sync_changes" (
  "id" BIGSERIAL NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "entity_type" VARCHAR(24) NOT NULL,
  "entity_id" VARCHAR(64) NOT NULL,
  "warehouse_id" CHAR(24),
  "deleted" BOOLEAN NOT NULL DEFAULT FALSE,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_sync_changes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "pos_sync_changes_company_cursor_idx"
  ON "pos_sync_changes" ("company_id", "id");
CREATE INDEX "pos_sync_changes_company_type_cursor_idx"
  ON "pos_sync_changes" ("company_id", "entity_type", "id");

CREATE FUNCTION record_pos_sync_change() RETURNS TRIGGER AS $$
DECLARE
  current_row JSONB;
  company_value CHAR(24);
  entity_value VARCHAR(24);
  entity_id_value VARCHAR(64);
  warehouse_value CHAR(24);
  deleted_value BOOLEAN := TG_OP = 'DELETE';
BEGIN
  current_row := CASE WHEN TG_OP = 'DELETE' THEN TO_JSONB(OLD) ELSE TO_JSONB(NEW) END;
  company_value := current_row->>'company_id';
  IF company_value IS NULL THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(735153, HASHtext(company_value));
  IF TG_TABLE_NAME = 'products' THEN
    entity_value := 'catalog';
    entity_id_value := current_row->>'id';
    deleted_value := deleted_value OR COALESCE((current_row->>'is_active')::BOOLEAN, FALSE) = FALSE
      OR COALESCE((current_row->>'is_archived')::BOOLEAN, FALSE) = TRUE;
  ELSIF TG_TABLE_NAME = 'categories' THEN
    INSERT INTO "pos_sync_changes" ("company_id", "entity_type", "entity_id", "deleted")
    SELECT company_value, 'catalog', product."id", FALSE
      FROM "products" product
     WHERE product."company_id" = company_value
       AND product."category_id" = current_row->>'id';
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  ELSIF TG_TABLE_NAME = 'stock_levels' THEN
    entity_value := 'catalog';
    entity_id_value := current_row->>'product_id';
    warehouse_value := current_row->>'warehouse_id';
    deleted_value := FALSE;
  ELSIF TG_TABLE_NAME = 'price_list_items' THEN
    entity_value := 'prices';
    entity_id_value := current_row->>'product_id';
  ELSIF TG_TABLE_NAME = 'price_lists' THEN
    INSERT INTO "pos_sync_changes" ("company_id", "entity_type", "entity_id", "deleted")
    SELECT company_value, 'prices', item."product_id", FALSE
      FROM "price_list_items" item
     WHERE item."company_id" = company_value
       AND item."price_list_id" = current_row->>'id';
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  ELSIF TG_TABLE_NAME = 'clients' THEN
    entity_value := 'customers';
    entity_id_value := current_row->>'id';
    deleted_value := deleted_value OR COALESCE((current_row->>'is_active')::BOOLEAN, TRUE) = FALSE;
  ELSIF TG_TABLE_NAME = 'warehouses' THEN
    entity_value := 'warehouses';
    entity_id_value := current_row->>'id';
    warehouse_value := current_row->>'id';
    deleted_value := deleted_value OR COALESCE((current_row->>'is_active')::BOOLEAN, TRUE) = FALSE;
  ELSE
    entity_value := 'settings';
    entity_id_value := current_row->>'id';
  END IF;

  IF TG_TABLE_NAME = 'warehouses'
    AND (TG_OP = 'INSERT' OR OLD."price_list_id" IS DISTINCT FROM NEW."price_list_id") THEN
    INSERT INTO "pos_sync_changes" (
      "company_id", "entity_type", "entity_id", "warehouse_id", "deleted"
    )
    SELECT company_value, 'prices', product."id", current_row->>'id', FALSE
      FROM "products" product
     WHERE product."company_id" = company_value;
  END IF;

  INSERT INTO "pos_sync_changes" (
    "company_id", "entity_type", "entity_id", "warehouse_id", "deleted"
  ) VALUES (
    company_value, entity_value, entity_id_value, warehouse_value, deleted_value
  );
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "products_pos_sync_change"
  AFTER INSERT OR UPDATE OR DELETE ON "products"
  FOR EACH ROW EXECUTE FUNCTION record_pos_sync_change();
CREATE TRIGGER "categories_pos_sync_change"
  AFTER INSERT OR UPDATE OR DELETE ON "categories"
  FOR EACH ROW EXECUTE FUNCTION record_pos_sync_change();
CREATE TRIGGER "stock_levels_pos_sync_change"
  AFTER INSERT OR UPDATE OR DELETE ON "stock_levels"
  FOR EACH ROW EXECUTE FUNCTION record_pos_sync_change();
CREATE TRIGGER "price_list_items_pos_sync_change"
  AFTER INSERT OR UPDATE OR DELETE ON "price_list_items"
  FOR EACH ROW EXECUTE FUNCTION record_pos_sync_change();
CREATE TRIGGER "price_lists_pos_sync_change"
  AFTER INSERT OR UPDATE OR DELETE ON "price_lists"
  FOR EACH ROW EXECUTE FUNCTION record_pos_sync_change();
CREATE TRIGGER "clients_pos_sync_change"
  AFTER INSERT OR UPDATE OR DELETE ON "clients"
  FOR EACH ROW EXECUTE FUNCTION record_pos_sync_change();
CREATE TRIGGER "warehouses_pos_sync_change"
  AFTER INSERT OR UPDATE OR DELETE ON "warehouses"
  FOR EACH ROW EXECUTE FUNCTION record_pos_sync_change();
CREATE TRIGGER "system_settings_pos_sync_change"
  AFTER INSERT OR UPDATE OR DELETE ON "system_settings"
  FOR EACH ROW EXECUTE FUNCTION record_pos_sync_change();

INSERT INTO "pos_sync_changes" ("company_id", "entity_type", "entity_id", "deleted")
SELECT product."company_id", 'catalog', product."id",
       NOT COALESCE(product."is_active", FALSE)
  FROM "products" product
UNION ALL
SELECT item."company_id", 'prices', item."product_id", FALSE
  FROM "price_list_items" item
UNION ALL
SELECT client."company_id", 'customers', client."id",
       NOT COALESCE(client."is_active", TRUE)
  FROM "clients" client
UNION ALL
SELECT warehouse."company_id", 'warehouses', warehouse."id",
       NOT COALESCE(warehouse."is_active", TRUE)
  FROM "warehouses" warehouse
UNION ALL
SELECT setting."company_id", 'settings', setting."id", FALSE
  FROM "system_settings" setting;

CREATE TABLE "pos_receipt_number_allocations" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "device_id" VARCHAR(160) NOT NULL,
  "register_id" CHAR(24) NOT NULL,
  "block_id" CHAR(24) NOT NULL,
  "block_index" INTEGER NOT NULL,
  "receipt_number" VARCHAR(100) NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "operation_id" VARCHAR(100),
  "used_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_receipt_number_allocations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_receipt_number_allocations_company_number_key" UNIQUE ("company_id", "receipt_number"),
  CONSTRAINT "pos_receipt_number_allocations_device_block_index_key" UNIQUE ("company_id", "device_id", "block_id", "block_index"),
  CONSTRAINT "pos_receipt_number_allocations_device_operation_key" UNIQUE ("company_id", "device_id", "operation_id")
);
CREATE INDEX "pos_receipt_number_allocations_device_expiry_idx"
  ON "pos_receipt_number_allocations" ("company_id", "device_id", "register_id", "expires_at");
