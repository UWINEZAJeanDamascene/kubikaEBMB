-- Managers may create and revoke private digital receipt links. Cashier
-- permissions are intentionally unchanged. Preserve the company's existing
-- POS role permission matrix and its array/object entry format.
CREATE OR REPLACE FUNCTION pg_temp.add_manager_receipt_link_permissions(source jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  result jsonb := source;
  role_name text;
  role_config jsonb;
  permissions jsonb;
  merged_permissions jsonb;
  receipt_permissions jsonb := '["pos.receipt.share", "pos.receipt.manage"]'::jsonb;
BEGIN
  IF jsonb_typeof(source) <> 'object' THEN RETURN source; END IF;

  FOR role_name, role_config IN SELECT key, value FROM jsonb_each(source)
  LOOP
    IF lower(role_name) NOT IN ('manager', 'store_manager') THEN CONTINUE; END IF;

    IF jsonb_typeof(role_config) = 'array' THEN
      permissions := role_config;
      SELECT COALESCE(jsonb_agg(to_jsonb(permission) ORDER BY permission), '[]'::jsonb)
      INTO merged_permissions
      FROM (
        SELECT DISTINCT jsonb_array_elements_text(permissions || receipt_permissions) AS permission
      ) merged;
      result := jsonb_set(result, ARRAY[role_name], merged_permissions, FALSE);
    ELSIF jsonb_typeof(role_config) = 'object'
      AND jsonb_typeof(role_config->'permissions') = 'array' THEN
      permissions := role_config->'permissions';
      SELECT COALESCE(jsonb_agg(to_jsonb(permission) ORDER BY permission), '[]'::jsonb)
      INTO merged_permissions
      FROM (
        SELECT DISTINCT jsonb_array_elements_text(permissions || receipt_permissions) AS permission
      ) merged;
      result := jsonb_set(result, ARRAY[role_name, 'permissions'], merged_permissions, FALSE);
    END IF;
  END LOOP;

  RETURN result;
END;
$$;

UPDATE system_settings
SET pos_role_permissions = pg_temp.add_manager_receipt_link_permissions(pos_role_permissions)
WHERE jsonb_typeof(pos_role_permissions) = 'object'
  AND EXISTS (
    SELECT 1 FROM jsonb_object_keys(pos_role_permissions) AS keys(role_name)
    WHERE lower(role_name) IN ('manager', 'store_manager')
  );
