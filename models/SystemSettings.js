'use strict';

const { buildTenantModel } = require('../utils/masterDataCommon');
const { generateObjectId, toIdString } = require('../utils/objectId');

const fields = {
  company_id: 'companyId', invoice_prefix: 'invoicePrefix', invoice_footer_text: 'invoiceFooterText',
  invoice_payment_instructions: 'invoicePaymentInstructions', default_invoice_due_days: 'defaultInvoiceDueDays',
  default_quote_expiry_days: 'defaultQuoteExpiryDays', auto_apply_vat: 'autoApplyVat', default_vat_rate_id: 'defaultVatRateId',
  default_costing_method: 'defaultCostingMethod', allow_negative_stock: 'allowNegativeStock', low_stock_alert_enabled: 'lowStockAlertEnabled',
  auto_reorder_enabled: 'autoReorderEnabled', auto_reorder_create_documents: 'autoReorderCreateDocuments',
  auto_reorder_safety_stock_days: 'autoReorderSafetyStockDays', auto_reorder_sales_lookback_days: 'autoReorderSalesLookbackDays',
  auto_reorder_direct_purchase_threshold: 'autoReorderDirectPurchaseThreshold', auto_reorder_created_by: 'autoReorderCreatedBy',
  require_po_approval: 'requirePoApproval', po_approval_threshold: 'poApprovalThreshold', require_invoice_approval: 'requireInvoiceApproval',
  document_terms_and_conditions: 'documentTermsAndConditions', document_theme_color: 'documentThemeColor',
  notify_on_low_stock: 'notifyOnLowStock', notify_on_overdue_invoice: 'notifyOnOverdueInvoice',
  overdue_invoice_alert_days: 'overdueInvoiceAlertDays', pos_offline_enabled: 'posOfflineEnabled',
  pos_offline_max_hours: 'posOfflineMaxHours', pos_offline_queue_limit: 'posOfflineQueueLimit',
  pos_offline_max_sales: 'posOfflineMaxSales', pos_offline_max_single_sale: 'posOfflineMaxSingleSale',
  pos_offline_action_caps: 'posOfflineActionCaps', pos_offline_policy: 'posOfflinePolicy',
  pos_negative_stock_escalation_days: 'posNegativeStockEscalationDays', last_updated_by: 'lastUpdatedBy',
};
const FIELD_MAP = Object.fromEntries(Object.entries(fields).map(([source, target]) => [source, { target, isId: /Id$/.test(target) || target === 'companyId' }]));
FIELD_MAP._id = { target: 'id', isId: true };
FIELD_MAP.id = { target: 'id', isId: true };

function toApi(row) {
  if (!row) return null;
  const result = { _id: row.id };
  for (const [source, target] of Object.entries(fields)) result[source] = row[target];
  result.createdAt = row.createdAt;
  result.updatedAt = row.updatedAt;
  return result;
}

function translateCreate(data = {}) {
  const result = { id: toIdString(data._id || data.id) || generateObjectId() };
  for (const [source, target] of Object.entries(fields)) {
    if (data[source] !== undefined) result[target] = /Id$/.test(target) || target === 'companyId' ? toIdString(data[source]) : data[source];
  }
  return result;
}

function translateUpdate(update = {}) {
  const source = update.$set ? { ...update, ...update.$set } : { ...update };
  delete source.$set;
  delete source.$unset;
  const result = {};
  for (const [sourceKey, target] of Object.entries(fields)) {
    if (source[sourceKey] !== undefined) result[target] = /Id$/.test(target) || target === 'companyId' ? toIdString(source[sourceKey]) : source[sourceKey];
  }
  return result;
}

module.exports = buildTenantModel({
  name: 'SystemSettings',
  collection: 'system_settings',
  delegateName: 'systemSettings',
  fieldMap: FIELD_MAP,
  toApi,
  translateCreate,
  translateUpdate,
  tenantField: 'companyId',
  mutable: true,
});
