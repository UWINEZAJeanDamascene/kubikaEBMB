ALTER TABLE "system_settings"
ADD COLUMN "pos_security_settings" JSONB NOT NULL DEFAULT '{}'::jsonb;
