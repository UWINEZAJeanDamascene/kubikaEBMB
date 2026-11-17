const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { drawerCommand, payloadHash } = require('../../src/escpos');
const { renderReceiptEscPos, renderThermalDocument } = require('../../../kubika-receipt-renderer/index.cjs');
const { PrintLedger } = require('../../src/ledger');
const { CredentialStore, dpapiProtect, dpapiUnprotect } = require('../../src/credentialStore');
const { shouldSkipAutomaticRetry, transmitJob } = require('../../src/jobProcessor');

test('shared thermal renderer adds a prominent COPY marker on duplicate output', () => {
  const bytes = renderThermalDocument({
    shopName: 'Kubika Shop',
    lines: [{ description: 'Tea', quantity: 2, total: 500 }],
    total: 500,
    copyRequired: true,
  }, { columns: 32, jobType: 'receipt' });
  const text = Buffer.from(bytes).toString('binary');
  assert.match(text, /COPY/);
});

test('drawer command uses configured pin and pulse', () => {
  const bytes = drawerCommand(5, 50, 100);
  assert.deepEqual([...bytes], [0x1b, 0x70, 0x01, 25, 50]);
});

test('A4 printing downloads the signed document and uses the selected printer and copy count', async () => {
  const previousFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return {
      ok: true,
      status: 200,
      headers: {
        get: (name) => name.toLowerCase() === 'content-type' ? 'application/pdf' : '12',
      },
      arrayBuffer: async () => Uint8Array.from(Buffer.from('%PDF-test')).buffer,
    };
  };
  const ledger = {
    get: () => null,
    save: () => {},
    markPrinted: () => {},
  };
  const printed = [];
  try {
    await transmitJob({
      id: 'a4-job-1',
      jobType: 'invoice-pdf',
      payloadJson: {
        signedUrl: 'https://pos.example.test/api/pos/print-agent/documents/aaaaaaaaaaaaaaaaaaaaaaaa?expires=9999999999&signature=' + 'a'.repeat(64),
        copies: 3,
        tray: 'Tray 2',
        duplex: true,
      },
    }, {
      name: 'Selected A4 printer',
      address: 'Selected A4 printer',
      transport: 'windows-spooler',
    }, ledger, {
      backendUrl: 'https://pos.example.test',
      printPdf: async (...args) => { printed.push(args); },
    });
  } finally {
    global.fetch = previousFetch;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.startsWith('https://pos.example.test/api/pos/print-agent/documents/'), true);
  assert.deepEqual(printed, [[
    'Selected A4 printer',
    Buffer.from('%PDF-test'),
    3,
    { tray: 'Tray 2', duplex: true },
  ]]);
});

test('A4 printing rejects signed-document URLs from another origin', async () => {
  const ledger = {
    get: () => null,
    save: () => {},
    markPrinted: () => {},
  };
  let downloaded = false;
  await assert.rejects(transmitJob({
    id: 'a4-job-foreign-origin',
    jobType: 'invoice-pdf',
    payloadJson: { signedUrl: 'https://attacker.example/file.pdf', copies: 1 },
  }, {
    name: 'Selected A4 printer',
    address: 'Selected A4 printer',
    transport: 'windows-spooler',
  }, ledger, {
    backendUrl: 'https://pos.example.test',
    printPdf: async () => {},
  }).then(() => { downloaded = true; }), {
    code: 'PRINT_DOCUMENT_URL_INVALID',
  });
  assert.equal(downloaded, false);
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

test('completed and uncertain job identities cannot be automatically transmitted twice', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubika-dedupe-ledger-'));
  const ledger = new PrintLedger(dir);
  const job = { id: 'job-duplicate', jobType: 'test-print', payloadJson: { total: 100 } };
  const printer = { transport: 'unsupported' };
  ledger.save({ jobId: job.id, status: 'transmitted', printedAt: new Date().toISOString() });

  await assert.rejects(transmitJob(job, printer, ledger), { code: 'PRINT_DUPLICATE_REFUSED', status: 409 });
  await assert.rejects(
    transmitJob({ ...job, copyRequired: true }, printer, ledger),
    { code: 'PRINT_DUPLICATE_REFUSED', status: 409 },
  );

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
    "transmitJob({ id: 'crash-job', jobType: 'test-print', payloadJson: { shopName: 'Crash Test', lines: [], total: 0 } },",
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
        jobType: 'test-print',
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

test('receipt jobs reject keys whose copy number differs from the canonical receipt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubika-copy-key-ledger-'));
  const ledger = new PrintLedger(dir);
  const sourceDocumentId = '507f1f77bcf86cd799439011';
  const receipt = {
    version: 1,
    flags: { isCopy: true, copyNumber: 1, receiptType: 'SALE' },
  };

  await assert.rejects(
    transmitJob({
      id: `${sourceDocumentId}:0:receipt`,
      jobType: 'receipt',
      payloadJson: { receipt },
    }, { transport: 'unsupported' }, ledger),
    { code: 'PRINT_JOB_COPY_KEY_MISMATCH', status: 400 },
  );
  assert.equal(ledger.get(`${sourceDocumentId}:0:receipt`), undefined);
  ledger.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a repeated server job with a new row ID still uses the receipt idempotency key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubika-idempotency-key-ledger-'));
  const ledger = new PrintLedger(dir);
  const sourceDocumentId = '507f1f77bcf86cd799439011';
  const idempotencyKey = `${sourceDocumentId}:0:receipt`;
  ledger.save({ jobId: idempotencyKey, status: 'transmitted' });

  await assert.rejects(
    transmitJob({
      id: '607f1f77bcf86cd799439011',
      idempotencyKey,
      jobType: 'receipt',
      payloadJson: {
        receipt: {
          version: 1,
          flags: { isCopy: false, copyNumber: 0, receiptType: 'SALE' },
        },
      },
    }, { transport: 'unsupported' }, ledger),
    { code: 'PRINT_DUPLICATE_REFUSED', status: 409 },
  );
  ledger.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('agent test-page jobs emit the shared renderer bytes with calibrated accents and columns', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubika-renderer-parity-ledger-'));
  let received = Buffer.alloc(0);
  const printer = net.createServer((socket) => {
    socket.on('data', (chunk) => { received = Buffer.concat([received, chunk]); });
  });
  await new Promise((resolve) => printer.listen(0, '127.0.0.1', resolve));
  const port = printer.address().port;
  const receipt = {
    version: 1,
    business: { name: 'Calibration Test' },
    receipt: { number: 'PRINTER TEST ONLY' },
    lines: [
      { name: `${'0123456789'.repeat(6)}0123`, quantity: 1, unitPriceRwf: 0, totalRwf: 0 },
      { name: 'Mélanie Crème', quantity: 1, unitPriceRwf: 0, totalRwf: 0 },
    ],
    totals: { currency: 'RWF', subtotalRwf: 0, taxTotalRwf: 0, grandTotalRwf: 0 },
    flags: { isCopy: false, copyNumber: 0, receiptType: 'SALE' },
  };
  const payload = { version: 1, receipt, paperWidthMm: 80, columns: 48, codeTable: 19 };
  const expected = renderReceiptEscPos(receipt, { columns: 48, codeTable: 19, qrMode: 'none' });
  const ledger = new PrintLedger(dir);

  try {
    await transmitJob(
      { id: 'calibration-test', jobType: 'test-print', payloadJson: payload },
      { transport: 'tcp9100', address: `127.0.0.1:${port}` },
      ledger,
    );
    assert.deepEqual(received, Buffer.from(expected));
  } finally {
    ledger.close();
    await new Promise((resolve) => printer.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agent output matches shared browser ESC/POS bytes for every thermal document and calibrated width', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubika-all-docs-ledger-'));
  const received = [];
  const printer = net.createServer((socket) => {
    const chunks = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => received.push(Buffer.concat(chunks)));
  });
  await new Promise((resolve) => printer.listen(0, '127.0.0.1', resolve));
  const port = printer.address().port;
  const ledger = new PrintLedger(dir);
  const columnsList = [32, 42, 48];
  const jobTypes = ['receipt', 'refund-receipt', 'gift-card-slip', 'x-report', 'z-report', 'cash-movement-slip', 'test-print'];
  const expected = [];

  try {
    let documentNumber = 1;
    for (const columns of columnsList) {
      for (const jobType of jobTypes) {
        const documentId = documentNumber.toString(16).padStart(24, '0');
        const canonical = ['receipt', 'refund-receipt'].includes(jobType)
          ? {
            version: 1,
            business: { name: 'Kubika Shop' },
            receipt: { number: `PARITY-${documentNumber}` },
            lines: [{ name: 'Mélanie Crème', quantity: 1, unitPriceRwf: 1200, totalRwf: 1200 }],
            totals: { currency: 'RWF', subtotalRwf: 1200, taxTotalRwf: 0, grandTotalRwf: 1200 },
            flags: { isCopy: false, copyNumber: 0, receiptType: jobType === 'refund-receipt' ? 'REFUND' : 'SALE' },
          }
          : null;
        const payload = canonical
          ? { receipt: canonical, paperWidthMm: columns === 32 ? 58 : 80, columns, codeTable: 19 }
          : {
            jobType,
            paperWidthMm: columns === 32 ? 58 : 80,
            columns,
            codeTable: 19,
            shopName: 'Kubika Shop',
            title: 'Mélanie Crème',
            lines: [{ name: 'Mélanie Crème', quantity: 1, total: '1200 RWF' }],
            total: '1200 RWF',
            giftCard: { code: '1234567890', value: 1200 },
          };
        const job = {
          id: documentId,
          idempotencyKey: canonical ? `${documentId}:0:${jobType}` : `parity-${jobType}-${columns}`,
          jobType,
          payloadJson: payload,
        };
        const printerConfig = { transport: 'tcp9100', address: `127.0.0.1:${port}`, columns, codePage: 19 };
        expected.push(canonical
          ? Buffer.from(renderReceiptEscPos(canonical, { columns, codeTable: 19, qrMode: 'none', cut: true }))
          : Buffer.from(renderThermalDocument(payload, { columns, codeTable: 19, jobType, qrMode: 'none', cut: true })));

        await transmitJob(job, printerConfig, ledger);
        documentNumber += 1;
      }
    }

    assert.equal(received.length, expected.length);
    for (let index = 0; index < expected.length; index += 1) {
      assert.deepEqual(received[index], expected[index], `document output ${index + 1} must match the shared renderer`);
    }
  } finally {
    ledger.close();
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
