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
        company_id TEXT,
        register_id TEXT,
        job_type TEXT,
        local_only INTEGER NOT NULL DEFAULT 0,
        payload_hash TEXT,
        lease_token TEXT,
        printed_at TEXT,
        error TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        result_synced_at TEXT
      );
      CREATE TABLE IF NOT EXISTS duplicate_prints (
        job_id TEXT NOT NULL,
        copied_at TEXT NOT NULL,
        PRIMARY KEY (job_id, copied_at)
      );
    `);
    const columns = new Set(this.db.prepare('PRAGMA table_info(jobs)').all().map((column) => column.name));
    for (const [name, definition] of [
      ['company_id', 'TEXT'],
      ['register_id', 'TEXT'],
      ['job_type', 'TEXT'],
      ['local_only', 'INTEGER NOT NULL DEFAULT 0'],
      ['result_synced_at', 'TEXT'],
    ]) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${definition}`);
    }
    this.upsert = this.db.prepare(`
      INSERT INTO jobs(job_id,status,printer_id,company_id,register_id,job_type,local_only,payload_hash,lease_token,printed_at,error,attempt_count,updated_at)
      VALUES(@job_id,@status,@printer_id,@company_id,@register_id,@job_type,@local_only,@payload_hash,@lease_token,@printed_at,@error,@attempt_count,@updated_at)
      ON CONFLICT(job_id) DO UPDATE SET
        status=excluded.status, printer_id=excluded.printer_id, payload_hash=excluded.payload_hash,
        company_id=COALESCE(excluded.company_id,jobs.company_id),
        register_id=COALESCE(excluded.register_id,jobs.register_id),
        job_type=COALESCE(excluded.job_type,jobs.job_type),
        local_only=MAX(excluded.local_only,jobs.local_only),
        lease_token=excluded.lease_token, printed_at=excluded.printed_at, error=excluded.error,
        attempt_count=excluded.attempt_count, updated_at=excluded.updated_at
    `);
    this.pendingResults = this.db.prepare(`
      SELECT job_id, company_id, register_id, job_type, status, error, printed_at, updated_at
      FROM jobs
      WHERE result_synced_at IS NULL
        AND local_only = 1
        AND company_id IS NOT NULL AND register_id IS NOT NULL
        AND job_type IN ('receipt','refund-receipt')
        AND status IN ('transmitted','uncertain','failed')
      ORDER BY updated_at ASC
      LIMIT ?
    `);
    this.markSyncedStatement = this.db.prepare(`
      UPDATE jobs SET result_synced_at = ? WHERE job_id = ? AND result_synced_at IS NULL
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
      company_id: job.companyId || null,
      register_id: job.registerId || null,
      job_type: job.jobType || null,
      local_only: job.localOnly ? 1 : 0,
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

  getPendingResults(limit = 100) {
    return this.pendingResults.all(Math.max(1, Math.min(100, Number(limit) || 100)));
  }

  markResultSynced(jobId) {
    this.markSyncedStatement.run(new Date().toISOString(), jobId);
  }

  close() {
    this.db.close();
  }
}

module.exports = { PrintLedger };
