'use strict';

// These cases mutate append-only evidence and therefore run only against an
// explicitly provided local scratch database with the audit migration applied.
function scratchDatabaseUrl(value) {
  if (!value) return null;
  const parsed = new URL(value);
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  const loopback = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
    || !loopback.has(parsed.hostname)
    || !/(^|_)(test|scratch)$/i.test(dbName)) {
    throw new Error('POS_TEST_DATABASE_URL must point to a local database ending in _test or _scratch.');
  }
  return parsed.toString();
}

const databaseUrl = scratchDatabaseUrl(process.env.POS_TEST_DATABASE_URL);
let prisma;
let disconnectPrisma;
let writePosAuditLog;
let verifyPosAuditIntegrity;
let generateObjectId;

if (databaseUrl) {
  process.env.DATABASE_URL = databaseUrl;
  ({ prisma, disconnectPrisma } = require('../lib/prisma'));
  ({ writePosAuditLog } = require('../services/posAuditService'));
  ({ verifyPosAuditIntegrity } = require('../services/posAuditIntegrityService'));
  ({ generateObjectId } = require('../utils/objectId'));
}

const integrationDescribe = databaseUrl ? describe : describe.skip;

integrationDescribe('POS audit database integrity', () => {
  afterAll(async () => {
    if (disconnectPrisma) await disconnectPrisma();
  });

  test('database rejects update and delete tampering and verifier still accepts the untouched row', async () => {
    const companyId = generateObjectId();
    const event = await writePosAuditLog({ companyId, event: 'SESSION_ENDED', metadata: { testFixture: true } });

    await expect(prisma.posAuditLog.update({
      where: { id: event.id },
      data: { metadata: { testFixture: 'tampered' } },
    })).rejects.toMatchObject({ code: 'P2010' });
    await expect(prisma.posAuditLog.delete({ where: { id: event.id } }))
      .rejects.toMatchObject({ code: 'P2010' });

    const result = await verifyPosAuditIntegrity({
      companyId,
      streamId: `${companyId}:backoffice`,
    });
    expect(result.valid).toBe(true);
    expect(result.checkedRows).toBe(1);
  });

  test('audit-trigger failure aborts the surrounding business transaction', async () => {
    const companyId = generateObjectId();
    const reservationId = generateObjectId();

    await expect(prisma.$transaction(async (tx) => {
      await tx.posIdempotencyRecord.create({ data: {
        id: reservationId,
        companyId,
        scope: 'test:POST:/atomicity-probe',
        idempotencyKey: `audit-fail-${reservationId}`,
        payloadHash: 'a'.repeat(64),
        status: 'PROCESSING',
      } });
      await writePosAuditLog({ companyId, event: 'SESSION_ENDED' }, tx);
      // New rows without chain fields must fail at the database boundary.
      await tx.$executeRawUnsafe(
        'INSERT INTO pos_audit_logs (id, company_id, event, created_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)',
        generateObjectId(), companyId, 'SESSION_ENDED',
      );
    })).rejects.toThrow(/New POS audit rows require a valid hash-chain entry/);

    expect(await prisma.posIdempotencyRecord.findUnique({ where: { id: reservationId } })).toBeNull();
    expect(await prisma.posAuditLog.count({ where: { companyId } })).toBe(0);
  });
});
