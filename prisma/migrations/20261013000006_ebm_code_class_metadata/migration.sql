ALTER TABLE "ebm_codes"
  ADD COLUMN "code_class_description" TEXT,
  ADD COLUMN "class_user_defined_name_1" TEXT,
  ADD COLUMN "class_user_defined_name_2" TEXT,
  ADD COLUMN "class_user_defined_name_3" TEXT,
  ADD COLUMN "code_class_use_yn" TEXT,
  ADD COLUMN "code_class_source" JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN "user_defined_code_1" TEXT,
  ADD COLUMN "user_defined_code_2" TEXT,
  ADD COLUMN "user_defined_code_3" TEXT,
  ADD COLUMN "use_yn" TEXT;
