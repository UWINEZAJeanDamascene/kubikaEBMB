-- Split POS audit/security workspace permissions into read, export, verify,
-- and update capabilities. Existing broad grants remain available to read
-- views only through the compatibility map; sensitive actions are explicit.

CREATE OR REPLACE FUNCTION pg_temp.add_permission_actions(
  source jsonb,
  target_resource text,
  added_actions jsonb
) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  result jsonb := '[]'::jsonb;
  existing_actions jsonb := '[]'::jsonb;
  entry jsonb;
  merged_actions jsonb;
BEGIN
  IF jsonb_typeof(source) <> 'array' THEN RETURN source; END IF;
  FOR entry IN SELECT value FROM jsonb_array_elements(source)
  LOOP
    IF entry->>'resource' = target_resource THEN
      existing_actions := existing_actions || COALESCE(entry->'actions', '[]'::jsonb);
    ELSE
      result := result || jsonb_build_array(entry);
    END IF;
  END LOOP;
  SELECT COALESCE(jsonb_agg(to_jsonb(action) ORDER BY action), '[]'::jsonb)
  INTO merged_actions
  FROM (
    SELECT DISTINCT jsonb_array_elements_text(existing_actions || added_actions) AS action
  ) actions;
  RETURN result || jsonb_build_array(jsonb_build_object(
    'resource', target_resource,
    'actions', merged_actions
  ));
END;
$$;

UPDATE roles
SET permissions = pg_temp.add_permission_actions(
      pg_temp.add_permission_actions(
        permissions,
        'pos.admin.audit',
        '["read", "export", "verify"]'::jsonb
      ),
      'pos.admin.security',
      '["read", "update"]'::jsonb
    )
WHERE is_system_role = TRUE
  AND lower(name) IN ('admin', 'manager', 'store_manager', 'owner')
  AND jsonb_typeof(permissions) = 'array';

CREATE OR REPLACE FUNCTION pg_temp.add_session_permission_actions(
  source jsonb,
  role_name text,
  additions jsonb
) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  result jsonb := source;
  role_config jsonb;
  current_permissions jsonb;
  merged_permissions jsonb;
BEGIN
  IF jsonb_typeof(source) <> 'object' OR NOT (source ? role_name) THEN RETURN source; END IF;
  role_config := source->role_name;
  IF jsonb_typeof(role_config) = 'array' THEN
    current_permissions := role_config;
  ELSIF jsonb_typeof(role_config) = 'object'
    AND jsonb_typeof(role_config->'permissions') = 'array' THEN
    current_permissions := role_config->'permissions';
  ELSE
    RETURN source;
  END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(permission) ORDER BY permission), '[]'::jsonb)
  INTO merged_permissions
  FROM (
    SELECT DISTINCT jsonb_array_elements_text(current_permissions || additions) AS permission
  ) values_to_merge;
  IF jsonb_typeof(role_config) = 'array' THEN
    result := jsonb_set(source, ARRAY[role_name], merged_permissions, FALSE);
  ELSE
    result := jsonb_set(source, ARRAY[role_name, 'permissions'], merged_permissions, FALSE);
  END IF;
  RETURN result;
END;
$$;

UPDATE system_settings
SET pos_role_permissions = pg_temp.add_session_permission_actions(
      pg_temp.add_session_permission_actions(
        pos_role_permissions,
        'manager',
        '["pos.admin.audit.read", "pos.admin.audit.export", "pos.admin.audit.verify", "pos.admin.security.read", "pos.admin.security.update"]'::jsonb
      ),
      'owner',
      '["pos.admin.audit.read", "pos.admin.audit.export", "pos.admin.audit.verify", "pos.admin.security.read", "pos.admin.security.update"]'::jsonb
    )
WHERE jsonb_typeof(pos_role_permissions) = 'object';
