'use strict';

const crypto = require('crypto');
const { prisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');
const { writePosAuditLog, requestIp } = require('./posAuditService');
const { runInPrismaTransaction } = require('./transactionService');

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;
const RESPONSE_LIMIT = 1024 * 1024;
const PROCESSING_LEASE_MS = 15 * 60 * 1000;

function idempotencyKeyFrom(req) {
  const value = req.get?.('Idempotency-Key')
    || req.headers?.['idempotency-key']
    || req.body?.idempotencyKey
    || '';
  return String(value).trim();
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function payloadHash(value) {
  return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function requestScope(req, namespace = 'api') {
  const route = req.route?.path || req.path || 'unknown';
  return `${String(namespace).slice(0, 32)}:${String(req.method || 'POST').toUpperCase()}:${String(route).slice(0, 180)}`;
}

function requestIdentity(req) {
  const context = req.posAuthContext;
  const companyId = String(
    context?.company?.id
      || req.posSession?.companyId
      || req.posCompany?.id
      || req.user?.companyId
      || req.user?.company?._id
      || req.user?.company?.id
      || req.company?.id
      || '',
  );
  const actorId = String(context?.session?.userId || req.posUser?.id || req.user?.id || req.user?._id || '');
  const registerId = String(context?.register?.id || req.posRegister?.id || '');
  return { companyId, actorId, registerId };
}

function resultEncryptionKey() {
  const rootSecret = process.env.POS_IDEMPOTENCY_ENCRYPTION_KEY
    || process.env.JWT_SECRET
    || process.env.DATABASE_URL;
  if (!rootSecret) throw new Error('Configure POS_IDEMPOTENCY_ENCRYPTION_KEY or a shared server secret before enabling POS idempotency.');
  return crypto.createHash('sha256').update(`kubika-pos-idempotency:v1:${rootSecret}`).digest();
}

function encryptResult(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', resultEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ciphertext.toString('base64') });
}

function decryptResult(value) {
  const envelope = JSON.parse(value);
  if (envelope?.v !== 1) throw new Error('Unsupported POS idempotency result format.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', resultEncryptionKey(), Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8');
  return JSON.parse(plaintext);
}

function captureHttpOutcome(req, res) {
  const originals = {
    status: res.status,
    json: res.json,
    send: res.send,
    end: res.end,
    set: res.set,
    setHeader: res.setHeader,
    type: res.type,
  };
  const headers = {};
  let outcome = null;
  const setHeader = (name, value) => { headers[String(name).toLowerCase()] = String(value); };
  const capture = (body, contentType) => {
    if (!outcome) outcome = {
      status: res.statusCode || 200,
      body: body ?? null,
      contentType: contentType || headers['content-type'] || 'application/json',
      headers: { ...headers },
    };
    return res;
  };
  res.status = (code) => { res.statusCode = Number(code); return res; };
  res.set = (name, value) => {
    if (name && typeof name === 'object') Object.entries(name).forEach(([key, item]) => setHeader(key, item));
    else setHeader(name, value);
    return res;
  };
  res.setHeader = (name, value) => { setHeader(name, value); return res; };
  res.type = (value) => { setHeader('content-type', value); return res; };
  res.json = (body) => capture(body, 'application/json; charset=utf-8');
  res.send = (body) => capture(body, typeof body === 'string' ? (headers['content-type'] || 'text/html; charset=utf-8') : 'application/json; charset=utf-8');
  res.end = (body) => capture(body == null ? null : Buffer.isBuffer(body) ? { __buffer: body.toString('base64') } : body, headers['content-type'] || 'application/octet-stream');

  const restore = () => Object.entries(originals).forEach(([key, method]) => { if (method) res[key] = method; });
  const emit = (saved) => {
    Object.entries(saved?.headers || {}).forEach(([name, value]) => {
      if (!['connection', 'transfer-encoding', 'content-length', 'date'].includes(name)) res.setHeader?.(name, value);
    });
    if (saved?.contentType) res.setHeader?.('content-type', saved.contentType);
    res.status(saved?.status || 200);
    const body = saved?.body?.__buffer ? Buffer.from(saved.body.__buffer, 'base64') : saved?.body;
    if (saved?.contentType?.includes('application/json')) return res.json(body);
    if (body == null) return res.end();
    return res.send(body);
  };
  return { getOutcome: () => outcome, restore, emit, headers, req };
}

async function replayCompleted(record, req, res) {
  const result = await prisma.posIdempotencyResult.findUnique({
    where: { idempotencyRecordId: record.id },
  });
  if (!result || result.companyId !== record.companyId || result.id !== record.resultReferenceId) {
    return res.status(503).json({ success: false, code: 'POS_IDEMPOTENCY_RESULT_UNAVAILABLE', message: 'The saved POS result is temporarily unavailable. Ask a manager to review this action.' });
  }
  let saved;
  try { saved = decryptResult(result.payloadCiphertext); }
  catch (error) {
    console.error('[pos-idempotency] Could not decrypt the referenced result:', error?.message || error);
    return res.status(503).json({ success: false, code: 'POS_IDEMPOTENCY_RESULT_UNAVAILABLE', message: 'The saved result cannot be opened. Ask a manager to review this action.' });
  }
  res.set('Idempotent-Replay', 'true');
  const capture = captureHttpOutcome(req, res);
  capture.restore();
  return capture.emit(saved);
}

async function auditDuplicateAttempt(req, { scope, status, payloadMatched }) {
  const identity = requestIdentity(req);
  await writePosAuditLog({
    companyId: identity.companyId,
    registerId: identity.registerId || null,
    userId: identity.actorId || null,
    event: 'POS_DUPLICATE_REQUEST_ATTEMPT',
    metadata: { scope, existingStatus: status, payloadMatched },
    ip: requestIp(req),
  });
}

async function reserveRequest(req, res, namespace, required) {
  const stopWithResponse = (status, body) => {
    req.posIdempotencyFinished = true;
    return res.status(status).json(body);
  };
    const key = idempotencyKeyFrom(req);
    if (!key) {
      if (!required) return { bypass: true };
      return stopWithResponse(400, {
        success: false,
        code: 'POS_IDEMPOTENCY_KEY_REQUIRED',
        message: 'This POS action needs a request key. Refresh the screen and try again.',
      });
    }
    if (!KEY_PATTERN.test(key)) {
      return stopWithResponse(400, {
        success: false,
        code: 'POS_IDEMPOTENCY_KEY_INVALID',
        message: 'The request key is not valid. Refresh the screen and try again.',
      });
    }

    const identity = requestIdentity(req);
    if (!/^[a-f\d]{24}$/i.test(identity.companyId)) {
      return stopWithResponse(401, { success: false, code: 'POS_COMPANY_CONTEXT_REQUIRED', message: 'Sign in to the correct workspace and try again.' });
    }
    const scope = requestScope(req, namespace);
    const bodyHash = payloadHash({ params: req.params || {}, query: req.query || {}, body: req.body || {} });
    const recordWhere = { companyId_scope_idempotencyKey: { companyId: identity.companyId, scope, idempotencyKey: key } };

    try {
      let record;
      try {
        record = await prisma.posIdempotencyRecord.create({
          data: {
            id: generateObjectId(), companyId: identity.companyId, scope,
            idempotencyKey: key, payloadHash: bodyHash,
            actorId: identity.actorId || null, registerId: identity.registerId || null,
            status: 'PROCESSING', leaseExpiresAt: new Date(Date.now() + PROCESSING_LEASE_MS),
          },
        });
      } catch (error) {
        if (error?.code !== 'P2002') throw error;
        record = await prisma.posIdempotencyRecord.findUnique({ where: recordWhere });
        if (!record) throw error;
        await auditDuplicateAttempt(req, {
          scope,
          status: record.status,
          payloadMatched: record.payloadHash === bodyHash,
        });
        if (record.payloadHash !== bodyHash || (record.actorId && identity.actorId && record.actorId !== identity.actorId)) {
          return stopWithResponse(409, { success: false, code: 'POS_IDEMPOTENCY_KEY_REUSED', message: 'This request key belongs to a different action. Refresh and try again.' });
        }
        if (record.status === 'COMPLETED' && record.resultReferenceId) {
          await replayCompleted(record, req, res);
          req.posIdempotencyFinished = true;
          return null;
        }
        if (record.status === 'COMPLETED_NO_REPLAY') return stopWithResponse(409, { success: false, code: 'POS_IDEMPOTENCY_ALREADY_COMPLETED', message: 'This action was already accepted. Check its current status before trying again.' });
        if (record.status === 'PROCESSING' && record.leaseExpiresAt && record.leaseExpiresAt <= new Date()) {
          await prisma.posIdempotencyRecord.updateMany({
            where: { id: record.id, companyId: identity.companyId, status: 'PROCESSING', leaseExpiresAt: { lte: new Date() } },
            data: { status: 'NEEDS_REVIEW', completedAt: new Date() },
          });
          return stopWithResponse(409, { success: false, code: 'POS_IDEMPOTENCY_NEEDS_REVIEW', message: 'The previous attempt stopped responding. Ask a manager to check the POS action before retrying.' });
        }
        if (record.status === 'FAILED_SAFE') {
          const reset = await prisma.posIdempotencyRecord.updateMany({
            where: { id: record.id, status: 'FAILED_SAFE' },
            data: { status: 'PROCESSING', responseStatus: null, resultReferenceId: null, completedAt: null, leaseExpiresAt: new Date(Date.now() + PROCESSING_LEASE_MS) },
          });
          if (reset.count !== 1) return stopWithResponse(409, { success: false, code: 'POS_IDEMPOTENCY_IN_PROGRESS', message: 'This action is already being processed. Wait a moment and refresh.' });
        } else {
          return stopWithResponse(409, {
            success: false,
            code: record.status === 'NEEDS_REVIEW' ? 'POS_IDEMPOTENCY_NEEDS_REVIEW' : 'POS_IDEMPOTENCY_IN_PROGRESS',
            message: record.status === 'NEEDS_REVIEW'
              ? 'The previous attempt may have completed. Ask a manager to check the POS action before retrying.'
              : 'This action is already being processed. Wait a moment and refresh.',
          });
        }
      }

      return record;
    } catch (error) { throw error; }
}

/**
 * Reserve the key, execute the controller and persist an encrypted replay
 * result inside one database transaction. The HTTP response is held until that
 * transaction commits, so a failed ledger write also rolls back the business
 * action and a lost acknowledgement can always replay the committed result.
 */
function idempotentHandler(handler, options) {
  const { namespace = 'api', required = true } = options || {};
  return async function guardedPosMutation(req, res, next) {
    let record;
    try {
      record = await reserveRequest(req, res, namespace, required);
      if (record?.bypass) return handler(req, res, next);
      if (!record || req.posIdempotencyFinished || res.headersSent) return;

      let transactionWorkCompleted = false;
      const captured = captureHttpOutcome(req, res);
      let handlerError = null;
      try {
        await runInPrismaTransaction(async (tx) => {
          await new Promise((resolve, reject) => {
            let nextCalled = false;
            const handlerNext = (error) => {
              if (nextCalled) return;
              nextCalled = true;
              if (error) { handlerError = error; reject(error); }
              else resolve();
            };
            try {
              const result = handler(req, res, handlerNext);
              if (result && typeof result.then === 'function') {
                result.then(() => {
                  if (captured.getOutcome()) resolve();
                  else reject(new Error('POS mutation completed without an HTTP result.'));
                }, reject);
              } else if (captured.getOutcome()) resolve();
              else reject(new Error('POS mutation completed without an HTTP result.'));
            } catch (error) { reject(error); }
          });
          const outcome = captured.getOutcome();
          if (!outcome) throw new Error('POS mutation completed without an HTTP result.');
          if (outcome.status >= 500) throw Object.assign(new Error('POS handler returned a server error; transaction rolled back.'), { safeRetry: true });
          const serialized = JSON.stringify(outcome);
          if (Buffer.byteLength(serialized, 'utf8') > RESPONSE_LIMIT) {
            throw Object.assign(new Error('POS response exceeds the supported replay result size.'), { safeRetry: true });
          }
          const resultId = generateObjectId();
          await tx.posIdempotencyResult.create({
            data: {
              id: resultId,
              companyId: record.companyId,
              idempotencyRecordId: record.id,
              payloadCiphertext: encryptResult(outcome),
            },
          });
          const completed = await tx.posIdempotencyRecord.updateMany({
            where: { id: record.id, companyId: record.companyId, status: 'PROCESSING' },
            data: {
              status: 'COMPLETED', responseStatus: outcome.status,
              resultReferenceId: resultId, completedAt: new Date(), leaseExpiresAt: null,
            },
          });
          if (completed.count !== 1) throw new Error('POS idempotency reservation was lost before transaction commit.');
          transactionWorkCompleted = true;
        });
      } catch (error) {
        captured.restore();
        const status = transactionWorkCompleted ? 'NEEDS_REVIEW' : 'FAILED_SAFE';
        await prisma.posIdempotencyRecord.updateMany({
          where: { id: record.id, companyId: record.companyId, status: 'PROCESSING' },
          data: { status, completedAt: status === 'NEEDS_REVIEW' ? new Date() : null, leaseExpiresAt: null },
        }).catch((markError) => console.error('[pos-idempotency] Failed to record transaction outcome:', markError?.message || markError));
        if (handlerError) return next(handlerError);
        if (error?.safeRetry || !transactionWorkCompleted) return captured.emit({ status: 503, contentType: 'application/json; charset=utf-8', body: { success: false, code: 'POS_IDEMPOTENCY_RETRY_SAFE', message: 'The POS action was not committed. Retry this same action.' } });
        if (transactionWorkCompleted) return captured.emit({ status: 503, contentType: 'application/json; charset=utf-8', body: { success: false, code: 'POS_IDEMPOTENCY_NEEDS_REVIEW', message: 'The commit result is uncertain. Check POS Back Office Approvals before retrying this action.' } });
        console.error('[pos-idempotency] Transaction failed:', error?.message || error);
        return next(error);
      }
      captured.restore();
      return captured.emit(captured.getOutcome());
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = { KEY_PATTERN, PROCESSING_LEASE_MS, canonicalJson, payloadHash, idempotencyKeyFrom, requestScope, requestIdentity, idempotentHandler, encryptResult, decryptResult };
