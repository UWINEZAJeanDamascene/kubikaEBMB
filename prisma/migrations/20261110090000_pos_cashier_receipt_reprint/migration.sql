-- Cashiers may prepare a copy of an already signed receipt. The POS reprint
-- service still requires a reason and writes an audit record for every copy.

CREATE OR REPLACE FUNCTION pg_temp.pos_add_cashier_reprint(source jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  result jsonb := '[]'::jsonb;
  entry jsonb;
  actions jsonb;
  found_till boolean := false;
BEGIN
  IF jsonb_typeof(source) <> 'array' THEN RETURN source; END IF;

  FOR entry IN SELECT value FROM jsonb_array_elements(source)
  LOOP
    IF entry->>'resource' = 'pos.till' THEN
      found_till := true;
      actions := COALESCE(entry->'actions', '[]'::jsonb);
      IF jsonb_typeof(actions) = 'array'
        AND NOT actions @> '["reprint"]'::jsonb THEN
        entry := jsonb_set(entry, '{actions}', actions || '["reprint"]'::jsonb, true);
      END IF;
    END IF;
    result := result || jsonb_build_array(entry);
  END LOOP;

  IF NOT found_till THEN
    result := result || '[{"resource":"pos.till","actions":["reprint"]}]'::jsonb;
  END IF;
  RETURN result;
END;
$$;

UPDATE roles
SET permissions = pg_temp.pos_add_cashier_reprint(permissions), updated_at = NOW()
WHERE lower(name) IN ('cashier', 'sales')
  AND jsonb_typeof(permissions) = 'array';

UPDATE role_permission_overrides overrides
SET permissions = pg_temp.pos_add_cashier_reprint(overrides.permissions), updated_at = NOW()
FROM roles
WHERE roles.id = overrides.role_id
  AND lower(roles.name) IN ('cashier', 'sales')
  AND jsonb_typeof(overrides.permissions) = 'array';

CREATE OR REPLACE FUNCTION pg_temp.pos_add_cashier_reprint_matrix(source jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  result jsonb := source;
  role_name text;
  role_config jsonb;
  permissions jsonb;
  merged_permissions jsonb;
BEGIN
  IF jsonb_typeof(source) <> 'object' THEN RETURN source; END IF;

  FOR role_name, role_config IN SELECT key, value FROM jsonb_each(source)
  LOOP
    IF lower(role_name) NOT IN ('cashier', 'sales') THEN CONTINUE; END IF;

    IF jsonb_typeof(role_config) = 'array' THEN
      permissions := role_config;
      SELECT COALESCE(jsonb_agg(to_jsonb(permission) ORDER BY permission), '[]'::jsonb)
      INTO merged_permissions
      FROM (
        SELECT DISTINCT jsonb_array_elements_text(permissions || '["pos.till.reprint"]'::jsonb) AS permission
      ) merged;
      result := jsonb_set(result, ARRAY[role_name], merged_permissions, false);
    ELSIF jsonb_typeof(role_config) = 'object'
      AND jsonb_typeof(role_config->'permissions') = 'array' THEN
      permissions := role_config->'permissions';
      SELECT COALESCE(jsonb_agg(to_jsonb(permission) ORDER BY permission), '[]'::jsonb)
      INTO merged_permissions
      FROM (
        SELECT DISTINCT jsonb_array_elements_text(permissions || '["pos.till.reprint"]'::jsonb) AS permission
      ) merged;
      result := jsonb_set(result, ARRAY[role_name, 'permissions'], merged_permissions, false);
    END IF;
  END LOOP;
  RETURN result;
END;
$$;

UPDATE system_settings
SET pos_role_permissions = pg_temp.pos_add_cashier_reprint_matrix(pos_role_permissions), updated_at = NOW()
WHERE jsonb_typeof(pos_role_permissions) = 'object'
  AND EXISTS (
    SELECT 1 FROM jsonb_object_keys(pos_role_permissions) AS keys(role_name)
    WHERE lower(role_name) IN ('cashier', 'sales')
  );
