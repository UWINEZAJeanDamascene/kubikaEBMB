CREATE OR REPLACE FUNCTION record_pos_sync_change() RETURNS TRIGGER AS $$
DECLARE
  current_row JSONB;
  company_value CHAR(24);
  entity_value VARCHAR(24);
  entity_id_value VARCHAR(64);
  warehouse_value CHAR(24);
  deleted_value BOOLEAN := TG_OP = 'DELETE';
  warehouse_price_list_changed BOOLEAN := FALSE;
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

  IF TG_TABLE_NAME = 'warehouses' THEN
    IF TG_OP IN ('INSERT', 'DELETE') THEN
      warehouse_price_list_changed := TRUE;
    ELSIF TG_OP = 'UPDATE' THEN
      warehouse_price_list_changed := OLD."price_list_id" IS DISTINCT FROM NEW."price_list_id";
    END IF;
  END IF;
  IF warehouse_price_list_changed THEN
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
