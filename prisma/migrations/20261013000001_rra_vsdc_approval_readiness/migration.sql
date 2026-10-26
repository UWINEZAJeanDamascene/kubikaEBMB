ALTER TABLE "companies"
  ADD COLUMN "rra_vsdc_approval_status" TEXT NOT NULL DEFAULT 'not_confirmed',
  ADD COLUMN "rra_vsdc_approval_reference" TEXT,
  ADD COLUMN "rra_vsdc_approval_reason" TEXT,
  ADD COLUMN "rra_vsdc_approved_at" TIMESTAMPTZ(3),
  ADD COLUMN "rra_vsdc_approved_by" CHAR(24);

ALTER TABLE "companies"
  ADD CONSTRAINT "companies_rra_vsdc_approval_status_check"
  CHECK ("rra_vsdc_approval_status" IN ('not_confirmed', 'approved'));
