const { getTransporter } = require('../config/email');

// Import centralized configuration
const env = require('../src/config/environment');
const config = env.getConfig();
const emailConfig = config.email;

// ============================================
// CONSTANTS
// ============================================

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000; // exponential: 1s → 2s → 4s

const getSender = () => {
  // Gmail must send from the authenticated mailbox; using another address here
  // makes the message look spoofed and increases spam placement.
  const address = emailConfig.provider === 'gmail'
    ? emailConfig.gmailUser
    : (emailConfig.fromAddress || emailConfig.smtpUser || emailConfig.gmailUser);
  return `${emailConfig.fromName} <${address}>`;
};

const FRONTEND_URL = config.server.frontendUrl.replace(/\/$/, '');

// ============================================
// HELPERS
// ============================================

/** Basic HTML-entity escaping to prevent XSS in dynamic values */
const esc = (str) => {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
};

/** Coerce Decimal/string/number amounts for email templates */
const moneyFmt = (value, digits = 2) => {
  const n = typeof value === 'number' ? value : Number(value);
  return (Number.isFinite(n) ? n : 0).toFixed(digits);
};

/** Sleep helper for retry backoff */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Validate email format (loose check) */
const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

// ============================================
// CORE SEND — with retry & validation
// ============================================

const sendEmail = async (to, subject, html, { text, attachments, retries } = {}) => {
  // Validate recipient(s)
  const recipients = String(to).split(',').map((e) => e.trim()).filter(Boolean);
  const validRecipients = recipients.filter(isValidEmail);

  if (validRecipients.length === 0) {
    console.warn('❌ sendEmail: no valid recipients —', to);
    return false;
  }

  const mailOptions = {
    from: getSender(),
    to: validRecipients.join(','),
    subject,
    html,
    text: text || html.replace(/<[^>]*>/g, ''),
    ...(attachments && attachments.length > 0 ? { attachments } : {})
  };

  const maxAttempts = retries ?? MAX_RETRIES;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const transporter = getTransporter();
      const delivery = await transporter.sendMail(mailOptions);
      if (delivery?.messageId === 'skipped' || (Array.isArray(delivery?.accepted) && delivery.accepted.length === 0)) {
        console.warn(`[Mailer] Provider did not accept the message for ${validRecipients.join(', ')}`);
        return false;
      }
      console.log(`📧 Email sent to: ${validRecipients.join(', ')}`);
      return true;
    } catch (error) {
      const isLast = attempt === maxAttempts;
      const isTransient =
        error.responseCode >= 400 ||
        ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'ESOCKET'].includes(error.code);

      if (isLast || !isTransient) {
        console.error(
          `❌ Email failed [attempt ${attempt}/${maxAttempts}] to=${validRecipients.join(',')} subject="${subject}":`,
          error.message
        );
        return false;
      }

      const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
      console.warn(`⚠️  Email retry ${attempt}/${maxAttempts} in ${delay}ms — ${error.message}`);
      await sleep(delay);
    }
  }

  return false;
};

// ============================================
// INVOICE NOTIFICATIONS
// ============================================

const sendInvoiceEmail = async (invoice, company, client, pdfBuffer = null) => {
  const clientEmail = client?.contact?.email || client?.email;
  if (!clientEmail) {
    console.warn('No client email found for invoice:', invoice?.invoiceNumber);
    return false;
  }

  const subject = `Invoice ${esc(invoice.invoiceNumber)} from ${esc(company?.name || 'StockManager')}`;
  const dueDate = new Date(invoice.dueDate).toLocaleDateString();
  const createdDate = new Date(invoice.createdAt).toLocaleDateString();
  const currency = invoice.currency || 'RF';

  let itemsHtml = '';
  if (invoice.items && invoice.items.length > 0) {
    itemsHtml = invoice.items
      .map(
        (item) => `
      <tr>
        <td style="padding:10px; border-bottom:1px solid #ddd;">${esc(item.description || item.name || 'Item')}</td>
        <td style="padding:10px; border-bottom:1px solid #ddd; text-align:center;">${item.quantity || 1}</td>
        <td style="padding:10px; border-bottom:1px solid #ddd; text-align:right;">${currency} ${(item.price || 0).toFixed(2)}</td>
        <td style="padding:10px; border-bottom:1px solid #ddd; text-align:right;">${currency} ${(item.total || item.price * item.quantity).toFixed(2)}</td>
      </tr>`
      )
      .join('');
  }

  const html = `
    <div style="font-family:Arial,sans-serif; max-width:600px; margin:0 auto;">
      <div style="background:#0f766e; padding:30px; border-radius:10px 10px 0 0;">
        <h1 style="color:white; margin:0; text-align:center;">📄 Invoice</h1>
      </div>
      <div style="background:#f9f9f9; padding:30px; border:1px solid #ddd; border-top:none; border-radius:0 0 10px 10px;">
        <h2 style="color:#7c3aed; margin:0 0 5px;">${esc(invoice.invoiceNumber)}</h2>
        <p style="color:#666; margin:5px 0;">Date: ${createdDate}</p>
        <p style="color:#666; margin:5px 0;">Due Date: ${dueDate}</p>
        <div style="background:white; padding:15px; border-radius:8px; margin:20px 0;">
          <strong>Bill To:</strong><br/>${esc(client?.name || 'Client')}<br/>${esc(client?.contact?.address || '')}
        </div>
        <table style="width:100%; border-collapse:collapse; margin:20px 0;">
          <thead>
            <tr style="background:#7c3aed; color:white;">
              <th style="padding:12px; text-align:left;">Description</th>
              <th style="padding:12px; text-align:center;">Qty</th>
              <th style="padding:12px; text-align:right;">Price</th>
              <th style="padding:12px; text-align:right;">Total</th>
            </tr>
          </thead>
          <tbody>${itemsHtml}</tbody>
        </table>
        <div style="text-align:right; margin:20px 0;">
          <p style="margin:5px 0;">Subtotal: ${currency} ${(invoice.subtotal || invoice.total || 0).toFixed(2)}</p>
          <p style="margin:5px 0;">Tax: ${currency} ${(invoice.tax || 0).toFixed(2)}</p>
          <p style="margin:5px 0; font-size:18px; font-weight:bold; color:#7c3aed;">Total: ${currency} ${(invoice.total || 0).toFixed(2)}</p>
          ${invoice.balance !== undefined ? `<p style="margin:5px 0; color:#ef4444;">Balance Due: ${currency} ${(invoice.balance || 0).toFixed(2)}</p>` : ''}
        </div>
        ${invoice.notes ? `<div style="background:white; padding:15px; border-radius:8px; margin:20px 0;"><strong>Notes:</strong><br/>${esc(invoice.notes)}</div>` : ''}
        <div style="text-align:center; margin-top:30px;">
          <a href="${FRONTEND_URL}/invoices/${invoice._id}" style="background:#7c3aed; color:white; padding:12px 30px; text-decoration:none; border-radius:8px; display:inline-block;">View Invoice Online</a>
        </div>
        <hr style="border:none; border-top:1px solid #ddd; margin:30px 0;"/>
        <p style="font-size:12px; color:#888; text-align:center;">Thank you for your business! Payment is due by ${dueDate}.<br/>StockManager — Manage Your Stock From Supply to Final Sale</p>
      </div>
    </div>`;

  const attachments = pdfBuffer
    ? [{ filename: `${invoice.invoiceNumber}.pdf`, content: pdfBuffer }]
    : [];

  return sendEmail(clientEmail, subject, html, { attachments });
};

// ============================================
// PAYMENT REMINDER NOTIFICATIONS
// ============================================

const sendPaymentReminderEmail = async (invoice, company, client) => {
  const clientEmail = client?.contact?.email || client?.email;
  if (!clientEmail) return false;

  const daysUntilDue = Math.ceil((new Date(invoice.dueDate) - new Date()) / (1000 * 60 * 60 * 24));
  const isOverdue = daysUntilDue < 0;
  const daysOverdue = Math.abs(daysUntilDue);
  const currency = invoice.currency || 'RF';

  const subject = isOverdue
    ? `Payment Reminder: ${invoice.invoiceNumber} - OVERDUE`
    : `Payment Reminder: ${invoice.invoiceNumber} due in ${daysUntilDue} day(s)`;

  const html = `
    <div style="font-family:Arial,sans-serif; max-width:600px; margin:0 auto;">
      <div style="background:${isOverdue ? '#ef4444' : '#7c3aed'}; padding:30px; border-radius:10px 10px 0 0;">
        <h1 style="color:white; margin:0; text-align:center;">${isOverdue ? '⚠️ PAYMENT OVERDUE' : '⏰ Payment Reminder'}</h1>
      </div>
      <div style="background:#f9f9f9; padding:30px; border:1px solid #ddd; border-top:none; border-radius:0 0 10px 10px;">
        <p>Dear <strong>${esc(client?.name || 'Valued Customer')}</strong>,</p>
        <p>${isOverdue
          ? `Your invoice <b>${esc(invoice.invoiceNumber)}</b> is <b style="color:#ef4444;">${daysOverdue} days overdue.</b>`
          : `Your invoice <b>${esc(invoice.invoiceNumber)}</b> is due soon.`
        }</p>
        <table style="width:100%; border-collapse:collapse; margin:20px 0;">
          <tr><td style="padding:8px; border:1px solid #ddd;">Invoice Number</td><td style="padding:8px; border:1px solid #ddd;">${esc(invoice.invoiceNumber)}</td></tr>
          <tr><td style="padding:8px; border:1px solid #ddd;">Amount Due</td><td style="padding:8px; border:1px solid #ddd; color:#7c3aed; font-weight:bold;">${currency} ${(invoice.balance || invoice.total || 0).toFixed(2)}</td></tr>
          <tr><td style="padding:8px; border:1px solid #ddd;">Due Date</td><td style="padding:8px; border:1px solid #ddd;">${new Date(invoice.dueDate).toLocaleDateString()}</td></tr>
        </table>
        <p>Please arrange payment at your earliest convenience.</p>
        <div style="text-align:center; margin-top:30px;">
          <a href="${FRONTEND_URL}/invoices/${invoice._id}" style="background:#7c3aed; color:white; padding:12px 30px; text-decoration:none; border-radius:8px; display:inline-block;">Pay Now</a>
        </div>
        <hr style="border:none; border-top:1px solid #ddd; margin:30px 0;"/>
        <p style="font-size:12px; color:#888; text-align:center;">If you have already made payment, please ignore this reminder.<br/>StockManager — Manage Your Stock From Supply to Final Sale</p>
      </div>
    </div>`;

  return sendEmail(clientEmail, subject, html);
};

// ============================================
// LOW STOCK ALERT NOTIFICATIONS
// ============================================

const sendLowStockAlertEmail = async (product, company, reorderPoint = null) => {
  const User = require('../models/User');
  const admins = await User.find({
    company: company._id,
    role: 'admin',
    isActive: true
  }).select('email name');

  const emails = admins.map((a) => a.email).filter(Boolean);
  if (emails.length === 0) {
    console.warn('No admin emails found for company:', company.name);
    return false;
  }

  const threshold = process.env.LOW_STOCK_THRESHOLD || 10;
  const isCritical = product.currentStock <= Math.floor(threshold / 2);

  const subject = isCritical
    ? `🔴 CRITICAL: Low Stock Alert - ${esc(product.name)}`
    : `⚠️ Low Stock Alert - ${esc(product.name)}`;

  const html = `
    <div style="font-family:Arial,sans-serif; max-width:600px; margin:0 auto;">
      <div style="background:${isCritical ? '#ef4444' : '#f59e0b'}; padding:30px; border-radius:10px 10px 0 0;">
        <h1 style="color:white; margin:0; text-align:center;">${isCritical ? '🔴 CRITICAL LOW STOCK' : '⚠️ Low Stock Alert'}</h1>
      </div>
      <div style="background:#f9f9f9; padding:30px; border:1px solid #ddd; border-top:none; border-radius:0 0 10px 10px;">
        <p>Dear <strong>Administrator</strong>,</p>
        <p>The following product requires immediate attention:</p>
        <div style="background:white; padding:20px; border-radius:8px; margin:20px 0;">
          <table style="width:100%;">
            <tr><td style="padding:8px 0;"><strong>Product Name:</strong></td><td style="text-align:right;">${esc(product.name)}</td></tr>
            <tr><td style="padding:8px 0;"><strong>SKU:</strong></td><td style="text-align:right;">${esc(product.sku || 'N/A')}</td></tr>
            <tr><td style="padding:8px 0;"><strong>Current Stock:</strong></td><td style="text-align:right; font-size:24px; color:${isCritical ? '#ef4444' : '#f59e0b'}; font-weight:bold;">${product.currentStock}</td></tr>
            <tr><td style="padding:8px 0;"><strong>Reorder Point:</strong></td><td style="text-align:right;">${reorderPoint?.reorderQuantity || threshold}</td></tr>
            <tr><td style="padding:8px 0;"><strong>Warehouse:</strong></td><td style="text-align:right;">${esc(product.warehouse?.name || 'Default')}</td></tr>
          </table>
        </div>
        <div style="text-align:center; margin-top:30px;">
          <a href="${FRONTEND_URL}/products/${product._id}" style="background:#7c3aed; color:white; padding:12px 30px; text-decoration:none; border-radius:8px; display:inline-block;">Reorder Now</a>
        </div>
        <hr style="border:none; border-top:1px solid #ddd; margin:30px 0;"/>
        <p style="font-size:12px; color:#888; text-align:center;">StockManager — Automated Stock Alert</p>
      </div>
    </div>`;

  return sendEmail(emails.join(','), subject, html);
};

// ============================================
// BULK LOW STOCK ALERT (multiple products)
// ============================================

const sendBulkLowStockAlert = async ({ to, products }) => {
  const subject = `⚠️ Low Stock Alert - ${products.length} product(s)`;

  const rowsHtml = products
    .map(
      (p) => `
    <tr>
      <td style="padding:8px; border:1px solid #ddd;">${esc(p.name)}</td>
      <td style="padding:8px; border:1px solid #ddd; text-align:center; color:${p.currentStock === 0 ? '#ef4444' : '#f59e0b'};">${p.currentStock} ${esc(p.unit || '')}</td>
      <td style="padding:8px; border:1px solid #ddd; text-align:center;">${p.minStock} ${esc(p.unit || '')}</td>
      <td style="padding:8px; border:1px solid #ddd; text-align:center;">${p.currentStock === 0 ? '🔴 Out of Stock' : '🟡 Low Stock'}</td>
    </tr>`
    )
    .join('');

  const html = `
    <div style="font-family:Arial,sans-serif; max-width:600px; margin:0 auto;">
      <div style="background:#f59e0b; padding:30px; border-radius:10px 10px 0 0;">
        <h1 style="color:white; margin:0; text-align:center;">⚠️ Low Stock Alert</h1>
      </div>
      <div style="background:#f9f9f9; padding:30px; border:1px solid #ddd; border-top:none; border-radius:0 0 10px 10px;">
        <p>The following products need restocking:</p>
        <table style="width:100%; border-collapse:collapse;">
          <tr style="background:#f3f4f6;">
            <th style="padding:8px; border:1px solid #ddd; text-align:left;">Product</th>
            <th style="padding:8px; border:1px solid #ddd;">Current Stock</th>
            <th style="padding:8px; border:1px solid #ddd;">Min Stock</th>
            <th style="padding:8px; border:1px solid #ddd;">Status</th>
          </tr>
          ${rowsHtml}
        </table>
        <hr style="border:none; border-top:1px solid #ddd; margin:30px 0;"/>
        <p style="font-size:12px; color:#888; text-align:center;">StockManager — Automated Stock Alert</p>
      </div>
    </div>`;

  return sendEmail(to, subject, html);
};

// ============================================
// WELCOME EMAIL
// ============================================

const sendWelcomeEmail = async ({ to, name, companyName }) => {
  const subject = `Welcome to StockManager, ${esc(companyName)}!`;

  const html = `
    <div style="font-family:Arial,sans-serif; max-width:600px; margin:0 auto;">
      <div style="background:linear-gradient(135deg,#7c3aed,#6d28d9); padding:30px; border-radius:10px 10px 0 0;">
        <h1 style="color:white; margin:0; text-align:center;">Welcome to StockManager! 🎉</h1>
      </div>
      <div style="background:#f9f9f9; padding:30px; border:1px solid #ddd; border-top:none; border-radius:0 0 10px 10px;">
        <p>Hi <strong>${esc(name)}</strong>,</p>
        <p>Your account for <b>${esc(companyName)}</b> has been approved.</p>
        <p>You can now login and start managing your stock.</p>
        <div style="text-align:center; margin:30px 0;">
          <a href="${FRONTEND_URL}/login" style="background:#7c3aed; color:white; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block;">Login to Dashboard →</a>
        </div>
        <hr style="border:none; border-top:1px solid #ddd; margin:30px 0;"/>
        <p style="font-size:12px; color:#888; text-align:center;">StockManager — Manage Your Stock From Supply to Final Sale</p>
      </div>
    </div>`;

  return sendEmail(to, subject, html);
};

// ============================================
// PASSWORD RESET
// ============================================

const sendPasswordResetEmail = async ({ to, name, resetToken }) => {
  const resetUrl = `${FRONTEND_URL}/reset-password?token=${encodeURIComponent(resetToken)}`;
  const subject = 'Reset your KUBIKA password';
  const text = [
    `Hello ${name || 'there'},`,
    '',
    'A password reset was requested for your KUBIKA account.',
    `Reset your password using this one-time link: ${resetUrl}`,
    'This link expires in one hour. If you did not request this, you can ignore this email.',
  ].join('\n');

  const html = `
    <div style="font-family:Arial,sans-serif; max-width:600px; margin:0 auto;">
      <div style="background:linear-gradient(135deg,#7c3aed,#6d28d9); padding:30px; border-radius:10px 10px 0 0;">
        <h1 style="color:white; margin:0; text-align:center;">🔒 Password Reset</h1>
      </div>
      <div style="background:#f9f9f9; padding:30px; border:1px solid #ddd; border-top:none; border-radius:0 0 10px 10px;">
        <p>Hi <strong>${esc(name)}</strong>,</p>
        <p>Click below to reset your password. This link expires in <b>1 hour</b>.</p>
        <div style="text-align:center; margin:30px 0;">
          <a href="${resetUrl}" style="background:#7c3aed; color:white; padding:12px 24px; border-radius:8px; text-decoration:none; display:inline-block;">Reset Password →</a>
        </div>
        <p style="color:#888; font-size:12px;">If you did not request this, please ignore this email.</p>
        <hr style="border:none; border-top:1px solid #ddd; margin:30px 0;"/>
        <p style="font-size:12px; color:#888; text-align:center;">StockManager — Manage Your Stock From Supply to Final Sale</p>
      </div>
    </div>`;

  return sendEmail(to, subject, html, { text });
};

// ============================================
// BACKUP CONFIRMATION
// ============================================

const sendBackupConfirmation = async ({ to, fileName, size }) => {
  const subject = '✅ Database Backup Completed';

  const html = `
    <div style="font-family:Arial,sans-serif; max-width:600px; margin:0 auto;">
      <div style="background:#10b981; padding:30px; border-radius:10px 10px 0 0;">
        <h1 style="color:white; margin:0; text-align:center;">✅ Backup Completed</h1>
      </div>
      <div style="background:#f9f9f9; padding:30px; border:1px solid #ddd; border-top:none; border-radius:0 0 10px 10px;">
        <p>Your database backup was completed successfully.</p>
        <div style="background:white; padding:20px; border-radius:8px; margin:20px 0;">
          <p style="margin:8px 0;"><strong>File:</strong> ${esc(fileName)}</p>
          <p style="margin:8px 0;"><strong>Size:</strong> ${esc(size)}</p>
          <p style="margin:8px 0;"><strong>Stored in:</strong> Dropbox/StockManagerBackups</p>
        </div>
        <hr style="border:none; border-top:1px solid #ddd; margin:30px 0;"/>
        <p style="font-size:12px; color:#888; text-align:center;">StockManager — Automated Backup Notification</p>
      </div>
    </div>`;

  return sendEmail(to, subject, html);
};

// ============================================
// COMPANY APPROVAL / REJECTION
// ============================================

const sendApprovalEmail = async (companyEmail, companyName, adminName) => {
  const subject = 'Your Company Has Been Approved - StockManager';

  const html = `
    <div style="font-family:Arial,sans-serif; max-width:600px; margin:0 auto;">
      <div style="background:linear-gradient(135deg,#7c3aed,#6d28d9); padding:30px; border-radius:10px 10px 0 0;">
        <h1 style="color:white; margin:0; text-align:center;">🎉 Congratulations!</h1>
      </div>
      <div style="background:#f9f9f9; padding:30px; border:1px solid #ddd; border-top:none; border-radius:0 0 10px 10px;">
        <p>Dear <strong>${esc(adminName)}</strong>,</p>
        <p>Your company <strong>${esc(companyName)}</strong> has been <span style="color:#10b981; font-weight:bold;">APPROVED</span> on StockManager.</p>
        <div style="background:white; padding:20px; border-radius:8px; margin:20px 0; border-left:4px solid #10b981;">
          <h3 style="margin-top:0; color:#10b981;">✅ What's Next?</h3>
          <ul style="margin:0; padding-left:20px;">
            <li>Log in to your account</li>
            <li>Complete your company profile</li>
            <li>Start managing your inventory and sales</li>
            <li>Invite team members</li>
          </ul>
        </div>
        <div style="text-align:center; margin-top:30px;">
          <a href="${FRONTEND_URL}" style="background:#7c3aed; color:white; padding:12px 30px; text-decoration:none; border-radius:8px; display:inline-block;">Login to Your Account</a>
        </div>
        <hr style="border:none; border-top:1px solid #ddd; margin:30px 0;"/>
        <p style="font-size:12px; color:#888; text-align:center;">StockManager — Manage Your Stock From Supply to Final Sale</p>
      </div>
    </div>`;

  return sendEmail(companyEmail, subject, html);
};

// ============================================
// PURCHASE ORDER NOTIFICATIONS
// ============================================

const sendPurchaseOrderEmail = async (po, company, supplier, action) => {
  const supplierEmail = supplier?.contact?.email || supplier?.email;
  if (!supplierEmail) {
    console.warn('No supplier email found for PO:', po.referenceNo);
    return false;
  }

  const actionText = {
    created: 'Created',
    approved: 'Approved',
    cancelled: 'Cancelled'
  }[action] || 'Updated';

  const subject = `Purchase Order ${po.referenceNo} - ${actionText}`;

  let itemsHtml = '';
  if (po.lines && po.lines.length > 0) {
    itemsHtml = po.lines.map(line => `
      <tr>
        <td style="padding:10px; border-bottom:1px solid #ddd;">${esc(line.product?.name || 'Item')}</td>
        <td style="padding:10px; border-bottom:1px solid #ddd; text-align:center;">${line.qtyOrdered || 0}</td>
        <td style="padding:10px; border-bottom:1px solid #ddd; text-align:right;">${po.currencyCode || 'RF'} ${(line.unitCost || 0).toFixed(2)}</td>
        <td style="padding:10px; border-bottom:1px solid #ddd; text-align:right;">${po.currencyCode || 'RF'} ${((line.lineTotal) || 0).toFixed(2)}</td>
      </tr>
    `).join('');
  }

  const totalAmount = po.totalAmount || 0;
  const currency = po.currencyCode || 'RF';

  const statusColor = {
    created: '#7c3aed',
    approved: '#10b981',
    cancelled: '#ef4444'
  }[action] || '#7c3aed';

  const html = `
    <div style="font-family:Arial,sans-serif; max-width:600px; margin:0 auto;">
      <div style="background:${statusColor}; padding:30px; border-radius:10px 10px 0 0;">
        <h1 style="color:white; margin:0; text-align:center;">📦 Purchase Order ${actionText}</h1>
      </div>
      <div style="background:#f9f9f9; padding:30px; border:1px solid #ddd; border-top:none; border-radius:0 0 10px 10px;">
        <h2 style="color:#7c3aed; margin:0 0 5px;">${esc(po.referenceNo || '')}</h2>
        <p style="color:#666; margin:5px 0;">Date: ${new Date(po.orderDate).toLocaleDateString()}</p>
        <p style="color:#666; margin:5px 0;">Status: <strong>${actionText}</strong></p>
        <div style="background:white; padding:15px; border-radius:8px; margin:20px 0;">
          <strong>Supplier:</strong><br/>${esc(supplier?.name || 'Supplier')}<br/>${esc(supplier?.contact?.address || '')}
        </div>
        <table style="width:100%; border-collapse:collapse; margin:20px 0;">
          <thead>
            <tr style="background:#7c3aed; color:white;">
              <th style="padding:12px; text-align:left;">Product</th>
              <th style="padding:12px; text-align:center;">Qty</th>
              <th style="padding:12px; text-align:right;">Unit Price</th>
              <th style="padding:12px; text-align:right;">Total</th>
            </tr>
          </thead>
          <tbody>${itemsHtml}</tbody>
        </table>
        <div style="text-align:right; margin:20px 0;">
          <p style="margin:5px 0; font-size:18px; font-weight:bold; color:#7c3aed;">Total: ${currency} ${moneyFmt(totalAmount)}</p>
        </div>
        ${po.notes ? `<div style="background:white; padding:15px; border-radius:8px; margin:20px 0;"><strong>Notes:</strong><br/>${esc(po.notes)}</div>` : ''}
        <div style="text-align:center; margin-top:30px;">
          <a href="${FRONTEND_URL}/purchase-orders/${po._id}" style="background:#7c3aed; color:white; padding:12px 30px; text-decoration:none; border-radius:8px; display:inline-block;">View Purchase Order</a>
        </div>
        <hr style="border:none; border-top:1px solid #ddd; margin:30px 0;"/>
        <p style="font-size:12px; color:#888; text-align:center;">StockManager — Manage Your Stock From Supply to Final Sale</p>
      </div>
    </div>`;

  return sendEmail(supplierEmail, subject, html);
};

const sendGRNReceivedEmail = async (grn, po, company, supplier) => {
  const supplierEmail = supplier?.contact?.email || supplier?.email;
  if (!supplierEmail) {
    console.warn('No supplier email found for GRN:', grn.referenceNo);
    return false;
  }

  const subject = `Goods Received Note ${grn.referenceNo} - Items Received`;

  let itemsHtml = '';
  if (grn.lines && grn.lines.length > 0) {
    itemsHtml = grn.lines.map(line => `
      <tr>
        <td style="padding:10px; border-bottom:1px solid #ddd;">${esc(line.product?.name || 'Item')}</td>
        <td style="padding:10px; border-bottom:1px solid #ddd; text-align:center;">${line.qtyReceived || 0}</td>
      </tr>
    `).join('');
  }

  const totalAmount = grn.totalAmount || 0;

  const html = `
    <div style="font-family:Arial,sans-serif; max-width:600px; margin:0 auto;">
      <div style="background:#10b981; padding:30px; border-radius:10px 10px 0 0;">
        <h1 style="color:white; margin:0; text-align:center;">✅ Goods Received</h1>
      </div>
      <div style="background:#f9f9f9; padding:30px; border:1px solid #ddd; border-top:none; border-radius:0 0 10px 10px;">
        <h2 style="color:#10b981; margin:0 0 5px;">GRN: ${esc(grn.referenceNo || '')}</h2>
        <p style="color:#666; margin:5px 0;">Received Date: ${new Date(grn.receivedDate).toLocaleDateString()}</p>
        <p style="color:#666; margin:5px 0;">PO Reference: ${esc(po?.referenceNo || '')}</p>
        <div style="background:white; padding:15px; border-radius:8px; margin:20px 0;">
          <strong>Supplier:</strong><br/>${esc(supplier?.name || 'Supplier')}
        </div>
        <table style="width:100%; border-collapse:collapse; margin:20px 0;">
          <thead>
            <tr style="background:#10b981; color:white;">
              <th style="padding:12px; text-align:left;">Product</th>
              <th style="padding:12px; text-align:center;">Qty Received</th>
            </tr>
          </thead>
          <tbody>${itemsHtml}</tbody>
        </table>
        <div style="text-align:right; margin:20px 0;">
          <p style="margin:5px 0; font-size:18px; font-weight:bold; color:#10b981;">Total Value: ${po?.currencyCode || 'RF'} ${moneyFmt(totalAmount)}</p>
        </div>
        <div style="text-align:center; margin-top:30px;">
          <a href="${FRONTEND_URL}/goods-received-notes/${grn._id}" style="background:#10b981; color:white; padding:12px 30px; text-decoration:none; border-radius:8px; display:inline-block;">View GRN Details</a>
        </div>
        <hr style="border:none; border-top:1px solid #ddd; margin:30px 0;"/>
        <p style="font-size:12px; color:#888; text-align:center;">StockManager — Manage Your Stock From Supply to Final Sale</p>
      </div>
    </div>`;

  return sendEmail(supplierEmail, subject, html);
};

// ============================================
// SALES ORDER NOTIFICATIONS
// ============================================

const sendSalesOrderEmail = async (so, company, client, action) => {
  const clientEmail = client?.contact?.email || client?.email;
  if (!clientEmail) {
    console.warn('No client email found for SO:', so.referenceNo);
    return false;
  }

  const actionText = {
    created: 'Created',
    confirmed: 'Confirmed',
    cancelled: 'Cancelled',
    fulfilled: 'Fulfilled'
  }[action] || 'Updated';

  const subject = `Sales Order ${so.referenceNo} - ${actionText}`;

  let itemsHtml = '';
  if (so.lines && so.lines.length > 0) {
    itemsHtml = so.lines.map(line => `
      <tr>
        <td style="padding:10px; border-bottom:1px solid #ddd;">${esc(line.product?.name || line.description || 'Item')}</td>
        <td style="padding:10px; border-bottom:1px solid #ddd; text-align:center;">${line.qty || 0}</td>
        <td style="padding:10px; border-bottom:1px solid #ddd; text-align:right;">${so.currencyCode || 'USD'} ${(line.unitPrice || 0).toFixed(2)}</td>
        <td style="padding:10px; border-bottom:1px solid #ddd; text-align:right;">${so.currencyCode || 'USD'} ${((line.qty || 0) * (line.unitPrice || 0)).toFixed(2)}</td>
      </tr>
    `).join('');
  }

  const subtotal = so.subtotal || 0;
  const taxAmount = so.taxAmount || 0;
  const totalAmount = so.totalAmount || so.grandTotal || 0;
  const currency = so.currencyCode || 'USD';

  const statusColor = {
    created: '#7c3aed',
    confirmed: '#10b981',
    cancelled: '#ef4444',
    fulfilled: '#059669'
  }[action] || '#7c3aed';

  const html = `
    <div style="font-family:Arial,sans-serif; max-width:600px; margin:0 auto;">
      <div style="background:${statusColor}; padding:30px; border-radius:10px 10px 0 0;">
        <h1 style="color:white; margin:0; text-align:center;">📋 Sales Order ${actionText}</h1>
      </div>
      <div style="background:#f9f9f9; padding:30px; border:1px solid #ddd; border-top:none; border-radius:0 0 10px 10px;">
        <h2 style="color:#7c3aed; margin:0 0 5px;">${esc(so.referenceNo || '')}</h2>
        <p style="color:#666; margin:5px 0;">Date: ${new Date(so.orderDate).toLocaleDateString()}</p>
        <p style="color:#666; margin:5px 0;">Status: <strong>${actionText}</strong></p>
        ${so.expectedDate ? `<p style="color:#666; margin:5px 0;">Expected Date: ${new Date(so.expectedDate).toLocaleDateString()}</p>` : ''}
        <div style="background:white; padding:15px; border-radius:8px; margin:20px 0;">
          <strong>Customer:</strong><br/>${esc(client?.name || 'Customer')}<br/>${esc(client?.address || '')}
        </div>
        <table style="width:100%; border-collapse:collapse; margin:20px 0;">
          <thead>
            <tr style="background:#7c3aed; color:white;">
              <th style="padding:12px; text-align:left;">Product</th>
              <th style="padding:12px; text-align:center;">Qty</th>
              <th style="padding:12px; text-align:right;">Unit Price</th>
              <th style="padding:12px; text-align:right;">Total</th>
            </tr>
          </thead>
          <tbody>${itemsHtml}</tbody>
        </table>
        <div style="text-align:right; margin:20px 0;">
          <p style="margin:5px 0;">Subtotal: ${currency} ${subtotal.toFixed(2)}</p>
          <p style="margin:5px 0;">Tax: ${currency} ${taxAmount.toFixed(2)}</p>
          <p style="margin:5px 0; font-size:18px; font-weight:bold; color:#7c3aed;">Total: ${currency} ${moneyFmt(totalAmount)}</p>
        </div>
        ${so.notes ? `<div style="background:white; padding:15px; border-radius:8px; margin:20px 0;"><strong>Notes:</strong><br/>${esc(so.notes)}</div>` : ''}
        <div style="text-align:center; margin-top:30px;">
          <a href="${FRONTEND_URL}/sales-orders/${so._id}" style="background:#7c3aed; color:white; padding:12px 30px; text-decoration:none; border-radius:8px; display:inline-block;">View Sales Order</a>
        </div>
        <hr style="border:none; border-top:1px solid #ddd; margin:30px 0;"/>
        <p style="font-size:12px; color:#888; text-align:center;">StockManager — Manage Your Stock From Supply to Final Sale</p>
      </div>
    </div>`;

  return sendEmail(clientEmail, subject, html);
};

// ============================================
// PURCHASE (DIRECT/LEGACY) NOTIFICATIONS
// ============================================

const sendPurchaseEmail = async (purchase, company, supplier, action) => {
  const supplierEmail = supplier?.contact?.email || supplier?.email;
  if (!supplierEmail) {
    console.warn('No supplier email found for Purchase:', purchase.purchaseNumber);
    return false;
  }

  const actionText = {
    created: 'Created',
    received: 'Items Received',
    paid: 'Payment Recorded',
    cancelled: 'Cancelled'
  }[action] || 'Updated';

  const subject = `Purchase ${purchase.purchaseNumber} - ${actionText}`;

  let itemsHtml = '';
  if (purchase.items && purchase.items.length > 0) {
    itemsHtml = purchase.items.map(item => `
      <tr>
        <td style="padding:10px; border-bottom:1px solid #ddd;">${esc(item.product?.name || item.itemCode || 'Item')}</td>
        <td style="padding:10px; border-bottom:1px solid #ddd; text-align:center;">${item.quantity ?? item.qty ?? 0}</td>
        <td style="padding:10px; border-bottom:1px solid #ddd; text-align:right;">${purchase.currency || 'USD'} ${moneyFmt(item.unitCost)}</td>
        <td style="padding:10px; border-bottom:1px solid #ddd; text-align:right;">${purchase.currency || 'USD'} ${moneyFmt(item.totalWithTax ?? item.lineTotal)}</td>
      </tr>
    `).join('');
  }

  const totalAmount = purchase.roundedAmount || purchase.totalAmount || purchase.grandTotal || 0;
  const currency = purchase.currency || 'USD';

  const statusColor = {
    created: '#7c3aed',
    received: '#10b981',
    paid: '#059669',
    cancelled: '#ef4444'
  }[action] || '#7c3aed';

  const html = `
    <div style="font-family:Arial,sans-serif; max-width:600px; margin:0 auto;">
      <div style="background:${statusColor}; padding:30px; border-radius:10px 10px 0 0;">
        <h1 style="color:white; margin:0; text-align:center;">🛒 Purchase ${actionText}</h1>
      </div>
      <div style="background:#f9f9f9; padding:30px; border:1px solid #ddd; border-top:none; border-radius:0 0 10px 10px;">
        <h2 style="color:#7c3aed; margin:0 0 5px;">${esc(purchase.purchaseNumber || '')}</h2>
        <p style="color:#666; margin:5px 0;">Date: ${new Date(purchase.purchaseDate).toLocaleDateString()}</p>
        <p style="color:#666; margin:5px 0;">Status: <strong>${actionText}</strong></p>
        <div style="background:white; padding:15px; border-radius:8px; margin:20px 0;">
          <strong>Supplier:</strong><br/>${esc(supplier?.name || 'Supplier')}<br/>${esc(supplier?.contact?.address || '')}
        </div>
        <table style="width:100%; border-collapse:collapse; margin:20px 0;">
          <thead>
            <tr style="background:#7c3aed; color:white;">
              <th style="padding:12px; text-align:left;">Product</th>
              <th style="padding:12px; text-align:center;">Qty</th>
              <th style="padding:12px; text-align:right;">Unit Cost</th>
              <th style="padding:12px; text-align:right;">Total</th>
            </tr>
          </thead>
          <tbody>${itemsHtml}</tbody>
        </table>
        <div style="text-align:right; margin:20px 0;">
          <p style="margin:5px 0; font-size:18px; font-weight:bold; color:#7c3aed;">Total: ${currency} ${moneyFmt(totalAmount)}</p>
          ${purchase.amountPaid ? `<p style="margin:5px 0; color:#10b981;">Paid: ${currency} ${moneyFmt(purchase.amountPaid)}</p>` : ''}
          ${purchase.balance ? `<p style="margin:5px 0; color:#ef4444;">Balance: ${currency} ${moneyFmt(purchase.balance)}</p>` : ''}
        </div>
        ${purchase.notes ? `<div style="background:white; padding:15px; border-radius:8px; margin:20px 0;"><strong>Notes:</strong><br/>${esc(purchase.notes)}</div>` : ''}
        <div style="text-align:center; margin-top:30px;">
          <a href="${FRONTEND_URL}/purchases/${purchase._id}" style="background:#7c3aed; color:white; padding:12px 30px; text-decoration:none; border-radius:8px; display:inline-block;">View Purchase</a>
        </div>
        <hr style="border:none; border-top:1px solid #ddd; margin:30px 0;"/>
        <p style="font-size:12px; color:#888; text-align:center;">StockManager — Manage Your Stock From Supply to Final Sale</p>
      </div>
    </div>`;

  return sendEmail(supplierEmail, subject, html);
};

const sendRejectionEmail = async (companyEmail, companyName, adminName, reason) => {
  const subject = 'Your Company Registration - StockManager';

  const html = `
    <div style="font-family:Arial,sans-serif; max-width:600px; margin:0 auto;">
      <div style="background:#ef4444; padding:30px; border-radius:10px 10px 0 0;">
        <h1 style="color:white; margin:0; text-align:center;">Important Update</h1>
      </div>
      <div style="background:#f9f9f9; padding:30px; border:1px solid #ddd; border-top:none; border-radius:0 0 10px 10px;">
        <p>Dear <strong>${esc(adminName)}</strong>,</p>
        <p>Your company <strong>${esc(companyName)}</strong>'s registration has been <span style="color:#ef4444; font-weight:bold;">NOT APPROVED</span>.</p>
        ${reason ? `
        <div style="background:white; padding:20px; border-radius:8px; margin:20px 0; border-left:4px solid #ef4444;">
          <h3 style="margin-top:0; color:#ef4444;">Reason:</h3>
          <p style="margin:0;">${esc(reason)}</p>
        </div>` : ''}
        <p>If you believe this is an error, please contact our support team.</p>
        <hr style="border:none; border-top:1px solid #ddd; margin:30px 0;"/>
        <p style="font-size:12px; color:#888; text-align:center;">StockManager — Manage Your Stock From Supply to Final Sale</p>
      </div>
    </div>`;

  return sendEmail(companyEmail, subject, html);
};

// ============================================
// DAILY / WEEKLY SUMMARY REPORTS
// ============================================

const sendDailySummaryEmail = async (company, stats) => {
  const User = require('../models/User');
  const admins = await User.find({ company: company._id, role: 'admin', isActive: true }).select('email');
  const emails = admins.map((a) => a.email).filter(Boolean);
  if (emails.length === 0) return false;

  const subject = `📊 Daily Summary - ${esc(company.name)} - ${new Date().toLocaleDateString()}`;

  const html = `
    <div style="font-family:Arial,sans-serif; max-width:600px; margin:0 auto;">
      <div style="background:linear-gradient(135deg,#7c3aed,#6d28d9); padding:30px; border-radius:10px 10px 0 0;">
        <h1 style="color:white; margin:0; text-align:center;">📊 Daily Summary</h1>
        <p style="color:white; text-align:center; margin:10px 0 0;">${esc(company.name)} — ${new Date().toLocaleDateString()}</p>
      </div>
      <div style="background:#f9f9f9; padding:30px; border:1px solid #ddd; border-top:none; border-radius:0 0 10px 10px;">
        <table style="width:100%; border-collapse:collapse; margin:20px 0;">
          <tr>
            <td style="background:white; padding:20px; border-radius:8px; text-align:center; width:50%;"><div style="font-size:32px; font-weight:bold; color:#7c3aed;">${stats.newInvoices || 0}</div><div style="color:#666;">New Invoices</div></td>
            <td style="width:15px;"></td>
            <td style="background:white; padding:20px; border-radius:8px; text-align:center; width:50%;"><div style="font-size:32px; font-weight:bold; color:#10b981;">${stats.newSales || 0}</div><div style="color:#666;">Sales Today</div></td>
          </tr>
          <tr><td colspan="3" style="height:15px;"></td></tr>
          <tr>
            <td style="background:white; padding:20px; border-radius:8px; text-align:center;"><div style="font-size:32px; font-weight:bold; color:#f59e0b;">${stats.lowStockCount || 0}</div><div style="color:#666;">Low Stock Items</div></td>
            <td style="width:15px;"></td>
            <td style="background:white; padding:20px; border-radius:8px; text-align:center;"><div style="font-size:32px; font-weight:bold; color:#ef4444;">${stats.overdueInvoices || 0}</div><div style="color:#666;">Overdue Invoices</div></td>
          </tr>
        </table>
        <div style="text-align:center; margin-top:30px;">
          <a href="${FRONTEND_URL}/dashboard" style="background:#7c3aed; color:white; padding:12px 30px; text-decoration:none; border-radius:8px; display:inline-block;">View Dashboard</a>
        </div>
        <hr style="border:none; border-top:1px solid #ddd; margin:30px 0;"/>
        <p style="font-size:12px; color:#888; text-align:center;">StockManager — Automated Daily Report</p>
      </div>
    </div>`;

  return sendEmail(emails.join(','), subject, html);
};

const sendWeeklySummaryEmail = async (company, stats) => {
  const User = require('../models/User');
  const admins = await User.find({ company: company._id, role: 'admin', isActive: true }).select('email');
  const emails = admins.map((a) => a.email).filter(Boolean);
  if (emails.length === 0) return false;

  const startOfWeek = new Date();
  startOfWeek.setDate(startOfWeek.getDate() - 7);
  const currency = company.currency || 'RF';

  const subject = `📊 Weekly Summary - ${esc(company.name)} - Week of ${startOfWeek.toLocaleDateString()}`;

  const html = `
    <div style="font-family:Arial,sans-serif; max-width:600px; margin:0 auto;">
      <div style="background:linear-gradient(135deg,#10b981,#059669); padding:30px; border-radius:10px 10px 0 0;">
        <h1 style="color:white; margin:0; text-align:center;">📊 Weekly Summary</h1>
        <p style="color:white; text-align:center; margin:10px 0 0;">${esc(company.name)}</p>
        <p style="color:white; text-align:center; margin:5px 0 0;">${startOfWeek.toLocaleDateString()} — ${new Date().toLocaleDateString()}</p>
      </div>
      <div style="background:#f9f9f9; padding:30px; border:1px solid #ddd; border-top:none; border-radius:0 0 10px 10px;">
        <table style="width:100%; border-collapse:collapse; margin:20px 0;">
          <tr>
            <td style="background:white; padding:20px; border-radius:8px; text-align:center; width:50%;"><div style="font-size:32px; font-weight:bold; color:#7c3aed;">${stats.totalInvoices || 0}</div><div style="color:#666;">Total Invoices</div></td>
            <td style="width:15px;"></td>
            <td style="background:white; padding:20px; border-radius:8px; text-align:center; width:50%;"><div style="font-size:32px; font-weight:bold; color:#10b981;">${currency} ${(stats.totalRevenue || 0).toFixed(2)}</div><div style="color:#666;">Total Revenue</div></td>
          </tr>
          <tr><td colspan="3" style="height:15px;"></td></tr>
          <tr>
            <td style="background:white; padding:20px; border-radius:8px; text-align:center;"><div style="font-size:32px; font-weight:bold; color:#f59e0b;">${stats.totalPurchases || 0}</div><div style="color:#666;">Purchase Orders</div></td>
            <td style="width:15px;"></td>
            <td style="background:white; padding:20px; border-radius:8px; text-align:center;"><div style="font-size:32px; font-weight:bold; color:#ef4444;">${stats.lowStockCount || 0}</div><div style="color:#666;">Low Stock Items</div></td>
          </tr>
        </table>
        <div style="text-align:center; margin-top:30px;">
          <a href="${FRONTEND_URL}/reports" style="background:#10b981; color:white; padding:12px 30px; text-decoration:none; border-radius:8px; display:inline-block;">View Full Report</a>
        </div>
        <hr style="border:none; border-top:1px solid #ddd; margin:30px 0;"/>
        <p style="font-size:12px; color:#888; text-align:center;">StockManager — Automated Weekly Report</p>
      </div>
    </div>`;

  return sendEmail(emails.join(','), subject, html);
};

// ============================================
// USER INVITATION
// ============================================

const sendUserInvitationEmail = async ({ to, name, companyName, inviterName, role, departmentName, setupUrl }) => {
  const safeCompanyName = esc(companyName || 'KUBIKA');
  const safeInviterName = esc(inviterName || 'Your administrator');
  const safeRole = esc(role || 'Viewer');
  const safeDepartment = esc(departmentName || 'Not specified');
  const subject = `Invitation to join ${String(companyName || 'KUBIKA').replace(/[\r\n]+/g, ' ').trim()}`;
  const actionUrl = setupUrl || `${FRONTEND_URL}/login`;
  const text = [
    `Hello ${name || 'there'},`,
    '',
    `${inviterName || 'Your administrator'} invited you to join ${companyName || 'KUBIKA'} as ${role || 'Viewer'}.`,
    `Department: ${departmentName || 'Not specified'}`,
    setupUrl ? 'Set your password using this secure, one-time link:' : 'Use your existing password to sign in.',
    `${actionUrl}${setupUrl ? '\nThis link expires in 24 hours.' : ''}`,
    '',
    'If you were not expecting this invitation, you can ignore this email.',
  ].join('\n');

  const html = `
    <div style="font-family:Arial,sans-serif; max-width:600px; margin:0 auto; color:#1f2937;">
      <div style="padding:24px 0; border-bottom:2px solid #0f766e;">
        <p style="margin:0 0 8px; color:#0f766e; font-size:12px; font-weight:700; letter-spacing:1.5px;">KUBIKA SYSTEM</p>
        <h1 style="color:#172033; margin:0; font-size:24px;">You have been invited</h1>
      </div>
      <div style="padding:24px 0;">
        <p>Hello <strong>${esc(name || 'there')}</strong>,</p>
        <p><strong>${safeInviterName}</strong> invited you to join <strong>${safeCompanyName}</strong> on KUBIKA.</p>
        <p>Your role: <strong>${safeRole}</strong></p>
        <p>Department: <strong>${safeDepartment}</strong></p>
        ${setupUrl
          ? '<p>For your security, set your password using the one-time link below. The link expires in 24 hours.</p>'
          : '<p>Use your existing password to sign in. Your access to this workspace has been added.</p>'}
        <div style="margin:28px 0;">
          <a href="${esc(actionUrl)}" style="background:#0f766e; color:white; padding:12px 20px; border-radius:6px; text-decoration:none; display:inline-block;">${setupUrl ? 'Set password and continue' : 'Open KUBIKA'}</a>
        </div>
        ${setupUrl ? `<p style="color:#6b7280; font-size:12px;">If the button does not work, copy this link into your browser:<br/><a href="${esc(actionUrl)}" style="color:#0f766e; word-break:break-all;">${esc(actionUrl)}</a></p>` : ''}
        <p style="color:#6b7280; font-size:13px;">If you were not expecting this invitation, you can ignore this email.</p>
        <p style="color:#6b7280; font-size:12px; margin-top:28px;">KUBIKA System · Secure Business Operations</p>
      </div>
    </div>`;

  return sendEmail(to, subject, html, { text });
};

// ============================================
// QUOTATION NOTIFICATIONS
// ============================================

const sendQuotationEmail = async (quotation, company, client, action = 'sent', recipientEmail) => {
  const config = env.getConfig();
  if (!config.features?.emailNotifications) {
    console.warn('[Quotation] Email notifications disabled (ENABLE_EMAIL_NOTIFICATIONS=false)');
    return false;
  }

  const { valid } = require('../config/email').validateConfig();
  if (!valid) {
    console.warn('[Quotation] Email provider is not configured — skipping quotation email');
    return false;
  }

  const clientEmail = recipientEmail || client?.contact?.email || client?.email;
  if (!clientEmail) {
    console.warn('[Quotation] No client email found for quotation:', quotation?.referenceNo || quotation?._id);
    return false;
  }

  const actionText = { sent: 'Sent', accepted: 'Accepted', rejected: 'Rejected', expired: 'Expired' }[action] || 'Updated';
  const refNo = quotation.referenceNo || quotation.quotationNumber || quotation._id;
  const subject = `Quotation ${refNo} - ${actionText}`;
  const currency = quotation.currencyCode || quotation.currency || 'RWF';
  const lines = quotation.lines || [];
  const statusColor = action === 'accepted' ? '#10b981' : action === 'rejected' ? '#ef4444' : action === 'expired' ? '#f59e0b' : '#7c3aed';

  const itemsHtml = lines.length
    ? lines.map((line) => {
      const productName = line.product?.name || line.productName || line.description || 'Item';
      const qty = line.qty ?? line.quantity ?? 0;
      const unitPrice = Number(line.unitPrice || 0);
      const lineTotal = Number(line.lineTotal || 0);
      return `
        <tr>
          <td style="padding:10px; border-bottom:1px solid #ddd;">${esc(productName)}</td>
          <td style="padding:10px; border-bottom:1px solid #ddd; text-align:center;">${qty}</td>
          <td style="padding:10px; border-bottom:1px solid #ddd; text-align:right;">${currency} ${unitPrice.toFixed(2)}</td>
          <td style="padding:10px; border-bottom:1px solid #ddd; text-align:right;">${currency} ${lineTotal.toFixed(2)}</td>
        </tr>`;
    }).join('')
    : '';

  const acceptToken = quotation.publicAcceptToken || quotation.customerAction?.publicAcceptToken;
  const rejectToken = quotation.publicRejectToken || quotation.customerAction?.publicRejectToken;
  const acceptUrl = acceptToken
    ? `${FRONTEND_URL}/quotations/public/${acceptToken}/accept`
    : `${FRONTEND_URL}/quotations/${quotation._id}`;
  const rejectUrl = rejectToken
    ? `${FRONTEND_URL}/quotations/public/${rejectToken}/reject`
    : `${FRONTEND_URL}/quotations/${quotation._id}`;

  const totalAmount = Number(quotation.totalAmount ?? quotation.grandTotal ?? 0);
  const expiryDate = quotation.expiryDate || quotation.validUntil;

  const html = `
    <div style="font-family:Arial,sans-serif; max-width:600px; margin:0 auto;">
      <div style="background:${statusColor}; padding:30px; border-radius:10px 10px 0 0;">
        <h1 style="color:white; margin:0; text-align:center;">📄 Quotation ${esc(actionText)}</h1>
      </div>
      <div style="background:#f9f9f9; padding:30px; border:1px solid #ddd; border-top:none; border-radius:0 0 10px 10px;">
        <h2 style="color:${statusColor}; margin:0 0 5px;">${esc(refNo)}</h2>
        <p style="color:#666; margin:5px 0;">From: ${esc(company?.name || 'KUBIKA')}</p>
        <p style="color:#666; margin:5px 0;">Date: ${new Date(quotation.quotationDate || quotation.createdAt).toLocaleDateString()}</p>
        <p style="color:#666; margin:5px 0;">Status: <strong>${esc(actionText)}</strong></p>
        <div style="background:white; padding:15px; border-radius:8px; margin:20px 0;">
          <strong>Customer:</strong><br/>${esc(client?.name || 'Customer')}
        </div>
        <table style="width:100%; border-collapse:collapse; margin:20px 0;">
          <thead>
            <tr style="background:${statusColor}; color:white;">
              <th style="padding:12px; text-align:left;">Product</th>
              <th style="padding:12px; text-align:center;">Qty</th>
              <th style="padding:12px; text-align:right;">Unit Price</th>
              <th style="padding:12px; text-align:right;">Total</th>
            </tr>
          </thead>
          <tbody>${itemsHtml}</tbody>
        </table>
        <div style="text-align:right; margin:20px 0;">
          <p style="margin:5px 0; font-size:18px; font-weight:bold; color:${statusColor};">Total: ${currency} ${moneyFmt(totalAmount)}</p>
        </div>
        ${expiryDate ? `<p style="color:#666;">Valid until: ${new Date(expiryDate).toLocaleDateString()}</p>` : ''}
        ${quotation.notes ? `<div style="background:white; padding:15px; border-radius:8px; margin:20px 0;"><strong>Notes:</strong><br/>${esc(quotation.notes)}</div>` : ''}
        ${action === 'sent' ? `
        <div style="text-align:center; margin-top:30px; display:flex; gap:12px; justify-content:center; flex-wrap:wrap;">
          <a href="${acceptUrl}" style="background:#10b981; color:white; padding:12px 18px; text-decoration:none; border-radius:8px; display:inline-block;">Accept</a>
          <a href="${rejectUrl}" style="background:#ef4444; color:white; padding:12px 18px; text-decoration:none; border-radius:8px; display:inline-block;">Reject</a>
          <a href="${FRONTEND_URL}/quotations/${quotation._id}" style="background:${statusColor}; color:white; padding:12px 18px; text-decoration:none; border-radius:8px; display:inline-block;">View</a>
        </div>` : ''}
        <hr style="border:none; border-top:1px solid #ddd; margin:30px 0;"/>
        <p style="font-size:12px; color:#888; text-align:center;">KUBIKA system — Manage Your Stock From Supply to Final Sale</p>
      </div>
    </div>`;

  return sendEmail(clientEmail, subject, html);
};

// ============================================
// EXPORTS
// ============================================

module.exports = {
  // Expose the same non-secret configuration summary used by notification
  // settings and provider health indicators.
  validateConfig: () => require('../config/email').validateConfig(),
  sendEmail,
  // Invoice
  sendInvoiceEmail,
  // Payment reminders
  sendPaymentReminderEmail,
  // Low stock alerts
  sendLowStockAlertEmail,
  sendBulkLowStockAlert,
  // Welcome / Auth
  sendWelcomeEmail,
  sendPasswordResetEmail,
  // Backup
  sendBackupConfirmation,
  // Summary reports
  sendDailySummaryEmail,
  sendWeeklySummaryEmail,
  // Company notifications
  sendApprovalEmail,
  sendRejectionEmail,
  // Purchase Order notifications
  sendPurchaseOrderEmail,
  sendQuotationEmail,
  sendGRNReceivedEmail,
  // Sales Order notifications
  sendSalesOrderEmail,
  // Purchase (Direct/Legacy) notifications
  sendPurchaseEmail,
  // User Invitation
  sendUserInvitationEmail
};
