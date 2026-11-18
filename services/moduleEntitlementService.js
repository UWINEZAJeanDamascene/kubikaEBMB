const { prisma } = require('../lib/prisma');
const { redisClient, isRedisConfigured } = require('../config/redis');

const CACHE_TTL_SECONDS = 5;
const MODULE_CODE_PATTERN = /^[a-z][a-z0-9._-]{0,79}$/;

function createEntitlementError(code, message, statusCode = 503) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function normalizeScope(companyId, moduleCode) {
  const normalizedCompanyId = String(companyId || '').trim();
  const normalizedModuleCode = String(moduleCode || '').trim();
  if (!normalizedCompanyId || !MODULE_CODE_PATTERN.test(normalizedModuleCode)) {
    throw createEntitlementError('MODULE_ENTITLEMENT_SCOPE_INVALID', 'A valid company and module are required.', 400);
  }
  return { companyId: normalizedCompanyId, moduleCode: normalizedModuleCode };
}

function cacheKey(companyId, moduleCode) {
  return `module-entitlement:v2:${companyId}:${moduleCode}`;
}

function effectiveStatus(entitlement) {
  return entitlement.pendingStatus || entitlement.status;
}

async function setCachedValue(key, value) {
  if (typeof redisClient.setex === 'function') {
    await redisClient.setex(key, CACHE_TTL_SECONDS, value);
    return;
  }
  if (typeof redisClient.setEx === 'function') {
    await redisClient.setEx(key, CACHE_TTL_SECONDS, value);
    return;
  }
  await redisClient.set(key, value, { ex: CACHE_TTL_SECONDS });
}

async function readCachedStatus(key, companyId) {
  if (!isRedisConfigured() || typeof redisClient.get !== 'function') return null;
  try {
    const cached = await redisClient.get(key);
    if (cached == null) return null;
    const decoded = typeof cached === 'string' ? JSON.parse(cached) : cached;
    if (decoded && (decoded.status === 'on' || decoded.status === 'off')) {
      return { ...decoded, status: effectiveStatus(decoded) };
    }
    console.warn('[module-entitlement] Ignoring malformed shared entitlement cache entry.');
  } catch (error) {
    console.warn('[module-entitlement] Shared entitlement cache read failed; using the database.', error.message);
  }
  return null;
}

async function writeCachedStatus(key, value) {
  const canWrite = ['setex', 'setEx', 'set'].some((method) => typeof redisClient[method] === 'function');
  if (!isRedisConfigured() || !canWrite) return;
  try {
    await setCachedValue(key, JSON.stringify(value));
  } catch (error) {
    console.warn('[module-entitlement] Shared entitlement cache write failed.', error.message);
  }
}

async function getEntitlement(companyId, moduleCode, { useCache = true } = {}) {
  const scope = normalizeScope(companyId, moduleCode);
  const key = cacheKey(scope.companyId, scope.moduleCode);
  if (useCache) {
    const cached = await readCachedStatus(key, scope.companyId);
    if (cached) return cached;
  }

  const entitlement = await prisma.companyModuleEntitlement.findUnique({
    where: {
      companyId_moduleCode: {
        companyId: scope.companyId,
        moduleCode: scope.moduleCode,
      },
    },
    select: {
      status: true,
      effectiveAt: true,
      version: true,
      pendingStatus: true,
      pendingEffectiveAt: true,
      pendingCorrelationId: true,
    },
  });

  if (!entitlement) {
    throw createEntitlementError(
      'MODULE_ENTITLEMENT_MISSING',
      'Company module entitlement is missing. Contact platform support.',
    );
  }
  if (entitlement.status !== 'on' && entitlement.status !== 'off') {
    throw createEntitlementError(
      'MODULE_ENTITLEMENT_INVALID',
      'Company module entitlement has an invalid status. Contact platform support.',
    );
  }

  const result = {
    status: effectiveStatus(entitlement),
    effectiveAt: entitlement.effectiveAt,
    version: entitlement.version,
    pendingStatus: entitlement.pendingStatus,
    pendingEffectiveAt: entitlement.pendingEffectiveAt,
    pendingCorrelationId: entitlement.pendingCorrelationId,
  };
  if (useCache) await writeCachedStatus(key, result);
  return result;
}

async function hasModule(companyId, moduleCode, options) {
  const entitlement = await getEntitlement(companyId, moduleCode, options);
  return entitlement.status === 'on';
}

async function getEffectiveCapabilities(companyId) {
  const normalizedCompanyId = String(companyId || '').trim();
  if (!normalizedCompanyId) {
    throw createEntitlementError('MODULE_ENTITLEMENT_SCOPE_INVALID', 'A valid company is required.', 400);
  }
  const entitlement = await getEntitlement(normalizedCompanyId, 'fiscal.ebm');
  return {
    modules: {
      'fiscal.ebm': entitlement.status === 'on',
    },
    versions: {
      'fiscal.ebm': entitlement.version,
    },
    sandboxSetupAllowed: require('./ebmService').isSandboxMode(),
  };
}

async function getFiscalSnapshot(companyId) {
  const entitlement = await getEntitlement(companyId, 'fiscal.ebm', { useCache: false });
  const enabled = entitlement.status === 'on';
  return {
    fiscalMode: enabled ? 'ebm' : 'none',
    fiscalStatus: enabled ? 'not_submitted' : 'not_required',
  };
}

async function invalidate(companyId, moduleCode) {
  const scope = normalizeScope(companyId, moduleCode);
  if (!isRedisConfigured() || typeof redisClient.del !== 'function') return;
  await redisClient.del(cacheKey(scope.companyId, scope.moduleCode));
}

module.exports = {
  CACHE_TTL_SECONDS,
  getEntitlement,
  hasModule,
  getEffectiveCapabilities,
  getFiscalSnapshot,
  invalidate,
};
