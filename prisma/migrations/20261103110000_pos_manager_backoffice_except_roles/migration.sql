-- Managers receive the full POS Back Office. POS role administration remains
-- owner-only. Preserve every existing permission and company-specific setting.
CREATE OR REPLACE FUNCTION pg_temp.add_pos_manager_backoffice_permissions(source jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  result jsonb := '[]'::jsonb;
  entry jsonb;
  existing_actions jsonb := '[]'::jsonb;
  manager_actions jsonb := '[
    "view", "reports", "cashiers", "registers", "printers",
    "settings", "shifts", "approvals", "audit"
  ]'::jsonb;
  merged_actions jsonb;
BEGIN
  IF jsonb_typeof(source) <> 'array' THEN RETURN source; END IF;

  FOR entry IN SELECT value FROM jsonb_array_elements(source)
  LOOP
    IF entry->>'resource' = 'pos.admin' THEN
      existing_actions := existing_actions || COALESCE(entry->'actions', '[]'::jsonb);
    ELSE
      result := result || jsonb_build_array(entry);
    END IF;
  END LOOP;

  SELECT COALESCE(jsonb_agg(to_jsonb(action) ORDER BY action), '[]'::jsonb)
  INTO merged_actions
  FROM (
    SELECT DISTINCT jsonb_array_elements_text(existing_actions || manager_actions) AS action
  ) actions
  WHERE action <> 'roles';

  RETURN result
    || jsonb_build_array(jsonb_build_object('resource', 'pos.admin', 'actions', merged_actions))
    || jsonb_build_array(jsonb_build_object('resource', 'tills', 'actions', jsonb_build_array('read', 'create')))
    || jsonb_build_array(jsonb_build_object('resource', 'ebm', 'actions', jsonb_build_array('read')));
END;
$$;

UPDATE roles
SET permissions = pg_temp.add_pos_manager_backoffice_permissions(permissions)
WHERE is_system_role = TRUE
  AND lower(name) IN ('manager', 'store_manager')
  AND jsonb_typeof(permissions) = 'array';

CREATE OR REPLACE FUNCTION pg_temp.add_pos_manager_backoffice_session_permissions(source jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  result jsonb := source;
  role_name text;
  role_config jsonb;
  permissions jsonb;
  merged_permissions jsonb;
  extra_permissions jsonb := '[
    "pos.admin.view", "pos.admin.reports", "pos.admin.cashiers",
    "pos.admin.registers", "pos.admin.printers", "pos.admin.settings",
    "pos.admin.shifts", "pos.admin.approvals", "pos.admin.audit",
    "pos.shift.settings", "pos.payment.settings",
    "pos.payment.manual_confirm", "pos.giftcard.manage"
  ]'::jsonb;
BEGIN
  IF jsonb_typeof(source) <> 'object' THEN RETURN source; END IF;

  FOR role_name, role_config IN SELECT key, value FROM jsonb_each(source)
  LOOP
    IF lower(role_name) <> 'manager' THEN CONTINUE; END IF;

    IF jsonb_typeof(role_config) = 'array' THEN
      permissions := role_config;
      SELECT COALESCE(jsonb_agg(to_jsonb(permission) ORDER BY permission), '[]'::jsonb)
      INTO merged_permissions
      FROM (
        SELECT DISTINCT jsonb_array_elements_text(permissions || extra_permissions) AS permission
      ) merged;
      -- Role administration remains owner-only even if an older matrix granted it.
      merged_permissions := (
        SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
        FROM jsonb_array_elements(merged_permissions) AS item(value)
        WHERE value #>> '{}' <> 'pos.admin.roles'
      );
      result := jsonb_set(result, ARRAY[role_name], merged_permissions, FALSE);
    ELSIF jsonb_typeof(role_config) = 'object'
      AND jsonb_typeof(role_config->'permissions') = 'array' THEN
      permissions := role_config->'permissions';
      SELECT COALESCE(jsonb_agg(to_jsonb(permission) ORDER BY permission), '[]'::jsonb)
      INTO merged_permissions
      FROM (
        SELECT DISTINCT jsonb_array_elements_text(permissions || extra_permissions) AS permission
      ) merged;
      -- Role administration remains owner-only even if an older matrix granted it.
      merged_permissions := (
        SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
        FROM jsonb_array_elements(merged_permissions) AS item(value)
        WHERE value #>> '{}' <> 'pos.admin.roles'
      );
      result := jsonb_set(result, ARRAY[role_name, 'permissions'], merged_permissions, FALSE);
    END IF;
  END LOOP;

  RETURN result;
END;
$$;

UPDATE system_settings
SET pos_role_permissions = pg_temp.add_pos_manager_backoffice_session_permissions(pos_role_permissions)
WHERE jsonb_typeof(pos_role_permissions) = 'object'
  AND EXISTS (
    SELECT 1 FROM jsonb_object_keys(pos_role_permissions) AS keys(role_name)
    WHERE lower(role_name) = 'manager'
  );
