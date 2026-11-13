jest.mock('../controllers/posPublicReceiptController', () => ({
  publicDocument: (_req, res) => res.status(200).json({ success: true }),
  publicPdf: (_req, res) => res.status(200).send('pdf'),
}));

const express = require('express');
const request = require('supertest');
const publicReceiptRoutes = require('../routes/publicReceiptRoutes');

describe('public receipt HTTP privacy and rate limits', () => {
  it('applies privacy headers and blocks the 31st request within 15 minutes', async () => {
    const app = express();
    app.use('/public/receipt', publicReceiptRoutes);

    const receipt = await request(app).get(`/public/receipt/${'b'.repeat(43)}`);
    const pdf = await request(app).get(`/public/receipt/${'c'.repeat(43)}/pdf`);
    for (const response of [receipt, pdf]) {
      expect(response.status).toBe(200);
      expect(response.headers['x-robots-tag']).toBe('noindex, nofollow');
      expect(response.headers['cache-control']).toBe('no-store, private');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
    }

    let lastResponse;

    for (let index = 0; index < 29; index += 1) {
      lastResponse = await request(app).get(`/public/receipt/${'a'.repeat(43)}`);
    }

    expect(lastResponse.status).toBe(429);
    expect(lastResponse.body.code).toBe('POS_PUBLIC_RECEIPT_RATE_LIMITED');
    expect(lastResponse.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(lastResponse.headers['cache-control']).toBe('no-store, private');
    expect(lastResponse.headers['referrer-policy']).toBe('no-referrer');
  });
});
