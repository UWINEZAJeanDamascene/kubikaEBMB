const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { createLocalServer } = require('../../src/localServer');

const { renderThermal, drawerCommand } = require('../../src/escpos');
const { printTcp9100 } = require('../../src/transports');

test('TCP 9100 simulator receives exact ESC/POS receipt bytes', async () => {
  const bytes = renderThermal({
    shopName: 'Kubika Test Shop',
    receiptNumber: 'R-1001',
    lines: [{ description: 'Coffee', quantity: 2, total: 5 }],
    total: 5,
    paperWidthMm: 58,
  });
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
  assert.deepEqual(received, bytes);
  assert.equal(received.includes(Buffer.from('COPY / DUPLICATE')), false);
  assert.ok(received.length > 100);
  fs.unlinkSync(capturePath);
});

test('drawer pulse and 80 mm thermal rendering are emitted as ESC/POS bytes', () => {
  const pulse = drawerCommand(5, 25, 500);
  assert.deepEqual([...pulse], [0x1b, 0x70, 0x01, 13, 250]);

  const receipt = renderThermal({
    shopName: 'Kubika',
    lines: [{ description: 'Item', quantity: 1, total: 100 }],
    total: 100,
    paperWidthMm: 80,
  });
  assert.ok(receipt.includes(Buffer.from('Kubika')));
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
    rateLimitOptions: { limit: 2, windowMs: 60000 },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/v1/status`;

  try {
    const forbiddenOrigin = await fetch(url, { headers: { Origin: 'https://attacker.example' } });
    assert.equal(forbiddenOrigin.status, 403);

    const missingToken = await fetch(url);
    assert.equal(missingToken.status, 401);

    const first = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const second = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const limited = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(limited.status, 429);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('local drawer kicks require a valid one-time server authorization', async () => {
  const token = 'installed-agent-token';
  const consumed = new Set();
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
      return { authorized: true };
    },
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
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
