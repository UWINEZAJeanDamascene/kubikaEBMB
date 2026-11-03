const Invoice = require('../models/Invoice');
const Company = require('../models/Company');
const smsService = require('../services/smsService');

const RECEIPT_WORDS = {
  en: { title: 'Receipt from', defaultBusiness: 'The shop', item: 'Item', customer: 'Customer', invoice: 'Invoice', items: 'Items', subtotal: 'Subtotal', discount: 'Discount', tax: 'Tax', total: 'Total', paid: 'Paid', thanks: 'Thank you for shopping with us.' },
  rw: { title: 'Inyemezabwishyu ya', defaultBusiness: 'Iduka', item: 'Igicuruzwa', customer: 'Umukiriya', invoice: 'Fagitire', items: 'Ibicuruzwa', subtotal: "Mbere y'umusoro", discount: 'Igabanyirizwa', tax: 'Umusoro', total: 'Igiteranyo', paid: 'Yishyuwe', thanks: 'Murakoze kugura.' },
  fr: { title: 'Reçu de', defaultBusiness: 'Le magasin', item: 'Article', customer: 'Client', invoice: 'Facture', items: 'Articles', subtotal: 'Sous-total', discount: 'Remise', tax: 'Taxe', total: 'Total', paid: 'Payé', thanks: 'Merci de votre achat.' },
};

function amount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

exports.sendSms = async (req, res, next) => {
  try {
    const companyId = req.user?.company?._id || req.user?.company;
    const invoiceId = req.params.invoiceId;
    const phone = String(req.body?.phone || '').trim();
    if (!phone) return res.status(400).json({ success: false, code: 'POS_RECEIPT_PHONE_REQUIRED', message: 'Enter a customer phone number.' });
    if (!smsService.normalizePhoneNumber(phone)) {
      return res.status(400).json({ success: false, code: 'POS_RECEIPT_PHONE_INVALID', message: 'Enter a valid phone number with its country code.' });
    }

    // Always scope the invoice lookup to the authenticated company.
    const [invoice, company] = await Promise.all([
      Invoice.findOne({ _id: invoiceId, company: companyId })
        .populate('client', 'name contact')
        .populate('lines.product', 'name sku'),
      Company.findById(companyId).lean(),
    ]);
    if (!invoice) return res.status(404).json({ success: false, code: 'POS_RECEIPT_NOT_FOUND', message: 'Sale not found.' });
    if (invoice.status === 'cancelled' || invoice.status === 'draft') {
      return res.status(409).json({ success: false, code: 'POS_RECEIPT_SALE_UNAVAILABLE', message: 'A receipt cannot be sent for this sale.' });
    }

    const number = smsService.normalizePhoneNumber(phone);
    const ref = String(invoice.invoiceNumber || invoice.referenceNo || invoice._id).replace(/[\r\n]+/g, ' ').slice(0, 80);
    const currency = invoice.currencyCode || invoice.currency || 'RWF';
    const language = String(req.body?.locale || 'en').slice(0, 2).toLowerCase();
    const words = RECEIPT_WORDS[language] || RECEIPT_WORDS.en;
    const total = amount(invoice.grandTotal ?? invoice.totalAmount);
    const paid = amount(invoice.amountPaid);
    const subtotal = amount(invoice.subtotal);
    const discount = amount(invoice.totalDiscount);
    const tax = amount(invoice.taxAmount ?? invoice.totalTax);
    const businessName = String(company?.name || words.defaultBusiness).replace(/[\r\n]+/g, ' ').slice(0, 100);
    const customerName = String(invoice.client?.name || invoice.customerName || '').replace(/[\r\n]+/g, ' ').slice(0, 80);
    const message = [
      `${words.title} ${businessName}`,
      customerName ? `${words.customer}: ${customerName}` : null,
      `${words.invoice}: ${ref}`,
      `${words.items}:`,
      ...(invoice.lines || invoice.items || []).map((line) => {
        const name = String(line.product?.name || line.productName || line.description || words.item).replace(/[\r\n]+/g, ' ').slice(0, 80);
        const quantity = amount(line.quantity ?? line.qty);
        const lineTotal = amount(line.lineTotal ?? line.totalWithTax ?? (Number(line.unitPrice) * quantity));
        return `${quantity} x ${name} - ${currency} ${lineTotal.toLocaleString('en-US')}`;
      }),
      `${words.subtotal}: ${currency} ${subtotal.toLocaleString('en-US')}`,
      ...(discount > 0 ? [`${words.discount}: -${currency} ${discount.toLocaleString('en-US')}`] : []),
      `${words.tax}: ${currency} ${tax.toLocaleString('en-US')}`,
      `${words.total}: ${currency} ${total.toLocaleString('en-US')}`,
      `${words.paid}: ${currency} ${paid.toLocaleString('en-US')}`,
      words.thanks,
    ].filter(Boolean).join('\n');

    const result = await smsService.sendSMS(number, message);
    if (!result?.success) {
      const providerUnavailable = /not configured|no sms provider/i.test(String(result?.error || ''));
      return res.status(providerUnavailable ? 503 : 502).json({
        success: false,
        code: providerUnavailable ? 'POS_RECEIPT_SMS_NOT_CONFIGURED' : 'POS_RECEIPT_SMS_FAILED',
        message: providerUnavailable
          ? 'SMS is not configured. Ask an administrator to configure an SMS provider.'
          : 'The SMS provider did not accept the receipt. Check the number and try again.',
      });
    }
    return res.json({ success: true, message: 'Receipt accepted by the SMS provider.' });
  } catch (error) {
    return next(error);
  }
};

exports.sendWhatsApp = async (req, res, next) => {
  try {
    const companyId = req.user?.company?._id || req.user?.company;
    const invoiceId = req.params.invoiceId;
    const phone = String(req.body?.phone || '').trim();
    if (!phone) return res.status(400).json({ success: false, code: 'POS_RECEIPT_PHONE_REQUIRED', message: 'Enter a customer phone number.' });
    if (!smsService.normalizePhoneNumber(phone)) {
      return res.status(400).json({ success: false, code: 'POS_RECEIPT_PHONE_INVALID', message: 'Enter a valid phone number with its country code.' });
    }

    const [invoice, company] = await Promise.all([
      Invoice.findOne({ _id: invoiceId, company: companyId })
        .populate('client', 'name contact')
        .populate('lines.product', 'name sku'),
      Company.findById(companyId).lean(),
    ]);
    if (!invoice) return res.status(404).json({ success: false, code: 'POS_RECEIPT_NOT_FOUND', message: 'Sale not found.' });
    if (invoice.status === 'cancelled' || invoice.status === 'draft') {
      return res.status(409).json({ success: false, code: 'POS_RECEIPT_SALE_UNAVAILABLE', message: 'A receipt cannot be sent for this sale.' });
    }

    const ref = String(invoice.invoiceNumber || invoice.referenceNo || invoice._id).replace(/[\r\n]+/g, ' ').slice(0, 80);
    const currency = invoice.currencyCode || invoice.currency || 'RWF';
    const language = String(req.body?.locale || 'en').slice(0, 2).toLowerCase();
    const words = RECEIPT_WORDS[language] || RECEIPT_WORDS.en;
    const total = amount(invoice.grandTotal ?? invoice.totalAmount);
    const paid = amount(invoice.amountPaid);
    const subtotal = amount(invoice.subtotal);
    const discount = amount(invoice.totalDiscount);
    const tax = amount(invoice.taxAmount ?? invoice.totalTax);
    const businessName = String(company?.name || words.defaultBusiness).replace(/[\r\n]+/g, ' ').slice(0, 100);
    const customerName = String(invoice.client?.name || invoice.customerName || '').replace(/[\r\n]+/g, ' ').slice(0, 80);
    const message = [
      `${words.title} ${businessName}`,
      customerName ? `${words.customer}: ${customerName}` : null,
      `${words.invoice}: ${ref}`,
      `${words.items}:`,
      ...(invoice.lines || invoice.items || []).map((line) => {
        const name = String(line.product?.name || line.productName || line.description || words.item).replace(/[\r\n]+/g, ' ').slice(0, 80);
        const quantity = amount(line.quantity ?? line.qty);
        const lineTotal = amount(line.lineTotal ?? line.totalWithTax ?? (Number(line.unitPrice) * quantity));
        return `${quantity} x ${name} - ${currency} ${lineTotal.toLocaleString('en-US')}`;
      }),
      `${words.subtotal}: ${currency} ${subtotal.toLocaleString('en-US')}`,
      ...(discount > 0 ? [`${words.discount}: -${currency} ${discount.toLocaleString('en-US')}`] : []),
      `${words.tax}: ${currency} ${tax.toLocaleString('en-US')}`,
      `${words.total}: ${currency} ${total.toLocaleString('en-US')}`,
      `${words.paid}: ${currency} ${paid.toLocaleString('en-US')}`,
      words.thanks,
    ].filter(Boolean).join('\n');

    const result = await smsService.sendWhatsApp(phone, message);
    if (!result?.success) {
      const providerUnavailable = /not configured/i.test(String(result?.error || ''));
      return res.status(providerUnavailable ? 503 : 502).json({
        success: false,
        code: providerUnavailable ? 'POS_RECEIPT_WHATSAPP_NOT_CONFIGURED' : 'POS_RECEIPT_WHATSAPP_FAILED',
        message: providerUnavailable
          ? 'WhatsApp is not configured. Ask an administrator to configure Meta WhatsApp or Twilio WhatsApp.'
          : 'The WhatsApp provider did not accept the receipt. Check the number and try again.',
      });
    }
    return res.json({ success: true, message: 'Receipt accepted by the WhatsApp provider.' });
  } catch (error) {
    return next(error);
  }
};
