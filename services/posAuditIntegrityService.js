const { createHash } = require('crypto');
const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');

const GENESIS_HASH = '0'.repeat(64);
const VERIFY_BATCH_SIZE = 500;

function canonicalize(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

function sha256Canonical(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value)), 'utf8').digest('hex');
}

function normalizedAuditRow(row) {
  const normalized = {
    id: String(row.id).trim(),
    companyId: String(row.companyId).trim(),
    registerId: row.registerId == null ? null : String(row.registerId).trim(),
    userId: row.userId == null ? null : String(row.userId).trim(),
    event: String(row.event),
    metadata: row.metadata ?? null,
    ip: row.ip ?? null,
    streamId: String(row.streamId),
    streamSequence: BigInt(row.streamSequence).toString(),
    prevHash: String(row.prevHash).trim(),
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : new Date(row.createdAt).toISOString(),
  };
  // Rows written before structured audit fields retain their original hash
  // representation. Version 2 commits action, outcome and entity fields too.
  if (Number(row.hashVersion || row.hash_version || 0) >= 2) {
    normalized.hashVersion = 2;
    normalized.actionId = row.actionId == null ? null : String(row.actionId).trim();
    normalized.correlationId = row.correlationId == null ? null : String(row.correlationId);
    normalized.outcome = row.outcome == null ? null : String(row.outcome);
    normalized.entityType = row.entityType == null ? null : String(row.entityType);
    normalized.entityId = row.entityId == null ? null : String(row.entityId);
  }
  return normalized;
}

function hashAuditRow(row) {
  return sha256Canonical(normalizedAuditRow(row));
}

function normalizedCheckpoint(checkpoint) {
  const date = checkpoint.checkpointDate instanceof Date
    ? checkpoint.checkpointDate.toISOString().slice(0, 10)
    : String(checkpoint.checkpointDate).slice(0, 10);
  return {
    companyId: String(checkpoint.companyId).trim(),
    streamId: String(checkpoint.streamId),
    checkpointDate: date,
    streamSequence: BigInt(checkpoint.streamSequence).toString(),
    auditLogId: String(checkpoint.auditLogId).trim(),
    auditHash: String(checkpoint.auditHash).trim(),
  };
}

function hashCheckpoint(checkpoint) {
  return sha256Canonical(normalizedCheckpoint(checkpoint));
}

function streamIdFor({ companyId, registerId }) {
  const company = String(companyId || '').trim();
  if (!company) throw new Error('A company is required to write a POS audit event.');
  const register = registerId == null ? '' : String(registerId).trim();
  return register ? `${company}:register:${register}` : `${company}:backoffice`;
}

async function acquireStreamLock(client, streamId) {
  // The 32-bit advisory key can cause harmless lock contention on collisions;
  // the database uniqueness constraint still prevents sequence duplication.
  // Prisma cannot deserialize PostgreSQL's `void` result without a cast.
  await client.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${streamId}))::text AS "locked"`;
}

async function verifyStream({ companyId, streamId, client }) {
  let expectedSequence = 1n;
  let expectedPreviousHash = GENESIS_HASH;
  let checkedRows = 0;
  let firstBreak = null;
  const checkpoints = await client.posAuditCheckpoint.findMany({
    where: { companyId, streamId },
    orderBy: { checkpointDate: 'asc' },
  });
  const checkpointsBySequence = new Map(checkpoints.map((checkpoint) => [
    BigInt(checkpoint.streamSequence).toString(), checkpoint,
  ]));
  const verifiedCheckpointIds = new Set();

  while (true) {
    const rows = await client.posAuditLog.findMany({
      where: { companyId, streamId, streamSequence: { gte: expectedSequence } },
      orderBy: { streamSequence: 'asc' },
      take: VERIFY_BATCH_SIZE,
    });
    if (!rows.length) break;

    for (const row of rows) {
      const sequence = BigInt(row.streamSequence);
      if (sequence !== expectedSequence) {
        firstBreak = { reason: 'SEQUENCE_GAP', auditLogId: row.id, expectedSequence: expectedSequence.toString(), actualSequence: sequence.toString() };
        break;
      }
      if (String(row.prevHash || '').trim() !== expectedPreviousHash) {
        firstBreak = { reason: 'PREVIOUS_HASH_MISMATCH', auditLogId: row.id, sequence: sequence.toString() };
        break;
      }
      const calculatedHash = hashAuditRow(row);
      if (String(row.hash || '').trim() !== calculatedHash) {
        firstBreak = { reason: 'ROW_HASH_MISMATCH', auditLogId: row.id, sequence: sequence.toString() };
        break;
      }
      const checkpoint = checkpointsBySequence.get(sequence.toString());
      if (checkpoint) {
        if (hashCheckpoint(checkpoint) !== String(checkpoint.checkpointHash).trim()) {
          firstBreak = { reason: 'CHECKPOINT_HASH_MISMATCH', checkpointId: checkpoint.id };
          break;
        }
        if (String(checkpoint.auditLogId).trim() !== String(row.id).trim()
          || String(checkpoint.auditHash).trim() !== calculatedHash) {
          firstBreak = { reason: 'CHECKPOINT_REFERENCE_MISMATCH', checkpointId: checkpoint.id };
          break;
        }
        verifiedCheckpointIds.add(String(checkpoint.id));
      }
      checkedRows += 1;
      expectedSequence += 1n;
      expectedPreviousHash = calculatedHash;
    }
    if (firstBreak || rows.length < VERIFY_BATCH_SIZE) break;
  }

  if (!firstBreak && verifiedCheckpointIds.size !== checkpoints.length) {
    const missing = checkpoints.find((checkpoint) => !verifiedCheckpointIds.has(String(checkpoint.id)));
    firstBreak = { reason: 'CHECKPOINT_REFERENCE_MISMATCH', checkpointId: missing?.id || null };
  }

  return {
    streamId,
    valid: firstBreak == null,
    checkedRows,
    verifiedCheckpoints: verifiedCheckpointIds.size,
    firstBreak,
    lastVerifiedSequence: (expectedSequence - 1n).toString(),
    lastVerifiedHash: expectedPreviousHash,
  };
}

/** Verify hashed audit rows and checkpoints for one company or one stream. */
async function verifyPosAuditIntegrity({ companyId, streamId = null, client = prisma }) {
  const tenantId = String(companyId || '').trim();
  if (!tenantId) throw new Error('A company is required to verify POS audit integrity.');

  const streams = streamId
    ? [String(streamId)]
    : (await client.posAuditLog.findMany({
      where: { companyId: tenantId, streamId: { not: null } },
      distinct: ['streamId'],
      select: { streamId: true },
      orderBy: { streamId: 'asc' },
    })).map((row) => row.streamId).filter(Boolean);

  const [legacyRows, results] = await Promise.all([
    client.posAuditLog.count({ where: { companyId: tenantId, hash: null } }),
    Promise.all(streams.map((id) => verifyStream({ companyId: tenantId, streamId: id, client }))),
  ]);
  return {
    companyId: tenantId,
    valid: results.every((result) => result.valid),
    verifiedStreams: results.length,
    checkedRows: results.reduce((sum, result) => sum + result.checkedRows, 0),
    verifiedCheckpoints: results.reduce((sum, result) => sum + result.verifiedCheckpoints, 0),
    legacyUnverifiedRows: legacyRows,
    legacyCoverageNote: legacyRows ? 'Rows written before the hash-chain cutover are retained but cannot be verified.' : null,
    streams: results,
  };
}

/** Create an immutable daily checkpoint for each stream active before UTC day end. */
async function createDailyPosAuditCheckpoints({ companyId, checkpointDate, client = prisma }) {
  const tenantId = String(companyId || '').trim();
  if (!tenantId) throw new Error('A company is required to create POS audit checkpoints.');
  const date = checkpointDate instanceof Date ? checkpointDate : new Date(`${checkpointDate}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw new Error('A valid UTC checkpoint date is required.');
  const checkpointDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const endExclusive = new Date(checkpointDay.getTime() + 24 * 60 * 60 * 1000);

  const run = async (tx) => {
    const activeStreams = await tx.posAuditLog.findMany({
      where: { companyId: tenantId, streamId: { not: null }, hash: { not: null }, createdAt: { lt: endExclusive } },
      distinct: ['streamId'],
      select: { streamId: true },
      orderBy: { streamId: 'asc' },
    });
    const created = [];
    const skipped = [];

    for (const { streamId } of activeStreams) {
      await acquireStreamLock(tx, streamId);
      const existing = await tx.posAuditCheckpoint.findUnique({
        where: { companyId_streamId_checkpointDate: { companyId: tenantId, streamId, checkpointDate: checkpointDay } },
      });
      if (existing) {
        skipped.push(streamId);
        continue;
      }
      const last = await tx.posAuditLog.findFirst({
        where: { companyId: tenantId, streamId, hash: { not: null }, createdAt: { lt: endExclusive } },
        orderBy: { streamSequence: 'desc' },
      });
      if (!last) continue;

      const values = {
        companyId: tenantId,
        streamId,
        checkpointDate: checkpointDay,
        streamSequence: BigInt(last.streamSequence),
        auditLogId: String(last.id).trim(),
        auditHash: String(last.hash).trim(),
      };
      const checkpointHash = hashCheckpoint(values);
      const checkpoint = await tx.posAuditCheckpoint.create({
        data: { id: generateObjectId(), ...values, checkpointHash },
      });
      created.push(checkpoint);
    }
    return { companyId: tenantId, checkpointDate: checkpointDay.toISOString().slice(0, 10), created, skipped };
  };

  return client === prisma ? prisma.$transaction(run) : run(client);
}

module.exports = {
  GENESIS_HASH,
  canonicalize,
  hashAuditRow,
  hashCheckpoint,
  streamIdFor,
  verifyPosAuditIntegrity,
  createDailyPosAuditCheckpoints,
};
