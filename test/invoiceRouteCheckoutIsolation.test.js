'use strict';

jest.mock('../middleware/auth', () => ({
  protect: (req, res, next) => next(),
}));
jest.mock('../middleware/rbacMiddleware', () => ({
  requirePermission: () => (req, res, next) => next(),
}));
jest.mock('../middleware/authorize', () => ({
  PermissionService: { check: jest.fn() },
  resolveUserRoles: jest.fn().mockResolvedValue([]),
}));
jest.mock('../middleware/logAction', () => () => (req, res, next) => next());
jest.mock('../middleware/cacheMiddleware', () => ({
  cacheMiddleware: () => (req, res, next) => next(),
  cacheInvalidationMiddleware: () => (req, res, next) => next(),
}));
jest.mock('../models/Invoice', () => ({ findOne: jest.fn() }));
jest.mock('../controllers/invoiceController', () => {
  const passThrough = (req, res, next) => next();
  return {
    getInvoices: passThrough,
    getInvoice: passThrough,
    createInvoice: (req, res) => res.status(201).json({ success: true, source: 'back-office-invoice' }),
    updateInvoice: passThrough,
    deleteInvoice: passThrough,
    confirmInvoice: passThrough,
    correctInvoiceTaxFromDeliveryNote: passThrough,
    recordPayment: passThrough,
    writeOffInvoiceBadDebt: passThrough,
    cancelInvoice: passThrough,
    saveReceiptMetadata: passThrough,
    verifyInvoiceCustomerTin: passThrough,
    submitInvoiceEbm: passThrough,
    getClientInvoices: passThrough,
    getProductInvoices: passThrough,
    generateInvoicePDF: passThrough,
    sendInvoiceEmail: passThrough,
  };
});

const express = require('express');
const invoiceRoutes = require('../routes/invoiceRoutes');

describe('back-office invoice checkout isolation', () => {
  test('creates an invoice without register or shift context through the existing invoice route', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/invoices', invoiceRoutes);

    const response = await require('supertest')(app)
      .post('/api/invoices')
      .send({ customerId: 'customer-a', items: [{ productId: 'product-a', quantity: 1 }] });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ success: true, source: 'back-office-invoice' });
  });
});
