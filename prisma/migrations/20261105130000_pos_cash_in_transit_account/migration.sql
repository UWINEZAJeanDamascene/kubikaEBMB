WITH available_codes AS (
  SELECT company.id AS company_id,
         code.code::text AS account_code
    FROM companies company
    CROSS JOIN generate_series(1120, 1190, 10) AS code(code)
   WHERE NOT EXISTS (
           SELECT 1
             FROM chart_of_accounts account
            WHERE account.company_id = company.id
              AND account.code = code.code::text
         )
     AND NOT EXISTS (
           SELECT 1
             FROM chart_of_accounts account
            WHERE account.company_id = company.id
              AND account.name = 'Cash in Transit (Bank Deposit Clearing)'
         )
),
selected_codes AS (
  SELECT DISTINCT ON (company_id) company_id, account_code
    FROM available_codes
   ORDER BY company_id, account_code
)
INSERT INTO chart_of_accounts (
  id,
  company_id,
  code,
  name,
  type,
  subtype,
  normal_balance,
  allow_direct_posting,
  is_active,
  custom_fields,
  created_at,
  updated_at
)
SELECT SUBSTRING(MD5(company_id::text || ':' || account_code || ':cash-in-transit'), 1, 24),
       company_id,
       account_code,
       'Cash in Transit (Bank Deposit Clearing)',
       'asset'::"AccountType",
       'cash_equivalent',
       'debit'::"NormalBalance",
       TRUE,
       TRUE,
       '{}'::jsonb,
       CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP
  FROM selected_codes
ON CONFLICT (company_id, code) DO NOTHING;
