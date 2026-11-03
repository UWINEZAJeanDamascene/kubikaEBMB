CREATE TABLE "pos_print_pairing_codes" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "register_id" CHAR(24),
  "name" VARCHAR(120) NOT NULL,
  "code_hash" CHAR(64) NOT NULL,
  "created_by_id" CHAR(24) NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "used_at" TIMESTAMPTZ(3),
  "used_agent_id" CHAR(24),
  "revoked_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_print_pairing_codes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_print_pairing_codes_code_hash_key" UNIQUE ("code_hash")
);

CREATE INDEX "pos_print_pairing_codes_company_id_register_id_expires_at_idx"
  ON "pos_print_pairing_codes" ("company_id", "register_id", "expires_at");

CREATE TABLE "pos_print_agents" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "register_id" CHAR(24),
  "name" VARCHAR(120) NOT NULL,
  "device_id" VARCHAR(80) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
  "access_token_hash" CHAR(64) NOT NULL,
  "refresh_token_hash" CHAR(64) NOT NULL,
  "access_expires_at" TIMESTAMPTZ(3) NOT NULL,
  "platform" VARCHAR(20) NOT NULL DEFAULT 'windows',
  "version" VARCHAR(40),
  "last_seen_at" TIMESTAMPTZ(3),
  "last_error" TEXT,
  "revoked_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "pos_print_agents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_print_agents_access_token_hash_key" UNIQUE ("access_token_hash"),
  CONSTRAINT "pos_print_agents_refresh_token_hash_key" UNIQUE ("refresh_token_hash"),
  CONSTRAINT "pos_print_agents_company_id_device_id_key" UNIQUE ("company_id", "device_id"),
  CONSTRAINT "pos_print_agents_status_check" CHECK ("status" IN ('pending','active','revoked'))
);

CREATE INDEX "pos_print_agents_company_id_register_id_status_idx"
  ON "pos_print_agents" ("company_id", "register_id", "status");

CREATE TABLE "pos_print_printers" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "agent_id" CHAR(24) NOT NULL,
  "name" VARCHAR(160) NOT NULL,
  "transport" VARCHAR(30) NOT NULL,
  "address" VARCHAR(255) NOT NULL,
  "paper_width_mm" INTEGER NOT NULL DEFAULT 80,
  "columns" INTEGER NOT NULL DEFAULT 42,
  "drawer_enabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "drawer_pin" INTEGER NOT NULL DEFAULT 2,
  "pulse_on_ms" INTEGER NOT NULL DEFAULT 25,
  "pulse_off_ms" INTEGER NOT NULL DEFAULT 500,
  "is_default" BOOLEAN NOT NULL DEFAULT FALSE,
  "status" VARCHAR(30) NOT NULL DEFAULT 'unknown',
  "last_error" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "pos_print_printers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_print_printers_agent_id_name_transport_address_key" UNIQUE ("agent_id", "name", "transport", "address"),
  CONSTRAINT "pos_print_printers_transport_check" CHECK ("transport" IN ('tcp9100','windows-spooler','serial','usb','unknown')),
  CONSTRAINT "pos_print_printers_paper_width_check" CHECK ("paper_width_mm" IN (58,80)),
  CONSTRAINT "pos_print_printers_columns_check" CHECK ("columns" BETWEEN 20 AND 80),
  CONSTRAINT "pos_print_printers_drawer_pin_check" CHECK ("drawer_pin" IN (2,5)),
  CONSTRAINT "pos_print_printers_pulse_check" CHECK ("pulse_on_ms" BETWEEN 1 AND 1000 AND "pulse_off_ms" BETWEEN 50 AND 5000),
  CONSTRAINT "pos_print_printers_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "pos_print_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "pos_print_printers_agent_id_is_default_idx"
  ON "pos_print_printers" ("agent_id", "is_default");

CREATE TABLE "pos_print_jobs" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "register_id" CHAR(24) NOT NULL,
  "agent_id" CHAR(24),
  "printer_id" CHAR(24),
  "job_type" VARCHAR(40) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'queued',
  "idempotency_key" VARCHAR(160) NOT NULL,
  "payload_json" JSONB NOT NULL,
  "payload_hash" CHAR(64) NOT NULL,
  "copy_required" BOOLEAN NOT NULL DEFAULT FALSE,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 8,
  "lease_timeout_seconds" INTEGER NOT NULL DEFAULT 30,
  "lease_token_hash" CHAR(64),
  "leased_until" TIMESTAMPTZ(3),
  "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "transmitted_at" TIMESTAMPTZ(3),
  "confirmed_at" TIMESTAMPTZ(3),
  "acknowledged_at" TIMESTAMPTZ(3),
  "last_error" TEXT,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "created_by_id" CHAR(24),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "pos_print_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pos_print_jobs_company_id_idempotency_key_key" UNIQUE ("company_id", "idempotency_key"),
  CONSTRAINT "pos_print_jobs_status_check" CHECK ("status" IN ('queued','leased','transmitting','transmitted','confirmed','failed','expired')),
  CONSTRAINT "pos_print_jobs_type_check" CHECK ("job_type" IN ('receipt','refund-receipt','drawer-open','invoice-pdf','report-pdf','test-print')),
  CONSTRAINT "pos_print_jobs_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "pos_print_agents"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "pos_print_jobs_printer_id_fkey" FOREIGN KEY ("printer_id") REFERENCES "pos_print_printers"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "pos_print_jobs_register_id_fkey" FOREIGN KEY ("register_id") REFERENCES "pos_registers"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "pos_print_jobs_company_id_register_id_status_idx"
  ON "pos_print_jobs" ("company_id", "register_id", "status");
CREATE INDEX "pos_print_jobs_agent_id_status_available_at_idx"
  ON "pos_print_jobs" ("agent_id", "status", "available_at");
CREATE INDEX "pos_print_jobs_expiry_idx"
  ON "pos_print_jobs" ("expires_at");

ALTER TABLE "pos_print_pairing_codes"
  ADD CONSTRAINT "pos_print_pairing_codes_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_print_pairing_codes_register_id_fkey" FOREIGN KEY ("register_id") REFERENCES "pos_registers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_print_pairing_codes_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_print_pairing_codes_used_agent_id_fkey" FOREIGN KEY ("used_agent_id") REFERENCES "pos_print_agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "pos_print_agents"
  ADD CONSTRAINT "pos_print_agents_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_print_agents_register_id_fkey" FOREIGN KEY ("register_id") REFERENCES "pos_registers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "pos_print_printers"
  ADD CONSTRAINT "pos_print_printers_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "pos_print_jobs"
  ADD CONSTRAINT "pos_print_jobs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_print_jobs_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
