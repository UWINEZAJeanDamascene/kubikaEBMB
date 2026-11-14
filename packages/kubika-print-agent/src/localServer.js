const express = require('express');
const fs = require('fs');
const path = require('path');

const DEFAULT_ALLOWED_ORIGINS = new Set([
  'http://localhost',
  'http://127.0.0.1',
  'https://kubika-ebmf.vercel.app',
  'https://kubikapos.up.railway.app',
  'https://www.kubika-ebmf.vercel.app',
]);

function allowedOrigins() {
  const configured = String(process.env.KUBIKA_PRINT_AGENT_ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  return new Set([...DEFAULT_ALLOWED_ORIGINS, ...configured]);
}

function isAllowedOrigin(origin, origins = allowedOrigins()) {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    if (origins.has(origin)) return true;
    if (parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname)) return true;
  } catch {
    return false;
  }
  return false;
}

function getRequestToken(req) {
  const headerToken = String(req.headers['x-kubika-agent-token'] || '').trim();
  if (headerToken) return headerToken;
  const auth = String(req.headers.authorization || '').trim();
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  return match ? match[1].trim() : '';
}

function createRateLimiter(limit = 40, windowMs = 60000) {
  const buckets = new Map();
  return function rateLimit(req, res, next) {
    const key = `${req.ip || 'unknown'}::${req.path}`;
    const now = Date.now();
    const current = buckets.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > current.resetAt) {
      current.count = 0;
      current.resetAt = now + windowMs;
    }
    current.count += 1;
    buckets.set(key, current);
    if (current.count > limit) {
      return res.status(429).json({ success: false, code: 'PRINT_AGENT_RATE_LIMITED', message: 'Too many print-agent requests; try again shortly.' });
    }
    return next();
  };
}

function createLocalServer({
  ledger,
  credentialStore,
  discoverPrinters,
  refreshPrinters,
  savePrinters,
  transmitDirect,
  onPair,
  authorizeDrawer,
  rateLimitOptions,
}) {
  const app = express();
  const rateLimit = createRateLimiter(rateLimitOptions?.limit, rateLimitOptions?.windowMs);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && !isAllowedOrigin(origin)) {
      return res.status(403).json({ success: false, code: 'PRINT_AGENT_ORIGIN_FORBIDDEN', message: 'This origin is not allowed to use the local Print Agent.' });
    }
    if (origin) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Vary', 'Origin, Access-Control-Request-Private-Network');
    }
    res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Kubika-Agent-Token,Access-Control-Request-Private-Network');
    res.header('Access-Control-Allow-Private-Network', 'true');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '10mb' }));
  app.use((req, res, next) => {
    const publicSetupRead = req.method === 'GET'
      && ['/', '/setup', '/v1/setup', '/status', '/v1/status'].includes(req.path);
    if (req.path === '/v1/pair' || publicSetupRead) return next();
    const token = getRequestToken(req);
    const stored = credentialStore?.load?.();
    const hasInstalledToken = Boolean(stored?.accessToken && token === stored.accessToken);
    const hasDrawerCapability = req.method === 'POST'
      && req.path === '/v1/jobs'
      && req.body?.jobType === 'drawer-open'
      && Boolean(String(req.body?.drawerAuthorizationToken || '').trim());
    if (!hasInstalledToken && !hasDrawerCapability) {
      return res.status(401).json({ success: false, code: 'PRINT_AGENT_UNAUTHORIZED', message: 'This local agent requires the installed pairing token.' });
    }
    return next();
  });
  app.use(rateLimit);

  app.get('/v1/status', (_req, res) => {
    res.json({
      success: true,
      data: {
        paired: Boolean(credentialStore.load()),
        printers: discoverPrinters(),
        service: 'kubika-print-agent',
        version: '0.1.3',
      },
    });
  });

  app.post('/v1/printers/refresh', (_req, res) => {
    try {
      const printers = refreshPrinters ? refreshPrinters() : discoverPrinters();
      res.json({ success: true, data: { printers } });
    } catch (error) {
      res.status(500).json({ success: false, code: 'PRINTER_DISCOVERY_FAILED', message: error.message });
    }
  });

  app.post('/v1/pair', async (req, res) => {
    try {
      const result = await onPair(req.body);
      if (result?.accessToken) {
        const stored = credentialStore.load();
        if (stored && stored.accessToken !== result.accessToken) {
          credentialStore.save({ ...stored, accessToken: result.accessToken });
        }
      }
      res.json({
        success: true,
        data: {
          paired: true,
          agentId: result.agentId,
          accessToken: result.accessToken || credentialStore.load()?.accessToken || null,
          printers: result.printers || [],
        },
      });
    } catch (error) {
      res.status(400).json({ success: false, code: 'PRINT_PAIRING_FAILED', message: error.message });
    }
  });

  app.post('/v1/jobs', async (req, res) => {
    try {
      if (req.body?.jobType === 'drawer-open') {
        if (typeof authorizeDrawer !== 'function') {
          return res.status(503).json({ success: false, code: 'PRINT_DRAWER_AUTHORIZATION_UNAVAILABLE', message: 'The server must authorize every drawer kick.' });
        }
        await authorizeDrawer(String(req.body.drawerAuthorizationToken || ''));
      }
      const result = await transmitDirect(req.body);
      res.json({ success: true, data: result });
    } catch (error) {
      const drawerAuthorizationFailure = req.body?.jobType === 'drawer-open';
      res.status(error.status || (drawerAuthorizationFailure ? 403 : 400)).json({
        success: false,
        code: error.code || (drawerAuthorizationFailure ? 'PRINT_DRAWER_AUTHORIZATION_REQUIRED' : 'LOCAL_PRINT_FAILED'),
        message: error.message || (drawerAuthorizationFailure ? 'The drawer kick was not authorized.' : 'Local print failed.'),
      });
    }
  });

  app.post('/v1/unpair', (_req, res) => {
    credentialStore.clear();
    res.json({ success: true, data: { paired: false } });
  });

  app.post('/v1/printers/select', (req, res) => {
    try {
      const name = String(req.body?.name || '').trim();
      const printers = discoverPrinters();
      const selected = printers.find((printer) => (
        printer.transport === 'windows-spooler' && printer.name === name
      ));
      if (!selected) {
        return res.status(404).json({
          success: false,
          code: 'PRINT_PRINTER_NOT_FOUND',
          message: 'Select a Windows printer discovered by this Print Agent.',
        });
      }
      const updated = printers.map((printer) => ({
        ...printer,
        isDefault: printer.transport === selected.transport && printer.name === selected.name,
      }));
      savePrinters(updated);
      return res.json({ success: true, data: { printers: updated } });
    } catch (error) {
      return res.status(400).json({ success: false, code: 'PRINT_PRINTER_SELECT_FAILED', message: error.message });
    }
  });

  app.post('/v1/printers', (req, res) => {
    try {
      const address = String(req.body.address || '').trim();
      if (!/^[^:]+:\d+$/.test(address)) {
        return res.status(400).json({ success: false, message: 'Enter a printer address such as 127.0.0.1:9100.' });
      }
      const printer = {
        name: String(req.body.name || 'Virtual TCP Printer').trim(),
        transport: 'tcp9100',
        address,
        isDefault: true,
        status: 'configured',
      };
      savePrinters([printer]);
      res.json({ success: true, data: { printers: [printer] } });
    } catch (error) {
      res.status(400).json({ success: false, message: error.message });
    }
  });

  app.get(['/setup', '/v1/setup'], (_req, res) => {
    res.redirect('/');
  });
  app.get(['/status', '/v1/status'], (_req, res) => {
    const paired = Boolean(credentialStore.load());
    res.json({
      success: true,
      data: {
        paired,
        printers: discoverPrinters(),
        service: 'kubika-print-agent',
        version: '0.1.3',
      },
    });
  });
  app.get(['/logs', '/v1/logs'], (_req, res) => {
    const logDir = process.env.WINSW_SERVICE_LOG_DIR || path.join(process.env.ProgramData || process.cwd(), 'Kubika', 'PrintAgent', 'logs');
    const files = fs.existsSync(logDir)
      ? fs.readdirSync(logDir).filter((name) => name.endsWith('.log')).slice(-5)
      : [];
    const lines = files.flatMap((name) => {
      try { return fs.readFileSync(path.join(logDir, name), 'utf8').split(/\r?\n/).slice(-100); } catch { return []; }
    });
    res.json({ success: true, data: { lines } });
  });

  app.get('/', (_req, res) => {
    res.type('html').send(`<!doctype html><html><body style="font-family:sans-serif;max-width:720px;margin:40px auto">
      <h1>Kubika Print Agent</h1>
      <p>Local setup and diagnostics. This page is available only on this computer.</p>
      <h2>Pair agent</h2>
      <form id="pair"><label>Pairing code</label><br><input name="pairingCode" placeholder="KUBIKA-XXXXXXXX" required><br><br>
      <label>Device name</label><br><input name="name" value="Shop Print Agent"><br><br>
      <button>Pair</button></form><pre id="result"></pre>
      <script>
        const getMachineId=()=>{
          let id=localStorage.getItem('kubika:print-agent-machine-id');
          if(!id){id=crypto.randomUUID();localStorage.setItem('kubika:print-agent-machine-id',id)}
          return id;
        };
        pair.onsubmit=async e=>{
          e.preventDefault();
          const button=e.submitter;
          button.disabled=true;
          const f=new FormData(pair);
          const body=Object.fromEntries(f);
          body.deviceId=getMachineId();
          body.platform=navigator.platform.includes('Win')?'windows':'other';
          result.textContent='Pairing...';
          try{
            const r=await fetch('/v1/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
            const response=await r.json();
            if(r.ok&&response.success&&response.data?.paired){
              result.textContent='Success: Print Agent paired successfully.';
            }else{
              result.textContent='Pairing failed: '+(response.message||'Please check the pairing code and try again.');
            }
          }catch(error){
            result.textContent='Pairing failed: unable to connect to the local Print Agent.';
          }finally{
            button.disabled=false;
          }
        };
      </script>
    </body></html>`);
  });

  return app;
}

module.exports = { createLocalServer };
