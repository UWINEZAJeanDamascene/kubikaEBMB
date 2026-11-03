ALTER TABLE "system_settings"
  ADD COLUMN "pos_loyalty_settings" JSONB NOT NULL DEFAULT '{"pointValueRwf":1}'::jsonb;
