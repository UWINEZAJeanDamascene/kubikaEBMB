const cron = require('node-cron');
const Invoice = require('../models/Invoice');
const Product = require('../models/Product');
const Company = require('../models/Company');
const User = require('../models/User');
const NotificationSettings = require('../models/NotificationSettings');
const FixedAsset = require('../models/FixedAsset');
const JournalEntry = require('../models/JournalEntry');
const emailService = require('./emailService');
const smsService = require('./smsService');
const { notifyLowStock, notifyOutOfStock } = require('./notificationHelper');
const { DEFAULT_ACCOUNTS } = require('../constants/chartOfAccounts');
const JournalService = require('./journalService');
const { dbClient } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');

const SCHEDULER_PAGE_SIZE = Math.min(100, Math.max(10, Number(process.env.SCHEDULER_PAGE_SIZE || 100)));
const SCHEDULER_MAX_ROWS = Math.max(SCHEDULER_PAGE_SIZE, Number(process.env.SCHEDULER_MAX_ROWS || 10000));
const LOW_STOCK_NOTIFICATION_COOLDOWN_HOURS = (() => {
  const value = Number(process.env.LOW_STOCK_NOTIFICATION_COOLDOWN_HOURS || 24);
  return Number.isFinite(value) && value > 0 && value <= 720 ? value : 24;
})();
const NOTIFICATION_TIMEZONE = (() => {
  const candidate = String(process.env.NOTIFICATION_TIMEZONE || process.env.TZ || 'UTC').trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date());
    return candidate;
  } catch (_) {
    console.error(`Invalid NOTIFICATION_TIMEZONE "${candidate}"; notification schedules will use UTC.`);
    return 'UTC';
  }
})();

function getScheduleClock(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: NOTIFICATION_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return {
    date: `${value.year}-${value.month}-${value.day}`,
    time: `${value.hour}:${value.minute}`,
    weekday: value.weekday,
  };
}

async function claimSummaryDelivery(settings, kind, dateKey) {
  const field = kind === 'daily' ? 'lastDailySummaryDate' : 'lastWeeklySummaryDate';
  const id = String(settings?._id || settings?.id || '');
  const companyId = String(settings?.company || settings?.companyId || '');
  if (!id || !companyId) return false;
  const result = await dbClient().notificationSettings.updateMany({
    where: {
      id,
      companyId,
      OR: [{ [field]: null }, { [field]: { not: dateKey } }],
    },
    data: { [field]: dateKey },
  });
  if (result.count === 1) {
    settings[field] = dateKey;
    return true;
  }
  return false;
}

async function releaseSummaryDelivery(settings, kind, dateKey) {
  const field = kind === 'daily' ? 'lastDailySummaryDate' : 'lastWeeklySummaryDate';
  const id = String(settings?._id || settings?.id || '');
  const companyId = String(settings?.company || settings?.companyId || '');
  if (!id || !companyId) return;
  await dbClient().notificationSettings.updateMany({
    where: { id, companyId, [field]: dateKey },
    data: { [field]: null },
  });
}

async function claimLowStockAlert(companyId, productId, alertType, now = new Date()) {
  const identity = { companyId: String(companyId), productId: String(productId), alertType };
  const cutoff = new Date(now.getTime() - LOW_STOCK_NOTIFICATION_COOLDOWN_HOURS * 60 * 60 * 1000);
  const updated = await dbClient().stockAlertCooldown.updateMany({
    where: { ...identity, lastNotifiedAt: { lte: cutoff } },
    data: { lastNotifiedAt: now },
  });
  if (updated.count === 1) return now;

  try {
    await dbClient().stockAlertCooldown.create({
      data: { id: generateObjectId(), ...identity, lastNotifiedAt: now },
    });
    return now;
  } catch (error) {
    // A concurrent worker may have claimed the unique key after updateMany.
    if (error?.code === 'P2002') return null;
    throw error;
  }
}

async function releaseLowStockAlertClaim(companyId, productId, alertType, claimedAt) {
  await dbClient().stockAlertCooldown.deleteMany({
    where: {
      companyId: String(companyId), productId: String(productId), alertType,
      lastNotifiedAt: claimedAt,
    },
  });
}

async function fetchPaged(model, filter, configure = (query) => query, pageSize = SCHEDULER_PAGE_SIZE) {
  const rows = [];
  for (let page = 0; page * pageSize < SCHEDULER_MAX_ROWS; page += 1) {
    let query = model.find(filter)
      .sort({ _id: 1 })
      .skip(page * pageSize)
      .limit(Math.min(pageSize, SCHEDULER_MAX_ROWS - page * pageSize));
    query = configure(query) || query;
    const batch = await query;
    rows.push(...batch);
    if (batch.length < pageSize) return rows;
  }
  throw Object.assign(new Error(`scheduler read exceeded ${SCHEDULER_MAX_ROWS} rows`), { code: 'READ_BATCH_EXCEEDED', statusCode: 413 });
}

// ============================================
// HELPER FUNCTIONS
// ============================================

// Get notification settings for a company
const getNotificationSettings = async (companyId) => {
  try {
    let settings = await NotificationSettings.findOne({ company: companyId });
    
    // Create default settings if none exist (use upsert to avoid duplicate-key race)
    if (!settings) {
      settings = await NotificationSettings.findOneAndUpdate(
        { company: companyId },
        {
          $setOnInsert: {
            company: companyId,
            emailNotifications: {
              enabled: true,
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
          }
        },
        { upsert: true, new: true }
      );
    }
    
    return settings;
  } catch (err) {
    console.error('Error getting notification settings:', err);
    return null;
  }
};

// Get admin users with phones for SMS
const getAdminPhones = async (companyId, existingSettings) => {
  const admins = await fetchPaged(User, {
    company: companyId,
    role: 'admin',
    isActive: true,
  }, (query) => query.select('phone'));

  const phones = admins.map(a => a.phone).filter(Boolean);
  const settings = existingSettings || await getNotificationSettings(companyId);
  
  if (settings?.smsNotifications?.adminPhones?.length > 0) {
    return [...new Set([...phones, ...settings.smsNotifications.adminPhones])];
  }
  
  return phones;
};

const getCriticalAlertPhones = async (companyId, existingSettings) => {
  const settings = existingSettings || await getNotificationSettings(companyId);
  const configured = (settings?.criticalAlertPhones || [])
    .map((phone) => smsService.normalizePhoneNumber(String(phone || '')))
    .filter(Boolean);
  // Keep legacy delivery to company admins until a dedicated list is configured.
  return configured.length ? [...new Set(configured)] : getAdminPhones(companyId, settings);
};

// ============================================
// PAYMENT REMINDERS
// ============================================

async function sendPaymentReminders() {
  console.log('🔔 Running payment reminder job...');
  
  try {
const companies = await fetchPaged(Company, {});
    
    for (const company of companies) {
      const settings = await getNotificationSettings(company._id);
      
      // Check if email notifications enabled
      if (!settings?.emailNotifications?.enabled || 
          !settings?.emailNotifications?.paymentReminders) {
        continue;
      }

      const daysBefore = Number(settings?.preferences?.paymentReminderDays ?? 3);
      const now = new Date();
      const target = new Date(now.getTime() + daysBefore * 24 * 60 * 60 * 1000);

      // Find due invoices
      const invoices = await fetchPaged(Invoice, {
        company: company._id,
        dueDate: { $lte: target },
        status: { $in: ['draft', 'confirmed'] },
        balance: { $gt: 0 },
      }, (query) => query.populate('client company'));


      for (const inv of invoices) {
        const clientEmail = inv.client?.contact?.email || inv.customerEmail;
        if (!clientEmail) continue;

        try {
          await emailService.sendPaymentReminderEmail(inv, company, inv.client);
          console.log(`📧 Payment reminder sent for invoice ${inv.invoiceNumber}`);
        } catch (err) {
          console.error('Failed to send payment reminder for invoice', inv._id, err);
        }
      }
      
      // Check for overdue invoices - send SMS for critical
      const overdueInvoices = await fetchPaged(Invoice, {
        company: company._id,
        dueDate: { $lt: now },
        status: { $in: ['draft', 'confirmed'] },
        balance: { $gt: 0 },
      });
      
      if (settings?.smsNotifications?.enabled && overdueInvoices.length > 0) {
        const [adminPhones, criticalPhones] = await Promise.all([
          getAdminPhones(company._id, settings),
          getCriticalAlertPhones(company._id, settings),
        ]);
        const phones = [...new Set([...adminPhones, ...criticalPhones])];
        if (phones.length > 0) {
          for (const inv of overdueInvoices.slice(0, 3)) { // Limit to 3 SMS
            await smsService.sendPaymentOverdueSMS(inv, company, phones);
          }
        }
      }
    }
  } catch (err) {
    console.error('Payment reminder job failed', err);
  }
}

// ============================================
// LOW STOCK CHECKS
// ============================================

async function checkLowStock() {
  console.log('🔔 Running low stock check job...');
  
  try {
const companies = await fetchPaged(Company, {});
    const threshold = Number(process.env.LOW_STOCK_THRESHOLD || 10);

    for (const company of companies) {
      const settings = await getNotificationSettings(company._id);
      const companyThreshold = Number(settings?.preferences?.lowStockThreshold ?? threshold);

      // Find low stock products
      // Use `defaultWarehouse` field (if present) instead of `warehouse` which is not in the schema
      const products = await fetchPaged(Product, {
        company: company._id,
        currentStock: { $lte: companyThreshold },
      }, (query) => query.populate('company'));

      // A recovered product starts a new alert lifecycle if it becomes low again.
      const lowProductIds = products.map((product) => String(product._id));
      await dbClient().stockAlertCooldown.deleteMany({
        where: lowProductIds.length
          ? { companyId: String(company._id), productId: { notIn: lowProductIds } }
          : { companyId: String(company._id) },
      });
      const outOfStockIds = products
        .filter((product) => Number(product.currentStock) <= 0)
        .map((product) => String(product._id));
      await dbClient().stockAlertCooldown.deleteMany({
        where: {
          companyId: String(company._id),
          alertType: outOfStockIds.length ? 'low_stock' : 'out_of_stock',
          ...(outOfStockIds.length ? { productId: { in: outOfStockIds } } : {}),
        },
      });
      const lowStockIds = products
        .filter((product) => Number(product.currentStock) > 0)
        .map((product) => String(product._id));
      if (lowStockIds.length) {
        await dbClient().stockAlertCooldown.deleteMany({
          where: {
            companyId: String(company._id),
            productId: { in: lowStockIds },
            alertType: 'out_of_stock',
          },
        });
      }

      const [adminPhones, criticalPhones] = settings?.smsNotifications?.enabled
        ? await Promise.all([
          getAdminPhones(company._id, settings),
          getCriticalAlertPhones(company._id, settings),
        ])
        : [[], []];
      const criticalOnly = settings?.smsNotifications?.criticalOnly !== false;
      for (const p of products) {
        const isCritical = p.currentStock <= Math.floor(companyThreshold / 2);
        const alertType = p.currentStock <= 0 ? 'out_of_stock' : 'low_stock';
        
        // Create in-app database notification
        let alertClaimedAt = null;
        try {
          alertClaimedAt = await claimLowStockAlert(company._id, p._id, alertType);
          if (alertClaimedAt && p.currentStock <= 0) {
            const notifications = await notifyOutOfStock(company._id, p);
            if (notifications.length === 0) {
              await releaseLowStockAlertClaim(company._id, p._id, alertType, alertClaimedAt);
              alertClaimedAt = null;
            }
            console.log(`🔔 In-app notification created: ${p.name} is out of stock`);
          } else if (alertClaimedAt) {
            const notifications = await notifyLowStock(company._id, p, p.currentStock);
            if (notifications.length === 0) {
              await releaseLowStockAlertClaim(company._id, p._id, alertType, alertClaimedAt);
              alertClaimedAt = null;
            }
            console.log(`🔔 In-app notification created: ${p.name} is low stock (${p.currentStock})`);
          }
        } catch (err) {
          if (alertClaimedAt) {
            try {
              await releaseLowStockAlertClaim(company._id, p._id, alertType, alertClaimedAt);
            } catch (releaseError) {
              console.error('Failed to release low-stock alert claim:', releaseError);
            }
          }
          console.error('Failed to create in-app notification:', err);
        }
        
        // Send email alert
        if (settings?.emailNotifications?.enabled && 
            settings?.emailNotifications?.lowStockAlerts) {
          try {
            await emailService.sendLowStockAlertEmail(p, company);
            console.log(`📧 Low stock alert sent for product ${p.name}`);
          } catch (err) {
            console.error('Failed to send low stock email for product', p._id, err);
          }
        }
        
        // Respect the company preference: criticalOnly=true sends only severe
        // alerts; false also sends ordinary low-stock alerts.
        const smsRecipients = isCritical
          ? [...new Set([...adminPhones, ...criticalPhones])]
          : adminPhones;
        if (smsRecipients.length > 0 && (!criticalOnly || isCritical)) {
          try {
            await smsService.sendLowStockAlertSMS(p, company, smsRecipients, isCritical);
          } catch (err) {
            console.error('Failed to send low-stock SMS for product', p._id, err);
          }
        }
      }
    }
  } catch (err) {
    console.error('Low stock check job failed', err);
  }
}

// ============================================
// DAILY SUMMARY REPORTS
// ============================================

async function sendDailySummaryReports() {
  console.log('🔔 Running daily summary job...');
  
  try {
const companies = await fetchPaged(Company, {});

    for (const company of companies) {
      const settings = await getNotificationSettings(company._id);
      
      if (!settings?.emailNotifications?.enabled || 
          !settings?.emailNotifications?.dailySummary) {
        continue;
      }

      const clock = getScheduleClock();
      const sendTime = String(settings.preferences?.summarySendTime || '09:00');
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(sendTime) || clock.time < sendTime) continue;

      // Get stats
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      
      const [
        newInvoices,
        newSales,
        lowStockCount,
        overdueInvoices,
        topProducts
      ] = await Promise.all([
        Invoice.countDocuments({ company: company._id, createdAt: { $gte: since } }),
        Invoice.countDocuments({ company: company._id, status: 'confirmed', createdAt: { $gte: since } }),
        Product.countDocuments({ company: company._id, currentStock: { $lte: Number(settings.preferences?.lowStockThreshold ?? process.env.LOW_STOCK_THRESHOLD ?? 5) } }),
        Invoice.countDocuments({ 
          company: company._id, 
          dueDate: { $lt: new Date() },
          status: { $in: ['draft', 'confirmed'] },
          balance: { $gt: 0 }
        }),
        // Get top products by sales (simplified)
        Product.find({ company: company._id }).sort({ currentStock: 1 }).limit(5)
      ]);

      const stats = {
        newInvoices,
        newSales,
        lowStockCount,
        overdueInvoices,
        topProducts: topProducts.map(p => ({ name: p.name, quantity: p.currentStock }))
      };

      if (!(await claimSummaryDelivery(settings, 'daily', clock.date))) continue;

      try {
        const delivered = await emailService.sendDailySummaryEmail(company, stats);
        if (delivered === false) {
          await releaseSummaryDelivery(settings, 'daily', clock.date);
          continue;
        }
        console.log(`📧 Daily summary sent for company ${company.name}`);
      } catch (err) {
        console.error('Failed to send daily summary for company', company._id, err);
        await releaseSummaryDelivery(settings, 'daily', clock.date).catch((releaseError) => {
          console.error('Could not release daily-summary delivery claim:', releaseError.message || releaseError);
        });
      }
    }
  } catch (err) {
    console.error('Daily summary job failed', err);
  }
}

// ============================================
// WEEKLY SUMMARY REPORTS
// ============================================

async function sendWeeklySummaryReports() {
  console.log('🔔 Running weekly summary job...');
  
  try {
const companies = await fetchPaged(Company, {});

    for (const company of companies) {
      const settings = await getNotificationSettings(company._id);
      
      if (!settings?.emailNotifications?.enabled || 
          !settings?.emailNotifications?.weeklySummary) {
        continue;
      }

      const clock = getScheduleClock();
      const sendTime = String(settings.preferences?.summarySendTime || '09:00');
      if (clock.weekday !== 'Mon' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(sendTime) || clock.time < sendTime) continue;

      // Get stats for last 7 days
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      
      const [
        totalInvoices,
        totalRevenue,
        totalPurchases,
        lowStockCount,
        categoryBreakdown
      ] = await Promise.all([
        Invoice.countDocuments({ company: company._id, createdAt: { $gte: since } }),
        dbClient().invoice.aggregate({
          where: { companyId: String(company._id), status: 'confirmed', createdAt: { gte: since } },
          _sum: { totalAmount: true },
        }),
        require('../models/Purchase').countDocuments({ company: company._id, createdAt: { $gte: since } }),
        Product.countDocuments({ company: company._id, currentStock: { $lte: Number(settings.preferences?.lowStockThreshold ?? process.env.LOW_STOCK_THRESHOLD ?? 5) } }),
        // Category breakdown (simplified)
        dbClient().product.groupBy({
          by: ['categoryId'],
          where: { companyId: String(company._id) },
          _sum: { currentStock: true },
          orderBy: { _sum: { currentStock: 'desc' } },
          take: 5,
        })
      ]);

      const stats = {
        totalInvoices,
        totalRevenue: Number(totalRevenue._sum.totalAmount || 0),
        totalPurchases,
        lowStockCount,
        categoryBreakdown: categoryBreakdown.map(c => ({
          category: c.categoryId || 'Uncategorized',
          revenue: Number(c._sum.currentStock || 0),
        }))
      };

      if (!(await claimSummaryDelivery(settings, 'weekly', clock.date))) continue;

      try {
        const delivered = await emailService.sendWeeklySummaryEmail(company, stats);
        if (delivered === false) {
          await releaseSummaryDelivery(settings, 'weekly', clock.date);
          continue;
        }
        console.log(`📧 Weekly summary sent for company ${company.name}`);
      } catch (err) {
        console.error('Failed to send weekly summary for company', company._id, err);
        await releaseSummaryDelivery(settings, 'weekly', clock.date).catch((releaseError) => {
          console.error('Could not release weekly-summary delivery claim:', releaseError.message || releaseError);
        });
      }
    }
  } catch (err) {
    console.error('Weekly summary job failed', err);
  }
}

// ============================================
// AUTOMATIC DEPRECIATION - Runs daily to create monthly depreciation
// ============================================

async function runAutomaticDepreciation() {
  console.log('📊 Running automatic depreciation job...');
  
  try {
const companies = await fetchPaged(Company, {});
    const now = new Date();
    const currentMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const monthLabel = `${currentMonth.getUTCFullYear()}-${String(currentMonth.getUTCMonth() + 1).padStart(2, '0')}`;
    
    for (const company of companies) {
      // Get all active fixed assets for the company
      const assets = await fetchPaged(FixedAsset, {
        company: company._id,
        status: { $in: ['active', 'in_use'] },
      });
      
      for (const asset of assets) {
        try {
          // Check if asset has depreciation settings
          if (!asset.usefulLifeYears || asset.usefulLifeYears <= 0) {
            continue;
          }
          
          // Check if asset is fully depreciated
          if (asset.isFullyDepreciated) {
            continue;
          }
          
          // Get the monthly depreciation amount
          const annualDepreciation = asset.annualDepreciation || 0;
          const monthlyDepreciation = annualDepreciation / 12;
          
          if (monthlyDepreciation <= 0) {
            continue;
          }
          
          // Check if depreciation entry already exists for this month
          const existingEntry = await JournalEntry.findOne({
            company: company._id,
            sourceType: 'depreciation',
            sourceId: asset._id,
            description: { $regex: new RegExp(monthLabel, 'i') }
          });
          
          if (existingEntry) {
            // Depreciation already created for this month
            continue;
          }
          
          // Create depreciation journal entry
          // Debit: Depreciation Expense (5800)
          // Credit: Accumulated Depreciation (1800)
          await JournalService.createEntry(company._id, null, {
            date: currentMonth,
            description: `Depreciation - ${asset.name} - ${monthLabel}`,
            sourceType: 'depreciation',
            sourceId: asset._id,
            sourceReference: asset.assetCode,
            lines: [
              JournalService.createDebitLine(
                DEFAULT_ACCOUNTS.depreciation,
                monthlyDepreciation,
                `Depreciation: ${asset.name}`
              ),
              JournalService.createCreditLine(
                DEFAULT_ACCOUNTS.accumulatedDepreciation,
                monthlyDepreciation,
                `Accumulated depreciation: ${asset.name}`
              )
            ],
            isAutoGenerated: true
          });
          
          // Update asset's accumulated depreciation
          asset.accumulatedDepreciation = (asset.accumulatedDepreciation || 0) + monthlyDepreciation;
          await asset.save();
          
          console.log(`✅ Depreciation created for ${asset.name}: ${monthlyDepreciation} (${monthLabel})`);
          
        } catch (assetError) {
          console.error(`Error processing depreciation for asset ${asset.name}:`, assetError.message);
        }
      }
    }
    
    console.log('✅ Automatic depreciation job completed');
  } catch (err) {
    console.error('Automatic depreciation job failed', err);
  }
}

// ============================================
// SCHEDULER START
// ============================================

// Cron handles are kept so the process can shut down cleanly. Without this the
// tasks could only be stopped by killing the process, which left the worker
// unable to drain: node-cron timers keep the event loop alive.
let scheduledTasks = [];

function startScheduler() {
  console.log('📅 Starting notification scheduler...');

  if (scheduledTasks.length) {
    console.warn('⚠️  Notification scheduler already running; ignoring duplicate start.');
    return;
  }

  scheduledTasks = [
    // Payment reminders - every hour
    cron.schedule('0 * * * *', sendPaymentReminders),
    // Low stock check - every 2 hours
    cron.schedule('0 */2 * * *', checkLowStock),
    // Company-specific summary time. Database claims make each report at most
    // once per local day even if scheduler ticks or worker instances overlap.
    cron.schedule('* * * * *', sendDailySummaryReports, { timezone: NOTIFICATION_TIMEZONE }),
    cron.schedule('* * * * 1', sendWeeklySummaryReports, { timezone: NOTIFICATION_TIMEZONE }),
    // Automatic depreciation - every day at 1 AM
    cron.schedule('0 1 * * *', runAutomaticDepreciation),
  ];

  // Do not fan out several database-heavy scans during worker startup. The
  // worker may be waking a Neon compute at the same time as report and queue
  // schedulers; the normal cron schedules run these checks shortly afterward.
  // Operators can opt in to a sequential catch-up run when they specifically
  // need it, without launching three scans concurrently.
  if (String(process.env.NOTIFICATION_RUN_CHECKS_ON_STARTUP || '').toLowerCase() === 'true') {
    (async () => {
      await sendPaymentReminders();
      await checkLowStock();
      await sendDailySummaryReports();
    })().catch((error) => console.error('Notification startup checks failed:', error.message || error));
  }

  console.log('✅ Notification scheduler started with cron jobs');
}

/**
 * Cancel every scheduled task. Safe to call when the scheduler was never
 * started, and safe to call twice.
 */
function stopScheduler() {
  if (!scheduledTasks.length) return;
  for (const task of scheduledTasks) {
    try {
      // node-cron exposes stop(); newer versions also expose destroy().
      if (task && typeof task.stop === 'function') task.stop();
      if (task && typeof task.destroy === 'function') task.destroy();
    } catch (error) {
      console.warn('Error stopping a notification cron task:', error.message || error);
    }
  }
  scheduledTasks = [];
  console.log('🛑 Notification scheduler stopped.');
}

module.exports = { startScheduler, stopScheduler };
