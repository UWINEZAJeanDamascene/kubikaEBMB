const fs = require('fs');
const path = require('path');
const config = require('./config');
const { CredentialStore } = require('./credentialStore');
const { PrintLedger } = require('./ledger');
const { discoverWindowsPrinters, mergePrinterProfiles } = require('./printerDiscovery');
const { createLocalServer } = require('./localServer');
const { transmitJob, retryDelay, shouldSkipAutomaticRetry } = require('./jobProcessor');

fs.mkdirSync(config.dataDir, { recursive: true });
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

async function pair(body) {
  const result = await api('/api/pos/print-agent/pair', {
    method: 'POST',
    body: JSON.stringify({
      pairingCode: body.pairingCode,
      deviceId: body.deviceId || require('crypto').randomUUID(),
      name: body.name || 'Kubika Print Agent',
      platform: 'windows',
      version: '0.1.4',
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
  const printer = printers.find((item) => item.isDefault || item.is_default) || printers[0] || null;
  const job = {
    id: body.id || `local-${Date.now()}`,
    jobType: body.jobType || 'test-print',
    payloadJson: body.payload || body,
    copy_required: Boolean(body.copyRequired),
  };
  return transmitJob(job, printer, ledger);
}

async function authorizeDrawer(token) {
  const stored = await refreshCredentials();
  if (!stored?.accessToken) {
    throw Object.assign(new Error('Pair the Print Agent before opening the cash drawer.'), {
      status: 401,
      code: 'PRINT_AGENT_UNAUTHORIZED',
    });
  }
  return api('/api/pos/print-agent/agent/drawer-authorizations/consume', {
    method: 'POST',
    body: JSON.stringify({ token }),
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
    await transmitJob(leased, printer, ledger);
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
