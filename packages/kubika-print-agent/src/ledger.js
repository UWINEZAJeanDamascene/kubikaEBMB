const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

class PrintLedger {
  constructor(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new Database(path.join(dataDir, 'print-ledger.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        printer_id TEXT,
        payload_hash TEXT,
        lease_token TEXT,
        printed_at TEXT,
        error TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS duplicate_prints (
        job_id TEXT NOT NULL,
        copied_at TEXT NOT NULL,
        PRIMARY KEY (job_id, copied_at)
      );
    `);
    this.upsert = this.db.prepare(`
      INSERT INTO jobs(job_id,status,printer_id,payload_hash,lease_token,printed_at,error,attempt_count,updated_at)
      VALUES(@job_id,@status,@printer_id,@payload_hash,@lease_token,@printed_at,@error,@attempt_count,@updated_at)
      ON CONFLICT(job_id) DO UPDATE SET
        status=excluded.status, printer_id=excluded.printer_id, payload_hash=excluded.payload_hash,
        lease_token=excluded.lease_token, printed_at=excluded.printed_at, error=excluded.error,
        attempt_count=excluded.attempt_count, updated_at=excluded.updated_at
    `);
    this.db.prepare(`
      UPDATE jobs SET status = 'uncertain', updated_at = ?
      WHERE status = 'transmitting'
    `).run(new Date().toISOString());
  }

  get(jobId) {
    return this.db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId);
  }

  save(job) {
    const now = new Date().toISOString();
    this.upsert.run({
      job_id: job.jobId,
      status: job.status,
      printer_id: job.printerId || null,
      payload_hash: job.payloadHash || null,
      lease_token: job.leaseToken || null,
      printed_at: job.printedAt || null,
      error: job.error || null,
      attempt_count: job.attemptCount || 0,
      updated_at: now,
    });
  }

  markUncertain(jobId, reason = 'Unknown after restart') {
    const row = this.get(jobId);
    if (!row) return;
    this.db.prepare(`UPDATE jobs SET status = 'uncertain', error = ?, updated_at = ? WHERE job_id = ?`).run(reason, new Date().toISOString(), jobId);
  }

  markPrinted(jobId) {
    const row = this.get(jobId);
    if (row) {
      this.db.prepare("INSERT OR IGNORE INTO duplicate_prints(job_id,copied_at) VALUES (?,?)").run(jobId, new Date().toISOString());
    }
  }

  close() {
    this.db.close();
  }
}

module.exports = { PrintLedger };
