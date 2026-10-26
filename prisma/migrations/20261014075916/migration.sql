/*
  Warnings:

  - You are about to drop the column `plan_name` on the `subscriptions` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "pos_promotions" DROP CONSTRAINT "pos_promotions_created_by_id_fkey";

-- DropForeignKey
ALTER TABLE "pos_sale_requests" DROP CONSTRAINT "pos_sale_requests_company_id_fkey";

-- DropForeignKey
ALTER TABLE "pos_sale_requests" DROP CONSTRAINT "pos_sale_requests_created_by_id_fkey";

-- DropForeignKey
ALTER TABLE "pos_sale_requests" DROP CONSTRAINT "pos_sale_requests_invoice_id_fkey";

-- DropForeignKey
ALTER TABLE "stock_transfer_discrepancies" DROP CONSTRAINT "stock_transfer_discrepancies_company_id_fkey";

-- DropIndex
DROP INDEX "credit_notes_company_status_refund_idx";

-- DropIndex
DROP INDEX "ebm_tins_active_idx";

-- DropIndex
DROP INDEX "ebm_tins_tin_taxpayer_name_idx";

-- DropIndex
DROP INDEX "products_company_active_name_id_idx";

-- DropIndex
DROP INDEX "till_sessions_company_id_opened_by_status_idx";

-- DropIndex
DROP INDEX "till_sessions_company_register_status_idx";

-- AlterTable
ALTER TABLE "ai_action_proposals" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "ai_findings" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "backups" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "cash_drawers" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "fixed_deposits" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "import_logs" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "import_templates" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "interest_accruals" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "liabilities" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "payment_schedules" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "pos_offline_conflicts" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "pos_promotions" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "pos_registers" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "pos_stored_value_accounts" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "precomputed_aggregations" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "price_list_items" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "price_lists" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "subscriptions" DROP COLUMN "plan_name",
ADD COLUMN     "planName" TEXT,
ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "system_settings" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "testimonials" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "warehouse_inventory_costs" ALTER COLUMN "updated_at" DROP DEFAULT;

-- CreateIndex
CREATE INDEX "products_company_active_name_id_idx" ON "clients"("company_id", "is_active", "name", "id");

-- CreateIndex
CREATE INDEX "till_sessions_company_id_opened_by_register_id_status_idx" ON "till_sessions"("company_id", "opened_by", "register_id", "status");

-- AddForeignKey
ALTER TABLE "till_sessions" ADD CONSTRAINT "till_sessions_handover_from_id_fkey" FOREIGN KEY ("handover_from_id") REFERENCES "till_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "ai_alert_daily_usage_company_user_date_key" RENAME TO "ai_alert_daily_usage_company_id_user_id_alert_date_key";

-- RenameIndex
ALTER INDEX "ai_finding_alert_deliveries_company_user_date_idx" RENAME TO "ai_finding_alert_deliveries_company_id_user_id_alert_date_idx";

-- RenameIndex
ALTER INDEX "ai_finding_alert_deliveries_company_user_finding_date_key" RENAME TO "ai_finding_alert_deliveries_company_id_user_id_finding_id_a_key";

-- RenameIndex
ALTER INDEX "ai_finding_user_states_company_user_finding_key" RENAME TO "ai_finding_user_states_company_id_user_id_finding_id_key";

-- RenameIndex
ALTER INDEX "ai_finding_user_states_company_user_state_snoozed_idx" RENAME TO "ai_finding_user_states_company_id_user_id_state_snoozed_unt_idx";

-- RenameIndex
ALTER INDEX "ai_forecasts_company_type_created_at_idx" RENAME TO "ai_forecasts_company_id_forecast_type_created_at_idx";

-- RenameIndex
ALTER INDEX "ai_reports_company_report_type_generated_at_idx" RENAME TO "ai_reports_company_id_report_type_generated_at_idx";

-- RenameIndex
ALTER INDEX "backups_company_created_at_idx" RENAME TO "backups_company_id_created_at_idx";

-- RenameIndex
ALTER INDEX "backups_company_status_idx" RENAME TO "backups_company_id_status_idx";

-- RenameIndex
ALTER INDEX "backups_company_type_idx" RENAME TO "backups_company_id_type_idx";

-- RenameIndex
ALTER INDEX "cash_drawers_company_drawer_id_key" RENAME TO "cash_drawers_company_id_drawer_id_key";

-- RenameIndex
ALTER INDEX "cash_drawers_company_status_idx" RENAME TO "cash_drawers_company_id_status_idx";

-- RenameIndex
ALTER INDEX "ebm_devices_company_id_branch_id_device_serial_no_environment_k" RENAME TO "ebm_devices_company_id_branch_id_device_serial_no_environme_key";

-- RenameIndex
ALTER INDEX "ebm_submission_queues_operation_environment_key" RENAME TO "ebm_submission_queues_company_id_document_type_document_id__key";

-- RenameIndex
ALTER INDEX "fixed_deposits_company_maturity_date_idx" RENAME TO "fixed_deposits_company_id_maturity_date_idx";

-- RenameIndex
ALTER INDEX "fixed_deposits_company_status_idx" RENAME TO "fixed_deposits_company_id_status_idx";

-- RenameIndex
ALTER INDEX "import_logs_company_entity_started_idx" RENAME TO "import_logs_company_id_entity_type_started_at_idx";

-- RenameIndex
ALTER INDEX "import_templates_company_entity_idx" RENAME TO "import_templates_company_id_entity_type_idx";

-- RenameIndex
ALTER INDEX "import_templates_company_entity_name_key" RENAME TO "import_templates_company_id_entity_type_name_key";

-- RenameIndex
ALTER INDEX "interest_accruals_company_bank_period_key" RENAME TO "interest_accruals_company_id_bank_account_id_period_month_p_key";

-- RenameIndex
ALTER INDEX "interest_accruals_company_deposit_period_key" RENAME TO "interest_accruals_company_id_fixed_deposit_id_period_month__key";

-- RenameIndex
ALTER INDEX "interest_accruals_company_status_idx" RENAME TO "interest_accruals_company_id_status_idx";

-- RenameIndex
ALTER INDEX "liabilities_company_reference_no_key" RENAME TO "liabilities_company_id_reference_no_key";

-- RenameIndex
ALTER INDEX "liabilities_company_status_idx" RENAME TO "liabilities_company_id_status_idx";

-- RenameIndex
ALTER INDEX "payment_schedules_company_purchase_idx" RENAME TO "payment_schedules_company_id_purchase_id_idx";

-- RenameIndex
ALTER INDEX "payment_schedules_company_scheduled_date_idx" RENAME TO "payment_schedules_company_id_scheduled_date_idx";

-- RenameIndex
ALTER INDEX "payment_schedules_company_status_idx" RENAME TO "payment_schedules_company_id_status_idx";

-- RenameIndex
ALTER INDEX "payment_schedules_company_supplier_idx" RENAME TO "payment_schedules_company_id_supplier_id_idx";

-- RenameIndex
ALTER INDEX "payroll_audit_events_company_actor_created_idx" RENAME TO "payroll_audit_events_company_id_actor_user_id_created_at_idx";

-- RenameIndex
ALTER INDEX "payroll_audit_events_company_entity_created_idx" RENAME TO "payroll_audit_events_company_id_entity_type_entity_id_creat_idx";

-- RenameIndex
ALTER INDEX "payroll_period_inputs_company_id_employee_id_period_year_period" RENAME TO "payroll_period_inputs_company_id_employee_id_period_year_pe_key";

-- RenameIndex
ALTER INDEX "payroll_period_inputs_company_id_period_year_period_month_statu" RENAME TO "payroll_period_inputs_company_id_period_year_period_month_s_idx";

-- RenameIndex
ALTER INDEX "pos_manager_approvals_company_cashier_action_exp_idx" RENAME TO "pos_manager_approvals_company_id_cashier_id_action_expires__idx";

-- RenameIndex
ALTER INDEX "pos_manager_approvals_company_subject_action_idx" RENAME TO "pos_manager_approvals_company_id_subject_id_action_idx";

-- RenameIndex
ALTER INDEX "pos_offline_conflicts_company_invoice_idx" RENAME TO "pos_offline_conflicts_company_id_invoice_id_idx";

-- RenameIndex
ALTER INDEX "pos_offline_conflicts_company_status_escalation_idx" RENAME TO "pos_offline_conflicts_company_id_status_escalation_at_idx";

-- RenameIndex
ALTER INDEX "pos_offline_sales_company_offline_sale_key" RENAME TO "pos_offline_sales_company_id_offline_sale_id_key";

-- RenameIndex
ALTER INDEX "pos_offline_sales_company_register_synced_idx" RENAME TO "pos_offline_sales_company_id_register_id_synced_at_idx";

-- RenameIndex
ALTER INDEX "pos_offline_sales_company_request_key" RENAME TO "pos_offline_sales_company_id_request_key_key";

-- RenameIndex
ALTER INDEX "pos_offline_sales_company_snapshot_synced_idx" RENAME TO "pos_offline_sales_company_id_snapshot_id_synced_at_idx";

-- RenameIndex
ALTER INDEX "pos_offline_snapshots_binding_idx" RENAME TO "pos_offline_snapshots_company_id_user_id_device_id_register_idx";

-- RenameIndex
ALTER INDEX "pos_sale_request_recoveries_company_original_created_idx" RENAME TO "pos_sale_request_recoveries_company_id_original_request_key_idx";

-- RenameIndex
ALTER INDEX "pos_sale_request_recoveries_company_replacement_key" RENAME TO "pos_sale_request_recoveries_company_id_replacement_request__key";

-- RenameIndex
ALTER INDEX "pos_stored_value_accounts_company_client_kind_currency_key" RENAME TO "pos_stored_value_accounts_company_id_client_id_kind_currenc_key";

-- RenameIndex
ALTER INDEX "pos_stored_value_accounts_company_client_kind_idx" RENAME TO "pos_stored_value_accounts_company_id_client_id_kind_idx";

-- RenameIndex
ALTER INDEX "pos_stored_value_accounts_company_code_hash_key" RENAME TO "pos_stored_value_accounts_company_id_code_hash_key";

-- RenameIndex
ALTER INDEX "pos_stored_value_accounts_company_kind_active_idx" RENAME TO "pos_stored_value_accounts_company_id_kind_is_active_idx";

-- RenameIndex
ALTER INDEX "pos_stored_value_ledger_company_account_created_idx" RENAME TO "pos_stored_value_ledger_company_id_account_id_created_at_idx";

-- RenameIndex
ALTER INDEX "pos_stored_value_ledger_company_invoice_idx" RENAME TO "pos_stored_value_ledger_company_id_invoice_id_idx";

-- RenameIndex
ALTER INDEX "project_material_requisition_lines_company_id_product_id_wareho" RENAME TO "project_material_requisition_lines_company_id_product_id_wa_idx";

-- RenameIndex
ALTER INDEX "project_material_requisition_lines_company_id_project_id_task_i" RENAME TO "project_material_requisition_lines_company_id_project_id_ta_idx";

-- RenameIndex
ALTER INDEX "subscriptions_company_status_idx" RENAME TO "subscriptions_company_id_status_idx";

-- RenameIndex
ALTER INDEX "warehouse_inventory_costs_company_product_idx" RENAME TO "warehouse_inventory_costs_company_id_product_id_idx";

-- RenameIndex
ALTER INDEX "warehouse_inventory_costs_company_warehouse_idx" RENAME TO "warehouse_inventory_costs_company_id_warehouse_id_idx";

-- RenameIndex
ALTER INDEX "warehouse_inventory_costs_company_warehouse_product_key" RENAME TO "warehouse_inventory_costs_company_id_warehouse_id_product_i_key";
