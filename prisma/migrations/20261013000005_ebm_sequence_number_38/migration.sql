ALTER TABLE "ebm_sequences"
  ALTER COLUMN "last_number" TYPE NUMERIC(38, 0)
  USING "last_number"::NUMERIC(38, 0);
