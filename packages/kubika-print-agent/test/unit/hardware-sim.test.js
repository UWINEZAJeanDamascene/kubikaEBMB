const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { createLocalServer } = require('../../src/localServer');

const { drawerCommand } = require('../../src/escpos');
const { renderThermalDocument } = require('../../../kubika-receipt-renderer/index.cjs');
const { printTcp9100 } = require('../../src/transports');

test('TCP 9100 simulator receives exact ESC/POS receipt bytes', async () => {
  const bytes = renderThermalDocument({
    shopName: 'Kubika Test Shop',
    receiptNumber: 'R-1001',
    lines: [{ description: 'Coffee', quantity: 2, total: 5 }],
    total: 5,
    paperWidthMm: 58,
  }, { columns: 32, jobType: 'receipt' });
  const capturePath = path.join(os.tmpdir(), `kubika-escpos-${process.pid}.bin`);

  const received = await new Promise((resolve, reject) => {
    const chunks = [];
    const server = net.createServer((socket) => {
      socket.on('data', (chunk) => chunks.push(chunk));
      socket.on('end', () => {
        server.close();
        resolve(Buffer.concat(chunks));
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', async () => {
      const port = server.address().port;
      try {
        await printTcp9100(`127.0.0.1:${port}`, bytes, 3000);
      } catch (error) {
        server.close();
        reject(error);
      }
    });
  });

  fs.writeFileSync(capturePath, received);
  assert.deepEqual(received, Buffer.from(bytes));
  assert.equal(received.includes(Buffer.from('COPY / DUPLICATE')), false);
  assert.ok(received.length > 100);
  fs.unlinkSync(capturePath);
});

test('drawer pulse and 80 mm thermal rendering are emitted as ESC/POS bytes', () => {
  const pulse = drawerCommand(5, 25, 500);
  assert.deepEqual([...pulse], [0x1b, 0x70, 0x01, 13, 250]);

  const receipt = renderThermalDocument({
    shopName: 'Kubika',
    lines: [{ description: 'Item', quantity: 1, total: 100 }],
    total: 100,
    paperWidthMm: 80,
  }, { columns: 48, jobType: 'receipt' });
  assert.ok(Buffer.from(receipt).includes(Buffer.from('Kubika')));
  assert.equal(receipt[0], 0x1b);
});

test('local printer selection persists the chosen discovered Windows printer as default', async () => {
  const token = 'installed-agent-token';
  const discovered = [
    { name: 'Microsoft Print to PDF', transport: 'windows-spooler', isDefault: true },
    { name: 'HP LaserJet P2055dn', transport: 'windows-spooler', isDefault: false },
  ];
  let savedPrinters = discovered;
  const app = createLocalServer({
    ledger: {},
    credentialStore: { load: () => ({ accessToken: token }) },
    discoverPrinters: () => savedPrinters,
    savePrinters: (printers) => { savedPrinters = printers; },
    transmitDirect: async () => ({}),
    onPair: async () => ({}),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/printers/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'HP LaserJet P2055dn' }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(savedPrinters.find((printer) => printer.name === 'HP LaserJet P2055dn').isDefault, true);
    assert.equal(savedPrinters.find((printer) => printer.name === 'Microsoft Print to PDF').isDefault, false);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('paired browser sessions authorize only origin-bound local printer operations', async () => {
  const token = 'installed-agent-token';
  let savedPrinters = [];
  const app = createLocalServer({
    ledger: {},
    credentialStore: { load: () => ({ accessToken: token }) },
    discoverPrinters: () => [{ name: 'Receipt Printer', transport: 'windows-spooler', isDefault: false }],
    savePrinters: (printers) => { savedPrinters = printers; },
    transmitDirect: async () => ({}),
    onPair: async () => ({ agentId: 'agent-test', accessToken: token }),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const origin = 'https://kubika-ebmf.vercel.app';

  try {
    const originlessSession = await fetch(`${baseUrl}/v1/browser-session`, { method: 'POST' });
    assert.equal(originlessSession.status, 403);

    const pairResponse = await fetch(`${baseUrl}/v1/pair`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingCode: 'test-code' }),
    });
    const pairBody = await pairResponse.json();
    assert.equal(pairResponse.status, 200);
    assert.equal(Object.prototype.hasOwnProperty.call(pairBody.data, 'accessToken'), false);

    const missingToken = await fetch(`${baseUrl}/v1/printers/refresh`, { method: 'POST' });
    assert.equal(missingToken.status, 401);

    const bootstrap = await fetch(`${baseUrl}/v1/browser-session`, {
      method: 'POST',
      headers: { Origin: origin },
    });
    const session = await bootstrap.json();
    assert.equal(bootstrap.status, 200);
    assert.equal(session.success, true);
    assert.ok(Date.parse(session.data.expiresAt) > Date.now());
    assert.notEqual(session.data.token, token);

    const refresh = await fetch(`${baseUrl}/v1/printers/refresh`, {
      method: 'POST',
      headers: { Origin: origin, Authorization: `Bearer ${session.data.token}` },
    });
    assert.equal(refresh.status, 200);

    const selection = await fetch(`${baseUrl}/v1/printers/select`, {
      method: 'POST',
      headers: { Origin: origin, Authorization: `Bearer ${session.data.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Receipt Printer' }),
    });
    assert.equal(selection.status, 200);
    assert.equal(savedPrinters[0].isDefault, true);

    const wrongOrigin = await fetch(`${baseUrl}/v1/printers/refresh`, {
      method: 'POST',
      headers: { Origin: 'https://attacker.example', Authorization: `Bearer ${session.data.token}` },
    });
    assert.equal(wrongOrigin.status, 403);

    const outOfScope = await fetch(`${baseUrl}/v1/logs`, {
      headers: { Origin: origin, Authorization: `Bearer ${session.data.token}` },
    });
    assert.equal(outOfScope.status, 401);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('local printer selection rejects a printer not discovered by the agent', async () => {
  const token = 'installed-agent-token';
  const app = createLocalServer({
    ledger: {},
    credentialStore: { load: () => ({ accessToken: token }) },
    discoverPrinters: () => [],
    savePrinters: () => assert.fail('must not save an unavailable printer'),
    transmitDirect: async () => ({}),
    onPair: async () => ({}),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/printers/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Uninstalled printer' }),
    });
    const body = await response.json();

    assert.equal(response.status, 404);
    assert.equal(body.code, 'PRINT_PRINTER_NOT_FOUND');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('local API rejects untrusted origins, missing tokens, and repeated requests', async () => {
  const token = 'installed-agent-token';
  const app = createLocalServer({
    ledger: {},
    credentialStore: { load: () => ({ accessToken: token }) },
    discoverPrinters: () => [],
    savePrinters: () => {},
    transmitDirect: async () => ({}),
    onPair: async () => ({}),
    rateLimitOptions: { limit: 3, windowMs: 60000 },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/v1/status`;

  try {
    const forbiddenOrigin = await fetch(url, { headers: { Origin: 'https://attacker.example' } });
    assert.equal(forbiddenOrigin.status, 403);

    const missingToken = await fetch(`http://127.0.0.1:${address.port}/v1/printers/refresh`, { method: 'POST' });
    assert.equal(missingToken.status, 401);

    const first = await fetch(url);
    const second = await fetch(url);
    const limited = await fetch(url);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(limited.status, 429);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('local API rejects unconfigured localhost ports and private-network preflights', async () => {
  const previousAllowedOrigins = process.env.KUBIKA_PRINT_AGENT_ALLOWED_ORIGINS;
  process.env.KUBIKA_PRINT_AGENT_ALLOWED_ORIGINS = 'http://localhost:5173';
  const app = createLocalServer({
    ledger: {},
    credentialStore: { load: () => ({ accessToken: 'installed-agent-token' }) },
    discoverPrinters: () => [],
    savePrinters: () => {},
    transmitDirect: async () => ({}),
    onPair: async () => ({}),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/v1/status`;

  try {
    const configured = await fetch(url, { headers: { Origin: 'http://localhost:5173' } });
    const unconfigured = await fetch(url, { headers: { Origin: 'http://localhost:3000' } });
    const preflight = await fetch(url, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:3000', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Private-Network': 'true' },
    });
    assert.equal(configured.status, 200);
    assert.equal(unconfigured.status, 403);
    assert.equal(preflight.status, 403);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (previousAllowedOrigins === undefined) delete process.env.KUBIKA_PRINT_AGENT_ALLOWED_ORIGINS;
    else process.env.KUBIKA_PRINT_AGENT_ALLOWED_ORIGINS = previousAllowedOrigins;
  }
});

test('local setup page and status are available before pairing; printer mutations still require a token', async () => {
  const app = createLocalServer({
    ledger: {},
    credentialStore: { load: () => null },
    discoverPrinters: () => [{ name: 'Receipt Printer', transport: 'windows-spooler' }],
    savePrinters: () => {},
    transmitDirect: async () => ({}),
    onPair: async () => ({}),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const page = await fetch(baseUrl);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Pair agent/);

    const status = await fetch(`${baseUrl}/v1/status`);
    const body = await status.json();
    assert.equal(status.status, 200);
    assert.equal(body.data.paired, false);
    assert.equal(body.data.printers[0].name, 'Receipt Printer');
    assert.equal(body.data.version, require('../../package.json').version);

    const mutation = await fetch(`${baseUrl}/v1/printers/refresh`, { method: 'POST' });
    assert.equal(mutation.status, 401);

    const browserSession = await fetch(`${baseUrl}/v1/browser-session`, {
      method: 'POST',
      headers: { Origin: 'https://kubika-ebmf.vercel.app' },
    });
    assert.equal(browserSession.status, 401);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('local drawer kicks require a valid one-time server authorization', async () => {
  const token = 'installed-agent-token';
  const consumed = new Set();
  const outcomes = [];
  let transmitted = 0;
  const app = createLocalServer({
    ledger: {},
    credentialStore: { load: () => ({ accessToken: token }) },
    discoverPrinters: () => [],
    savePrinters: () => {},
    transmitDirect: async () => { transmitted += 1; return { transmitted: true }; },
    onPair: async () => ({}),
    authorizeDrawer: async (authorizationToken) => {
      if (!authorizationToken) throw Object.assign(new Error('Authorization required.'), { code: 'PRINT_DRAWER_AUTHORIZATION_INVALID' });
      if (authorizationToken === 'expired') throw Object.assign(new Error('Authorization expired.'), { status: 410 });
      if (consumed.has(authorizationToken)) throw Object.assign(new Error('Authorization already used.'), { status: 409 });
      consumed.add(authorizationToken);
      return { authorizationId: 'drawer-authorization-1' };
    },
    recordDrawerOutcome: async (authorizationId, outcome) => outcomes.push({ authorizationId, outcome }),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/v1/jobs`;
  const send = (drawerAuthorizationToken) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jobType: 'drawer-open', drawerAuthorizationToken }),
  });

  try {
    assert.equal((await send('')).status, 403);
    assert.equal((await send('expired')).status, 410);
    assert.equal((await send('one-time-token')).status, 200);
    assert.equal((await send('one-time-token')).status, 409);
    assert.equal(transmitted, 1);
    assert.deepEqual(outcomes, [{ authorizationId: 'drawer-authorization-1', outcome: 'opened' }]);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('local drawer failures record a failed outcome after consuming authorization', async () => {
  const outcomes = [];
  const app = createLocalServer({
    ledger: {},
    credentialStore: { load: () => ({ accessToken: 'installed-agent-token' }) },
    discoverPrinters: () => [],
    savePrinters: () => {},
    transmitDirect: async () => { throw new Error('Printer unavailable.'); },
    onPair: async () => ({}),
    authorizeDrawer: async () => ({ authorizationId: 'drawer-authorization-2' }),
    recordDrawerOutcome: async (authorizationId, outcome) => outcomes.push({ authorizationId, outcome }),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer installed-agent-token' },
      body: JSON.stringify({ jobType: 'drawer-open', drawerAuthorizationToken: 'authorized-token' }),
    });
    assert.equal(response.status, 502);
    assert.deepEqual(outcomes, [{ authorizationId: 'drawer-authorization-2', outcome: 'failed' }]);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
