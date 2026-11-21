/**
 * Environment Configuration - Central Config Loader
 * 
 * This is the single source of truth for all environment variables.
 * All other files should import configuration from here - never from process.env directly.
 * 
 * Usage:
 *   const config = require('./src/config/environment');
 *   const dbConfig = config.db;
 *   const jwtConfig = config.jwt;
 */

const REQUIRED_ENV_VARS = [];

const REQUIRED_IN_PRODUCTION = [];
const PRODUCTION_FRONTEND_ORIGIN = 'https://kubika-ebmf.vercel.app';

const RETIRED_AI_MODELS = Object.freeze({
  groq: Object.freeze({
    'llama-3.1-8b-instant': 'openai/gpt-oss-20b',
    'llama-3.3-70b-versatile': 'openai/gpt-oss-120b',
  }),
  gemini: Object.freeze({
    'gemini-2.0-flash': 'gemini-3.5-flash-lite',
    'gemini-2.0-flash-lite': 'gemini-3.5-flash-lite',
  }),
});

function resolveAIModel(provider, configuredModel, fallbackModel) {
  const model = String(configuredModel || fallbackModel).trim();
  const replacement = RETIRED_AI_MODELS[provider]?.[model];
  if (replacement) {
    console.warn(`[AI] ${provider} model "${model}" is retired; using "${replacement}". Update its model environment variable.`);
    return replacement;
  }
  return model;
}

function normalizeNodeEnv() {
  const raw = String(process.env.NODE_ENV || '').trim();
  const nodeEnv = raw && raw !== 'undefined' && raw !== 'null' ? raw : 'development';
  process.env.NODE_ENV = nodeEnv;
  return nodeEnv;
}

/**
 * Validate required environment variables
 * Note: For test environment, we use mongodb-memory-server so MONGODB_URI is not required
 */
function validateEnv() {
  const missing = [];
  const nodeEnv = normalizeNodeEnv();
  
  // In test environment, skip strict validation - tests use mongodb-memory-server
  if (nodeEnv === 'test') {
    // Set test defaults if not provided
    if (!process.env.PORT) process.env.PORT = '3001';
    if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'test-jwt-secret-for-testing';
    return; // Skip validation for tests
  }
  
  // Check all required vars
  for (const varName of REQUIRED_ENV_VARS) {
    if (!process.env[varName]) {
      missing.push(varName);
    }
  }
  
  // Additional checks for production
  if (nodeEnv === 'production') {
    for (const varName of REQUIRED_IN_PRODUCTION) {
      if (!process.env[varName]) {
        missing.push(varName);
      }
    }
  }
  
  if (missing.length > 0) {
    const errorMsg = `\n❌ Missing required environment variables:\n${missing.map(v => `  - ${v}`).join('\n')}\n\nPlease set these variables in your .env file or environment.`;
    throw new Error(errorMsg);
  }
}

/**
 * Get boolean value with default
 */
function bool(value, defaultVal = false) {
  if (value === undefined || value === null) return defaultVal;
  if (typeof value === 'boolean') return value;
  const lower = String(value).toLowerCase().trim();
  if (lower === 'true' || lower === '1' || lower === 'yes') return true;
  if (lower === 'false' || lower === '0' || lower === 'no') return false;
  return defaultVal;
}

/**
 * Get number value with default
 */
function number(value, defaultVal = 0) {
  if (value === undefined || value === null) return defaultVal;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultVal;
}

/**
 * Get array value from comma-separated string
 */
function array(value, defaultVal = []) {
  if (!value) return defaultVal;
  return String(value).split(',').map(s => s.trim()).filter(Boolean);
}

function uniqueOrigins(origins, nodeEnv) {
  const loopbackOrigin = /^https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i;
  return [...new Set(origins)]
    .filter((origin) => nodeEnv !== 'production' || !loopbackOrigin.test(origin));
}

/**
 * Build the frozen config object
 */
function buildConfig() {
  const nodeEnv = normalizeNodeEnv();
  const frontendUrl = process.env.FRONTEND_URL || (
    nodeEnv === 'production' ? PRODUCTION_FRONTEND_ORIGIN : 'http://localhost:5173'
  );
  const frontendOrigin = new URL(frontendUrl).origin;
  const configuredOrigins = array(
    process.env.ALLOWED_ORIGINS,
    nodeEnv === 'production' ? [PRODUCTION_FRONTEND_ORIGIN] : ['http://localhost:3000', 'http://localhost:5173'],
  );
  const configuredCorsOrigins = array(
    process.env.CORS_ORIGINS || process.env.ALLOWED_ORIGINS,
    nodeEnv === 'production' ? [PRODUCTION_FRONTEND_ORIGIN] : ['http://localhost:3000', 'http://localhost:5173'],
  );
  
  const config = {
    // =====================
    // Environment
    // =====================
    env: {
      node: nodeEnv,
      isDevelopment: nodeEnv === 'development',
      isStaging: nodeEnv === 'staging',
      isProduction: nodeEnv === 'production',
      isTest: nodeEnv === 'test',
    },
    
    // =====================
    // Server Configuration
    // =====================
    server: {
      env: nodeEnv,
      port: number(process.env.PORT, 3000),
      frontendUrl,
      allowedOrigins: uniqueOrigins([...configuredOrigins, frontendOrigin], nodeEnv),
      corsOrigins: uniqueOrigins([...configuredCorsOrigins, frontendOrigin], nodeEnv),
    },
    
    // =====================
    // Database Configuration
    // =====================
    db: {
      // No fallback: when MONGODB_URI is unset, MongoDB is disabled and only
      // the PostgreSQL-backed domains (auth/tenancy) are available.
      uri: process.env.MONGODB_URI || null,
      postgresUrl: process.env.DATABASE_URL || null,
      maxPoolSize: number(process.env.MONGODB_MAX_POOL_SIZE, 50),
      minPoolSize: number(process.env.MONGODB_MIN_POOL_SIZE, 0),
      serverSelectionTimeoutMs: number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS, 30000),
      socketTimeoutMs: number(process.env.MONGODB_SOCKET_TIMEOUT_MS, 0),
      connectTimeoutMs: number(process.env.MONGODB_CONNECT_TIMEOUT_MS, 30000),
      heartbeatFrequencyMs: number(process.env.MONGODB_HEARTBEAT_FREQUENCY_MS, 10000),
    },
    
    // =====================
    // JWT & Auth Configuration
    // =====================
    jwt: {
      secret: process.env.JWT_SECRET || 'dev-secret-key-change-in-production',
      expiresIn: process.env.JWT_EXPIRE || '15m',
      refreshExpiresIn: process.env.JWT_REFRESH_EXPIRE || '7d',
      issuer: process.env.JWT_ISSUER || 'stock-management',
      audience: process.env.JWT_AUDIENCE || 'stock-management-app',
    },
    
    // =====================
    // Session Configuration
    // =====================
    session: {
      ttl: number(process.env.SESSION_TTL, 86400), // 24 hours default
      maxConcurrent: number(process.env.SESSION_MAX_CONCURRENT, 5),
    },
    
    // =====================
    // Security Configuration
    // =====================
    security: {
      bcryptRounds: number(process.env.BCRYPT_ROUNDS, 12),
      rateLimitWindowMs: number(process.env.RATE_LIMIT_WINDOW_MS, 900000), // 15 min
      rateLimitMaxRequests: number(process.env.RATE_LIMIT_MAX_REQUESTS, 100),
      lowStockThreshold: number(process.env.LOW_STOCK_THRESHOLD, 10),
    },
    
    // =====================
    // Redis Configuration
    // =====================
    cache: {
      upstashUrl: process.env.UPSTASH_REDIS_REST_URL || null,
      upstashToken: process.env.UPSTASH_REDIS_REST_TOKEN || null,
      redisUrl: process.env.REDIS_URL || null,
      redisHost: process.env.REDIS_HOST || 'localhost',
      redisPort: number(process.env.REDIS_PORT, 6379),
      redisPassword: process.env.REDIS_PASSWORD || undefined,
      redisDb: number(process.env.REDIS_DB, 0),
      clusterNodes: process.env.REDIS_CLUSTER_NODES ? array(process.env.REDIS_CLUSTER_NODES) : null,
      isConfigured: Boolean(
        process.env.REDIS_URL
        || process.env.REDIS_HOST
        || process.env.REDIS_CLUSTER_NODES
        || (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN),
      ),
    },
    
    // =====================
    // Email Configuration
    // =====================
    email: {
      provider: (process.env.EMAIL_PROVIDER || 'gmail').toLowerCase(),
      gmailUser: process.env.GMAIL_USER || null,
      gmailAppPassword: process.env.GMAIL_APP_PASSWORD || null,
      gmailApiClientId: process.env.GMAIL_API_CLIENT_ID || null,
      gmailApiClientSecret: process.env.GMAIL_API_CLIENT_SECRET || null,
      gmailApiRefreshToken: process.env.GMAIL_API_REFRESH_TOKEN || null,
      resendApiKey: process.env.RESEND_API_KEY || null,
      smtpHost: process.env.SMTP_HOST || 'smtp.gmail.com',
      smtpPort: number(process.env.SMTP_PORT, 587),
      smtpUser: process.env.SMTP_USER || null,
      smtpPass: process.env.SMTP_PASS || null,
      fromAddress: process.env.EMAIL_FROM_ADDRESS || null,
      fromName: process.env.EMAIL_FROM_NAME || 'KUBIKA system',
    },
    
    // =====================
    // SMS Configuration
    // =====================
    sms: {
      twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || null,
      twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || null,
      twilioFromNumber: process.env.TWILIO_FROM_NUMBER || null,
      nexmoApiKey: process.env.NEXMO_API_KEY || null,
      nexmoApiSecret: process.env.NEXMO_API_SECRET || null,
      nexmoFromNumber: process.env.NEXMO_FROM_NUMBER || null,
    },
    
    // =====================
    // Notification Configuration
    // =====================
    notifications: {
      paymentReminderDays: number(process.env.PAYMENT_REMINDER_DAYS, 3),
      dailySummaryEnabled: bool(process.env.DAILY_SUMMARY_ENABLED, false),
      weeklySummaryEnabled: bool(process.env.WEEKLY_SUMMARY_ENABLED, true),
      largeOrderThreshold: number(process.env.LARGE_ORDER_THRESHOLD, 10000),
    },
    
    // =====================
    // Cloud Storage Configuration
    // =====================
    storage: {
      dropboxAccessToken: process.env.DROPBOX_ACCESS_TOKEN || null,
      googleDriveFolderId: process.env.GOOGLE_DRIVE_FOLDER_ID || null,
      googleServiceAccountFile: process.env.GOOGLE_SERVICE_ACCOUNT_FILE || null,
      googleDriveOwnerEmail: process.env.GOOGLE_DRIVE_OWNER_EMAIL || null,
    },
    
    // =====================
    // AI/Chatbot Configuration
    // =====================
    ai: {
      geminiApiKey: process.env.GEMINI_API_KEY || null,
      geminiModel: resolveAIModel('gemini', process.env.GEMINI_MODEL, 'gemini-3.5-flash-lite'),
      groqApiKey: process.env.GROQ_API_KEY || null,
      groqBaseUrl: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
      groqModel: resolveAIModel('groq', process.env.GROQ_MODEL, 'openai/gpt-oss-20b'),
      mistralApiKey: process.env.MISTRAL_API_KEY || null,
      mistralModel: process.env.MISTRAL_MODEL || 'mistral-small-latest',
      openRouterApiKey: process.env.OPENROUTER_API_KEY || null,
      openRouterModel: process.env.OPENROUTER_MODEL || 'openrouter/free',
      deepseekApiKey: process.env.DEEPSEEK_API_KEY || null,
      deepseekModel: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
      togetherApiKey: process.env.TOGETHER_API_KEY || null,
      togetherModel: process.env.TOGETHER_MODEL || 'meta-llama/Llama-3.2-3B-Instruct-Turbo',
      cacheTtlSeconds: number(process.env.AI_CACHE_TTL_SECONDS, 30),
      timeoutMs: number(process.env.AI_TIMEOUT_MS, 10000),
      metricsRetentionDays: Math.max(30, Math.min(365, number(process.env.AI_METRICS_RETENTION_DAYS, 90))),
      providerOrder: array(process.env.AI_PROVIDER_ORDER, ['groq', 'gemini', 'mistral', 'openrouter', 'deepseek', 'together', 'ollama'])
        .map((provider) => provider.toLowerCase())
        .filter((provider, index, providers) => ['groq', 'gemini', 'mistral', 'openrouter', 'deepseek', 'together', 'ollama'].includes(provider) && providers.indexOf(provider) === index),
      ollamaBaseUrl: process.env.OLLAMA_BASE_URL || null,
      ollamaModel: process.env.OLLAMA_MODEL || 'llama3.2',
      rolloutStage: String(process.env.AI_ROLLOUT_STAGE || (nodeEnv === 'production' ? 'internal' : 'all')).toLowerCase(),
      rolloutInternalTenantIds: array(process.env.AI_ROLLOUT_INTERNAL_TENANT_IDS),
      rolloutTestCompanyId: process.env.AI_ROLLOUT_TEST_COMPANY_ID || null,
      rolloutBetaTenantIds: array(process.env.AI_ROLLOUT_BETA_TENANT_IDS),
      killSwitches: {
        providerCalls: bool(process.env.AI_KILL_PROVIDER_CALLS, false),
        scheduledMonitoring: bool(process.env.AI_KILL_SCHEDULED_MONITORING, false),
        proposalExecution: bool(process.env.AI_KILL_PROPOSAL_EXECUTION, false),
      },
      featureFlags: {
        aiChatV2: bool(process.env.AI_FEATURE_CHAT_V2_ENABLED, true),
        proactiveFindings: bool(process.env.AI_FEATURE_FINDINGS_ENABLED, true),
        proposals: bool(process.env.AI_FEATURE_PROPOSALS_ENABLED, true),
        forecasts: bool(process.env.AI_FEATURE_FORECASTS_ENABLED, true),
        reports: bool(process.env.AI_FEATURE_REPORTS_ENABLED, true),
      },
    },
    
    // =====================
    // Logging Configuration
    // =====================
    logging: {
      level: process.env.LOG_LEVEL || (nodeEnv === 'production' ? 'warn' : 'debug'),
      logQueries: bool(process.env.LOG_QUERIES, false),
      sentryDsn: process.env.SENTRY_DSN || null,
    },
    
    // =====================
    // Feature Flags
    // =====================
    features: {
      emailNotifications: bool(process.env.ENABLE_EMAIL_NOTIFICATIONS, true),
      smsNotifications: bool(process.env.ENABLE_SMS_NOTIFICATIONS, false),
      cloudBackup: bool(process.env.ENABLE_CLOUD_BACKUP, false),
      advancedReporting: bool(process.env.ENABLE_ADVANCED_REPORTING, true),
    },
  };
  
  return config;
}

// Validate first, then build and freeze
validateEnv();
const config = buildConfig();

// Freeze to prevent accidental mutation
Object.freeze(config);
Object.freeze(config.env);
Object.freeze(config.server);
Object.freeze(config.db);
Object.freeze(config.jwt);
Object.freeze(config.session);
Object.freeze(config.security);
Object.freeze(config.cache);
Object.freeze(config.email);
Object.freeze(config.sms);
Object.freeze(config.notifications);
Object.freeze(config.storage);
Object.freeze(config.ai);
Object.freeze(config.ai.killSwitches);
Object.freeze(config.ai.featureFlags);
Object.freeze(config.logging);
Object.freeze(config.features);

// Export both the config object and a getConfig method for backward compatibility
// Use a wrapper object to avoid issues with frozen config
const configExporter = {
  ...config,
  resolveAIModel,
  getConfig: () => config
};
module.exports = configExporter;
