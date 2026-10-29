const NotificationSettings = require('../models/NotificationSettings');
const Company = require('../models/Company');
const Client = require('../models/Client');
const User = require('../models/User');
const emailService = require('./emailService');
const smsService = require('./smsService');
const { notifyInvoiceSent } = require('./notificationHelper');

async function sendInvoiceDelivery(invoice, companyId, { explicit = false } = {}) {
  const settings = await NotificationSettings.getOrCreateForCompany(companyId);
  const automatic = settings.emailNotifications?.enabled === true
    && settings.emailNotifications?.invoiceDelivery === true
    && invoice?.status === 'confirmed';
  if (!explicit && !automatic) return { sent: false, reason: 'disabled_or_unconfirmed' };

  const [company, client] = await Promise.all([
    Company.findById(companyId),
    Client.findOne({ _id: invoice.client, company: companyId }),
  ]);
  const clientEmail = client?.contact?.email || client?.email || invoice.customerEmail;
  if (!clientEmail) return { sent: false, reason: 'missing_customer_email' };

  const deliveryClient = client || {
    name: invoice.customerName || 'Customer',
    email: invoice.customerEmail,
    contact: { email: invoice.customerEmail },
  };
  const result = await emailService.sendInvoiceEmail(invoice, company, deliveryClient);
  if (result === false) return { sent: false, reason: 'delivery_unavailable' };
  await notifyInvoiceSent(companyId, invoice);
  return { sent: true };
}

async function sendLargeOrderAlert(invoice, companyId) {
  const settings = await NotificationSettings.getOrCreateForCompany(companyId);
  if (settings.smsNotifications?.enabled !== true) return { sent: false, reason: 'sms_disabled' };

  const threshold = Number(settings.preferences?.largeOrderThreshold);
  const total = Number(invoice?.grandTotal ?? invoice?.totalAmount ?? invoice?.total);
  if (!Number.isFinite(threshold) || threshold < 0 || !Number.isFinite(total) || total < threshold) {
    return { sent: false, reason: 'below_threshold' };
  }

  const company = await Company.findById(companyId);
  const invoiceCurrency = String(invoice?.currencyCode || invoice?.currency || company?.base_currency || '').toUpperCase();
  const baseCurrency = String(company?.base_currency || company?.baseCurrency || invoiceCurrency).toUpperCase();
  // A threshold has no meaningful comparison across currencies without a
  // configured, dated exchange-rate policy. Avoid false alerts on unlike units.
  if (invoiceCurrency && baseCurrency && invoiceCurrency !== baseCurrency) {
    return { sent: false, reason: 'currency_mismatch' };
  }

  const admins = await User.find({ company: companyId, role: 'admin', isActive: true }).select('phone');
  const phones = [...new Set([
    ...(settings.smsNotifications?.adminPhones || []),
    ...(settings.criticalAlertPhones || []),
    ...admins.map((admin) => admin.phone).filter(Boolean),
  ].map((phone) => smsService.normalizePhoneNumber(String(phone))).filter(Boolean))].slice(0, 50);
  if (!phones.length) return { sent: false, reason: 'no_recipient' };

  // Passing a known-threshold crossing to this dedicated path classifies it as
  // a critical business event, so it remains eligible when criticalOnly=true.
  const result = await smsService.sendLargeOrderSMS({
    _id: invoice._id || invoice.id,
    orderNumber: invoice.orderNumber || invoice.invoiceNumber || invoice.referenceNo,
    total,
    currency: invoiceCurrency || baseCurrency,
  }, company, phones, threshold);
  return { sent: result.length > 0 };
}

module.exports = { sendInvoiceDelivery, sendLargeOrderAlert };
