'use strict';

const customers = require('../services/customerService');
const Client = require('../models/Client');
const emailService = require('../services/emailService');
const smsService = require('../services/smsService');
const { writePosAuditLog } = require('../services/posAuditService');

function companyIdFromRequest(req) {
  const company = req.user?.company;
  return String(company?._id || company?.id || (typeof company === 'string' ? company : '') || req.user?.companyId || '');
}

function userIdFromRequest(req) {
  return String(req.user?._id || req.user?.id || '');
}

function sendError(res, error) {
  const status = Number(error?.statusCode) || 500;
  return res.status(status).json({
    success: false,
    code: error?.code || 'CUSTOMER_REQUEST_FAILED',
    message: status >= 500 ? 'The customer request could not be completed.' : error.message,
    ...(error?.duplicates ? { duplicates: error.duplicates } : {}),
  });
}

exports.search = async (req, res) => {
  try {
    const data = await customers.searchCustomers({
      companyId: companyIdFromRequest(req), query: req.query.query ?? req.query.search ?? '', limit: req.query.limit,
    });
    return res.json({ success: true, data });
  } catch (error) { return sendError(res, error); }
};

exports.walkIn = async (req, res) => {
  try {
    const data = await customers.getWalkInCustomer({ companyId: companyIdFromRequest(req) });
    return res.json({ success: true, data });
  } catch (error) { return sendError(res, error); }
};

exports.duplicates = async (req, res) => {
  try {
    const data = await customers.findCustomerDuplicates({
      companyId: companyIdFromRequest(req), name: req.query.name,
      phone: req.query.phone, excludeId: req.query.excludeId,
    });
    return res.json({ success: true, data });
  } catch (error) { return sendError(res, error); }
};

exports.create = async (req, res) => {
  try {
    const data = await customers.createCustomer({ companyId: companyIdFromRequest(req), userId: userIdFromRequest(req), input: req.body });
    return res.status(201).json({ success: true, data });
  } catch (error) { return sendError(res, error); }
};

exports.quickAdd = async (req, res) => {
  try {
    const data = await customers.quickAddCustomer({ companyId: companyIdFromRequest(req), userId: userIdFromRequest(req), input: req.body });
    return res.status(201).json({ success: true, data });
  } catch (error) { return sendError(res, error); }
};

exports.get = async (req, res) => {
  try {
    const data = await customers.getCustomer({ companyId: companyIdFromRequest(req), customerId: req.params.id });
    return res.json({ success: true, data });
  } catch (error) { return sendError(res, error); }
};

exports.ledgers = async (req, res) => {
  try {
    const data = await customers.getCustomerLedgers({
      companyId: companyIdFromRequest(req), customerId: req.params.id, limit: req.query.limit,
    });
    return res.json({ success: true, data });
  } catch (error) { return sendError(res, error); }
};

exports.adjustLoyalty = async (req, res) => {
  try {
    const points = Number(req.body?.points);
    const reason = String(req.body?.reason || '').trim();
    const idempotencyKey = String(req.get?.('Idempotency-Key') || req.headers?.['idempotency-key'] || '').trim();
    if (!Number.isSafeInteger(points) || points === 0 || reason.length < 3 || !idempotencyKey) {
      return res.status(400).json({ success: false, code: 'CUSTOMER_LOYALTY_ADJUSTMENT_INVALID', message: 'Enter a non-zero whole point change, an idempotency key, and a reason of at least 3 characters.' });
    }
    const data = await customers.appendLoyaltyEntry({
      companyId: companyIdFromRequest(req), customerId: req.params.id, userId: userIdFromRequest(req),
      entryType: 'ADJUST', points, reason, idempotencyKey,
    });
    return res.status(201).json({ success: true, data });
  } catch (error) { return sendError(res, error); }
};

exports.sendMarketingMessage = async (req, res) => {
  try {
    const companyId = companyIdFromRequest(req);
    const userId = userIdFromRequest(req);
    const customerId = String(req.params.id || '');
    const channel = String(req.body?.channel || '').toUpperCase();
    const message = String(req.body?.message || '').trim();
    const subject = String(req.body?.subject || '').trim();
    if (!['EMAIL', 'SMS', 'WHATSAPP'].includes(channel) || !message || message.length > 2000 || (channel === 'EMAIL' && (!subject || subject.length > 120))) {
      return res.status(400).json({ success: false, code: 'CUSTOMER_MARKETING_MESSAGE_INVALID', message: 'Choose a channel and enter a message. Email also needs a subject.' });
    }
    const customer = await Client.findOne({ _id: customerId, company: companyId });
    if (!customer) return res.status(404).json({ success: false, code: 'CUSTOMER_NOT_FOUND', message: 'Customer not found.' });
    if (customer.marketingConsent !== true) {
      return res.status(403).json({ success: false, code: 'CUSTOMER_MARKETING_CONSENT_REQUIRED', message: 'This customer has not agreed to marketing messages.' });
    }
    const email = String(customer.contact?.email || '').trim();
    const phone = String(customer.contact?.phone || '').trim();
    let sent = false;
    if (channel === 'EMAIL') {
      if (!email) return res.status(409).json({ success: false, code: 'CUSTOMER_MARKETING_DESTINATION_MISSING', message: 'Add an email address to this customer before sending.' });
      const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
      sent = await emailService.sendEmail(email, subject, `<p>${escapeHtml(message).replace(/\n/g, '<br>')}</p>`, { text: message });
    } else {
      if (!phone) return res.status(409).json({ success: false, code: 'CUSTOMER_MARKETING_DESTINATION_MISSING', message: 'Add a phone number to this customer before sending.' });
      const result = channel === 'SMS'
        ? await smsService.sendSMS(phone, message)
        : await smsService.sendWhatsApp(phone, message);
      sent = result?.success === true;
    }
    if (!sent) return res.status(502).json({ success: false, code: 'CUSTOMER_MARKETING_DELIVERY_FAILED', message: 'The message could not be delivered. Check provider setup and try again.' });
    await writePosAuditLog({ companyId, userId, event: 'CUSTOMER_MARKETING_MESSAGE_SENT', metadata: { customerId, channel } });
    return res.json({ success: true, message: 'Marketing message accepted by the provider.' });
  } catch (error) { return sendError(res, error); }
};

exports.update = async (req, res) => {
  try {
    const data = await customers.updateCustomer({ companyId: companyIdFromRequest(req), customerId: req.params.id, userId: userIdFromRequest(req), input: req.body });
    return res.json({ success: true, data });
  } catch (error) { return sendError(res, error); }
};

exports.deactivate = async (req, res) => {
  try {
    const data = await customers.deactivateCustomer({ companyId: companyIdFromRequest(req), customerId: req.params.id, userId: userIdFromRequest(req), reason: req.body?.reason });
    return res.json({ success: true, data });
  } catch (error) { return sendError(res, error); }
};

exports.merge = async (req, res) => {
  try {
    const data = await customers.mergeCustomers({
      companyId: companyIdFromRequest(req), sourceId: req.params.id,
      survivorId: req.body?.survivorId, userId: userIdFromRequest(req), reason: req.body?.reason,
    });
    return res.json({ success: true, data });
  } catch (error) { return sendError(res, error); }
};
