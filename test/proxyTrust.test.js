const express = require('express');
const rateLimit = require('express-rate-limit');
const request = require('supertest');
const { configureProxyTrust } = require('../config/proxyTrust');

describe('proxy trust configuration', () => {
  test('trusts only the Railway ingress hop in production so forwarded IP rate limits work', async () => {
    const app = express();
    configureProxyTrust(app, 'production');
    app.use(rateLimit({ windowMs: 60000, limit: 10 }));
    app.get('/', (req, res) => res.json({ ip: req.ip }));

    const response = await request(app)
      .get('/')
      .set('X-Forwarded-For', '203.0.113.10');

    expect(response.status).toBe(200);
    expect(response.body.ip).toBe('203.0.113.10');
    expect(app.get('trust proxy')).toBe(1);
  });

  test('does not trust forwarded addresses outside production', () => {
    const app = express();

    configureProxyTrust(app, 'development');

    expect(app.get('trust proxy')).toBe(false);
  });
});
