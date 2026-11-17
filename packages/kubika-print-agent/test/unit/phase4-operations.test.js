const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLocalServer } = require('../../src/localServer');
const { createLogger, readRedactedDiagnostics, redact } = require('../../src/structuredLogger');

test('structured logger writes JSON, redacts secrets, and exports bounded diagnostics', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubika-print-agent-'));
  try {
    const output = { log() {}, info() {}, warn() {}, error() {} };
    const logger = createLogger(dir, output);
    logger.error('failed Authorization: Bearer abc123 and password=secret');
    const diagnostics = readRedactedDiagnostics(logger.logFile);
    assert.equal(diagnostics.logs.length, 1);
    assert.equal(diagnostics.logs[0].level, 'error');
    assert.match(diagnostics.logs[0].message, /\[REDACTED\]/);
    assert.doesNotMatch(JSON.stringify(diagnostics), /abc123|secret/);
    assert.deepEqual(redact({ refreshToken: 'hidden', nested: 'access_token=hidden' }), {
      refreshToken: '[REDACTED]', nested: 'access_token=[REDACTED]',
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('structured logger rotates files at the configured size limit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubika-print-agent-'));
  try {
    const logger = createLogger(dir, { log() {}, info() {}, warn() {}, error() {} });
    for (let i = 0; i < 1300; i += 1) logger.info('x'.repeat(1000));
    assert.ok(fs.existsSync(`${logger.logFile}.1`));
    assert.ok(fs.statSync(logger.logFile).size < 1024 * 1024);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('browser can download diagnostics only through its short-lived local session', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubika-print-agent-'));
  const logger = createLogger(dir, { log() {}, info() {}, warn() {}, error() {} });
  logger.error('password=must-not-leak');
  const app = createLocalServer({
    ledger: { getPendingResults: () => [] },
    credentialStore: { load: () => ({ accessToken: 'installed-agent-token' }) },
    discoverPrinters: () => [],
    diagnosticsPath: logger.logFile,
  });
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const unauthorized = await fetch(`${baseUrl}/v1/diagnostics`);
  assert.equal(unauthorized.status, 401);
  const headers = { Origin: 'https://kubika-ebmf.vercel.app' };
  const sessionResponse = await fetch(`${baseUrl}/v1/browser-session`, { method: 'POST', headers });
  const session = await sessionResponse.json();
  const response = await fetch(`${baseUrl}/v1/diagnostics`, { headers: { ...headers, Authorization: `Bearer ${session.data.token}` } });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.doesNotMatch(JSON.stringify(body), /must-not-leak/);
  assert.match(response.headers.get('content-disposition'), /attachment/);
});
