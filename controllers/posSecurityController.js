const { prisma } = require('../lib/prisma');
const { verifyPosAuditIntegrity } = require('../services/posAuditIntegrityService');
const { requestIp, writePosAuditLog } = require('../services/posAuditService');
const { generateObjectId } = require('../utils/objectId');

const DEFAULTS = Object.freeze({
  duplicateAttemptWindowMinutes: 15,
  duplicateAttemptThreshold: 5,
  riskReportLookbackDays: 30,
  pinFailureLimit: 5,
  pinLockoutMinutes: 5,
  idleLockMinutes: 5,
  singleRegisterSession: true,
});
const MAX_REPORT_ROWS = 5000;
const SECURITY_EVENTS = ['PIN_LOGIN_FAILED', 'PIN_LOCKOUT', 'POS_ACTION_DENIED', 'POS_ACTION_FAILED', 'POS_DUPLICATE_REQUEST_ATTEMPT'];

function companyIdFrom(req) {
  const id = req.company?.id || req.company?._id || req.user?.company?.id || req.user?.companyId;
  return id == null ? null : String(id).trim();
}

function readSettings(raw, systemSettings = {}) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    duplicateAttemptWindowMinutes: boundedInt(value.duplicateAttemptWindowMinutes, DEFAULTS.duplicateAttemptWindowMinutes, 1, 1440),
    duplicateAttemptThreshold: boundedInt(value.duplicateAttemptThreshold, DEFAULTS.duplicateAttemptThreshold, 2, 100),
    riskReportLookbackDays: boundedInt(value.riskReportLookbackDays, DEFAULTS.riskReportLookbackDays, 1, 90),
    pinFailureLimit: boundedInt(value.pinFailureLimit, DEFAULTS.pinFailureLimit, 3, 20),
    pinLockoutMinutes: boundedInt(value.pinLockoutMinutes, DEFAULTS.pinLockoutMinutes, 1, 60),
    idleLockMinutes: boundedInt(systemSettings.posIdleLockMinutes, DEFAULTS.idleLockMinutes, 1, 60),
    singleRegisterSession: systemSettings.posSingleRegisterSession !== false,
  };
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function sendError(res, status, code, message) {
  return res.status(status).json({ success: false, code, message });
}

async function getCompanySettings(companyId) {
  const row = await prisma.systemSettings.findUnique({
    where: { companyId },
    select: { posSecuritySettings: true, posIdleLockMinutes: true, posSingleRegisterSession: true },
  });
  return { row, settings: readSettings(row?.posSecuritySettings, row || {}) };
}

exports.getSettings = async (req, res) => {
  const companyId = companyIdFrom(req);
  if (!companyId) return sendError(res, 400, 'COMPANY_REQUIRED', 'A company workspace is required.');
  try {
    const { settings } = await getCompanySettings(companyId);
    return res.json({ success: true, data: settings });
  } catch (error) {
    console.error('POS security settings read failed:', error);
    return sendError(res, 500, 'POS_SECURITY_SETTINGS_UNAVAILABLE', 'Security settings could not be loaded.');
  }
};

exports.updateSettings = async (req, res) => {
  const companyId = companyIdFrom(req);
  if (!companyId) return sendError(res, 400, 'COMPANY_REQUIRED', 'A company workspace is required.');
  const body = req.body || {};
  const expected = ['duplicateAttemptWindowMinutes', 'duplicateAttemptThreshold', 'riskReportLookbackDays', 'pinFailureLimit', 'pinLockoutMinutes', 'idleLockMinutes'];
  if (expected.some((key) => !Number.isInteger(Number(body[key]))) || typeof body.singleRegisterSession !== 'boolean') {
    return sendError(res, 422, 'INVALID_SECURITY_SETTINGS', 'Enter valid whole numbers and choose a session policy.');
  }
  const settings = readSettings(body, {
    posIdleLockMinutes: body.idleLockMinutes,
    posSingleRegisterSession: body.singleRegisterSession,
  });
  if (Object.keys(settings).some((key) => key === 'singleRegisterSession'
    ? settings[key] !== body[key]
    : settings[key] !== Number(body[key]))) {
    return sendError(res, 422, 'INVALID_SECURITY_SETTINGS', 'One or more settings are outside the allowed range.');
  }
  const userId = req.user?.id || req.user?._id || null;
  try {
    const before = await getCompanySettings(companyId);
    await prisma.$transaction(async (tx) => {
      await tx.systemSettings.upsert({
        where: { companyId },
        create: {
          id: generateObjectId(), companyId,
          posSecuritySettings: {
            duplicateAttemptWindowMinutes: settings.duplicateAttemptWindowMinutes,
            duplicateAttemptThreshold: settings.duplicateAttemptThreshold,
            riskReportLookbackDays: settings.riskReportLookbackDays,
            pinFailureLimit: settings.pinFailureLimit,
            pinLockoutMinutes: settings.pinLockoutMinutes,
          },
          posIdleLockMinutes: settings.idleLockMinutes,
          posSingleRegisterSession: settings.singleRegisterSession,
        },
        update: {
          posSecuritySettings: {
            duplicateAttemptWindowMinutes: settings.duplicateAttemptWindowMinutes,
            duplicateAttemptThreshold: settings.duplicateAttemptThreshold,
            riskReportLookbackDays: settings.riskReportLookbackDays,
            pinFailureLimit: settings.pinFailureLimit,
            pinLockoutMinutes: settings.pinLockoutMinutes,
          },
          posIdleLockMinutes: settings.idleLockMinutes,
          posSingleRegisterSession: settings.singleRegisterSession,
        },
      });
      await writePosAuditLog({
        companyId, userId, event: 'POS_SECURITY_SETTINGS_UPDATED',
        metadata: { before: before.settings, after: settings }, ip: requestIp(req),
      }, tx);
    });
    return res.json({ success: true, data: settings });
  } catch (error) {
    console.error('POS security settings update failed:', error);
    return sendError(res, 500, 'POS_SECURITY_SETTINGS_SAVE_FAILED', 'Security settings could not be saved.');
  }
};

exports.activeSessions = async (req, res) => {
  const companyId = companyIdFrom(req);
  if (!companyId) return sendError(res, 400, 'COMPANY_REQUIRED', 'A company workspace is required.');
  try {
    const rows = await prisma.posSession.findMany({
      where: { companyId, status: { in: ['active', 'locked'] } },
      orderBy: { lastActivityAt: 'desc' }, take: 500,
      include: {
        user: { select: { id: true, name: true, email: true } },
        register: { select: { id: true, name: true, code: true, claimedDeviceId: true } },
      },
    });
    return res.json({ success: true, data: rows.map((row) => ({
      id: row.id, status: row.status, startedAt: row.startedAt, lastActivityAt: row.lastActivityAt,
      lockedAt: row.lockedAt, cashier: row.user?.name || row.user?.email || 'Unknown cashier',
      register: row.register?.name || row.register?.code || 'Unknown register',
      device: row.register?.claimedDeviceId ? `Device ${String(row.register.claimedDeviceId).slice(-6)}` : 'Unassigned device',
    })) });
  } catch (error) {
    console.error('POS active sessions read failed:', error);
    return sendError(res, 500, 'POS_SESSIONS_UNAVAILABLE', 'Active POS sessions could not be loaded.');
  }
};

exports.revokeSession = async (req, res) => {
  const companyId = companyIdFrom(req);
  const sessionId = String(req.params.sessionId || '').trim();
  if (!companyId) return sendError(res, 400, 'COMPANY_REQUIRED', 'A company workspace is required.');
  if (!/^[a-f\d]{24}$/i.test(sessionId)) return sendError(res, 400, 'POS_SESSION_ID_INVALID', 'Select a valid POS session.');
  const userId = req.user?.id || req.user?._id || null;
  try {
    const outcome = await prisma.$transaction(async (tx) => {
      const session = await tx.posSession.findFirst({
        where: { id: sessionId, companyId, status: { in: ['active', 'locked'] } },
        select: { id: true, registerId: true, userId: true, status: true },
      });
      if (!session) return { missing: true };
      const changed = await tx.posSession.updateMany({
        where: { id: session.id, companyId, status: { in: ['active', 'locked'] } },
        data: { status: 'ended', endedAt: new Date(), endReason: 'REVOKED' },
      });
      if (changed.count !== 1) return { missing: true };
      await writePosAuditLog({
        companyId, registerId: session.registerId, userId,
        event: 'SESSION_ENDED', outcome: 'COMMITTED',
        metadata: { sessionId: session.id, cashierUserId: session.userId, reason: 'MANAGER_REVOKED' },
        ip: requestIp(req),
      }, tx);
      return { revoked: true };
    });
    if (outcome.missing) return sendError(res, 404, 'POS_SESSION_NOT_ACTIVE', 'That POS session is already ended or unavailable.');
    return res.json({ success: true, data: { sessionId, status: 'ended' } });
  } catch (error) {
    console.error('POS session revocation failed:', error);
    return sendError(res, 500, 'POS_SESSION_REVOKE_FAILED', 'The POS session could not be revoked.');
  }
};

exports.verifyAuditIntegrity = async (req, res) => {
  const companyId = companyIdFrom(req);
  if (!companyId) return sendError(res, 400, 'COMPANY_REQUIRED', 'A company workspace is required.');
  try {
    const report = await verifyPosAuditIntegrity({ companyId });
    // Record who ran the check. This new row is after the verified range and
    // does not change the result that was just calculated.
    await writePosAuditLog({
      companyId, userId: req.user?.id || req.user?._id || null,
      event: 'POS_AUDIT_INTEGRITY_VERIFIED',
      metadata: {
        valid: report.valid, verifiedStreams: report.verifiedStreams,
        checkedRows: report.checkedRows, verifiedCheckpoints: report.verifiedCheckpoints,
        legacyUnverifiedRows: report.legacyUnverifiedRows,
      }, ip: requestIp(req),
    });
    const safeReport = {
      valid: report.valid,
      verifiedStreams: report.verifiedStreams,
      checkedRows: report.checkedRows,
      verifiedCheckpoints: report.verifiedCheckpoints,
      legacyUnverifiedRows: report.legacyUnverifiedRows,
      legacyCoverageNote: report.legacyCoverageNote,
      streams: report.streams.map((stream) => ({
        streamLabel: stream.streamId.endsWith(':backoffice') ? 'Back office audit' : 'Register audit',
        valid: stream.valid,
        checkedRows: stream.checkedRows,
        verifiedCheckpoints: stream.verifiedCheckpoints,
        lastVerifiedSequence: stream.lastVerifiedSequence,
        firstBreak: stream.firstBreak ? {
          reason: stream.firstBreak.reason,
          sequence: stream.firstBreak.sequence || null,
          expectedSequence: stream.firstBreak.expectedSequence || null,
          actualSequence: stream.firstBreak.actualSequence || null,
        } : null,
      })),
    };
    return res.json({ success: true, data: safeReport });
  } catch (error) {
    const missingSchema = ['P2021', 'P2022'].includes(error?.code);
    if (!missingSchema) console.error('POS audit integrity verification failed:', error);
    return sendError(res, missingSchema ? 503 : 500,
      missingSchema ? 'POS_AUDIT_INTEGRITY_NOT_READY' : 'POS_AUDIT_INTEGRITY_CHECK_FAILED',
      missingSchema
        ? 'Audit integrity storage is not available in this database yet. Apply the POS audit integrity migration first.'
        : 'Audit integrity could not be verified.');
  }
};

async function getSecurityRows(companyId, from, to) {
  return prisma.posAuditLog.findMany({
    where: { companyId, event: { in: SECURITY_EVENTS }, createdAt: { gte: from, lte: to } },
    orderBy: { createdAt: 'desc' }, take: MAX_REPORT_ROWS,
    select: { event: true, userId: true, registerId: true, createdAt: true, metadata: true },
  });
}

async function labelsFor(rows, companyId) {
  const userIds = [...new Set(rows.map((row) => row.userId).filter(Boolean))];
  const registerIds = [...new Set(rows.map((row) => row.registerId).filter(Boolean))];
  const [users, registers] = await Promise.all([
    userIds.length ? prisma.user.findMany({ where: { id: { in: userIds }, companyId }, select: { id: true, name: true } }) : [],
    registerIds.length ? prisma.posRegister.findMany({ where: { companyId, id: { in: registerIds } }, select: { id: true, name: true, code: true } }) : [],
  ]);
  return {
    users: new Map(users.map((user) => [user.id, user.name || 'Unknown user'])),
    registers: new Map(registers.map((register) => [register.id, register.name || register.code || 'Unknown register'])),
  };
}

function groupAttempts(rows, labels, threshold, windowMs) {
  const failed = rows.filter((row) => row.event === 'PIN_LOGIN_FAILED' || row.event === 'PIN_LOCKOUT');
  const groups = new Map();
  for (const row of failed) {
    const key = `${row.registerId || 'none'}:${row.userId || 'unknown'}`;
    const current = groups.get(key) || {
      key, cashier: labels.users.get(row.userId) || 'Unknown user',
      register: labels.registers.get(row.registerId) || 'Unknown register',
      failedAttempts: 0, lockouts: 0, firstAt: row.createdAt, lastAt: row.createdAt,
      timestamps: [], sampledBuckets: new Map(),
    };
    if (row.event === 'PIN_LOGIN_FAILED') {
      const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
      const bucket = JSON.stringify([
        String(metadata.attemptWindowStartedAt || row.createdAt.toISOString()),
        String(metadata.attemptScope || 'legacy'),
      ]);
      current.sampledBuckets.set(bucket, Math.max(current.sampledBuckets.get(bucket) || 0,
        Number.isSafeInteger(Number(metadata.attemptCountInWindow)) ? Number(metadata.attemptCountInWindow) : 1));
    }
    if (row.event === 'PIN_LOCKOUT') current.lockouts += 1;
    current.timestamps.push(row.createdAt.getTime());
    if (row.createdAt < current.firstAt) current.firstAt = row.createdAt;
    if (row.createdAt > current.lastAt) current.lastAt = row.createdAt;
    groups.set(key, current);
  }
  return [...groups.values()].map(({ timestamps, sampledBuckets, ...row }) => {
    row.failedAttempts = [...sampledBuckets.values()].reduce((sum, count) => sum + count, 0);
    const sorted = timestamps.sort((a, b) => a - b);
    const weighted = [...sampledBuckets.entries()].map(([bucket, count]) => {
      let windowStart = bucket;
      try { windowStart = JSON.parse(bucket)[0]; } catch { /* legacy timestamp key */ }
      return [Date.parse(windowStart), count];
    })
      .filter(([at]) => Number.isFinite(at)).sort((a, b) => a[0] - b[0]);
    let duplicate = false;
    for (let start = 0, end = 0, total = 0; end < weighted.length; end += 1) {
      total += weighted[end][1];
      while (weighted[end][0] - weighted[start][0] > windowMs) {
        total -= weighted[start][1];
        start += 1;
      }
      if (total >= threshold) { duplicate = true; break; }
    }
    if (!weighted.length) {
      for (let start = 0, end = 0; end < sorted.length; end += 1) {
        while (sorted[end] - sorted[start] > windowMs) start += 1;
        if (end - start + 1 >= threshold) { duplicate = true; break; }
      }
    }
    return { ...row, duplicateAttempt: duplicate };
  }).sort((a, b) => b.lastAt.getTime() - a.lastAt.getTime());
}

function sampledEventCounts(rows) {
  const counters = new Map();
  for (const row of rows) {
    const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
    const bucket = metadata.attemptWindowStartedAt;
    if (!bucket || !Number.isSafeInteger(Number(metadata.attemptCountInWindow))) {
      counters.set(`${row.event}:${row.createdAt.toISOString()}:${counters.size}`, 1);
      continue;
    }
    const key = `${row.event}:${row.registerId || 'none'}:${row.userId || 'unknown'}:${bucket}:${metadata.attemptScope || 'unknown'}`;
    counters.set(key, Math.max(counters.get(key) || 0, Number(metadata.attemptCountInWindow)));
  }
  return [...counters.entries()].reduce((result, [key, value]) => {
    const event = key.slice(0, key.indexOf(':'));
    result[event] = (result[event] || 0) + value;
    return result;
  }, {});
}

function groupDuplicateRequests(rows, labels) {
  const groups = new Map();
  for (const row of rows.filter((item) => item.event === 'POS_DUPLICATE_REQUEST_ATTEMPT')) {
    const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
    const scope = String(metadata.scope || 'Unknown POS action');
    const key = `${row.registerId || 'none'}:${row.userId || 'unknown'}:${scope}`;
    const current = groups.get(key) || {
      cashier: labels.users.get(row.userId) || 'Unknown user',
      register: labels.registers.get(row.registerId) || 'Unknown register',
      action: scope, attempts: 0, payloadMismatchCount: 0,
      firstAt: row.createdAt, lastAt: row.createdAt,
    };
    current.attempts += 1;
    if (metadata.payloadMatched === false) current.payloadMismatchCount += 1;
    if (row.createdAt < current.firstAt) current.firstAt = row.createdAt;
    if (row.createdAt > current.lastAt) current.lastAt = row.createdAt;
    groups.set(key, current);
  }
  return [...groups.values()].sort((a, b) => b.lastAt.getTime() - a.lastAt.getTime());
}

function reportRange(query, defaultDays) {
  const days = boundedInt(query.days, defaultDays, 1, 90);
  const to = query.to && !Number.isNaN(Date.parse(query.to)) ? new Date(query.to) : new Date();
  const from = query.from && !Number.isNaN(Date.parse(query.from))
    ? new Date(query.from) : new Date(to.getTime() - days * 86400000);
  return { from, to, days };
}

exports.duplicateAttempts = async (req, res) => {
  const companyId = companyIdFrom(req);
  if (!companyId) return sendError(res, 400, 'COMPANY_REQUIRED', 'A company workspace is required.');
  try {
    const { settings } = await getCompanySettings(companyId);
    const range = reportRange(req.query, settings.riskReportLookbackDays);
    const rows = await getSecurityRows(companyId, range.from, range.to);
    const labels = await labelsFor(rows, companyId);
    const attempts = groupAttempts(rows, labels, settings.duplicateAttemptThreshold, settings.duplicateAttemptWindowMinutes * 60000);
    const duplicateRequests = groupDuplicateRequests(rows, labels);
    return res.json({ success: true, data: {
      range: { from: range.from, to: range.to }, threshold: settings.duplicateAttemptThreshold,
      windowMinutes: settings.duplicateAttemptWindowMinutes,
      attempts: attempts.filter((row) => row.duplicateAttempt || row.lockouts > 0 || row.failedAttempts > 0),
      duplicateRequests,
    } });
  } catch (error) {
    console.error('POS duplicate attempt report failed:', error);
    return sendError(res, 500, 'POS_DUPLICATE_ATTEMPTS_UNAVAILABLE', 'Duplicate attempt data could not be loaded.');
  }
};

exports.riskReport = async (req, res) => {
  const companyId = companyIdFrom(req);
  if (!companyId) return sendError(res, 400, 'COMPANY_REQUIRED', 'A company workspace is required.');
  try {
    const { settings } = await getCompanySettings(companyId);
    const range = reportRange(req.query, settings.riskReportLookbackDays);
    const [rows, pendingApprovals, openSyncExceptions, idempotencyReview] = await Promise.all([
      getSecurityRows(companyId, range.from, range.to),
      prisma.posApprovalRequest.count({ where: { companyId, status: 'PENDING', expiresAt: { gt: new Date() } } }),
      prisma.posSyncException.count({ where: { companyId, status: { in: ['open', 'retry_authorized'] } } }),
      prisma.posIdempotencyRecord.count({ where: { companyId, status: 'NEEDS_REVIEW' } }),
    ]);
    const labels = await labelsFor(rows, companyId);
    const attempts = groupAttempts(rows, labels, settings.duplicateAttemptThreshold, settings.duplicateAttemptWindowMinutes * 60000);
    const duplicateRequests = groupDuplicateRequests(rows, labels);
    const counts = sampledEventCounts(rows);
    return res.json({ success: true, data: {
      range: { from: range.from, to: range.to }, truncated: rows.length === MAX_REPORT_ROWS,
      events: counts,
      duplicateAttemptGroups: attempts.filter((row) => row.duplicateAttempt).length,
      duplicateRequestGroups: duplicateRequests.length,
      lockoutGroups: attempts.filter((row) => row.lockouts > 0).length,
      pendingApprovals, openSyncExceptions, idempotencyNeedsReview: idempotencyReview,
      settings,
    } });
  } catch (error) {
    console.error('POS risk report failed:', error);
    return sendError(res, 500, 'POS_RISK_REPORT_UNAVAILABLE', 'The POS risk report could not be loaded.');
  }
};

exports._test = { groupAttempts, sampledEventCounts };
