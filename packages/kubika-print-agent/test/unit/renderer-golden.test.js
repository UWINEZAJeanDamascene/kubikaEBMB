const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { PrintLedger } = require('../../src/ledger');
const { transmitJob } = require('../../src/jobProcessor');
const { columnsList, sampleJob, thermalJobTypes } = require('../fixtures/thermalDocuments.cjs');

test('agent transmission matches checked-in receipt goldens for every thermal type and column profile', async () => {
  const fixtureDirectory = path.join(__dirname, '..', 'fixtures', 'receipt-goldens');
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kubika-receipt-goldens-'));
  const ledger = new PrintLedger(tempDirectory);
  const received = [];
  const server = net.createServer((socket) => {
    const chunks = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => received.push(Buffer.concat(chunks)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = `127.0.0.1:${server.address().port}`;

  try {
    let index = 1;
    for (const columns of columnsList) {
      for (const jobType of thermalJobTypes) {
        const job = sampleJob(jobType, columns, index++);
        await transmitJob(job, { transport: 'tcp9100', address, columns, codePage: 19 }, ledger);
        const fixture = fs.readFileSync(path.join(fixtureDirectory, `${jobType}-${columns}.bin`));
        assert.deepEqual(received.at(-1), fixture, `${jobType} output at ${columns} columns must match its byte golden`);
      }
    }
  } finally {
    ledger.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
});
