jest.mock('../controllers/posPublicReceiptController', () => ({
  publicDocument: (_req, res) => res.status(200).json({ success: true }),
  publicPdf: (_req, res) => res.status(200).send('pdf'),
}));

const express = require('express');
const request = require('supertest');
const publicReceiptRoutes = require('../routes/publicReceiptRoutes');

describe('public receipt HTTP rate limit', () => {
  it('blocks requests after the configured 30 requests per 15 minutes', async () => {
    const app = express();
    app.use('/public/receipt', publicReceiptRoutes);
    let lastResponse;

    for (let index = 0; index < 31; index += 1) {
      lastResponse = await request(app).get(`/public/receipt/${'a'.repeat(43)}`);
    }

    expect(lastResponse.status).toBe(429);
    expect(lastResponse.body.code).toBe('POS_PUBLIC_RECEIPT_RATE_LIMITED');
  });
});
