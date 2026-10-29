const NotificationSettings = require('../models/NotificationSettings');
const Notification = require('../models/Notification');
const smsService = require('../services/smsService');
const emailService = require('../services/emailService');
const Invoice = require('../models/Invoice');
const Company = require('../models/Company');
const { parseBoundedPage } = require('../utils/querySafety');
const { dbClient } = require('../lib/prisma');

const notificationTimezone = (() => {
  const candidate = String(process.env.NOTIFICATION_TIMEZONE || process.env.TZ || 'UTC').trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date());
    return candidate;
  } catch (_) {
    return 'UTC';
  }
})();

function getRequestUserId(req) {
  return req.user?._id || req.user?.id;
}

function getRequestCompanyId(req) {
  return req.company?._id || req.company || req.user?.company?._id || req.user?.company;
}

function sendMissingContext(res) {
  return res.status(401).json({
    success: false,
    message: 'Authenticated user or company context is missing'
  });
}

const MAX_NOTIFICATION_THRESHOLD_INTEGER = '999999999999999';

function parseNotificationThreshold(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;

  const text = typeof value === 'string' ? value.trim() : String(value);
  if (!/^(?:\d+)(?:\.\d{1,4})?$/.test(text)) return null;

  const [integerPart] = text.split('.');
  const normalizedInteger = integerPart.replace(/^0+(?=\d)/, '');
  if (normalizedInteger.length > MAX_NOTIFICATION_THRESHOLD_INTEGER.length
    || (normalizedInteger.length === MAX_NOTIFICATION_THRESHOLD_INTEGER.length
      && normalizedInteger > MAX_NOTIFICATION_THRESHOLD_INTEGER)) return null;

  // Keep decimal input as a string so Prisma's DECIMAL(19,4) receives the
  // exact validated value instead of a rounded JavaScript floating-point value.
  return text;
}

function parsePaymentReminderDays(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  const text = typeof value === 'string' ? value.trim() : String(value);
  if (!/^\d{1,3}$/.test(text)) return null;
  const days = Number(text);
  return days <= 365 ? days : null;
}

function normalizeNotificationPhoneList(value, fieldName) {
  if (!Array.isArray(value)) {
    return { error: `${fieldName} must be an array of phone numbers.` };
  }
  if (value.length > 50) {
    return { error: `${fieldName} cannot contain more than 50 phone numbers.` };
  }

  const normalized = [];
  for (let index = 0; index < value.length; index += 1) {
    const phone = value[index];
    if (typeof phone !== 'string' || !phone.trim() || !/^\+?[\d\s().-]+$/.test(phone.trim())) {
      return { error: `${fieldName}[${index}] must be a valid phone number. Use international format, such as +250788123456.` };
    }
    const normalizedPhone = smsService.normalizePhoneNumber(phone.trim());
    if (!normalizedPhone) {
      return { error: `${fieldName}[${index}] could not be normalized. Include the country code or configure a default country code.` };
    }
    normalized.push(normalizedPhone);
  }

  return { value: [...new Set(normalized)] };
}


// @desc    Get all notifications for user
// @route   GET /api/notifications
// @access  Private
exports.getNotifications = async (req, res, next) => {
  try {
    const companyId = getRequestCompanyId(req);
    const userId = getRequestUserId(req);
    const { page, limit } = parseBoundedPage(req.query, { defaultLimit: 20, maxLimit: 100 });
    const { unreadOnly } = req.query;

    if (!userId) {
      return sendMissingContext(res);
    }

    if (!companyId) {
      return res.json({
        success: true,
        data: [],
        pagination: {
          page,
          limit,
          total: 0,
          pages: 0
        },
        unreadCount: 0,
        typeCounts: {},
        severityCounts: {}
      });
    }

    const query = {
      company: companyId,
      user: userId
    };
    
    if (unreadOnly === 'true') {
      query.isRead = false;
    }
    
    const prismaWhere = {
      companyId: String(companyId),
      userId: String(userId),
      ...(unreadOnly === 'true' ? { isRead: false } : {}),
    };
    const [notifications, total, unreadCount, groupedCounts] = await Promise.all([
      Notification.find(query)
        .sort({ createdAt: -1, _id: -1 })
        .limit(limit)
        .skip((page - 1) * limit),
      Notification.countDocuments(query),
      Notification.countDocuments({ company: companyId, user: userId, isRead: false }),
      dbClient().notification.groupBy({
        by: ['type', 'severity'],
        where: prismaWhere,
        // Prisma requires a deterministic order when groupBy uses `take`.
        // Without it the notifications endpoint rejects the request (500).
        orderBy: [{ type: 'asc' }, { severity: 'asc' }],
        _count: { _all: true },
        take: 500,
      }),
    ]);
    const typeCounts = {};
    const severityCounts = {};
    for (const group of groupedCounts) {
      const count = group._count._all;
      typeCounts[group.type] = (typeCounts[group.type] || 0) + count;
      severityCounts[group.severity] = (severityCounts[group.severity] || 0) + count;
    }
    
    res.json({
      success: true,
      data: notifications,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      },
      unreadCount,
      typeCounts,
      severityCounts,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get unread notifications count
// @route   GET /api/notifications/unread-count
// @access  Private
exports.getUnreadCount = async (req, res, next) => {
  try {
    const companyId = getRequestCompanyId(req);
    const userId = getRequestUserId(req);

    if (!userId) {
      return sendMissingContext(res);
    }

    if (!companyId) {
      return res.json({
        success: true,
        count: 0
      });
    }

    const count = await Notification.countDocuments({
      company: companyId,
      user: userId,
      isRead: false
    });
    
    res.json({
      success: true,
      count
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Mark notification as read
// @route   PUT /api/notifications/:id/read
// @access  Private
exports.markAsRead = async (req, res, next) => {
  try {
    const companyId = getRequestCompanyId(req);
    const userId = getRequestUserId(req);
    if (!companyId || !userId) {
      return sendMissingContext(res);
    }

    const notification = await Notification.findOne({ _id: req.params.id, company: companyId, user: userId });
    
    if (!notification) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found'
      });
    }
    
    // Verify ownership
    if (notification.user.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized'
      });
    }
    
    notification.isRead = true;
    notification.readAt = new Date();
    await notification.save();
    
    res.json({
      success: true,
      data: notification
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Mark all notifications as read
// @route   PUT /api/notifications/read-all
// @access  Private
exports.markAllAsRead = async (req, res, next) => {
  try {
    const companyId = getRequestCompanyId(req);
    const userId = getRequestUserId(req);

    if (!companyId || !userId) {
      return sendMissingContext(res);
    }

    await Notification.updateMany(
      { company: companyId, user: userId, isRead: false },
      { isRead: true, readAt: new Date() }
    );
    
    res.json({
      success: true,
      message: 'All notifications marked as read'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete a notification
// @route   DELETE /api/notifications/:id
// @access  Private
exports.deleteNotification = async (req, res, next) => {
  try {
    const companyId = getRequestCompanyId(req);
    const userId = getRequestUserId(req);
    if (!companyId || !userId) {
      return sendMissingContext(res);
    }

    const notification = await Notification.findOne({ _id: req.params.id, company: companyId, user: userId });
    
    if (!notification) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found'
      });
    }
    
    // Verify ownership
    if (notification.user.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized'
      });
    }
    
    await notification.deleteOne();
    
    res.json({
      success: true,
      message: 'Notification deleted'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create a notification (helper for other parts of the app)
// @desc    Get notification settings
// @route   GET /api/notifications/settings
// @access  Private (admin)
exports.getSettings = async (req, res, next) => {
  try {
    const companyId = getRequestCompanyId(req);

    if (!companyId) {
      return sendMissingContext(res);
    }

    let settings = await NotificationSettings.findOne({ company: companyId });
    
    if (!settings) {
      // Create default settings
      settings = await NotificationSettings.create({
        company: companyId,
        emailNotifications: {
          enabled: true,
          invoiceDelivery: false,
          paymentReminders: true,
          lowStockAlerts: true,
          dailySummary: false,
          weeklySummary: true
        },
        smsNotifications: {
          enabled: false,
          criticalOnly: true,
          adminPhones: []
        }
      });
    }
    
    res.json({
      success: true,
      data: {
        ...settings,
        scheduleTimezone: notificationTimezone,
        deliveryProviders: getNotificationProviderStatus()
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update notification settings
// @route   PUT /api/notifications/settings
// @access  Private (admin)
exports.updateSettings = async (req, res, next) => {
  try {
    const companyId = getRequestCompanyId(req);

    if (!companyId) {
      return sendMissingContext(res);
    }

    const {
      emailNotifications,
      smsNotifications,
      preferences,
      criticalAlertPhones
    } = req.body;
    let normalizedAdminPhones;
    if (smsNotifications?.adminPhones !== undefined) {
      const result = normalizeNotificationPhoneList(smsNotifications.adminPhones, 'smsNotifications.adminPhones');
      if (result.error) {
        return res.status(400).json({ success: false, code: 'INVALID_NOTIFICATION_PHONE', message: result.error });
      }
      normalizedAdminPhones = result.value;
    }
    const hasCriticalAlertPhones = Object.prototype.hasOwnProperty.call(req.body, 'criticalAlertPhones');
    let normalizedCriticalAlertPhones;
    if (hasCriticalAlertPhones) {
      const result = normalizeNotificationPhoneList(criticalAlertPhones, 'criticalAlertPhones');
      if (result.error) {
        return res.status(400).json({ success: false, code: 'INVALID_NOTIFICATION_PHONE', message: result.error });
      }
      normalizedCriticalAlertPhones = result.value;
    }
    const hasPreferences = preferences !== undefined;
    if (hasPreferences && (!preferences || typeof preferences !== 'object' || Array.isArray(preferences))) {
      return res.status(400).json({ success: false, code: 'INVALID_NOTIFICATION_PREFERENCES', message: 'Notification preferences must be an object.' });
    }
    const normalizedPreferences = hasPreferences ? { ...preferences } : undefined;

    if (hasPreferences) {
      if (preferences.summarySendTime !== undefined
        && (typeof preferences.summarySendTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(preferences.summarySendTime))) {
        return res.status(400).json({ success: false, code: 'INVALID_SUMMARY_SEND_TIME', message: 'Summary send time must use HH:mm (24-hour) format.' });
      }
      for (const field of ['lowStockThreshold', 'largeOrderThreshold']) {
        if (preferences[field] === undefined) continue;
        const value = parseNotificationThreshold(preferences[field]);
        if (value === null) {
          return res.status(400).json({ success: false, code: 'INVALID_NOTIFICATION_THRESHOLD', message: `${field} must be between 0 and 999999999999999, with no more than 4 decimal places.` });
        }
        normalizedPreferences[field] = value;
      }
      if (preferences.paymentReminderDays !== undefined) {
        const days = parsePaymentReminderDays(preferences.paymentReminderDays);
        if (days === null) {
          return res.status(400).json({ success: false, code: 'INVALID_PAYMENT_REMINDER_DAYS', message: 'Payment reminder days must be a whole number from 0 to 365.' });
        }
        normalizedPreferences.paymentReminderDays = days;
      }
    }
    
    let settings = await NotificationSettings.findOne({ company: companyId });
    
    if (!settings) {
      settings = await NotificationSettings.create({
        company: companyId
      });
    }
    
    // Update fields
    if (emailNotifications) {
      settings.emailNotifications = {
        ...settings.emailNotifications,
        ...emailNotifications
      };
    }
    
    if (smsNotifications) {
      settings.smsNotifications = {
        ...settings.smsNotifications,
        ...smsNotifications,
        ...(normalizedAdminPhones !== undefined ? { adminPhones: normalizedAdminPhones } : {})
      };
    }
    
    if (hasPreferences) {
      settings.preferences = {
        ...settings.preferences,
        ...normalizedPreferences
      };
    }
    
    if (hasCriticalAlertPhones) {
      settings.criticalAlertPhones = normalizedCriticalAlertPhones;
    }
    
    await settings.save();
    
    res.json({
      success: true,
      data: {
        ...settings,
        scheduleTimezone: notificationTimezone,
        deliveryProviders: getNotificationProviderStatus()
      }
    });
  } catch (error) {
    next(error);
  }
};

// Reports credential/configuration presence only. Connectivity is verified only
// by sending a test message; never return secret values to the client.
function getNotificationProviderStatus() {
  const emailService = require('../services/emailService');
  const emailConfig = emailService.validateConfig();
  const smsProvider = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER
    ? 'Twilio'
    : process.env.NEXMO_API_KEY && process.env.NEXMO_API_SECRET && process.env.NEXMO_FROM_NUMBER
      ? 'Vonage'
      : null;

  return {
    email: {
      provider: emailConfig.provider,
      configured: emailConfig.valid
    },
    sms: {
      provider: smsProvider,
      configured: Boolean(smsProvider)
    }
  };
}

// @desc    Test email notification
// @route   POST /api/notifications/test-email
// @access  Private (admin)
exports.testEmail = async (req, res, next) => {
  try {
    const { email } = req.body;
    const emailService = require('../services/emailService');
    
    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email address required'
      });
    }
    
    const result = await emailService.sendEmail(
      email,
      'Test Notification - KUBIKA SYSTEM',
      `
      <h2>Test Notification</h2>
      <p>This is a test email from your KUBIKA SYSTEM.</p>
      <p>If you received this, your email notifications are configured correctly!</p>
      `
    );
    
    if (result) {
      res.json({
        success: true,
        message: 'Test email sent successfully'
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to send test email'
      });
    }
  } catch (error) {
    next(error);
  }
};

// @desc    Test SMS notification
// @route   POST /api/notifications/test-sms
// @access  Private (admin)
exports.testSMS = async (req, res, next) => {
  try {
    const { phone } = req.body;
    const smsService = require('../services/smsService');
    
    if (!phone) {
      return res.status(400).json({
        success: false,
        message: 'Phone number required'
      });
    }
    
    const result = await smsService.sendSMS(
      phone,
      'This is a test SMS from your KUBIKA system. If you received this, your SMS notifications are configured correctly!'
    );
    
    if (result.success) {
      res.json({
        success: true,
        message: 'Test SMS sent successfully',
        messageId: result.messageId
      });
    } else {
      res.status(500).json({
        success: false,
        message: result.error || 'Failed to send test SMS'
      });
    }
  } catch (error) {
    next(error);
  }
};

// @desc    Trigger manual summary report
// @route   POST /api/notifications/send-summary
// @access  Private (admin)
exports.sendManualSummary = async (req, res, next) => {
  try {
    const { type } = req.body; // 'daily' or 'weekly'
    const companyId = getRequestCompanyId(req);
    const Company = require('../models/Company');
    const emailService = require('../services/emailService');

    if (!companyId) {
      return sendMissingContext(res);
    }
    
    const company = await Company.findById(companyId);
    
    if (!company) {
      return res.status(404).json({
        success: false,
        message: 'Company not found'
      });
    }
    
    // Get stats based on type
    const Invoice = require('../models/Invoice');
    const Product = require('../models/Product');
    
    const days = type === 'weekly' ? 7 : 1;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    
    const [
      totalInvoices,
      totalRevenue,
      lowStockCount,
      topProducts
    ] = await Promise.all([
      Invoice.countDocuments({ company: companyId, createdAt: { $gte: since } }),
      Invoice.aggregate([
        { $match: { company: companyId, status: 'confirmed', createdAt: { $gte: since } } },
        { $group: { _id: null, total: { $sum: '$total' } } }
      ]),
      Product.countDocuments({ company: companyId, currentStock: { $lte: Number(process.env.LOW_STOCK_THRESHOLD || 5) } }),
      Product.find({ company: companyId }).sort({ currentStock: 1 }).limit(5)
    ]);
    
    const stats = {
      newInvoices: totalInvoices,
      newSales: totalInvoices,
      lowStockCount,
      overdueInvoices: 0,
      topProducts: topProducts.map(p => ({ name: p.name, quantity: p.currentStock })),
      totalInvoices,
      totalRevenue: totalRevenue[0]?.total || 0,
      totalPurchases: 0
    };
    
    let result;
    if (type === 'weekly') {
      result = await emailService.sendWeeklySummaryEmail(company, stats);
    } else {
      result = await emailService.sendDailySummaryEmail(company, stats);
    }
    
    if (result) {
      res.json({
        success: true,
        message: `${type === 'weekly' ? 'Weekly' : 'Daily'} summary sent successfully`
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to send summary report'
      });
    }
  } catch (error) {
    next(error);
  }
};

// @desc    Send manual payment reminder for an invoice
// @route   POST /api/notifications/send-payment-reminder
// @access  Private (admin)
exports.sendManualPaymentReminder = async (req, res, next) => {
  try {
    const { invoiceId } = req.body;
    const companyId = getRequestCompanyId(req);

    if (!companyId) {
      return sendMissingContext(res);
    }

    if (!invoiceId) {
      return res.status(400).json({
        success: false,
        message: 'Invoice ID is required'
      });
    }

    const invoice = await Invoice.findOne({
      _id: invoiceId,
      company: companyId
    }).populate('client company');

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found'
      });
    }

    const clientEmail = invoice.client?.contact?.email || invoice.client?.email;
    if (!clientEmail) {
      return res.status(400).json({
        success: false,
        message: 'Client email not found'
      });
    }

    const config = require('../src/config/environment').getConfig();
    if (!config.features?.emailNotifications || !config.email?.gmailUser) {
      return res.status(500).json({
        success: false,
        message: 'Email notifications not configured'
      });
    }

    await emailService.sendPaymentReminderEmail(invoice, invoice.company, invoice.client);

    res.json({
      success: true,
      message: `Payment reminder sent to ${clientEmail}`
    });
  } catch (error) {
    next(error);
  }
};
