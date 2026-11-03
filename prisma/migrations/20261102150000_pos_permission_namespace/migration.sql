-- Copy existing POS-related RBAC grants into the canonical capability namespace.
-- Legacy grants remain in place for older screens and mixed-version deployments.
CREATE OR REPLACE FUNCTION pg_temp.pos_migrate_role_permissions(source jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  till_actions jsonb := '[]'::jsonb;
  admin_actions jsonb := '[]'::jsonb;
  result jsonb;
  mapping record;
BEGIN
  IF jsonb_typeof(source) <> 'array' THEN RETURN source; END IF;
  result := source;
  FOR mapping IN
    SELECT * FROM (VALUES
      ('point_of_sale','read','pos.till','enter'),
      ('point_of_sale','read','pos.till','reprint'),
      ('point_of_sale','read','pos.till','share_receipt'),
      ('point_of_sale','create','pos.till','sell'),
      ('point_of_sale','create','pos.till','open_shift'),
      ('point_of_sale','create','pos.till','discount'),
      ('point_of_sale','create','pos.till','cash_move'),
      ('point_of_sale','create','pos.till','credit_sell'),
      ('point_of_sale','create','pos.till','receive_account_payment'),
      ('point_of_sale','open','pos.till','no_sale'),
      ('tills','read','pos.admin','view'),
      ('tills','read','pos.admin','shifts'),
      ('tills','read','pos.admin','approvals'),
      ('tills','create','pos.admin','view'),
      ('tills','create','pos.admin','registers'),
      ('tills','create','pos.admin','cashiers'),
      ('tills','create','pos.admin','printers'),
      ('tills','create','pos.admin','settings'),
      ('roles','update','pos.admin','roles'),
      ('reports','read','pos.admin','reports'),
      ('audit_trail','read','pos.admin','audit')
    ) AS m(old_resource, old_action, new_resource, new_action)
  LOOP
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(source) p
      WHERE p->>'resource' = mapping.old_resource
        AND COALESCE(p->'actions', '[]'::jsonb) @> jsonb_build_array(mapping.old_action)
    ) THEN
      IF mapping.new_resource = 'pos.till' THEN
        till_actions := till_actions || jsonb_build_array(mapping.new_action);
      ELSE
        admin_actions := admin_actions || jsonb_build_array(mapping.new_action);
      END IF;
    END IF;
  END LOOP;

  IF jsonb_array_length(till_actions) > 0 THEN
    SELECT COALESCE(jsonb_agg(DISTINCT action), '[]'::jsonb) INTO till_actions
    FROM (
      SELECT jsonb_array_elements_text(till_actions) AS action
      UNION ALL
      SELECT jsonb_array_elements_text(p->'actions')
      FROM jsonb_array_elements(source) p WHERE p->>'resource' = 'pos.till'
    ) a;
    result := (SELECT COALESCE(jsonb_agg(p), '[]'::jsonb) FROM jsonb_array_elements(result) p WHERE p->>'resource' <> 'pos.till');
    result := result || jsonb_build_array(jsonb_build_object('resource','pos.till','actions',till_actions));
  ELSIF EXISTS (SELECT 1 FROM jsonb_array_elements(source) p WHERE p->>'resource' = 'pos.till') THEN
    SELECT COALESCE(jsonb_agg(p), '[]'::jsonb) INTO result FROM jsonb_array_elements(source) p WHERE p->>'resource' <> 'pos.till';
    result := result || (SELECT jsonb_agg(p) FROM jsonb_array_elements(source) p WHERE p->>'resource' = 'pos.till');
  END IF;

  IF jsonb_array_length(admin_actions) > 0 THEN
    SELECT COALESCE(jsonb_agg(DISTINCT action), '[]'::jsonb) INTO admin_actions
    FROM (
      SELECT jsonb_array_elements_text(admin_actions) AS action
      UNION ALL
      SELECT jsonb_array_elements_text(p->'actions')
      FROM jsonb_array_elements(source) p WHERE p->>'resource' = 'pos.admin'
    ) a;
    result := (SELECT COALESCE(jsonb_agg(p), '[]'::jsonb) FROM jsonb_array_elements(result) p WHERE p->>'resource' <> 'pos.admin');
    result := result || jsonb_build_array(jsonb_build_object('resource','pos.admin','actions',admin_actions));
  ELSIF EXISTS (SELECT 1 FROM jsonb_array_elements(source) p WHERE p->>'resource' = 'pos.admin') THEN
    SELECT COALESCE(jsonb_agg(p), '[]'::jsonb) INTO result FROM jsonb_array_elements(result) p WHERE p->>'resource' <> 'pos.admin';
    result := result || (SELECT jsonb_agg(p) FROM jsonb_array_elements(source) p WHERE p->>'resource' = 'pos.admin');
  END IF;
  RETURN result;
END;
$$;

UPDATE roles SET permissions = pg_temp.pos_migrate_role_permissions(permissions)
WHERE jsonb_typeof(permissions) = 'array';
UPDATE role_permission_overrides SET permissions = pg_temp.pos_migrate_role_permissions(permissions)
WHERE jsonb_typeof(permissions) = 'array';

-- Migrate session permission aliases inside per-role POS matrices. Keep the old
-- strings too so rollback and mixed-version clients remain compatible.
CREATE OR REPLACE FUNCTION pg_temp.pos_migrate_session_matrix(source jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  role_name text;
  role_config jsonb;
  original_permissions jsonb;
  migrated_permissions jsonb;
  mapping record;
  result jsonb := source;
BEGIN
  IF jsonb_typeof(source) <> 'object' THEN RETURN source; END IF;
  FOR role_name, role_config IN SELECT key, value FROM jsonb_each(source)
  LOOP
    IF jsonb_typeof(role_config) = 'array' THEN
      original_permissions := role_config;
    ELSIF jsonb_typeof(role_config) = 'object' AND jsonb_typeof(role_config->'permissions') = 'array' THEN
      original_permissions := role_config->'permissions';
    ELSE
      CONTINUE;
    END IF;
    migrated_permissions := original_permissions;
    FOR mapping IN SELECT * FROM (VALUES
      ('pos.shift.open','pos.till.open_shift'),
      ('pos.shift.close','pos.till.close_shift'),
      ('pos.payment.take','pos.till.sell'),
      ('pos.payment.refund','pos.till.refund'),
      ('pos.receipt.reprint','pos.till.reprint'),
      ('pos.receipt.share','pos.till.share_receipt'),
      ('pos.credit.sell','pos.till.credit_sell')
    ) AS m(old_permission, new_permission)
    LOOP
      IF original_permissions @> jsonb_build_array(mapping.old_permission)
        AND NOT migrated_permissions @> jsonb_build_array(mapping.new_permission) THEN
        migrated_permissions := migrated_permissions || jsonb_build_array(mapping.new_permission);
      END IF;
    END LOOP;
    IF jsonb_typeof(role_config) = 'array' THEN
      result := jsonb_set(result, ARRAY[role_name], migrated_permissions, false);
    ELSE
      result := jsonb_set(result, ARRAY[role_name,'permissions'], migrated_permissions, false);
    END IF;
  END LOOP;
  RETURN result;
END;
$$;

UPDATE system_settings
SET pos_role_permissions = pg_temp.pos_migrate_session_matrix(pos_role_permissions)
WHERE jsonb_typeof(pos_role_permissions) = 'object';
