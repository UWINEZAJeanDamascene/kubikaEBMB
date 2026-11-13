'use strict';

jest.mock('../services/posProviderEventService', () => ({
  recordProviderSuccess: jest.fn(),
  verifyProviderWebhookSignature: jest.fn(),
}));

const providerEvents = require('../services/posProviderEventService');
const controller = require('../controllers/posPaymentsV2Controller');

const COMPANY_ID = '507f1f77bcf86cd799439011';

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function request(payload, {
  signature = 'sha256:verified',
  timestamp = String(Math.floor(Date.now() / 1000)),
  provider = 'MTN',
  companyId = COMPANY_ID,
} = {}) {
  const headers = {
    'X-Kubika-Webhook-Signature': signature,
    'X-Kubika-Webhook-Timestamp': timestamp,
  };
  return {
    params: { provider, companyId },
    body: payload,
    headers,
    get(name) { return headers[name]; },
  };
}

describe('POS provider webhook controller contract', () => {
  const priorSecret = process.env.POS_MOMO_WEBHOOK_SECRET;

  beforeEach(() => {
    process.env.POS_MOMO_WEBHOOK_SECRET = 'test-webhook-secret';
    jest.clearAllMocks();
    providerEvents.verifyProviderWebhookSignature.mockReturnValue(true);
    providerEvents.recordProviderSuccess.mockResolvedValue({ replayed: false, unmatched: false });
  });

  afterAll(() => {
    if (priorSecret === undefined) delete process.env.POS_MOMO_WEBHOOK_SECRET;
    else process.env.POS_MOMO_WEBHOOK_SECRET = priorSecret;
  });

  test('rejects an invalid signature before recording or reserving its event identity', async () => {
    providerEvents.verifyProviderWebhookSignature.mockReturnValue(false);
    const res = response();

    await controller.providerWebhook(request({ externalId: 'payment-ref', amount: 500 }), res, jest.fn());

    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('POS_PROVIDER_WEBHOOK_SIGNATURE_INVALID');
    expect(providerEvents.recordProviderSuccess).not.toHaveBeenCalled();
  });

  test.each([
    ['missing reference', { amount: 500 }],
    ['invalid amount', { externalId: 'payment-ref', amount: 0 }],
    ['fractional amount', { externalId: 'payment-ref', amount: 1.5 }],
    ['array payload', []],
  ])('rejects malformed webhook payload (%s)', async (_label, payload) => {
    const res = response();

    await controller.providerWebhook(request(payload), res, jest.fn());

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('POS_PROVIDER_WEBHOOK_PAYLOAD_INVALID');
    expect(providerEvents.recordProviderSuccess).not.toHaveBeenCalled();
  });

  test('rejects invalid company IDs and oversized webhook payloads', async () => {
    const invalidCompany = response();
    await controller.providerWebhook(request({ externalId: 'payment-ref', amount: 500 }, { companyId: 'not-a-company-id' }), invalidCompany, jest.fn());
    expect(invalidCompany.statusCode).toBe(404);

    const oversized = response();
    await controller.providerWebhook(request({ externalId: 'payment-ref', amount: 500, padding: 'x'.repeat(65 * 1024) }), oversized, jest.fn());
    expect(oversized.statusCode).toBe(400);
    expect(oversized.body.code).toBe('POS_PROVIDER_WEBHOOK_PAYLOAD_INVALID');
    expect(providerEvents.recordProviderSuccess).not.toHaveBeenCalled();
  });

  test('uses stable provider event identity and returns the durable replay result', async () => {
    const payload = { externalId: 'payment-ref', transactionId: 'provider-event-42', amount: 500 };
    providerEvents.recordProviderSuccess
      .mockResolvedValueOnce({ replayed: false, unmatched: false })
      .mockResolvedValueOnce({ replayed: true, unmatched: false });
    const first = response();
    const retry = response();

    await controller.providerWebhook(request(payload), first, jest.fn());
    await controller.providerWebhook(request(payload), retry, jest.fn());

    expect(providerEvents.verifyProviderWebhookSignature).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'MTN_MOMO',
      timestamp: expect.stringMatching(/^\d{10}$/),
      secret: 'test-webhook-secret',
    }));
    expect(providerEvents.recordProviderSuccess).toHaveBeenNthCalledWith(1, expect.objectContaining({
      companyId: COMPANY_ID,
      provider: 'MTN_MOMO',
      eventKey: 'provider-event-42',
      externalRef: 'payment-ref',
      amount: 500,
      signatureOk: true,
    }));
    expect(first.body).toMatchObject({ success: true, replayed: false });
    expect(retry.body).toMatchObject({ success: true, replayed: true });
  });
});
