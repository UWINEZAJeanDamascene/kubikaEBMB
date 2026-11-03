-- The POS permission namespace migration translated broad legacy grants into
-- individual POS capabilities. For the built-in cashier role those derived
-- grants must remain least-privilege: no admin surface or sensitive actions.
CREATE OR REPLACE FUNCTION pg_temp.pos_cashier_permissions(source jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  result jsonb := '[]'::jsonb;
  entry jsonb;
  resource text;
  actions jsonb;
  filtered jsonb;
BEGIN
  IF jsonb_typeof(source) <> 'array' THEN RETURN source; END IF;
  FOR entry IN SELECT value FROM jsonb_array_elements(source)
  LOOP
    resource := entry->>'resource';
    actions := COALESCE(entry->'actions', '[]'::jsonb);
    IF resource IN ('pos.admin', 'tills', 'roles', 'audit_trail') THEN CONTINUE; END IF;
    IF resource = 'pos.till' THEN
      SELECT COALESCE(jsonb_agg(value), '[]'::jsonb) INTO filtered
      FROM jsonb_array_elements(actions) AS item(value)
      WHERE value #>> '{}' IN ('sell','cash_move','close_shift','discount','receive_account_payment','open_shift');
      IF jsonb_array_length(filtered) = 0 THEN CONTINUE; END IF;
      entry := jsonb_set(entry, '{actions}', filtered, true);
    END IF;
    result := result || jsonb_build_array(entry);
  END LOOP;
  RETURN result;
END;
$$;

UPDATE roles
SET permissions = pg_temp.pos_cashier_permissions(permissions)
WHERE lower(name) IN ('cashier', 'sales')
  AND jsonb_typeof(permissions) = 'array';

UPDATE role_permission_overrides overrides
SET permissions = pg_temp.pos_cashier_permissions(overrides.permissions)
FROM roles
WHERE roles.id = overrides.role_id
  AND lower(roles.name) IN ('cashier', 'sales')
  AND jsonb_typeof(overrides.permissions) = 'array';

-- Apply the same policy to per-company POS session matrices. Preserve unrelated
-- roles and the matrix's existing array/object wrapper format.
CREATE OR REPLACE FUNCTION pg_temp.pos_cashier_session_permissions(source jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  result jsonb := source;
  role_name text;
  role_config jsonb;
  permissions jsonb;
  filtered jsonb;
BEGIN
  IF jsonb_typeof(source) <> 'object' THEN RETURN source; END IF;
  FOR role_name, role_config IN SELECT key, value FROM jsonb_each(source)
  LOOP
    IF lower(role_name) NOT IN ('cashier', 'sales') THEN CONTINUE; END IF;
    IF jsonb_typeof(role_config) = 'array' THEN
      permissions := role_config;
      SELECT COALESCE(jsonb_agg(value), '[]'::jsonb) INTO filtered
      FROM jsonb_array_elements(permissions)
      WHERE value #>> '{}' IN (
        'pos.till.sell','pos.till.cash_move','pos.till.close_shift','pos.till.discount',
        'pos.till.receive_account_payment','pos.till.open_shift',
        'pos.payment.take','pos.shift.open','pos.shift.close','pos.cash.in','pos.cash.out',
        'pos.cash.safe_drop','pos.report.x'
      );
      result := jsonb_set(result, ARRAY[role_name], filtered, false);
    ELSIF jsonb_typeof(role_config) = 'object' AND jsonb_typeof(role_config->'permissions') = 'array' THEN
      permissions := role_config->'permissions';
      SELECT COALESCE(jsonb_agg(value), '[]'::jsonb) INTO filtered
      FROM jsonb_array_elements(permissions)
      WHERE value #>> '{}' IN (
        'pos.till.sell','pos.till.cash_move','pos.till.close_shift','pos.till.discount',
        'pos.till.receive_account_payment','pos.till.open_shift',
        'pos.payment.take','pos.shift.open','pos.shift.close','pos.cash.in','pos.cash.out',
        'pos.cash.safe_drop','pos.report.x'
      );
      result := jsonb_set(result, ARRAY[role_name,'permissions'], filtered, false);
    END IF;
  END LOOP;
  RETURN result;
END;
$$;

UPDATE system_settings
SET pos_role_permissions = pg_temp.pos_cashier_session_permissions(pos_role_permissions)
WHERE jsonb_typeof(pos_role_permissions) = 'object';
