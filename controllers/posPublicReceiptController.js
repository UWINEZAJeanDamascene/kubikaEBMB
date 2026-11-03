'use strict';

const smsService = require('../services/smsService');
const emailService = require('../services/emailService');
const {
  PUBLIC_RECEIPT_NOT_FOUND,
  createPublicReceiptLink,
  listPublicReceiptLinks,
  revokePublicReceiptLink,
  publicReceiptDocument,
  receiptPdfBuffer,
  auditShare,
} = require('../services/posPublicReceiptService');

const words = {
  en: { subject: 'Your receipt', message: 'Your receipt is ready: ', title: 'Digital receipt' },
  rw: { subject: 'Inyemezabwishyu yawe', message: 'Inyemezabwishyu yawe iriteguye: ', title: 'Inyemezabwishyu yo kuri internet' },
  fr: { subject: 'Votre re\u00e7u', message: 'Votre re\u00e7u est pr\u00eat : ', title: 'Re\u00e7u num\u00e9rique' },
};

function currentContext(req) {
  return {
    companyId: req.user?.company?._id || req.user?.companyId || req.user?.company,
    invoiceId: req.params.invoiceId,
    userId: req.posAuthContext?.user?.id || req.user?._id || req.user?.id,
    registerId: req.posAuthContext?.session?.registerId || null,
    req,
  };
}

function localeWords(value) {
  const locale = String(value || 'en').slice(0, 2).toLowerCase();
  return words[locale] || words.en;
}

function publicNotFound(res) {
  res.set('Cache-Control', 'no-store, private').set('X-Robots-Tag', 'noindex, nofollow').set('Referrer-Policy', 'no-referrer').set('X-Content-Type-Options', 'nosniff');
  return res.status(404).type('text/plain').send('Not found');
}

function consentDenied(res) {
  return res.status(403).json({
    success: false,
    code: 'POS_CUSTOMER_DIGITAL_RECEIPT_CONSENT_REQUIRED',
    message: 'This customer has not agreed to receive digital receipts. Ask for consent or print the receipt.',
  });
}

exports.createLink = async (req, res) => {
  try {
    const result = await createPublicReceiptLink(currentContext(req));
    return res.status(201).json({
      success: true,
      data: {
        id: result.id, url: result.url, qrDataUrl: result.qrDataUrl, expiresAt: result.expiresAt,
      },
    });
  } catch (error) {
    if (error === PUBLIC_RECEIPT_NOT_FOUND || error.statusCode === 404) return res.status(404).json({ success: false, code: 'POS_RECEIPT_NOT_FOUND', message: 'Receipt is unavailable for sharing.' });
    return res.status(error.statusCode || 500).json({ success: false, code: error.code || 'POS_RECEIPT_LINK_FAILED', message: error.statusCode ? error.message : 'Could not create the receipt link.' });
  }
};

exports.listLinks = async (req, res) => {
  try {
    const links = await listPublicReceiptLinks(currentContext(req));
    return res.json({ success: true, data: links });
  } catch {
    return res.status(500).json({ success: false, message: 'Could not load receipt links.' });
  }
};

exports.revokeLink = async (req, res) => {
  try {
    const result = await revokePublicReceiptLink({ ...currentContext(req), linkId: req.params.linkId });
    return res.json({ success: true, data: result });
  } catch (error) {
    if (error === PUBLIC_RECEIPT_NOT_FOUND || error.statusCode === 404) return res.status(404).json({ success: false, code: 'POS_RECEIPT_LINK_NOT_FOUND', message: 'Receipt link not found.' });
    return res.status(500).json({ success: false, message: 'Could not revoke receipt link.' });
  }
};

exports.shareEmail = async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ success: false, code: 'POS_RECEIPT_EMAIL_INVALID', message: 'Enter a valid email address.' });
    const context = currentContext(req);
    const link = await createPublicReceiptLink(context);
    const text = `${localeWords(req.body?.locale).message}${link.url}`;
    const htmlEscape = (value) => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const html = `<p>${htmlEscape(localeWords(req.body?.locale).message)}<a href="${htmlEscape(link.url)}">${htmlEscape(link.url)}</a></p><p>${htmlEscape(localeWords(req.body?.locale).title)}</p>`;
    const sent = await emailService.sendEmail(email, localeWords(req.body?.locale).subject, html, { text });
    if (!sent) {
      await revokePublicReceiptLink({ ...context, linkId: link.id });
      return res.status(502).json({ success: false, code: 'POS_RECEIPT_EMAIL_FAILED', message: 'The email provider did not accept the receipt.' });
    }
    await auditShare({ ...context, linkId: link.id, channel: 'EMAIL' });
    return res.json({ success: true, message: 'Receipt email accepted by the provider.', expiresAt: link.expiresAt });
  } catch (error) {
    if (error === PUBLIC_RECEIPT_NOT_FOUND || error.statusCode === 404) return res.status(404).json({ success: false, code: 'POS_RECEIPT_NOT_FOUND', message: 'Receipt is unavailable for sharing.' });
    if (error?.code === 'POS_CUSTOMER_DIGITAL_RECEIPT_CONSENT_REQUIRED') return consentDenied(res);
    return res.status(500).json({ success: false, code: 'POS_RECEIPT_EMAIL_FAILED', message: 'Could not send the receipt email.' });
  }
};

exports.shareSms = async (req, res) => {
  try {
    const phone = String(req.body?.phone || '').trim();
    const normalizedPhone = smsService.normalizePhoneNumber(phone);
    if (!normalizedPhone) return res.status(400).json({ success: false, code: 'POS_RECEIPT_PHONE_INVALID', message: 'Enter a valid phone number with its country code.' });
    const context = currentContext(req);
    const link = await createPublicReceiptLink(context);
    const result = await smsService.sendSMS(normalizedPhone, `${localeWords(req.body?.locale).message}${link.url}`);
    if (!result?.success) {
      await revokePublicReceiptLink({ ...context, linkId: link.id });
      return res.status(/not configured|no sms provider/i.test(String(result?.error || '')) ? 503 : 502).json({ success: false, code: 'POS_RECEIPT_SMS_FAILED', message: 'The SMS provider did not accept the receipt link.' });
    }
    await auditShare({ ...context, linkId: link.id, channel: 'SMS' });
    return res.json({ success: true, message: 'Receipt link accepted by the SMS provider.', expiresAt: link.expiresAt });
  } catch (error) {
    if (error === PUBLIC_RECEIPT_NOT_FOUND || error.statusCode === 404) return res.status(404).json({ success: false, code: 'POS_RECEIPT_NOT_FOUND', message: 'Receipt is unavailable for sharing.' });
    if (error?.code === 'POS_CUSTOMER_DIGITAL_RECEIPT_CONSENT_REQUIRED') return consentDenied(res);
    return res.status(502).json({ success: false, code: 'POS_RECEIPT_SMS_FAILED', message: 'Could not send the receipt link.' });
  }
};

exports.shareWhatsApp = async (req, res) => {
  try {
    const phone = String(req.body?.phone || '').trim();
    const normalizedPhone = smsService.normalizePhoneNumber(phone);
    if (!normalizedPhone) return res.status(400).json({ success: false, code: 'POS_RECEIPT_PHONE_INVALID', message: 'Enter a valid phone number with its country code.' });
    const context = currentContext(req);
    const link = await createPublicReceiptLink(context);
    const recipient = normalizedPhone.replace(/\D/g, '');
    const text = `${localeWords(req.body?.locale).message}${link.url}`;
    const whatsappUrl = `https://wa.me/${recipient}?text=${encodeURIComponent(text)}`;
    await auditShare({ ...context, linkId: link.id, channel: 'WHATSAPP_LINK' });
    return res.json({ success: true, data: { whatsappUrl, expiresAt: link.expiresAt } });
  } catch (error) {
    if (error === PUBLIC_RECEIPT_NOT_FOUND || error.statusCode === 404) return res.status(404).json({ success: false, code: 'POS_RECEIPT_NOT_FOUND', message: 'Receipt is unavailable for sharing.' });
    if (error?.code === 'POS_CUSTOMER_DIGITAL_RECEIPT_CONSENT_REQUIRED') return consentDenied(res);
    return res.status(500).json({ success: false, code: 'POS_RECEIPT_WHATSAPP_FAILED', message: 'Could not prepare the WhatsApp message.' });
  }
};

exports.publicDocument = async (req, res) => {
  try {
    const { receiptDocument } = await publicReceiptDocument(req.params.token);
    res.set('Cache-Control', 'no-store, private').set('X-Robots-Tag', 'noindex, nofollow').set('Referrer-Policy', 'no-referrer').set('X-Content-Type-Options', 'nosniff');
    return res.json({ success: true, data: receiptDocument });
  } catch (error) {
    if (error === PUBLIC_RECEIPT_NOT_FOUND || error.statusCode === 404) return publicNotFound(res);
    res.set('Cache-Control', 'no-store, private').set('Referrer-Policy', 'no-referrer').set('X-Content-Type-Options', 'nosniff');
    return res.status(500).type('text/plain').send('Receipt temporarily unavailable');
  }
};

exports.publicPdf = async (req, res) => {
  try {
    const { receiptDocument } = await publicReceiptDocument(req.params.token);
    const pdf = await receiptPdfBuffer(receiptDocument);
    const name = String(receiptDocument.receipt.number || 'receipt').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
    res.set('Cache-Control', 'no-store, private').set('X-Robots-Tag', 'noindex, nofollow').set('Referrer-Policy', 'no-referrer').set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${name}.pdf"`);
    return res.send(pdf);
  } catch (error) {
    if (error === PUBLIC_RECEIPT_NOT_FOUND || error.statusCode === 404) return publicNotFound(res);
    res.set('Cache-Control', 'no-store, private').set('Referrer-Policy', 'no-referrer').set('X-Content-Type-Options', 'nosniff');
    return res.status(500).type('text/plain').send('Receipt temporarily unavailable');
  }
};
