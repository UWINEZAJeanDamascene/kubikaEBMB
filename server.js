const compression = require('compression');
const cookieParser = require('cookie-parser');
const dotenv = require('dotenv');
const cors = require('cors');
const helmet = require('helmet');
const hpp = require('hpp');
const morgan = require('morgan');
const fs = require('fs');

// Load environment variables FIRST, before any other imports
dotenv.config();

// Sentry as early as possible so its instrumentation wraps the app. Inert
// unless SENTRY_DSN is set, so this costs nothing in environments without it.
require('./lib/sentry').initSentry();

// Sentry must initialise before Express is imported so request tracing can patch it.
const express = require('express');

// Prefer IPv4 DNS lookups to avoid IPv6 ENETUNREACH timeouts on some hosts
try {
  const dns = require('dns');
  if (typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
    console.log('DNS resolver set to prefer IPv4');
  }
} catch (e) {
  // ignore if not supported on older Node versions
}

const errorHandler = require('./middleware/errorHandler');
const { readContextMiddleware } = require('./lib/readContext');

// Redis-backed caching, rate limiting, and Phase 0 telemetry.
const { createRateLimiters } = require('./middleware/redisRateLimiter');
const phase0RateLimiters = createRateLimiters();
const { sessionMiddleware } = require('./middleware/cacheMiddleware');

// Import centralized configuration (now dotenv has been loaded)
const env = require('./src/config/environment');
const config = env.getConfig();

// Get commonly used config values
const NODE_ENV = config.server.env;
const PORT = config.server.port;
const CORS_ORIGINS = config.server.corsOrigins;

// App instance for export (populated after initialization)
let app;

// Initialize server (async to wait for DB connection before starting schedulers)
async function initializeServer() {
  // Connect PostgreSQL (Prisma) — required: auth/tenancy runs on Postgres (Phase 1)
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is required. Auth and tenancy run on PostgreSQL. ' +
      'Set DATABASE_URL (e.g. postgresql://stock:stock@localhost:5432/stock_management?schema=public) in .env'
    );
  }
  const { connectPrisma, warmPrisma, startPrismaKeepAlive } = require('./lib/prisma');
  await connectPrisma();
  await warmPrisma();
  // Required reference data is synchronized at every boot. This replaces
  // manual role and chart-of-account seed commands and is safe to repeat.
  const { initializeRequiredData } = require('./services/systemBootstrapService');
  await initializeRequiredData();
  // Keep pinging Neon periodically so its compute doesn't autosuspend while
  // this process is running, avoiding cold-start latency on user requests.
  startPrismaKeepAlive();

  // PostgreSQL is already connected and warmed above. Do not open a second
  // connection through the legacy database module during API boot.

  // Pricing packages are customer-facing reference data. Initialize the
  // default catalog automatically on PostgreSQL, without replacing administrator edits.
  if (process.env.DATABASE_URL) {
    const SubscriptionPlanService = require('./services/SubscriptionPlanService');
    await SubscriptionPlanService.seedDefaultPlans();
    console.log('[Bootstrap] Subscription plan catalog is ready.');
  }

  // With MongoDB disabled, background schedulers touching Mongo models reject
  // asynchronously. Log instead of letting Node kill the process.
  if (!config.db.uri) {
    process.on('unhandledRejection', (reason) => {
      console.warn('[mongo-disabled] Unhandled rejection:', reason && reason.message ? reason.message : reason);
    });
  }

    // Register tenant plugin before models are loaded so all models inherit it
  const mongoose = require('mongoose');
  // Determine if running under tests (Jest sets JEST_WORKER_ID, and tests may set NODE_ENV='test')
  const isTestEnv = (NODE_ENV === 'test') || !!process.env.JEST_WORKER_ID;
  // During tests, disable automatic index creation to avoid long-running index builds
  if (isTestEnv) {
    try {
      mongoose.set('autoIndex', false);
    } catch (e) {
      console.warn('Could not set mongoose autoIndex:', e && e.message ? e.message : e);
    }
  }
  try {
    const tenantPlugin = require('./plugins/tenantPlugin');
    mongoose.plugin(tenantPlugin);
  } catch (e) {
    console.warn('Tenant plugin could not be registered:', e && e.message ? e.message : e);
  }
  try {
    const maxRowsPlugin = require('./plugins/maxRowsPlugin');
    mongoose.plugin(maxRowsPlugin);
  } catch (e) {
    console.warn('Max-rows plugin could not be registered:', e && e.message ? e.message : e);
  }

  // Populate() interception for refs migrated to PostgreSQL (User/Company/Role)
  try {
    const postgresRefPlugin = require('./plugins/postgresRefPlugin');
    mongoose.plugin(postgresRefPlugin);
  } catch (e) {
    console.warn('Postgres ref plugin could not be registered:', e && e.message ? e.message : e);
  }

  // Load all models to ensure they're registered with mongoose
  require('./models/IPWhitelist');
  require('./models/Role');
  require('./models/SystemSettings');
  require('./models/Backup');
  require('./models/FixedAsset');
  require('./models/AuditLog');
  require('./models/AIFinding');
  require('./models/AIActionProposal');
  require('./models/JournalEntryLine');
  require('./models/JournalEntry');
  require('./models/AssetCategory');
  require('./models/Loan');
  require('./models/ChartOfAccount');
  require('./models/PrecomputedAggregation');
  require('./models/Expense');
  require('./models/Employee');
  require('./models/SalaryHistory');
  require('./models/Payroll');
  require('./models/PayrollRun');
  require('./models/Timesheet');
  require('./models/PurchaseReturn');
  require('./models/Invoice');
  require('./models/Purchase');
  require('./models/StockMovement');
  require('./models/Product');
  require('./models/Client');
  require('./models/Supplier');
  require('./models/CreditNote');
  require('./models/ARReceipt');
  require('./models/APPayment');
  require('./models/Testimonial');
  require('./models/DeliveryNote');
  require('./models/GoodsReceivedNote');
  require('./models/FreightBill');
  require('./models/PettyCash');
  require('./models/BankAccount');
  require('./models/FixedDeposit');
  require('./models/InterestAccrual');
  require('./models/Encumbrance');
  require('./models/BudgetLine');
  require('./models/Project');
  require('./models/StockTransfer');
  require('./models/StockTransferLine');
  require('./models/StockBatch');
  require('./models/StockSerialNumber');
  require('./models/EBMDevice');
  require('./models/EBMCode');
  require('./models/EBMItemClass');
  require('./models/EBMTIN');
  require('./models/EBMNotice');
  require('./models/EBMSyncState');
  require('./models/EBMImportedItem');
  require('./models/EBMUnmatchedPurchase');
   require('./models/EBMSubmissionQueue');
   require('./models/SalesOrder');
   require('./models/ImportTemplate');
   require('./models/ImportLog');
   require('./models/PickPack');
   require('./models/ARTransactionLedger');
   require('./models/APTransactionLedger');
   require('./models/APPayment');
   require('./models/APPaymentAllocation');
   require('./models/ARReceipt');
   require('./models/ARReceiptAllocation');
   require('./models/ARBadDebtWriteoff');
   require('./models/CreditNote');
   require('./models/EmployeeAdvance');
   require('./models/TillSession');
   require('./src/models/ImportJob');

  app = express();

  // Every request gets an explicit HTTP read context. Large reads must opt into
  // a worker/export context instead of escaping the policy through a query arg.
  app.use(readContextMiddleware);

  // Normalize accidental double slashes from deployed API base URLs with a trailing slash.
  app.use((req, res, next) => {
    const [pathname, query = ''] = req.url.split('?');
    const normalizedPath = pathname.replace(/\/{2,}/g, '/');
    if (normalizedPath !== pathname) {
      req.url = normalizedPath + (query ? `?${query}` : '');
    }
    next();
  });

  // Security middleware — XSS, clickjacking, MIME sniffing protection
  app.use(helmet({
    contentSecurityPolicy: NODE_ENV === 'production',
    crossOriginEmbedderPolicy: false
  }));

  // Tenant context middleware (sets per-request companyId for tenant plugin)
  const tenantContextMiddleware = require('./middleware/tenantContextMiddleware');
  app.use(tenantContextMiddleware);

  // Request timing must wrap health/performance routes too; otherwise the
  // performance endpoint cannot sample itself and the Phase 0 top-10 baseline
  // will always report 9/10 endpoints.
  const requestTiming = require('./middleware/requestTiming');
  app.use(requestTiming);

  // Health checks — mounted before /api rate limits (must stay unthrottled)
  const healthController = require('./controllers/healthController');
  const { protect } = require('./middleware/auth');
  const requireCompanyHeader = require('./middleware/requireCompanyHeader');
  app.get('/api/health', cors(), healthController.systemHealth);
  app.get('/health', cors(), healthController.systemHealth);
  app.get('/api/health/accounting', protect, requireCompanyHeader, healthController.accountingHealth);
  app.post('/api/health/gc', cors(), healthController.gcHint);
  // Performance metrics only — see healthController.performanceMetrics.
  app.get('/api/performance', cors(), healthController.performanceMetrics);
  app.get('/api/performance/pos-operations', protect, (req, res, next) => {
    if (!req.isPlatformAdmin && req.user?.role !== 'platform_admin') {
      return res.status(403).json({ success: false, message: 'Platform administrator access is required.' });
    }
    return require('./controllers/posObservabilityController').getPosOperations(req, res, next);
  });
  app.get('/api/performance/readiness', cors(), healthController.performanceReadiness);
  // Browser timing is anonymous, bounded, best-effort telemetry. It is rate
  // limited so it cannot become an ingestion or memory-amplification vector.
  app.post('/api/performance/client', cors(), express.json({ limit: '8kb' }), phase0RateLimiters.api, healthController.clientPerformance);

  // CORS - must run BEFORE rate limiters so that rate-limited responses
  // (429) include proper CORS headers instead of failing the browser fetch.
  const corsOptions = {
    origin: function (origin, callback) {
      if (!origin) return callback(null, true); // Allow no-origin (server-to-server)

      const isDevelopment = NODE_ENV === 'development';
      const isTest = NODE_ENV === 'test';

      // In development/test mode, allow common dev origins
      if (isDevelopment || isTest || !NODE_ENV || NODE_ENV === 'undefined') {
        if (origin.includes('localhost')) return callback(null, true);
        if (origin.includes('vercel.app')) return callback(null, true);
        if (origin.includes('render.com')) return callback(null, true);
      }

      // Check environment variable whitelist (production only)
      const explicitOrigins = CORS_ORIGINS;

      if (explicitOrigins.length > 0 && explicitOrigins.includes(origin)) {
        return callback(null, true);
      }

      // Block all other origins
      return callback(new Error('Not allowed by CORS'));
    },
    credentials: true
  };
  app.use(cors(corsOptions));

  // Parse request bodies before the general API limiter.
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // The global API limiter is disabled so dashboard requests are not blocked
  // by shared Redis state.

  // Response compression (gzip/deflate); skip tiny payloads and health checks
  app.use(compression({
    threshold: 1024,
    filter: (req, res) => {
      if (req.path === '/health' || req.path === '/api/health') return false;
      return compression.filter(req, res);
    }
  }));

  // Serve uploaded files
  const path = require('path');
  app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

  // Ensure downloads directory exists for Excel exports
  const downloadsDir = path.join(__dirname, 'downloads');
  if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });

  // Cookie parser (needed for httpOnly cookie sessions)
  app.use(cookieParser());

  // HTTP Parameter Pollution — last duplicate query key wins (single scalar)
  app.use(hpp());

  // Input sanitisation — strip dangerous chars (after body parsed)
  const sanitizeInput = require('./middleware/sanitizeInput');
  app.use(sanitizeInput);

  // Session management with Redis
  app.use(sessionMiddleware);

  // Logging
  if (NODE_ENV === 'development') {
    morgan.token('url', (req) => String(req.originalUrl || req.url || '')
      .replace(/(\/api(?:\/v1)?\/public\/pos\/receipts\/)[^/?]+/gi, '$1[redacted]'));
    app.use(morgan('dev'));
  }

  // API versioning — mount at /api/v1 (primary) and /api (backward compat)
  const apiRouter = express.Router();
  const { prepareMountedModule } = require('./middleware/modulePermissionFallback');
  const mountApiRouter = apiRouter.use.bind(apiRouter);
  // Register and guard new authenticated modules automatically. Routers with
  // explicit resource/action checks retain their existing fine-grained rules.
  apiRouter.use = function useApiModule(mountPath, ...handlers) {
    const moduleRouter = typeof mountPath === 'string'
      ? handlers.find((handler) => Array.isArray(handler?.stack))
      : null;
    if (moduleRouter) prepareMountedModule(moduleRouter, mountPath);
    return mountApiRouter(mountPath, ...handlers);
  };

  apiRouter.use('/auth', require('./routes/authRoutes'));
  apiRouter.use('/companies', require('./routes/companyRoutes'));
  apiRouter.use('/users', require('./routes/userRoutes'));
  apiRouter.use('/products', require('./routes/productRoutes'));
  apiRouter.use('/categories', require('./routes/categoryRoutes'));
  apiRouter.use('/suppliers', require('./routes/supplierRoutes'));
  apiRouter.use('/clients', require('./routes/clientRoutes'));
  apiRouter.use('/customers', require('./routes/customerMasterRoutes'));
  apiRouter.use('/stock', require('./routes/stockRoutes'));
  apiRouter.use('/stock/warehouses', require('./routes/warehouseRoutes'));
  apiRouter.use('/stock/advanced', require('./routes/advancedStockRoutes'));
  apiRouter.use('/quotations', require('./routes/quotationRoutes'));
  apiRouter.use('/sales-orders', require('./routes/salesOrderRoutes'));
  apiRouter.use('/pick-packs', require('./routes/pickPackRoutes'));
  apiRouter.use('/sales-invoices', require('./routes/invoiceRoutes'));
  apiRouter.use('/purchases', require('./routes/purchaseRoutes'));
  apiRouter.use('/pos', require('./routes/posRoutes'));
  apiRouter.use('/public/pos/receipts', require('./routes/publicReceiptRoutes'));
  apiRouter.use('/sales-legacy', require('./routes/salesLegacyRoutes'));
  apiRouter.use('/tills', require('./routes/tillRoutes'));
  apiRouter.use('/reports/daily', require('./routes/dailyReportsRoutes'));
  apiRouter.use('/reports/weekly', require('./routes/weeklyReportsRoutes'));
  apiRouter.use('/reports/monthly', require('./routes/monthlyReportsRoutes'));
  apiRouter.use('/reports/annual', require('./routes/annualReportsRoutes'));
  apiRouter.use('/reports', require('./routes/reportRoutes'));
  // Consolidated: dashboard.routes.js and dashboardRoutes.js used to be
  // mounted separately at the same base path; both path sets are live
  // traffic (see routes/dashboardRoutes.js header), so they were merged
  // into one explicitly-ordered router instead of relying on mount order.
  apiRouter.use('/dashboard', require('./routes/dashboardRoutes'));
  apiRouter.use('/currencies', require('./routes/currencyRoutes'));
  apiRouter.use('/exchange-rates', require('./routes/exchangeRateRoutes'));
  apiRouter.use('/access', require('./routes/advancedAccessRoutes'));
  apiRouter.use('/recurring-templates', require('./routes/recurringInvoiceRoutes'));
  apiRouter.use('/recurring-invoices', require('./routes/recurringInvoiceRoutes'));
  apiRouter.use('/subscriptions', require('./routes/subscriptionRoutes'));
  apiRouter.use('/credit-notes', require('./routes/creditNoteRoutes'));
  apiRouter.use('/notifications', require('./routes/notificationRoutes'));
  apiRouter.use('/backups', require('./routes/backupRoutes'));
  apiRouter.use('/fixed-assets', require('./routes/fixedAssetRoutes'));
  apiRouter.use('/asset-categories', require('./routes/assetCategoryRoutes'));
  apiRouter.use('/loans', require('./routes/loanRoutes'));
  apiRouter.use('/budgets', require('./routes/budgetRoutes'));
  apiRouter.use('/projects', require('./routes/projectRoutes'));
  apiRouter.use('/taxes', require('./routes/taxRoutes'));
  apiRouter.use('/payroll', require('./routes/payrollRoutes'));
  apiRouter.use('/payroll-runs', require('./routes/payrollRunRoutes'));
  apiRouter.use('/timesheets', require('./routes/timesheetRoutes'));
  apiRouter.use('/employees', require('./routes/employeeRoutes'));
  apiRouter.use('/employee-advances', require('./routes/employeeAdvanceRoutes'));
  apiRouter.use('/expenses', require('./routes/expenseRoutes'));
  apiRouter.use('/prepaid-expenses', require('./routes/prepaidExpenseRoutes'));
  apiRouter.use('/deferred-revenue', require('./routes/deferredRevenueRoutes'));
  apiRouter.use('/petty-cash', require('./routes/pettyCashRoutes'));
  apiRouter.use('/bank-accounts', require('./routes/bankAccountRoutes'));
  apiRouter.use('/bank-reconciliation', require('./routes/bankReconciliationRoutes'));
  apiRouter.use('/interest', require('./routes/interestRoutes'));
  apiRouter.use('/purchase-returns', require('./routes/purchaseReturnRoutes'));
  apiRouter.use('/payables', require('./routes/payableRoutes'));
  apiRouter.use('/ar', require('./routes/arRoutes'));
  apiRouter.use('/ar-reconciliation', require('./routes/arReconciliationRoutes'));
  apiRouter.use('/ap', require('./routes/apRoutes'));
  apiRouter.use('/ap-reconciliation', require('./routes/apReconciliationRoutes'));
  apiRouter.use('/delivery-notes', require('./routes/deliveryNoteRoutes'));
  apiRouter.use('/departments', require('./routes/departmentRoutes'));
  apiRouter.use('/imports', require('./routes/importsRoutes'));
  apiRouter.use('/audit-trail', require('./routes/auditTrailRoutes'));
  apiRouter.use('/chat', require('./routes/aiChatRoutes'));
  apiRouter.use('/ai/reports', require('./routes/aiReportRoutes'));
  apiRouter.use('/ai/forecasts', require('./routes/aiForecastRoutes'));
  apiRouter.use('/ai/observability', require('./routes/aiObservabilityRoutes'));
  apiRouter.use('/ai', require('./routes/aiContextRoutes'));
  apiRouter.use('/journal-entries', require('./routes/journalRoutes'));
  apiRouter.use('/accounting', require('./routes/accountingRoutes'));
  apiRouter.use('/account-mappings', require('./routes/accountMappingRoutes'));
  apiRouter.use('/chart-of-accounts', require('./routes/chartOfAccountsRoutes'));
  apiRouter.use('/reconciliation', require('./routes/reconciliationRoutes'));
  apiRouter.use('/gl-financials', require('./routes/glFinancialRoutes'));
  apiRouter.use('/stock-transfers', require('./routes/stockTransferRoutes'));
  apiRouter.use('/stock-audits', require('./routes/stockAuditRoutes'));
  apiRouter.use('/batches', require('./routes/stockBatchRoutes'));
  apiRouter.use('/serial-numbers', require('./routes/stockSerialNumberRoutes'));
  apiRouter.use('/periods', require('./routes/periodRoutes'));
  apiRouter.use('/settings', require('./routes/settingsRoutes'));
  apiRouter.use('/ebm', require('./routes/ebmRoutes'));
  apiRouter.use('/opening-balances', require('./routes/openingBalanceRoutes'));
  apiRouter.use('/audit-logs', require('./routes/auditRoutes'));
  apiRouter.use('/testimonials', require('./routes/testimonialRoutes'));

  // Import/Export routes (PHASE 5)
  apiRouter.use('/import', require('./src/routes/v1/import.routes'));
  apiRouter.use('/export', require('./src/routes/v1/export.routes'));

  if (config.db.uri) {
    try {
      const { markInterruptedMemoryJobs } = require('./services/importQueueService');
      markInterruptedMemoryJobs().catch((error) => {
        console.error('[Imports] Failed to mark interrupted memory fallback jobs:', error.message);
      });
    } catch (error) {
      console.error('[Imports] Startup fallback check failed:', error.message);
    }
  }

  app.use('/api', apiRouter);
  app.use('/api/v1', apiRouter);
  app.use('/auth', require('./routes/authRoutes'));

  // Test-only upload endpoint (no auth) to validate upload middleware and storage
  // NOTE: This is temporary for debugging; remove or protect in production.
  try {
    const { uploadFor } = require('./middleware/upload');
    app.post('/api/test/upload/avatar', uploadFor('users').single('avatar'), (req, res) => {
      if (!req.file) return res.status(422).json({ success: false, message: 'No file uploaded' });
      return res.json({ success: true, path: `/uploads/users/${req.file.filename}` });
    });
  } catch (e) {
    console.warn('Could not register test upload route:', e && e.message ? e.message : e);
  }

  // Admin: Reset rate limit for IP (for testing)
  app.post('/admin/reset-rate-limit', async (req, res) => {
    try {
      const { resetRateLimit } = require('./middleware/redisRateLimiter');
      const ip = req.body.ip || req.ip;
      const result = await resetRateLimit(ip, 'ratelimit:auth');
      res.json({ success: result, message: `Rate limit reset for IP: ${ip}` });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // Public download route for Excel files (token-based)
  app.get('/public-download/:token', async (req, res) => {
    try {
      const token = req.params.token;
      if (!token) return res.status(400).json({ success: false, message: 'Token required' });

      const env = require('./src/config/environment');
      const cfg = env.getConfig ? env.getConfig() : env;
      const JWT_SECRET = (cfg && cfg.jwt && cfg.jwt.secret) || process.env.JWT_SECRET || 'dev-secret-for-downloads';

      const jwt = require('jsonwebtoken');
      let payload;
      try {
        payload = jwt.verify(token, JWT_SECRET);
      } catch (err) {
        return res.status(401).json({ success: false, message: 'Invalid or expired token' });
      }

      const filename = payload && payload.file;
      if (!filename || !filename.match(/^[a-zA-Z0-9_-]+\.xlsx$/)) {
        return res.status(400).json({ success: false, message: 'Invalid filename in token' });
      }

      const filePath = path.join(__dirname, 'downloads', filename);
      if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, message: 'File not found' });

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      fs.createReadStream(filePath).pipe(res);
    } catch (err) {
      console.error('[PublicDownload] Error:', err && err.message ? err.message : err);
      res.status(500).json({ success: false, message: 'Public download failed' });
    }
  });

  // Root route
  app.get('/', (req, res) => {
    res.status(200).json({ 
      status: 'OK',
      message: 'KUBIKA system API',
      endpoints: [
        '/api/auth',
        '/api/companies',
        '/api/users',
        '/api/products',
        '/api/categories',
        '/api/suppliers',
        '/api/clients',
        '/api/stock',
        '/api/quotations',
        '/api/invoices',
        '/api/reports',
        '/api/dashboard',
        '/api/exchange-rates',
        '/health',
        '/api/health'
      ]
    });
  });

  // 404 handler
  app.use((req, res) => {
    res.status(404).json({ 
      success: false, 
      message: 'Route not found' 
    });
  });

  // Sentry's error handler must come before ours: ours ends the request with a
  // JSON response, so anything registered after it never sees the error.
  // No-op unless SENTRY_DSN is configured.
  require('./lib/sentry').setupExpressErrorHandler(app);

  // Error handler
  app.use(errorHandler);

  // Background schedulers and BullMQ consumers live in worker.js (`npm run worker`).
  // Background schedulers deliberately do NOT run in this process.
  //
  // They live in worker.js, a single process. Running them here would mean every
  // scaled HTTP replica firing the same cron — duplicate invoices, duplicate
  // notifications, duplicate accounting postings. This block previously held the
  // scheduler startup guarded by `if (false && ...)`, which achieved the right
  // outcome but read as an accident; the code has been removed rather than left
  // dead. See worker.js for what actually starts, and
  // `node scripts/audit-mongo-deps.js` for which schedulers are safe to add.

  // Verify email server connection (non-blocking)
  try {
    // Skip verifying external email connection during tests to avoid hangs
    if (!isTestEnv) {
      const { testConnection } = require('./config/email');
      testConnection();
    }
  } catch (err) {
    console.warn('Could not verify email server:', err.message || err);
  }

  let server;
  if (NODE_ENV !== 'test') {
    const { assertPerformanceReadinessAtBoot } = require('./utils/performancePhase0');
    await assertPerformanceReadinessAtBoot({ nodeEnv: NODE_ENV });

    server = app.listen(PORT, () => {
      console.log(`Server running in ${NODE_ENV} mode on port ${PORT}`);
    });

    server.on('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use.`);
        // Try next port once
        const fallbackPort = Number(PORT) + 1;
        console.log(`Attempting to listen on port ${fallbackPort} instead...`);
        server.close();
        app.listen(fallbackPort, () => {
          console.log(`Server running in ${NODE_ENV} mode on port ${fallbackPort}`);
        }).on('error', (e) => {
          console.error('Failed to bind to fallback port:', e.message);
          process.exit(1);
        });
      } else {
        console.error('Server error:', err);
        process.exit(1);
      }
    });
  }

  // Attach server reference to app for test teardown
  if (server) {
    app._server = server;
  }

  // Provide a graceful shutdown helper for tests and runtime
  app.shutdown = async () => {
    try {
      // Close HTTP server if running
      if (app._server && typeof app._server.close === 'function') {
        await new Promise((resolve, reject) => {
          app._server.close((err) => (err ? reject(err) : resolve()));
        });
      }

      // Close mongoose connection
      try {
        const mongoose = require('mongoose');
        if (mongoose && mongoose.connection && mongoose.connection.readyState) {
          await mongoose.connection.close();
        }
      } catch (e) {
        console.warn('Error closing mongoose connection during shutdown', e && e.message ? e.message : e);
      }

      // Close Prisma connection
      try {
        const { disconnectPrisma, stopPrismaKeepAlive } = require('./lib/prisma');
        stopPrismaKeepAlive();
        await disconnectPrisma();
      } catch (e) {
        console.warn('Error closing Prisma connection during shutdown', e && e.message ? e.message : e);
      }

      // Flush the buffered fleet metrics before closing Redis.
      try {
        await require('./services/performanceMetricsStore').flush();
      } catch (e) {
        console.warn('Error flushing performance metrics during shutdown', e && e.message ? e.message : e);
      }

      // Close Redis client if available
      try {
        const { redisClient } = require('./config/redis');
        if (redisClient) {
          if (typeof redisClient.quit === 'function') await redisClient.quit();
          else if (typeof redisClient.disconnect === 'function') await redisClient.disconnect();
          else if (typeof redisClient.close === 'function') await redisClient.close();
        }
      } catch (e) {
        console.warn('Error closing Redis client during shutdown', e && e.message ? e.message : e);
      }
    } catch (err) {
      console.error('Error during app.shutdown()', err && err.message ? err.message : err);
    }
  };
  // Initialize Socket.io for real-time notifications
  try {
    // Avoid initializing socket.io during tests (it can create listeners/handles)
    if (!isTestEnv) {
      const socketService = require('./services/socketService');
      socketService.init(server);
    }
  } catch (err) {
    console.warn('Could not initialize socket service', err.message || err);
  }

}

// Start the server
initializeServer().catch((err) => {
  console.error('Failed to initialize server:', err);
  process.exit(1);
});

module.exports = app;

