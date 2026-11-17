const fs = require('fs');
const path = require('path');
const config = require('./config');
const { CredentialStore } = require('./credentialStore');
const { PrintLedger } = require('./ledger');
const { discoverWindowsPrinters, mergePrinterProfiles } = require('./printerDiscovery');
const { createLocalServer } = require('./localServer');
const { transmitJob, retryDelay, shouldSkipAutomaticRetry } = require('./jobProcessor');
const { hydrateReferencedJob: hydrateStoredPrintJob } = require('./documentHydration');
const { createLogger } = require('./structuredLogger');
const VERSION = require('../package.json').version;

fs.mkdirSync(config.dataDir, { recursive: true });
const logger = createLogger(config.dataDir);
for (const level of ['log', 'info', 'warn', 'error']) console[level] = logger[level];
const credentials = new CredentialStore(config.dataDir);
const ledger = new PrintLedger(config.dataDir);

const printerFile = path.join(config.dataDir, 'printers.json');
function loadPrinters() {
  if (fs.existsSync(printerFile)) {
    try { return JSON.parse(fs.readFileSync(printerFile, 'utf8')); } catch {}
  }
  return discoverWindowsPrinters();
}
function savePrinters(printers) {
  fs.writeFileSync(printerFile, JSON.stringify(printers, null, 2), { mode: 0o600 });
}
function refreshPrinters() {
  const printers = mergePrinterProfiles(discoverWindowsPrinters(), loadPrinters());
  savePrinters(printers);
  return printers;
}

async function api(pathname, options = {}, token) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${config.backendUrl}${pathname}`, {
    ...options,
    headers,
  });
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok) {
    const error = new Error(body?.message || `HTTP ${response.status}`);
    error.status = response.status;
    error.code = body?.code;
    throw error;
  }
  return body;
}

async function hydrateReferencedJob(job, stored, renderOptions = {}) {
  return hydrateStoredPrintJob(job, async (documentId, version) => {
    if (!stored?.accessToken) {
      throw Object.assign(new Error('Print Agent credentials are unavailable for stored-document retrieval.'), {
        code: 'PRINT_AGENT_UNAUTHORIZED',
      });
    }
    const response = await api(
      `/api/pos/print-agent/agent/documents/${encodeURIComponent(documentId)}/versions/${version}`,
      { method: 'GET' },
      stored.accessToken,
    );
    return response.data;
  }, renderOptions);
}

async function pair(body) {
  const result = await api('/api/pos/print-agent/pair', {
    method: 'POST',
    body: JSON.stringify({
      pairingCode: body.pairingCode,
      deviceId: body.deviceId || require('crypto').randomUUID(),
      name: body.name || 'Kubika Print Agent',
      platform: 'windows',
      version: VERSION,
    }),
  });
  credentials.save({
    backendUrl: config.backendUrl,
    agentId: result.data.agentId,
    accessToken: result.data.accessToken,
    refreshToken: result.data.refreshToken,
    accessExpiresAt: result.data.accessExpiresAt,
    companyId: result.data.companyId || null,
    registerId: result.data.registerId || null,
  });
  const discovered = refreshPrinters();
  return { ...result.data, printers: discovered };
}

async function refreshCredentials() {
  const stored = credentials.load();
  if (!stored?.refreshToken) return null;
  if (stored.accessExpiresAt && Date.now() < new Date(stored.accessExpiresAt).getTime() - 30000) return stored;
  const result = await api('/api/pos/print-agent/refresh', {
    method: 'POST',
    body: JSON.stringify({ refreshToken: stored.refreshToken }),
  });
  const updated = {
    ...stored,
    accessToken: result.data.accessToken,
    refreshToken: result.data.refreshToken,
    accessExpiresAt: result.data.accessExpiresAt,
  };
  credentials.save(updated);
  return updated;
}

async function transmitDirect(body) {
  const printers = loadPrinters();
  const requestedName = String(body.printerName || '').trim();
  const printer = requestedName
    ? printers.find((item) => item.name === requestedName && item.transport === 'windows-spooler') || null
    : printers.find((item) => item.isDefault || item.is_default) || printers[0] || null;
  if (requestedName && !printer) {
    throw Object.assign(new Error('The selected Windows A4 printer is not available on this agent.'), {
      status: 404,
      code: 'PRINT_PRINTER_NOT_FOUND',
    });
  }
  let stored = credentials.load();
  const inputPayload = body.payload || body;
  let job = {
    id: body.id || `local-${Date.now()}`,
    jobType: body.jobType || 'test-print',
    companyId: stored?.companyId || null,
    registerId: stored?.registerId || null,
    localOnly: ['receipt', 'refund-receipt'].includes(body.jobType),
    payloadJson: inputPayload,
    copy_required: Boolean(body.copyRequired),
    documentId: inputPayload.documentId,
    documentVersion: inputPayload.documentVersion,
  };
  if (job.documentId || job.documentVersion) {
    stored = await refreshCredentials();
    job = await hydrateReferencedJob(job, stored, inputPayload);
  }
  return transmitJob(job, printer, ledger, { backendUrl: config.backendUrl });
}

async function authorizeDrawer(token) {
  const stored = await refreshCredentials();
  if (!stored?.accessToken) {
    throw Object.assign(new Error('Pair the Print Agent before opening the cash drawer.'), {
      status: 401,
      code: 'PRINT_AGENT_UNAUTHORIZED',
    });
  }
  const result = await api('/api/pos/print-agent/agent/drawer-authorizations/consume', {
    method: 'POST',
    body: JSON.stringify({ token }),
  }, stored.accessToken);
  return result.data;
}

async function recordDrawerOutcome(authorizationId, outcome) {
  const stored = await refreshCredentials();
  if (!stored?.accessToken) {
    throw Object.assign(new Error('Print Agent credentials are unavailable while recording the drawer outcome.'), {
      code: 'PRINT_DRAWER_OUTCOME_RECORD_FAILED',
    });
  }
  return api(`/api/pos/print-agent/agent/drawer-authorizations/${encodeURIComponent(authorizationId)}/outcome`, {
    method: 'POST',
    body: JSON.stringify({ outcome }),
  }, stored.accessToken);
}

async function leaseAndProcess(job, stored) {
  const lease = await api(`/api/pos/print-agent/agent/jobs/${encodeURIComponent(job.id)}/lease`, { method: 'POST' }, stored.accessToken);
  const leased = lease.data.job;
  const leaseToken = lease.data.leaseToken;
  const printers = loadPrinters();
  let printer = printers.find((item) => item.id === leased.printerId || item.id === leased.printer_id);
  printer = printer || printers.find((item) => item.isDefault || item.is_default) || printers[0] || null;

  let transmissionCompleted = false;
  try {
    let hydrated = leased;
    if (leased.documentId || leased.documentVersion || leased.document_id || leased.document_version) {
      try {
        hydrated = await hydrateReferencedJob(leased, stored);
      } catch (error) {
        await api(`/api/pos/print-agent/agent/jobs/${encodeURIComponent(job.id)}/fail`, {
          method: 'POST',
          body: JSON.stringify({ leaseToken, error: error.message }),
        }, stored.accessToken);
        throw error;
      }
    }
    await transmitJob(hydrated, printer, ledger, { backendUrl: config.backendUrl });
    transmissionCompleted = true;
    await api(`/api/pos/print-agent/agent/jobs/${encodeURIComponent(job.id)}/acknowledge`, {
      method: 'POST',
      body: JSON.stringify({ leaseToken, outcome: 'transmitted' }),
    }, stored.accessToken);
  } catch (error) {
    if (transmissionCompleted) ledger.markUncertain(leased.idempotencyKey || leased.idempotency_key || leased.id, error.message);
    await api(`/api/pos/print-agent/agent/jobs/${encodeURIComponent(job.id)}/uncertain`, {
      method: 'POST',
      body: JSON.stringify({ leaseToken, error: error.message }),
    }, stored.accessToken);
    throw error;
  }
}

async function pollLoop() {
  let stored;
  try {
    stored = await refreshCredentials();
  } catch (error) {
    console.warn('[print-agent] Credential refresh failed:', error.message);
    return;
  }
  if (!stored?.accessToken) return;
  try {
    const printers = refreshPrinters().map((printer) => ({
      name: printer.name,
      address: printer.address || printer.name,
      transport: printer.transport,
      status: printer.status || 'unknown',
      lastError: printer.lastError || null,
    }));
    await api('/api/pos/print-agent/agent/status', {
      method: 'POST',
      body: JSON.stringify({ version: VERSION, printers }),
    }, stored.accessToken);
  } catch (error) {
    console.warn('Agent health report failed:', error.message);
  }
  try {
    const pending = ledger.getPendingResults(100);
    if (pending.length) {
      const synced = await api('/api/pos/print-agent/agent/results', {
        method: 'POST',
        body: JSON.stringify({
          results: pending.map((result) => ({
            idempotencyKey: result.job_id,
            jobType: result.job_type,
            status: result.status,
            errorCode: result.status === 'uncertain'
              ? 'PRINT_OUTCOME_UNCERTAIN'
              : result.status === 'failed' ? 'LOCAL_PRINT_FAILED' : null,
            printedAt: result.printed_at,
          })),
        }),
      }, stored.accessToken);
      const syncedKeys = new Set(synced.data?.syncedKeys || []);
      for (const result of pending) {
        if (syncedKeys.has(result.job_id)) ledger.markResultSynced(result.job_id);
      }
    }
  } catch (error) {
    console.warn('[print-agent] Print-result sync failed:', error.message);
  }
  try {
    const polled = await api('/api/pos/print-agent/agent/jobs/poll', { method: 'GET' }, stored.accessToken);
    for (const job of polled.data.jobs || []) {
      const ledgerJobId = job.idempotencyKey || job.idempotency_key || job.id;
      const existing = ledger.get(ledgerJobId);
      if (shouldSkipAutomaticRetry(existing)) continue;
      try {
        await leaseAndProcess(job, stored);
      } catch {
        setTimeout(() => pollLoop(), retryDelay(existing?.attempt_count || 1));
      }
    }
  } catch (error) {
    console.warn('[print-agent] Poll failed:', error.message);
  }
}

let timer = null;
function start() {
  const app = createLocalServer({
    ledger,
    credentialStore: credentials,
    discoverPrinters: loadPrinters,
    refreshPrinters,
    savePrinters,
    transmitDirect,
    onPair: pair,
    authorizeDrawer,
    recordDrawerOutcome,
    diagnosticsPath: logger.logFile,
  });
  const server = app.listen(config.localPort, '127.0.0.1', () => {
    console.log(`[print-agent] Local setup listening at http://127.0.0.1:${config.localPort}`);
  });

  pollLoop();
  timer = setInterval(pollLoop, config.pollIntervalMs).unref();

  const shutdown = () => {
    clearInterval(timer);
    server.close(() => {
      ledger.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start();
