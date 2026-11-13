'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const hasDatabase = Boolean(process.env.DATABASE_URL);
const { randomUUID } = require('crypto');

describe('POS idempotency transaction boundary (PostgreSQL)', () => {
  const describeWithDb = hasDatabase ? describe : describe.skip;
  describeWithDb('local database', () => {
    const { prisma } = require('../lib/prisma');
    const { idempotentHandler } = require('../services/posIdempotencyService');
    const { payloadHash } = require('../services/posIdempotencyService');
    let companyId = null;
    let requestKey = null;
    let effectKey = null;

    function makeRequest(key) {
      const body = { probe: key };
      return {
        method: 'POST', path: '/api/pos/idempotency-atomic-probe', route: { path: '/atomic-probe' },
        params: {}, query: {}, body, headers: { 'idempotency-key': key },
        posAuthContext: { company: { id: companyId }, session: {}, register: {} },
      };
    }

    function makeResponse() {
      return {
        statusCode: 200, headers: {}, body: undefined,
        set(name, value) { this.headers[name] = value; return this; },
        setHeader(name, value) { this.headers[name] = value; return this; },
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
        send(body) { this.body = body; return this; },
        end(body) { this.body = body; return this; },
        on() { return this; },
      };
    }

    beforeAll(async () => {
      const company = await prisma.company.findFirst({ select: { id: true } });
      companyId = company?.id || null;
    });

    beforeEach(() => {
      const unique = randomUUID().replace(/-/g, '');
      requestKey = `atomic-${unique}`;
      effectKey = `effect-${unique}`;
    });

    afterEach(async () => {
      if (!companyId) return;
      await prisma.posIdempotencyRecord.deleteMany({
        where: { companyId, idempotencyKey: { in: [requestKey, effectKey] } },
      });
    });

    afterAll(async () => { await prisma.$disconnect(); });

    test('a lost acknowledgement retry returns the committed result and writes one effect', async () => {
      if (!companyId) return;
      let effects = 0;
      const handler = async (_req, res) => {
        effects += 1;
        const effectId = randomUUID().replace(/-/g, '').slice(0, 24);
        await prisma.posIdempotencyRecord.create({
          data: {
            id: effectId, companyId, scope: 'atomic-test-effect', idempotencyKey: effectKey,
            payloadHash: payloadHash({ effectKey }), status: 'COMPLETED_NO_REPLAY',
          },
        });
        return res.status(201).json({ success: true, effectId });
      };
      const guarded = idempotentHandler(handler, { namespace: 'atomic-integration' });
      const first = makeResponse();
      await guarded(makeRequest(requestKey), first, (error) => { throw error; });

      const retry = makeResponse();
      await guarded(makeRequest(requestKey), retry, (error) => { throw error; });

      const effectsSaved = await prisma.posIdempotencyRecord.count({
        where: { companyId, scope: 'atomic-test-effect', idempotencyKey: effectKey },
      });
      const completed = await prisma.posIdempotencyRecord.findFirst({
        where: { companyId, idempotencyKey: requestKey },
        select: { status: true, responseStatus: true, resultReferenceId: true },
      });
      expect(effects).toBe(1);
      expect(effectsSaved).toBe(1);
      expect(completed).toMatchObject({ status: 'COMPLETED', responseStatus: 201 });
      expect(completed.resultReferenceId).toBeTruthy();
      expect(retry.headers['Idempotent-Replay']).toBe('true');
      expect(retry.body).toEqual(first.body);
    });

    test('a handler error rolls back its direct Prisma write before the key is retried', async () => {
      if (!companyId) return;
      const handler = async (_req, res) => {
        await prisma.posIdempotencyRecord.create({
          data: {
            id: randomUUID().replace(/-/g, '').slice(0, 24), companyId,
            scope: 'atomic-test-effect', idempotencyKey: effectKey,
            payloadHash: payloadHash({ effectKey }), status: 'COMPLETED_NO_REPLAY',
          },
        });
        return res.status(500).json({ success: false });
      };
      const res = makeResponse();
      await idempotentHandler(handler, { namespace: 'atomic-integration' })(makeRequest(requestKey), res, (error) => { throw error; });

      const effectsSaved = await prisma.posIdempotencyRecord.count({
        where: { companyId, scope: 'atomic-test-effect', idempotencyKey: effectKey },
      });
      const requestRecord = await prisma.posIdempotencyRecord.findFirst({ where: { companyId, idempotencyKey: requestKey } });
      expect(effectsSaved).toBe(0);
      expect(requestRecord.status).toBe('FAILED_SAFE');
      expect(res.statusCode).toBe(503);
    });
  });
});
