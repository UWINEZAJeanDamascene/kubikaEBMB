CREATE TABLE "pos_cheque_deposits" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "bank_account_id" CHAR(24) NOT NULL,
  "bank_account_code" VARCHAR(32) NOT NULL,
  "idempotency_key" VARCHAR(100) NOT NULL,
  "payload_hash" CHAR(64) NOT NULL,
  "deposit_date" TIMESTAMPTZ(3) NOT NULL,
  "bank_slip_reference" VARCHAR(100) NOT NULL,
  "total_amount" INTEGER NOT NULL,
  "posting_status" VARCHAR(16) NOT NULL DEFAULT 'pending',
  "journal_entry_id" CHAR(24),
  "created_by_id" CHAR(24) NOT NULL,
  "approved_by_id" CHAR(24),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "pos_cheque_deposits_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_cheque_deposits_total_amount_check" CHECK ("total_amount" > 0),
  CONSTRAINT "pos_cheque_deposits_posting_status_check" CHECK ("posting_status" IN ('pending', 'posted', 'failed')),
  CONSTRAINT "pos_cheque_deposits_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_cheque_deposits_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "bank_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "pos_cheques" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "invoice_id" CHAR(24) NOT NULL,
  "payment_id" CHAR(24),
  "tender_index" INTEGER NOT NULL,
  "reference" VARCHAR(160) NOT NULL,
  "amount" INTEGER NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'in_hand',
  "cheques_in_hand_account_code" VARCHAR(32),
  "sale_posting_status" VARCHAR(16) NOT NULL DEFAULT 'pending',
  "sale_journal_entry_id" CHAR(24),
  "deposit_id" CHAR(24),
  "deposited_at" TIMESTAMPTZ(3),
  "bounced_at" TIMESTAMPTZ(3),
  "bounced_by_id" CHAR(24),
  "bounce_reason" VARCHAR(500),
  "bounce_idempotency_key" VARCHAR(100),
  "bounce_payload_hash" CHAR(64),
  "bounce_posting_status" VARCHAR(16),
  "bounce_journal_entry_id" CHAR(24),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "pos_cheques_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_cheques_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "pos_cheques_status_check" CHECK ("status" IN ('in_hand', 'deposited', 'bounced')),
  CONSTRAINT "pos_cheques_sale_posting_status_check" CHECK ("sale_posting_status" IN ('pending', 'posted', 'failed')),
  CONSTRAINT "pos_cheques_bounce_posting_status_check" CHECK ("bounce_posting_status" IS NULL OR "bounce_posting_status" IN ('pending', 'posted', 'failed')),
  CONSTRAINT "pos_cheques_state_check" CHECK (
    ("status" = 'in_hand' AND "deposit_id" IS NULL AND "deposited_at" IS NULL AND "bounced_at" IS NULL)
    OR ("status" = 'deposited' AND "deposit_id" IS NOT NULL AND "deposited_at" IS NOT NULL AND "bounced_at" IS NULL)
    OR ("status" = 'bounced' AND "bounced_at" IS NOT NULL AND "bounce_reason" IS NOT NULL
      AND ("deposit_id" IS NULL OR "deposited_at" IS NOT NULL))
  ),
  CONSTRAINT "pos_cheques_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pos_cheques_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pos_cheques_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "pos_payments"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "pos_cheques_deposit_id_fkey" FOREIGN KEY ("deposit_id") REFERENCES "pos_cheque_deposits"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "pos_cheque_deposits_company_id_idempotency_key_key"
  ON "pos_cheque_deposits"("company_id", "idempotency_key");
CREATE INDEX "pos_cheque_deposits_company_id_deposit_date_idx"
  ON "pos_cheque_deposits"("company_id", "deposit_date");
CREATE INDEX "pos_cheque_deposits_company_id_posting_status_idx"
  ON "pos_cheque_deposits"("company_id", "posting_status");
CREATE UNIQUE INDEX "pos_cheques_payment_id_key"
  ON "pos_cheques"("payment_id");
CREATE UNIQUE INDEX "pos_cheques_company_id_invoice_id_tender_index_key"
  ON "pos_cheques"("company_id", "invoice_id", "tender_index");
CREATE UNIQUE INDEX "pos_cheques_company_id_bounce_idempotency_key_key"
  ON "pos_cheques"("company_id", "bounce_idempotency_key");
CREATE INDEX "pos_cheques_company_id_status_created_at_idx"
  ON "pos_cheques"("company_id", "status", "created_at");
CREATE INDEX "pos_cheques_company_id_invoice_id_idx"
  ON "pos_cheques"("company_id", "invoice_id");
CREATE INDEX "pos_cheques_company_id_deposit_id_idx"
  ON "pos_cheques"("company_id", "deposit_id");

-- Capture existing POS cheque tenders so they can be deposited or bounced after deployment.
INSERT INTO "pos_cheques" (
  "id", "company_id", "invoice_id", "payment_id", "tender_index",
  "reference", "amount", "status", "sale_posting_status",
  "sale_journal_entry_id", "created_at", "updated_at"
)
SELECT
  SUBSTRING(MD5('pos-cheque:' || invoice."id" || ':' || (tender.ordinality - 1)::text), 1, 24),
  invoice."company_id",
  invoice."id",
  payment."id",
  (tender.ordinality - 1)::integer,
  LEFT(COALESCE(NULLIF(tender.payment->>'reference', ''), payment."reference"), 160),
  ROUND((tender.payment->>'amount')::numeric)::integer,
  'in_hand',
  COALESCE(invoice."pos_posting_status", 'posted'),
  invoice."revenue_journal_entry_id",
  invoice."created_at",
  CURRENT_TIMESTAMP
FROM "invoices" AS invoice
CROSS JOIN LATERAL JSONB_ARRAY_ELEMENTS(COALESCE(invoice."payments", '[]'::jsonb))
  WITH ORDINALITY AS tender(payment, ordinality)
LEFT JOIN "pos_payments" AS payment
  ON payment."company_id" = invoice."company_id"
 AND payment."sale_id" = invoice."id"
 AND payment."id" = NULLIF(tender.payment->>'posPaymentId', '')
WHERE invoice."pos_origin" = TRUE
  AND invoice."status" IN ('fully_paid', 'partially_paid')
  AND LOWER(COALESCE(tender.payment->>'paymentMethod', '')) = 'cheque'
  AND COALESCE(NULLIF(tender.payment->>'reference', ''), payment."reference") IS NOT NULL
  AND ROUND((tender.payment->>'amount')::numeric) > 0
ON CONFLICT DO NOTHING;
