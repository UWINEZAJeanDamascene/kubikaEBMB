  const nodemailer = require('nodemailer');

// Import centralized configuration
const env = require('../src/config/environment');
const config = env.getConfig();
const emailConfig = config.email;

// ============================================
// ENVIRONMENT VALIDATION
// ============================================

const validateConfig = () => {
  const provider = emailConfig.provider;
  const missing = [];

  if (provider === 'gmail') {
    if (!emailConfig.gmailUser) missing.push('GMAIL_USER');
    if (!emailConfig.gmailAppPassword) missing.push('GMAIL_APP_PASSWORD');
  } else if (provider === 'resend') {
    if (!emailConfig.resendApiKey) missing.push('RESEND_API_KEY');
  } else {
    if (!emailConfig.smtpHost) missing.push('SMTP_HOST');
    if (!emailConfig.smtpUser) missing.push('SMTP_USER');
    if (!emailConfig.smtpPass) missing.push('SMTP_PASS');
  }

  if (!emailConfig.fromAddress && !emailConfig.gmailUser) {
    missing.push('EMAIL_FROM_ADDRESS');
  }

  if (missing.length > 0) {
    console.warn(`⚠️  Email config: missing env vars: ${missing.join(', ')}`);
  }

  return { provider, valid: missing.length === 0, missing };
};

// ============================================
// TRANSPORTER FACTORY
// ============================================

const createTransporter = () => {
  const { provider, valid } = validateConfig();
  const nodeEnv = config.server.env;

  // If configuration is invalid (missing credentials), return a safe no-op transporter
  if (!valid) {
    return {
      verify: async () => false,
      sendMail: async (mail) => {
        try {
          console.warn('[Mailer] Credentials missing, skipping email to', mail && mail.to);
        } catch (e) {
          console.warn('[Mailer] Credentials missing, skipping email');
        }
        return Promise.resolve({ accepted: [], rejected: [], envelope: mail && mail.envelope ? mail.envelope : {}, messageId: 'skipped' });
      }
    };
  }

  if (provider === 'resend') {
    const request = async (path, method, body) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      let response;
      try {
        response = await fetch(`https://api.resend.com${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${emailConfig.resendApiKey}`,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: controller.signal,
        });
      } catch (error) {
        const timedOut = error?.name === 'AbortError';
        throw Object.assign(
          new Error(timedOut ? 'Resend API request timed out.' : 'Could not connect to the Resend API.'),
          { code: timedOut ? 'ETIMEDOUT' : 'ERESEND_CONNECTION' },
        );
      } finally {
        clearTimeout(timeout);
      }

      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw Object.assign(
          new Error(`Resend API request failed with HTTP ${response.status}.`),
          { code: response.status === 429 ? 'ERESEND_RATE_LIMIT' : 'ERESEND_API', status: response.status },
        );
      }
      return result;
    };

    return {
      verify: async () => {
        await request('/domains', 'GET');
        return true;
      },
      sendMail: async (mail) => {
        const attachments = (mail.attachments || []).map((attachment) => ({
          filename: attachment.filename,
          content: Buffer.isBuffer(attachment.content)
            ? attachment.content.toString('base64')
            : attachment.content,
          ...(attachment.contentType ? { content_type: attachment.contentType } : {}),
        }));
        const result = await request('/emails', 'POST', {
          from: mail.from,
          to: Array.isArray(mail.to) ? mail.to : String(mail.to || '').split(',').map((address) => address.trim()).filter(Boolean),
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
          ...(attachments.length ? { attachments } : {}),
        });
        return {
          accepted: Array.isArray(mail.to) ? mail.to : [mail.to],
          rejected: [],
          messageId: result.id,
          response: 'Resend API accepted the email.',
        };
      },
    };
  }

  const poolDefaults = {
    pool: true,
    maxConnections: 5,
    maxMessages: 100,
    rateLimit: 10, // max 10 messages/sec (Gmail limit ≈ 20/sec)
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
    logger: nodeEnv === 'development',
    debug: nodeEnv === 'development'
  };

  if (provider === 'gmail') {
    return nodemailer.createTransport({
      ...poolDefaults,
      service: 'gmail',
      family: 4,
      auth: {
        user: emailConfig.gmailUser,
        pass: emailConfig.gmailAppPassword
      }
    });
  }

  // Fallback: generic SMTP
  const port = emailConfig.smtpPort;
  return nodemailer.createTransport({
    ...poolDefaults,
    host: emailConfig.smtpHost,
    port,
    secure: port === 465,
    auth: {
      user: emailConfig.smtpUser,
      pass: emailConfig.smtpPass
    }
  });
};

let transporter = null;

/**
 * Lazily get or create the transporter singleton.
 * Avoids crashes if env vars are loaded late (e.g. dotenv in server.js).
 */
const getTransporter = () => {
  if (!transporter) {
    transporter = createTransporter();
  }
  return transporter;
};

/**
 * Verify the configured email provider. Safe to call at server startup.
 * Returns true/false — never throws.
 */
const testConnection = async () => {
  try {
    const { provider } = validateConfig();
    const t = getTransporter();
    await t.verify();
    console.log(`✅ Email server connected (provider: ${provider})`);
    return true;
  } catch (error) {
    const { provider } = validateConfig();
    console.error(`❌ Email server error [${provider}]:`, error.message);
    return false;
  }
};

module.exports = { getTransporter, testConnection, validateConfig };
