const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { renderThermal, drawerCommand, payloadHash } = require('../../src/escpos');
const { PrintLedger } = require('../../src/ledger');
const { CredentialStore, dpapiProtect, dpapiUnprotect } = require('../../src/credentialStore');
const { shouldSkipAutomaticRetry, transmitJob } = require('../../src/jobProcessor');

test('thermal renderer adds a prominent COPY marker on duplicate output', () => {
  const bytes = renderThermal({
    shopName: 'Kubika Shop',
    lines: [{ description: 'Tea', quantity: 2, total: 500 }],
    total: 500,
  }, { columns: 32, copy: true });
  const text = bytes.toString('binary');
  assert.match(text, /COPY \/ DUPLICATE/);
});

test('drawer command uses configured pin and pulse', () => {
  const bytes = drawerCommand(5, 50, 100);
  assert.deepEqual([...bytes], [0x1b, 0x70, 0x01, 25, 50]);
});

test('SQLite ledger persists transmitted job state and survives reopen', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubika-ledger-'));
  const ledger = new PrintLedger(dir);
  ledger.save({
    jobId: 'job-1',
    status: 'transmitted',
    payloadHash: payloadHash({ total: 100 }),
    printerId: 'printer-1',
    printedAt: new Date().toISOString(),
    attemptCount: 1,
  });
  ledger.markPrinted('job-1');
  const reopened = new PrintLedger(dir);
  assert.equal(reopened.get('job-1')?.status, 'transmitted');
  reopened.close();
  ledger.close();
});

test('completed and uncertain job IDs are refused unless a completed job is explicitly copied', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubika-dedupe-ledger-'));
  const ledger = new PrintLedger(dir);
  const job = { id: 'job-duplicate', jobType: 'receipt', payloadJson: { total: 100 } };
  const printer = { transport: 'unsupported' };
  ledger.save({ jobId: job.id, status: 'transmitted', printedAt: new Date().toISOString() });

  await assert.rejects(transmitJob(job, printer, ledger), { code: 'PRINT_DUPLICATE_REFUSED', status: 409 });

  ledger.save({ jobId: 'job-uncertain', status: 'uncertain' });
  await assert.rejects(
    transmitJob({ ...job, id: 'job-uncertain', copyRequired: true }, printer, ledger),
    { code: 'PRINT_JOB_OUTCOME_UNCERTAIN', status: 409 },
  );
  ledger.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a crash after printer bytes are sent recovers as uncertain and is not retried automatically', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubika-crash-ledger-'));
  let received = Buffer.alloc(0);
  let physicalPrints = 0;
  const printer = net.createServer((socket) => {
    socket.on('data', (chunk) => { received = Buffer.concat([received, chunk]); });
    socket.on('end', () => { physicalPrints += 1; });
  });
  await new Promise((resolve) => printer.listen(0, '127.0.0.1', resolve));
  const port = printer.address().port;
  const childScript = [
    "const { PrintLedger } = require('./src/ledger');",
    "const { transmitJob } = require('./src/jobProcessor');",
    "const ledger = new PrintLedger(process.argv[1]);",
    "transmitJob({ id: 'crash-job', jobType: 'receipt', payloadJson: { shopName: 'Crash Test', lines: [], total: 0 } },",
    "  { transport: 'tcp9100', address: `127.0.0.1:${process.argv[2]}` }, ledger,",
    "  { afterBytesSent: async () => process.exit(73) });",
  ].join('\n');

  try {
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', childScript, dir, String(port)], {
        cwd: path.resolve(__dirname, '../..'),
        stdio: 'ignore',
      });
      child.once('error', reject);
      child.once('close', resolve);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(exitCode, 73);
    assert.ok(received.length > 0);
    assert.equal(physicalPrints, 1);

    const recovered = new PrintLedger(dir);
    const job = recovered.get('crash-job');
    assert.equal(job.status, 'uncertain');
    assert.equal(shouldSkipAutomaticRetry(job), true);
    await assert.rejects(
      transmitJob({
        id: 'crash-job',
        jobType: 'receipt',
        payloadJson: { shopName: 'Crash Test', lines: [], total: 0 },
      }, { transport: 'tcp9100', address: `127.0.0.1:${port}` }, recovered),
      { code: 'PRINT_JOB_OUTCOME_UNCERTAIN', status: 409 },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(physicalPrints, 1);
    recovered.close();
  } finally {
    await new Promise((resolve) => printer.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('machine credential store protects and restores JSON credentials', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubika-creds-'));
  const store = new CredentialStore(dir);
  store.save({ agentId: 'agent-1', accessToken: 'secret-value' });
  assert.equal(store.load().accessToken, 'secret-value');
  store.clear();
});

test('payload hashes are stable for object payloads', () => {
  assert.equal(payloadHash({ a: 1, b: 2 }), payloadHash({ a: 1, b: 2 }));
});
