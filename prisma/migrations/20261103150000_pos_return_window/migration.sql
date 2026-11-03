ALTER TABLE "pos_payment_settings"
  ADD COLUMN IF NOT EXISTS "pos_return_window_days" INTEGER NOT NULL DEFAULT 30;

ALTER TABLE "pos_payment_settings"
  ADD CONSTRAINT "pos_payment_settings_pos_return_window_days_check"
  CHECK ("pos_return_window_days" BETWEEN 0 AND 3650);
