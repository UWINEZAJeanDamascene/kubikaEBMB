'use strict';

const { writePosDenialAudit, writePosAuditLog, requestIp } = require('../services/posAuditService');

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function actorContext(req) {
  const pos = req.posAuthContext;
  const companyId = pos?.company?.id
    || req.user?.companyId
    || req.user?.company?._id
    || req.user?.company?.id;
  if (!companyId) return null;
  return {
    companyId: String(companyId),
    registerId: pos?.register?.id || pos?.session?.registerId || null,
    userId: pos?.user?.id || pos?.session?.userId || req.user?.id || req.user?._id || null,
  };
}

function operationName(req) {
  const routePath = req.route?.path;
  const path = routePath
    ? `${req.baseUrl || ''}${routePath}`
    : String(req.baseUrl || '/api/pos');
  return `${String(req.method || 'UNKNOWN').toUpperCase()} ${path}`.slice(0, 180);
}

/**
 * Audits failed/denied POS write requests once, outside rolled-back business
 * transactions. Successful state changes are audited by their domain service
 * inside the transaction that commits the change.
 */
function posAuditOutcome(req, res, next) {
  if (!WRITE_METHODS.has(String(req.method || '').toUpperCase())) return next();

  let auditAttempted = false;
  const originalEnd = res.end.bind(res);

  function recordFailure(statusCode, chunk) {
    if (auditAttempted || statusCode < 400) return Promise.resolve();
    // PIN and voucher handlers write a domain-specific denial event with the
    // same request context. Avoid a second generic event for that outcome.
    if (req.posDomainDenialAudited) return Promise.resolve();
    const actor = actorContext(req);
    if (!actor) return Promise.resolve();
    auditAttempted = true;
    let body = null;
    try {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
      if (text.startsWith('{')) body = JSON.parse(text);
    } catch { /* response bodies are untrusted; status and route are enough */ }
    const responseCode = body && typeof body === 'object' ? String(body.code || body.error || '') : '';
    const denied = statusCode < 500;
    req.posAuditOutcomeRecorded = true;
    const entry = {
      ...actor,
      event: denied ? 'POS_ACTION_DENIED' : 'POS_ACTION_FAILED',
      metadata: {
        operation: operationName(req),
        statusCode,
        ...(responseCode ? { errorCode: responseCode.slice(0, 100) } : {}),
      },
      ip: requestIp(req),
    };
    return (denied ? writePosDenialAudit(entry) : writePosAuditLog(entry)).catch((error) => {
      // Do not replace the endpoint's response during an audit-store outage.
      // The warning is surfaced to server monitoring for operational follow-up.
      console.error('[pos-audit] Failed to record a denied/failed POS action:', error.message || error);
    });
  }

  // Hook the common terminal response primitive so JSON, text, and centralized
  // error-handler responses all wait for one audit insert before being sent.
  res.end = function auditedEnd(chunk, encoding, callback) {
    const statusCode = Number(res.statusCode || 200);
    const audit = recordFailure(statusCode, chunk);
    if (!audit || auditAttempted === false) return originalEnd(chunk, encoding, callback);
    audit.finally(() => originalEnd(chunk, encoding, callback));
    return res;
  };
  return next();
}

module.exports = { posAuditOutcome, actorContext, operationName };
