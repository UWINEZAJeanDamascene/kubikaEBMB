// SMS Notification Service with Twilio support
// Supports multiple SMS providers: Twilio, Nexmo (Vonage), etc.

const axios = require('axios');

// Provider configurations
const getTwilioConfig = () => ({
  accountSid: process.env.TWILIO_ACCOUNT_SID,
  authToken: process.env.TWILIO_AUTH_TOKEN,
  fromNumber: process.env.TWILIO_FROM_NUMBER
});

const getNexmoConfig = () => ({
  apiKey: process.env.NEXMO_API_KEY,
  apiSecret: process.env.NEXMO_API_SECRET,
  fromNumber: process.env.NEXMO_FROM_NUMBER
});

const sendViaTwilioWhatsApp = async (to, message) => {
  const config = getTwilioConfig();
  const fromNumber = process.env.TWILIO_WHATSAPP_FROM_NUMBER;
  if (!config.accountSid || !config.authToken || !fromNumber) {
    return { success: false, error: 'Twilio WhatsApp not configured' };
  }
  const normalizedPhone = normalizePhoneNumber(to);
  if (!normalizedPhone) return { success: false, error: 'Invalid phone number' };
  const whatsappFrom = String(fromNumber).startsWith('whatsapp:')
    ? String(fromNumber)
    : `whatsapp:${String(fromNumber).replace(/\s/g, '')}`;

  try {
    const response = await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`,
      new URLSearchParams({
        To: `whatsapp:${normalizedPhone}`,
        From: whatsappFrom,
        Body: message
      }),
      { auth: { username: config.accountSid, password: config.authToken } }
    );
    return { success: true, messageId: response.data.sid };
  } catch (error) {
    return { success: false, error: error.response?.data || error.message };
  }
};

const sendViaMetaWhatsApp = async (to, message) => {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!phoneNumberId || !accessToken) {
    return { success: false, error: 'WhatsApp provider not configured' };
  }
  const normalizedPhone = normalizePhoneNumber(to);
  if (!normalizedPhone) return { success: false, error: 'Invalid phone number' };
  try {
    const response = await axios.post(
      `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: normalizedPhone.replace(/^\+/, ''),
        type: 'text',
        text: { preview_url: false, body: message }
      },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    return { success: true, messageId: response.data?.messages?.[0]?.id || null };
  } catch (error) {
    return { success: false, error: error.response?.data || error.message };
  }
};

// Normalize phone number to E.164 format
// Uses DEFAULT_COUNTRY_CODE env var if provided (e.g. '1' for US)
const normalizePhoneNumber = (phone) => {
  if (!phone) return null;

  // Remove all non-digit characters
  let cleaned = String(phone).replace(/\D/g, '');

  // If user provided leading + in original string, keep it
  if (String(phone).trim().startsWith('+')) {
    cleaned = '+' + cleaned;
  } else {
    // If number already contains country code (length > 10), assume it's full
    if (cleaned.length > 10) {
      cleaned = '+' + cleaned;
    } else {
      // If default country code is configured, prepend it
      const defaultCountry = process.env.DEFAULT_COUNTRY_CODE || process.env.TWILIO_DEFAULT_COUNTRY || null;
      if (defaultCountry) {
        cleaned = '+' + String(defaultCountry).replace(/\D/g, '') + cleaned;
      } else {
        // Cannot safely guess country code — return null so caller can handle
        return null;
      }
    }
  }

  // Basic length validation for E.164 (max 15 digits excluding +)
  const digitsOnly = cleaned.replace(/^\+/, '');
  if (digitsOnly.length < 8 || digitsOnly.length > 15) return null;

  return cleaned;
};

// Send SMS via Twilio
const sendViaTwilio = async (to, message) => {
  const config = getTwilioConfig();
  
  if (!config.accountSid || !config.authToken || !config.fromNumber) {
    console.warn('Twilio not configured. SMS not sent.');
    return { success: false, error: 'Twilio not configured' };
  }

  try {
    const response = await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`,
      new URLSearchParams({
        To: normalizePhoneNumber(to),
        From: config.fromNumber,
        Body: message
      }),
      {
        auth: {
          username: config.accountSid,
          password: config.authToken
        }
      }
    );
    
    console.log('SMS accepted by Twilio.');
    return { success: true, messageId: response.data.sid };
  } catch (error) {
    // Prefer returning Twilio's structured error when available
    const twErr = error.response && error.response.data ? error.response.data : null;
    console.error('Twilio SMS request failed.', error.response?.status || '');
    return { success: false, error: twErr || error.message };
  }
};

// Send SMS via Nexmo (Vonage)
const sendViaNexmo = async (to, message) => {
  const config = getNexmoConfig();
  
  if (!config.apiKey || !config.apiSecret) {
    console.warn('Nexmo not configured. SMS not sent.');
    return { success: false, error: 'Nexmo not configured' };
  }

  try {
    const response = await axios.post('https://rest.nexmo.com/sms/json', {
      api_key: config.apiKey,
      api_secret: config.apiSecret,
      from: config.fromNumber,
      to: normalizePhoneNumber(to).substring(1), // Remove + for Nexmo
      text: message
    });
    
    if (response.data.messages[0].status === '0') {
      console.log('SMS accepted by Nexmo.');
      return { success: true, messageId: response.data.messages[0]['message-id'] };
    } else {
      throw new Error(response.data.messages[0]['error-text']);
    }
  } catch (error) {
    console.error('Nexmo SMS request failed.');
    return { success: false, error: error.message };
  }
};

// Main sendSMS function - auto-selects provider
const sendSMS = async (to, message) => {
  if (!to || !message) {
    console.warn('SMS not sent: missing phone number or message');
    return { success: false, error: 'Missing phone number or message' };
  }

  const normalizedPhone = normalizePhoneNumber(to);
  if (!normalizedPhone) {
    return { success: false, error: 'Invalid phone number' };
  }

  // Try Twilio first
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER) {
    return sendViaTwilio(normalizedPhone, message);
  }
  
  // Try Nexmo as fallback
  if (process.env.NEXMO_API_KEY && process.env.NEXMO_API_SECRET) {
    return sendViaNexmo(normalizedPhone, message);
  }
  
  // Do not log customer phone numbers or receipt content when delivery is not configured.
  return { success: false, error: 'No SMS provider configured' };
};

const sendWhatsApp = async (to, message) => {
  if (!to || !message) return { success: false, error: 'Missing phone number or message' };
  const normalizedPhone = normalizePhoneNumber(to);
  if (!normalizedPhone) return { success: false, error: 'Invalid phone number' };
  if (process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_ACCESS_TOKEN) {
    return sendViaMetaWhatsApp(normalizedPhone, message);
  }
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_WHATSAPP_FROM_NUMBER) {
    return sendViaTwilioWhatsApp(normalizedPhone, message);
  }
  return { success: false, error: 'No WhatsApp provider configured' };
};

// ============================================
// CRITICAL EVENT SMS NOTIFICATIONS
// ============================================

// Send low stock critical alert
const sendLowStockCriticalSMS = async (product, company, phoneNumbers) => {
  const message = `🔴 CRITICAL LOW STOCK ALERT: ${product.name} (SKU: ${product.sku || 'N/A'}) has only ${product.currentStock} units left. Immediate reorder required!`;
  
  const results = [];
  for (const phone of phoneNumbers) {
    const result = await sendSMS(phone, message);
    results.push({ phone, ...result });
  }
  return results;
};

const sendLowStockAlertSMS = async (product, company, phoneNumbers, isCritical = false) => {
  const severity = isCritical ? 'CRITICAL LOW STOCK' : 'LOW STOCK';
  const action = isCritical ? 'Immediate reorder required' : 'Please review reorder needs';
  const message = `${severity} ALERT: ${product.name} (SKU: ${product.sku || 'N/A'}) has ${product.currentStock} units remaining. ${action}.`;
  const results = [];
  for (const phone of phoneNumbers) {
    const result = await sendSMS(phone, message);
    results.push({ phone, ...result });
  }
  return results;
};

// Send payment overdue critical alert
const sendPaymentOverdueSMS = async (invoice, company, phoneNumbers) => {
  const message = `⚠️ PAYMENT OVERDUE: Invoice ${invoice.invoiceNumber} for ${(invoice.currency || '$')}${(invoice.balance || invoice.total).toFixed(2)} is overdue. Please contact client immediately.`;
  
  const results = [];
  for (const phone of phoneNumbers) {
    const result = await sendSMS(phone, message);
    results.push({ phone, ...result });
  }
  return results;
};

// Send large order notification
const sendLargeOrderSMS = async (order, company, phoneNumbers, threshold = 10000) => {
  const orderTotal = order.total || order.grandTotal || 0;
  
  if (orderTotal < threshold) return [];
  
  const message = `🛒 LARGE ORDER ALERT: New order #${order.orderNumber || order._id} received for ${(order.currency || '$')}${orderTotal.toFixed(2)}. Review required.`;
  
  const results = [];
  for (const phone of phoneNumbers) {
    const result = await sendSMS(phone, message);
    results.push({ phone, ...result });
  }
  return results;
};

// Send security alert
const sendSecurityAlertSMS = async (alert, company, phoneNumbers) => {
  const message = `🔒 SECURITY ALERT (${company.name}): ${alert.message || 'Unusual activity detected'}. Time: ${new Date().toISOString()}`;
  
  const results = [];
  for (const phone of phoneNumbers) {
    const result = await sendSMS(phone, message);
    results.push({ phone, ...result });
  }
  return results;
};

// ============================================
// EXPORTS
// ============================================

module.exports = {
  sendSMS,
  sendWhatsApp,
  normalizePhoneNumber,
  // Critical event notifications
  sendLowStockCriticalSMS,
  sendLowStockAlertSMS,
  sendPaymentOverdueSMS,
  sendLargeOrderSMS,
  sendSecurityAlertSMS
};
