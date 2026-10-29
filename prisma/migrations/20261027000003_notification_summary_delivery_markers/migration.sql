ALTER TABLE "notification_settings"
  ADD COLUMN "last_daily_summary_date" VARCHAR(10),
  ADD COLUMN "last_weekly_summary_date" VARCHAR(10);
