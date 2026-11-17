ALTER TABLE "system_settings"
  ADD COLUMN "pos_drawer_settings" JSONB NOT NULL
    DEFAULT '{"companyDefaults":{"cashSale":true,"onlyWhenChangeDue":false,"paidIn":false,"paidOut":false,"shiftOpen":false,"shiftClose":false,"noSale":true},"tillTypeOverrides":{},"registerOverrides":{}}',
  ADD COLUMN "pos_hardware_settings" JSONB NOT NULL
    DEFAULT '{"tillTypeOverrides":{},"registerOverrides":{}}';

ALTER TABLE "pos_print_drawer_authorizations"
  ADD COLUMN "outcome_at" TIMESTAMPTZ(3);

ALTER TABLE "pos_print_printers"
  ADD COLUMN "role" VARCHAR(20) NOT NULL DEFAULT 'receipt',
  ADD COLUMN "paper_size" VARCHAR(16) NOT NULL DEFAULT 'thermal',
  ADD COLUMN "copies" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "tray" VARCHAR(80),
  ADD COLUMN "duplex" BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT "pos_print_printers_role_check" CHECK ("role" IN ('receipt','report','a4')),
  ADD CONSTRAINT "pos_print_printers_paper_size_check" CHECK ("paper_size" IN ('thermal','a4')),
  ADD CONSTRAINT "pos_print_printers_copies_check" CHECK ("copies" BETWEEN 1 AND 10);

CREATE TABLE "pos_hardware_devices" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "register_id" CHAR(24) NOT NULL,
  "printer_id" CHAR(24),
  "kind" VARCHAR(24) NOT NULL,
  "name" VARCHAR(160) NOT NULL,
  "connection" VARCHAR(30) NOT NULL,
  "address" VARCHAR(255) NOT NULL,
  "profile_json" JSONB NOT NULL DEFAULT '{}',
  "status" VARCHAR(30) NOT NULL DEFAULT 'unknown',
  "last_seen_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "pos_hardware_devices_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_hardware_devices_printer_id_key" UNIQUE ("printer_id"),
  CONSTRAINT "pos_hardware_devices_identity_key" UNIQUE ("company_id","register_id","kind","connection","address"),
  CONSTRAINT "pos_hardware_devices_kind_check" CHECK ("kind" IN ('printer','drawer','scanner'))
);

INSERT INTO "pos_hardware_devices" (
  "id","company_id","register_id","printer_id","kind","name","connection","address",
  "profile_json","status","last_seen_at","updated_at"
)
SELECT
  p."id", p."company_id", a."register_id", p."id", 'printer', p."name", p."transport", p."address",
  jsonb_build_object(
    'role', p."role",
    'paperSize', p."paper_size",
    'paperWidthMm', p."paper_width_mm",
    'columns', p."columns",
    'codePage', p."code_page",
    'copies', p."copies",
    'tray', p."tray",
    'duplex', p."duplex",
    'drawerEnabled', p."drawer_enabled",
    'drawerPin', p."drawer_pin",
    'pulseOnMs', p."pulse_on_ms",
    'pulseOffMs', p."pulse_off_ms",
    'isDefault', p."is_default"
  ),
  p."status", a."last_seen_at", CURRENT_TIMESTAMP
FROM "pos_print_printers" p
JOIN "pos_print_agents" a ON a."id" = p."agent_id" AND a."company_id" = p."company_id"
WHERE a."register_id" IS NOT NULL
ORDER BY p."company_id", a."register_id", p."transport", p."address",
         p."is_default" DESC, p."created_at", p."id"
ON CONFLICT DO NOTHING;

CREATE INDEX "pos_hardware_devices_company_register_kind_status_idx"
  ON "pos_hardware_devices" ("company_id","register_id","kind","status");

ALTER TABLE "pos_hardware_devices"
  ADD CONSTRAINT "pos_hardware_devices_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_hardware_devices_register_id_fkey"
    FOREIGN KEY ("register_id") REFERENCES "pos_registers"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_hardware_devices_printer_id_fkey"
    FOREIGN KEY ("printer_id") REFERENCES "pos_print_printers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "pos_print_documents" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "register_id" CHAR(24) NOT NULL,
  "document_type" VARCHAR(40) NOT NULL,
  "source_document_id" VARCHAR(64) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "payload_json" JSONB,
  "pdf_bytes" BYTEA,
  "payload_hash" CHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(3),
  CONSTRAINT "pos_print_documents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_print_documents_identity_key" UNIQUE ("company_id","register_id","document_type","source_document_id","version"),
  CONSTRAINT "pos_print_documents_version_check" CHECK ("version" > 0),
  CONSTRAINT "pos_print_documents_payload_check" CHECK ("payload_json" IS NOT NULL OR "pdf_bytes" IS NOT NULL)
);

CREATE INDEX "pos_print_documents_company_register_expiry_idx"
  ON "pos_print_documents" ("company_id","register_id","expires_at");

ALTER TABLE "pos_print_documents"
  ADD CONSTRAINT "pos_print_documents_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_print_documents_register_id_fkey"
    FOREIGN KEY ("register_id") REFERENCES "pos_registers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "pos_print_jobs"
  ADD COLUMN "document_id" CHAR(24),
  ADD COLUMN "document_version" INTEGER;

ALTER TABLE "pos_print_jobs"
  DROP CONSTRAINT "pos_print_jobs_status_check",
  DROP CONSTRAINT "pos_print_jobs_type_check",
  ADD CONSTRAINT "pos_print_jobs_status_check"
    CHECK ("status" IN ('queued','leased','transmitting','transmitted','confirmed','failed','expired','uncertain','cancelled')),
  ADD CONSTRAINT "pos_print_jobs_type_check"
    CHECK ("job_type" IN ('receipt','refund-receipt','gift-card-slip','x-report','z-report','cash-movement-slip','drawer-open','invoice-pdf','statement-pdf','report-pdf','test-print')),
  ADD CONSTRAINT "pos_print_jobs_document_version_check"
    CHECK ("document_version" IS NULL OR "document_version" > 0),
  ADD CONSTRAINT "pos_print_jobs_document_id_fkey"
    FOREIGN KEY ("document_id") REFERENCES "pos_print_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "pos_print_jobs_document_idx" ON "pos_print_jobs" ("document_id","document_version");
