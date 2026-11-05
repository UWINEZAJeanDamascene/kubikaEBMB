ALTER TABLE "system_settings"
  ADD COLUMN IF NOT EXISTS "pos_gift_card_settings" JSONB NOT NULL
  DEFAULT '{"maxPerCard":100000,"dailyLimitPerCashier":300000,"tillTypeOverrides":{}}'::jsonb;
