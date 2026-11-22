ALTER TABLE "pos_print_printers"
  DROP CONSTRAINT "pos_print_printers_role_check",
  ADD CONSTRAINT "pos_print_printers_role_check"
    CHECK ("role" IN ('receipt','report','a4','kitchen','bar'));

ALTER TABLE "pos_print_jobs"
  DROP CONSTRAINT "pos_print_jobs_type_check",
  ADD CONSTRAINT "pos_print_jobs_type_check"
    CHECK ("job_type" IN ('receipt','refund-receipt','gift-card-slip','x-report','z-report','cash-movement-slip','drawer-open','invoice-pdf','statement-pdf','report-pdf','test-print','restaurant-ticket'));
