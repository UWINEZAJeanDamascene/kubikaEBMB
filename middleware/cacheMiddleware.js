const cacheService = require('../services/cacheService');
const jwt = require('jsonwebtoken');
const sessionService = require('../services/sessionService');

// Import centralized configuration
const env = require('../src/config/environment');
const config = env.getConfig();
const JWT_SECRET = config.jwt.secret;

/** Cap slow Redis calls so post-login requests are not blocked for seconds each. */
const REDIS_SESSION_TIMEOUT_MS = Number(process.env.REDIS_SESSION_TIMEOUT_MS || 500);
const CLOSED_PERIOD_STATUSES = new Set(['closed', 'locked']);

function reportDateRange(req) {
  const query = req.query || {};
  const year = Number(query.year);
  const month = Number(query.month);
  if (Number.isInteger(year) && year >= 1900 && year <= 2200) {
    if (Number.isInteger(month) && month >= 1 && month <= 12) {
      const start = new Date(year, month - 1, 1);
      const end = new Date(year, month, 0, 23, 59, 59, 999);
      return { start, end };
    }
    return {
      start: new Date(year, 0, 1),
      end: new Date(year, 11, 31, 23, 59, 59, 999),
    };
  }

  const parseDate = (value, endOfDay = false) => {
    if (!value) return null;
    const date = new Date(String(value));
    if (Number.isNaN(date.getTime())) return null;
    if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(String(value))) date.setHours(23, 59, 59, 999);
    return date;
  };

  const start = parseDate(query.date_from || query.startDate || query.as_of_date || query.asOfDate || query.weekStart || query.date);
  if (!start) return null;
  let end = parseDate(query.date_to || query.endDate);
  if (!end && query.weekStart) {
    end = new Date(start);
    end.setDate(end.getDate() + 6);
    end.setHours(23, 59, 59, 999);
  }
  if (!end && query.date) end = new Date(start);
  if (!end) return null;
  if (query.date && /^\d{4}-\d{2}-\d{2}$/.test(String(query.date))) end.setHours(23, 59, 59, 999);
  return { start, end };
}

/**
 * A report can be stored without expiry only when every accounting period it
 * covers is closed/locked. A missing period is not treated as closed: the
 * report may still change when the period is created or transactions are
 * backfilled.
 */
async function isClosedPeriodReport(req, companyId) {
  const range = reportDateRange(req);
  if (!range || !companyId) return false;
  try {
    const { dbClient } = require('../lib/prisma');
    const periods = await dbClient().accountingPeriod.findMany({
      where: {
        companyId: String(companyId),
        startDate: { lte: range.end },
        endDate: { gte: range.start },
      },
      select: { startDate: true, endDate: true, status: true },
      orderBy: { startDate: 'asc' },
    });
    if (!periods.length) return false;

    let coveredUntil = range.start.getTime();
    for (const period of periods) {
      const periodStart = new Date(period.startDate).getTime();
      const periodEnd = new Date(period.endDate).getTime();
      if (periodStart > coveredUntil + 1 || !CLOSED_PERIOD_STATUSES.has(String(period.status))) return false;
      coveredUntil = Math.max(coveredUntil, periodEnd);
      if (coveredUntil >= range.end.getTime()) return true;
    }
    return coveredUntil >= range.end.getTime();
  } catch (error) {
    // Cache classification must never make a report endpoint fail.
    console.warn('[cache] Could not determine report period status:', error.message || error);
    return false;
  }
}

/** GET inventory endpoints skip Redis session enrichment — JWT auth is sufficient. */
function shouldSkipSessionEnrichment(req) {
  if (req.method !== 'GET') return false;
  const path = String(req.originalUrl || req.url || req.path || '').split('?')[0];
  const skipPrefixes = [
    '/api/auth/login',
    '/api/auth/register',
    '/api/auth/me',
    '/api/auth/refresh',
    '/api/dashboard',
    '/api/products',
    '/api/categories',
    '/api/suppliers',
    '/api/v1/products',
    '/api/v1/categories',
    '/api/v1/suppliers',
  ];
  return skipPrefixes.some((prefix) => path.startsWith(prefix));
}

function withRedisTimeout(promise, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), REDIS_SESSION_TIMEOUT_MS)),
  ]);
}

/**
 * Cache middleware factory
 * Caches GET request responses automatically
 * 
 * @param {Object} options - Cache options
 * @param {string} options.type - Cache type (product, category, etc.)
 * @param {Function} options.keyGenerator - Function to generate cache key from req
 * @param {number} options.ttl - Custom TTL in seconds
   * @param {boolean} options.skipCache - Function to determine if should skip cache
   * @param {boolean} options.closedPeriodPersistent - Store closed-period reports without expiry
   * @param {boolean} options.varyByUser - Include authenticated user id in the cache key
   */
/**
 * Tenant that a cached response belongs to, or null when it cannot be
 * determined (most importantly a platform admin, for whom `protect` sets
 * `req.company = null` and lets the request through).
 */
const resolveCompanyId = (req) =>
  req.company?._id?.toString()
  || req.user?.company?._id?.toString()
  || (typeof req.user?.company === 'string' ? req.user.company : undefined)
  // Report routes run behind attachCompanyId, which puts the tenant here.
  || (req.companyId ? String(req.companyId) : undefined)
  || req.query.companyId
  || null;

const cacheMiddleware = (options = {}) => {
  const {
    type = 'default',
    keyGenerator = null,
    ttl = null,
    skipCache = null,
    closedPeriodPersistent = false,
    varyByUser = false,
    stampedeProtection = type === 'report',
    // Set for genuinely tenant-independent data (public/platform-wide). Without
    // it, a request with no resolvable tenant is served uncached rather than
    // risking a shared cache entry.
    global: isGlobal = false,
  } = options;

  return async (req, res, next) => {
    // Only cache GET requests
    if (req.method !== 'GET') {
      return next();
    }

    // Skip cache if configured
    if (skipCache && skipCache(req)) {
      return next();
    }

    // Never cache tenant-scoped data under a key that has no tenant in it: two
    // different callers would otherwise share one entry. Platform admins reach
    // here with req.company === null, so this is a live path, not a theoretical
    // one. Serving uncached is always safe; serving another tenant's rows is not.
    if (!isGlobal && !keyGenerator && !resolveCompanyId(req)) {
      return next();
    }

    try {
      const companyId = resolveCompanyId(req);
      // Generate cache key
      let cacheKey;
      if (keyGenerator) {
        cacheKey = keyGenerator(req);
      } else {
        // Default key generation based on URL
        const params = {
          path: req.path,
          query: req.query,
          ...(isGlobal ? { scope: 'global' } : { companyId }),
          ...(varyByUser ? { userId: req.user?._id || req.user?.id || null } : {}),
        };
        cacheKey = cacheService.generateKey(type, params);
      }

      // Try to get cached response before checking period state. A cache hit
      // should remain a single Redis read even for a closed report.
      const cachedResponse = await cacheService.get(cacheKey);
      
      if (cachedResponse) {
        // Return cached response
        return res.status(200).json({
          ...cachedResponse,
          fromCache: true,
        });
      }

      const requestFlight = stampedeProtection
        ? await cacheService.beginRequestFlight(cacheKey)
        : null;
      if (requestFlight && !requestFlight.acquired) {
        if (requestFlight.cached !== undefined && requestFlight.cached !== null) {
          return res.status(200).json({ ...requestFlight.cached, fromCache: true });
        }
        // The owner failed or Redis lock support is unavailable. Recompute
        // rather than blocking the request indefinitely.
      }

      let cacheTtl = ttl === null || ttl === undefined
        ? cacheService.getCacheConfig(type).ttl
        : ttl;
      if (closedPeriodPersistent && type === 'report' && await isClosedPeriodReport(req, companyId)) {
        cacheTtl = 0;
      }

      // Store original json method
      const originalJson = res.json.bind(res);

      // Override json method to cache response
      res.json = (data) => {
        // Only cache successful responses
        if (res.statusCode === 200 && data) {
          // Cache writes must not delay the response when Redis is reconnecting
          // or unavailable. The cache is an optimization, not a dependency.
          cacheService.set(cacheKey, data, cacheTtl).catch((error) => {
            console.error('Cache set error:', error);
          });
        }
        const result = originalJson(data);
        if (requestFlight?.release) requestFlight.release().catch(() => {});
        return result;
      };

      next();
    } catch (error) {
      console.error('Cache middleware error:', error);
      next();
    }
  };
};

/**
 * Cache invalidation middleware
 * Invalidates cache after mutations (POST, PUT, DELETE)
 * 
 * @param {Object} options - Invalidation options
 * @param {string} options.type - Cache type to invalidate
 * @param {Function} options.keyGenerator - Function to generate key to invalidate
 * @param {boolean} options.invalidateAll - Invalidate all cache of this type
 */
const cacheInvalidationMiddleware = (options = {}) => {
  const {
    type = 'default',
    keyGenerator = null,
    invalidateAll = false,
    invalidateByCompany = true,
    types = null,
    invalidateDashboards = false,
    global: isGlobal = false,
  } = options;

  return async (req, res, next) => {
    // Only invalidate on mutations
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      return next();
    }

    // Store original json to intercept response
    const originalJson = res.json.bind(res);

    // Override json to invalidate after successful mutation
    res.json = async (data) => {
      // Only invalidate on successful responses
      if (res.statusCode >= 200 && res.statusCode < 300) {
        try {
          const targetTypes = Array.isArray(types) && types.length ? types : [type];
          if (invalidateAll && isGlobal) {
            await Promise.all(targetTypes.map((targetType) => cacheService.invalidateType(targetType)));
          } else if (keyGenerator) {
            const key = keyGenerator(req, data);
            await cacheService.delete(key);
          } else if (invalidateByCompany) {
            // Must use the same tenant resolution as key generation. Reading
            // only req.company here meant a write whose cache key came from
            // req.user.company invalidated nothing, leaving stale reads behind.
            const companyId = resolveCompanyId(req);
            if (companyId) {
              await Promise.all(targetTypes.map((targetType) => cacheService.invalidateByCompany(companyId, targetType)));
              if (invalidateDashboards) {
                await require('../services/DashboardCacheService').invalidate(companyId);
              }
            }
          }
        } catch (error) {
          console.error('Cache invalidation error:', error);
        }
      }

      return originalJson(data);
    };

    next();
  };
};

/**
 * Express middleware for session management with Redis
 * Adds session data to request object and updates activity on every request
 */
const sessionMiddleware = async (req, res, next) => {
  // Authentication middleware performs the authoritative JWT/database checks.
  // Redis session enrichment is not needed for auth endpoints and can add
  // several network round trips to the login -> /me flow.
  if (shouldSkipSessionEnrichment(req)) {
    return next();
  }

  // Try to attach session data based on token or user
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer')) {
      return next();
    }

    const token = authHeader.split(' ')[1];

    // Check blacklist first (fail open on Redis timeout — JWT auth still applies)
    const isBlacklisted = await withRedisTimeout(
      sessionService.isTokenBlacklisted(token),
      false,
    );
    if (isBlacklisted) {
      return res.status(401).json({ success: false, message: 'Token has been revoked' });
    }

    // If `req.user` already exists (auth middleware ran earlier), use it
    let userId = null;
    if (req.user && req.user._id) {
      userId = req.user._id.toString();
      const session = await withRedisTimeout(sessionService.getSession(userId), null);
      if (session) {
        req.session = session;
        // Update last activity on every request (fire-and-forget)
        sessionService.extendSession(userId).catch(err => {
          console.error('Failed to extend session:', err.message);
        });
        sessionService.touchDeviceSession(userId, token).catch(err => {
          console.error('Failed to update device session activity:', err.message);
        });
      }
      return next();
    }

    // Try quick token->user mapping stored in Redis
    const byToken = await withRedisTimeout(sessionService.getUserByToken(token), null);
    if (byToken) {
      req.session = byToken;
      userId = byToken.userId;
      // Update last activity on every request (fire-and-forget)
      if (userId) {
        sessionService.extendSession(userId).catch(err => {
          console.error('Failed to extend session:', err.message);
        });
      }
      return next();
    }

    // As a last resort, decode JWT to find user id and load session
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const userIdFromPayload = payload.id || payload._id || null;
      if (userIdFromPayload) {
        userId = userIdFromPayload.toString();
        const session = await withRedisTimeout(sessionService.getSession(userId), null);
        if (session) {
          req.session = session;
          // Update last activity on every request (fire-and-forget)
          sessionService.extendSession(userId).catch(err => {
            console.error('Failed to extend session:', err.message);
          });
        }
      }
    } catch (e) {
      // ignore invalid tokens here; auth middleware will handle if required
    }
  } catch (error) {
    console.error('Session middleware error:', error);
  }

  next();
};

/**
 * Middleware to add cache control headers
 */
const cacheControl = (options = {}) => {
  const {
    maxAge = 0,
    mustRevalidate = true,
    isPrivate = false,
  } = options;

  return (req, res, next) => {
    if (req.method !== 'GET') {
      return next();
    }

    const directives = [];
    
    if (maxAge > 0) {
      directives.push(`max-age=${maxAge}`);
      if (mustRevalidate) {
        directives.push('must-revalidate');
      }
    } else {
      directives.push('no-cache');
    }

    if (isPrivate) {
      directives.push('private');
    } else {
      directives.push('public');
    }

    res.setHeader('Cache-Control', directives.join(', '));
    next();
  };
};

module.exports = {
  cacheMiddleware,
  cacheInvalidationMiddleware,
  sessionMiddleware,
  cacheControl,
  reportDateRange,
  isClosedPeriodReport,
  resolveCompanyId,
};
