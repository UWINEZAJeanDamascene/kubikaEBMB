const { PrismaClient } = require('@prisma/client');
const { getReadContext } = require('./readContext');
const {
  assertReadLimit,
  recordQuerySafetyViolation,
} = require('../utils/querySafety');

const globalForPrisma = globalThis;

/**
 * Neon suspends idle compute, so the first query after a quiet spell can outlast
 * Prisma's connect timeout (P1001) or land on a connection the pooler already
 * closed (P1017/P2024). P1001/P1002 mean the engine never reached the server, so
 * retrying cannot double-apply anything; the other codes can surface after the
 * statement was sent, so those are only retried for reads.
 */
const READ_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  '$queryRaw',
  '$queryRawUnsafe',
]);

/** Misconfiguration rather than an unreachable server — retrying cannot help. */
const FATAL_INIT_CODES = new Set(['P1000', 'P1003', 'P1012', 'P1013']);

const MAX_ATTEMPTS = Math.max(1, Number(process.env.PRISMA_RETRY_ATTEMPTS || 3));
const PRISMA_APPLICATION_NAME = process.env.PRISMA_APPLICATION_NAME || 'stock-management-api';
const QUERY_MAX_ROWS = Math.min(5000, Math.max(1, Number(process.env.QUERY_MAX_ROWS) || 500));
const QUERY_ENFORCE_MAX_ROWS = String(process.env.QUERY_ENFORCE_MAX_ROWS || 'true').toLowerCase() !== 'false';
const reportedUnbounded = new Set();
const prismaOperationMetrics = {
  total_operations: 0,
  in_flight: 0,
  max_in_flight: 0,
  errors: 0,
  pool_timeout_errors: 0,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function reportUnboundedPrismaRead(operation, rowCount) {
  const stack = (new Error().stack || '').split('\n').slice(3);
  const site = (stack.find((line) => !line.includes('lib/prisma.js') && !line.includes('lib\\prisma.js') && !line.includes('node:internal')) || 'unknown').trim();
  if (reportedUnbounded.has(site)) return;
  reportedUnbounded.add(site);
  const action = QUERY_ENFORCE_MAX_ROWS ? `capped at ${QUERY_MAX_ROWS}` : 're-read unbounded (warn mode)';
  console.warn(
    `[unbounded-read] Prisma ${operation} returned more than ${QUERY_MAX_ROWS} rows (${rowCount}+) — ${action}. `
    + `Add pagination at: ${site}`,
  );
}

function isRetryable(error, operation) {
  if (!error) return false;
  // The engine never established a connection, so no statement was executed.
  if (error.name === 'PrismaClientInitializationError') return !FATAL_INIT_CODES.has(error.errorCode);
  const code = error.code || error.errorCode;
  if (code === 'P1001' || code === 'P1002') return true;
  if (code === 'P1017' || code === 'P2024') return READ_OPERATIONS.has(operation);
  return false;
}

/**
 * Neon can take a while to accept a TCP connection while its compute resumes
 * from suspend. Without an explicit connect/pool timeout, the underlying pg
 * driver falls back to the OS default TCP timeout (which can run ~2 minutes
 * on some networks) before Prisma even gets a chance to retry. Forcing a
 * short timeout here means a cold endpoint fails fast and our own retry loop
 * (below) takes over instead of the request appearing to hang.
 */
function withConnectionTimeouts(url) {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has('connect_timeout')) {
      parsed.searchParams.set('connect_timeout', process.env.PRISMA_CONNECT_TIMEOUT || '10');
    }
    if (!parsed.searchParams.has('pool_timeout')) {
      parsed.searchParams.set('pool_timeout', process.env.PRISMA_POOL_TIMEOUT || '10');
    }
    // Keep the pool bound explicit. An unbounded default (num_cpus * 2 + 1)
    // can exhaust a serverless pooler or create a silent throughput ceiling.
    // Pool saturation is reported from pg_stat_activity by Phase 0 metrics.
    if (!parsed.searchParams.has('connection_limit')) {
      const configuredLimit = Number(process.env.PRISMA_CONNECTION_LIMIT || 20);
      parsed.searchParams.set('connection_limit', String(Number.isFinite(configuredLimit) && configuredLimit > 0 ? Math.floor(configuredLimit) : 20));
    }
    if (!parsed.searchParams.has('application_name')) {
      parsed.searchParams.set('application_name', PRISMA_APPLICATION_NAME);
    }
    return parsed.toString();
  } catch (_) {
    return url;
  }
}

function createClient() {
  const datasourceUrl = withConnectionTimeouts(process.env.DATABASE_URL);
  const client = new PrismaClient({
    log: (process.env.PRISMA_LOG || 'warn').split(',').filter(Boolean),
    ...(datasourceUrl ? { datasources: { db: { url: datasourceUrl } } } : {}),
  });

  return client.$extends({
    query: {
        async $allOperations({ operation, args, query }) {
          prismaOperationMetrics.total_operations += 1;
          prismaOperationMetrics.in_flight += 1;
          prismaOperationMetrics.max_in_flight = Math.max(
            prismaOperationMetrics.max_in_flight,
            prismaOperationMetrics.in_flight,
          );
          try {
            for (let attempt = 1; ; attempt += 1) {
              try {
                const readContext = getReadContext();
                let queryArgs = args;
                const maxRows = Math.max(1, Number(readContext.maxRows || QUERY_MAX_ROWS));
                const probeTake = operation === 'findMany'
                  && args
                  && args.take === maxRows + 1;
                const explicitTake = operation === 'findMany'
                  && args
                  && args.take !== undefined
                  && !probeTake
                  && !readContext.internalProbe;
                if (explicitTake) {
                  try {
                    assertReadLimit(args.take, readContext, { name: 'take', maxRows });
                  } catch (error) {
                    recordQuerySafetyViolation({
                      code: error.code,
                      operation,
                      purpose: readContext.purpose,
                    });
                    throw error;
                  }
                }
                const guardedFindMany = operation === 'findMany'
                  && args
                  && args.take === undefined;
                if (guardedFindMany) {
                  queryArgs = { ...args, take: maxRows + 1 };
                }
                const result = await query(queryArgs);
                if (guardedFindMany && Array.isArray(result) && result.length > maxRows) {
                  reportUnboundedPrismaRead(operation, result.length);
                  if (!QUERY_ENFORCE_MAX_ROWS) return query(args);
                  return result.slice(0, maxRows);
                }
                return result;
              } catch (error) {
                prismaOperationMetrics.errors += 1;
                if (error.code === 'P2024' || error.errorCode === 'P2024') {
                  prismaOperationMetrics.pool_timeout_errors += 1;
                }
                if (attempt >= MAX_ATTEMPTS || !isRetryable(error, operation)) throw error;
                console.warn(
                  `[Prisma] ${error.code || error.errorCode || error.name} on ${operation}`
                  + ` — retrying (${attempt}/${MAX_ATTEMPTS - 1})`,
                );
                await sleep(attempt * 400);
              }
            }
          } finally {
            prismaOperationMetrics.in_flight = Math.max(0, prismaOperationMetrics.in_flight - 1);
          }
        },
    },
  });
}

const prismaClient = globalForPrisma.__stockPrisma ?? createClient();

// Resolve model delegates through the ambient transaction when one is active.
// POS idempotency wraps the complete handler in an interactive transaction;
// legacy controllers often use the shared `prisma` export directly, so they
// must join that transaction just like prismaCompat models do.
const prisma = new Proxy(prismaClient, {
  get(target, property) {
    const { getActiveTx, runWithTx } = require('./txContext');
    const activeTx = getActiveTx();
    if (activeTx && property === '$transaction') {
      return (operation, options) => {
        if (typeof operation === 'function') return operation(activeTx);
        if (Array.isArray(operation)) return Promise.all(operation);
        return target.$transaction(operation, options);
      };
    }
    if (activeTx && (typeof property === 'string') && property in activeTx) {
      const transactionValue = activeTx[property];
      if (typeof transactionValue !== 'function') return transactionValue;
      return transactionValue.bind(activeTx);
    }
    const value = Reflect.get(target, property, target);
    if (property === '$transaction' && typeof value === 'function') {
      return (operation, options) => {
        if (typeof operation !== 'function') return value.call(target, operation, options);
        return value.call(target, (tx) => runWithTx(tx, () => operation(tx)), options);
      };
    }
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__stockPrisma = prisma;
}

/**
 * The client a query should run on: the ambient interactive-transaction client
 * when inside runInTransaction, otherwise the plain one.
 *
 * Most code never needs this — the compat layer resolves the transaction for
 * every Model.find/create/update on its own (utils/prismaCompat.js txDelegate).
 * Use it in the places that hold a Prisma client directly instead: custom
 * doc.save() implementations, model helpers, raw SQL. Those bypass the compat
 * layer, so without this they commit outside the caller's transaction and
 * survive its rollback — the exact half-committed state the transaction exists
 * to prevent. See lib/txContext.js.
 *
 * Required lazily so this module stays free of load-order constraints.
 */
function dbClient() {
  const { getActiveTx } = require('./txContext');
  return getActiveTx() || prisma;
}

async function connectPrisma() {
  if (!process.env.DATABASE_URL) {
    console.warn('[Prisma] DATABASE_URL not set — PostgreSQL client not connected');
    return false;
  }
  for (let attempt = 1; ; attempt += 1) {
    try {
      await prisma.$connect();
      console.log('PostgreSQL connected via Prisma');
      return true;
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS || !isRetryable(error, '$connect')) throw error;
      console.warn(
        `[Prisma] connect failed (${error.code || error.errorCode || error.name})`
        + ` — retrying (${attempt}/${MAX_ATTEMPTS - 1})`,
      );
      await sleep(attempt * 1000);
    }
  }
}

async function disconnectPrisma() {
  try {
    await prisma.$disconnect();
  } catch (_) {
    /* ignore */
  }
}

/** Run a lightweight query so the first real request (e.g. login) does not pay Neon wake-up cost. */
async function warmPrisma() {
  if (!process.env.DATABASE_URL) return false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    console.log('[Prisma] Connection warmed');
    return true;
  } catch (error) {
    console.warn('[Prisma] Warm-up query failed:', error.message || error);
    return false;
  }
}

let keepAliveTimer = null;

/**
 * Ping the database periodically so Neon's compute never gets a chance to
 * autosuspend while the server process is alive. This avoids cold-start
 * latency on the *next* user request entirely, rather than just failing
 * fast when it happens. Default interval is under Neon's default 5-minute
 * autosuspend window.
 */
function startPrismaKeepAlive(intervalMs = Number(process.env.PRISMA_KEEPALIVE_MS || 4 * 60 * 1000)) {
  if (!process.env.DATABASE_URL || keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    warmPrisma().catch(() => {});
  }, intervalMs);
  if (typeof keepAliveTimer.unref === 'function') keepAliveTimer.unref();
}

function stopPrismaKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

function getPrismaOperationMetrics() {
  return {
    ...prismaOperationMetrics,
    application_name: PRISMA_APPLICATION_NAME,
    configured_pool_limit: Number(process.env.PRISMA_CONNECTION_LIMIT || 20),
  };
}

module.exports = {
  prisma,
  dbClient,
  connectPrisma,
  disconnectPrisma,
  warmPrisma,
  startPrismaKeepAlive,
  stopPrismaKeepAlive,
  getPrismaOperationMetrics,
};
