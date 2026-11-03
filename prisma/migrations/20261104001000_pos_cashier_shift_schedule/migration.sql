ALTER TABLE "pos_register_access"
  ADD COLUMN "shift_days" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "shift_start_time" VARCHAR(5),
  ADD COLUMN "shift_end_time" VARCHAR(5);
