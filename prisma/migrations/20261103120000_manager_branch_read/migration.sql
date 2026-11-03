-- Register branch options are backed by company warehouse/branch records.
-- Managers need read access to choose an active branch during register setup.
UPDATE roles
SET permissions = permissions || '[{"resource":"warehouses","actions":["read"]}]'::jsonb
WHERE is_system_role = TRUE
  AND lower(name) IN ('manager', 'store_manager')
  AND jsonb_typeof(permissions) = 'array'
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(roles.permissions) AS entries(permission)
    WHERE permission->>'resource' = 'warehouses'
      AND COALESCE(permission->'actions', '[]'::jsonb) @> '["read"]'::jsonb
  );
