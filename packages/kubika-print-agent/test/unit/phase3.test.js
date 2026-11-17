const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');
const { PrintLedger } = require('../../src/ledger');

const root = path.resolve(__dirname, '../..');

test('WinSW service uses LocalSystem and machine data directory', () => {
  const xml = fs.readFileSync(path.join(root, 'service/winsw.xml'), 'utf8');
  assert.match(xml, /<id>KubikaPrintAgent<\/id>/);
  assert.match(xml, /<user>LocalSystem<\/user>/);
  assert.match(xml, /ProgramData%>\\Kubika\\PrintAgent|ProgramData/);
  assert.match(xml, /runtime\\node\.exe|runtime\/node\.exe/);
  assert.match(xml, /<arguments>"%BASE%\\src\\main\.js"<\/arguments>/);
  assert.match(xml, /<env name="KUBIKA_BACKEND_URL" value="https:\/\/kubikapos\.up\.railway\.app"\/>/);
});

test('agent config defaults to hosted API in production and localhost in development', () => {
  const configSource = fs.readFileSync(path.join(root, 'src/config.js'), 'utf8');
  assert.match(configSource, /process\.env\.NODE_ENV === 'production'[\s\S]*?'https:\/\/kubikapos\.up\.railway\.app'[\s\S]*?'http:\/\/127\.0\.0\.1:3000'/);
});

test('installer scripts provide install, uninstall, and setup shortcuts', () => {
  for (const relative of [
    'installer/setup.iss',
    'installer/build.ps1',
    'installer/verify-release.ps1',
    'service/install.ps1',
    'service/uninstall.ps1',
    'service/open-setup.cmd',
  ]) {
    assert.equal(fs.existsSync(path.join(root, relative)), true, relative);
  }
  const install = fs.readFileSync(path.join(root, 'service/install.ps1'), 'utf8');
  assert.match(install, /existing.*Get-Service|Get-Service.*existing/i);
  assert.match(install, /serviceExe stop|serviceExe start/);
});

test('portable package staging includes the service config and lifecycle scripts', () => {
  const build = fs.readFileSync(path.join(root, 'installer/build.ps1'), 'utf8');
  assert.match(build, /service\\winsw\.xml.*staging.*service\.xml/i);
  assert.match(build, /service\\install\.ps1/);
  assert.match(build, /service\\uninstall\.ps1/);
  assert.match(build, /service\\open-setup\.cmd/);
  assert.match(build, /service\\test-printer-visibility\.ps1/);
});

test('Inno installer stops before upgrade, supports per-machine install, and asks whether to keep data', () => {
  const iss = fs.readFileSync(path.join(root, 'installer/setup.iss'), 'utf8');
  const build = fs.readFileSync(path.join(root, 'installer/build.ps1'), 'utf8');
  assert.match(iss, /PrivilegesRequired=admin/);
  assert.match(iss, /ArchitecturesInstallIn64BitMode=x64compatible/);
  assert.match(iss, /Stop-Service -Name ''KubikaPrintAgent''/);
  assert.match(iss, /Keep the paired credentials/);
  assert.match(iss, /not WizardSilent/);
  assert.match(build, /packageSha256/);
  assert.match(build, /signingDecision/);
  assert.match(iss, /open-setup\.cmd/);
  assert.match(iss, /Source: "\.\.\\staging\\\*"/);
});

test('five offline receipt results survive restart and sync acknowledgment without storing receipt bodies', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubika-print-ledger-'));
  const dbPath = path.join(dataDir, 'print-ledger.sqlite');
  const legacyDb = new Database(dbPath);
  legacyDb.exec(`
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY, status TEXT NOT NULL, printer_id TEXT, payload_hash TEXT,
      lease_token TEXT, printed_at TEXT, error TEXT, attempt_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE duplicate_prints (
      job_id TEXT NOT NULL, copied_at TEXT NOT NULL, PRIMARY KEY (job_id, copied_at)
    );
  `);
  legacyDb.close();

  const keys = Array.from({ length: 5 }, (_, index) => `${String(index + 1).repeat(24)}:0:receipt`);
  let ledger = new PrintLedger(dataDir);
  for (const key of keys) {
    ledger.save({
      jobId: key,
      status: 'transmitted',
      companyId: 'b'.repeat(24),
      registerId: 'c'.repeat(24),
      jobType: 'receipt',
      localOnly: true,
      printedAt: new Date().toISOString(),
      attemptCount: 1,
    });
  }
  ledger.close();

  ledger = new PrintLedger(dataDir);
  const pending = ledger.getPendingResults();
  assert.equal(pending.length, 5);
  assert.deepEqual(pending.map((row) => row.job_id), keys);
  assert.ok(pending.every((row) => row.status === 'transmitted'));
  assert.ok(pending.every((row) => row.company_id === 'b'.repeat(24)));
  assert.ok(pending.every((row) => row.register_id === 'c'.repeat(24)));
  assert.ok(pending.every((row) => !Object.prototype.hasOwnProperty.call(row, 'payload_json')));

  for (const key of keys) ledger.markResultSynced(key);
  assert.deepEqual(ledger.getPendingResults(), []);
  ledger.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
