ALTER TABLE "companies"
  ADD COLUMN IF NOT EXISTS "ebm_enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "ebm_toggle_reason" TEXT,
  ADD COLUMN IF NOT EXISTS "ebm_toggle_changed_at" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "ebm_toggle_changed_by" CHAR(24);
