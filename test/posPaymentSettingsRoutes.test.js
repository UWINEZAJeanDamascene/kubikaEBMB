'use strict';

const express = require('express');
const request = require('supertest');

const mockPermissionChecks = [];
jest.mock('../middleware/posAuthMiddleware', () => ({
  requirePosSession: () => (req, _res, next) => {
    req.posAuthContext = {
      company: { id: req.get('x-session-company') || 'company-a' },
      register: { id: '507f1f77bcf86cd799439012' },
      user: { id: '507f1f77bcf86cd799439013' },
    };
    next();
  },
  requirePermission: (permission) => {
    mockPermissionChecks.push(permission);
    return (req, res, next) => {
      const permissions = String(req.get('x-pos-permissions') || '').split(',').filter(Boolean);
      if (!permissions.includes(permission)) {
        return res.status(403).json({
          success: false,
          code: 'POS_PERMISSION_DENIED',
          requiredPermission: permission,
        });
      }
      return next();
    };
  },
}));

jest.mock('../services/posPaymentService', () => ({
  getPaymentSettings: jest.fn(),
  listPaymentRegisters: jest.fn(),
  resolveEnabledMethods: jest.fn((settings, registerId) => (
    settings.registerOverrides[registerId] ?? settings.enabledMethods
  )),
  resolvePaymentFlow: jest.fn((settings, registerId) => (
    settings.registerPaymentFlowOverrides?.[registerId] ?? settings.paymentFlow ?? 'LEGACY'
  )),
  savePaymentSettings: jest.fn(),
}));

const posPaymentService = require('../services/posPaymentService');
const paymentSettingsRoutes = require('../routes/posPaymentSettingsRoutes');

const app = express();
app.use(express.json());
app.use('/api/pos/payment-settings', paymentSettingsRoutes);

function safeSettings(overrides = {}) {
  return {
    enabledMethods: ['CASH', 'CARD'],
    registerOverrides: {},
    paymentFlow: 'LEGACY',
    registerPaymentFlowOverrides: {},
    momoTimeoutSec: 120,
    cashRounding: null,
    allowOverCreditLimit: false,
    bankTransferNeedsConfirm: true,
    providerEnvironment: 'sandbox',
    providers: {
      MTN_MOMO: { configured: false },
      AIRTEL_MONEY: { configured: false },
    },
    ...overrides,
  };
}

describe('POS payment settings routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('uses the POS session and method-specific permissions', async () => {
    expect(mockPermissionChecks).toEqual([
      'pos.payment.take',
      'pos.payment.settings',
      'pos.payment.settings',
    ]);

    const deniedMethods = await request(app).get('/api/pos/payment-settings/methods');
    expect(deniedMethods.status).toBe(403);
    expect(deniedMethods.body.requiredPermission).toBe('pos.payment.take');

    const deniedSettings = await request(app)
      .get('/api/pos/payment-settings')
      .set('x-pos-permissions', 'pos.payment.take');
    expect(deniedSettings.status).toBe(403);
    expect(deniedSettings.body.requiredPermission).toBe('pos.payment.settings');
  });

  test('returns only the effective methods for the current POS register', async () => {
    const settings = safeSettings({
      registerOverrides: { '507f1f77bcf86cd799439012': ['CASH'] },
    });
    posPaymentService.getPaymentSettings.mockResolvedValue(settings);

    const response = await request(app)
      .get('/api/pos/payment-settings/methods')
      .set('x-pos-permissions', 'pos.payment.take');

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      registerId: '507f1f77bcf86cd799439012',
      methods: ['CASH'],
      paymentFlow: 'LEGACY',
      providerEnvironment: 'sandbox',
      automaticConfirmationAvailable: false,
    });
    expect(posPaymentService.getPaymentSettings).toHaveBeenCalledWith('company-a');
    expect(posPaymentService.resolveEnabledMethods).toHaveBeenCalledWith(
      settings,
      '507f1f77bcf86cd799439012',
    );
  });

  test('rejects invalid provider saves with the friendly setup message', async () => {
    posPaymentService.savePaymentSettings.mockRejectedValue(Object.assign(
      new Error('This payment method is not set up yet.'),
      { code: 'POS_PAYMENT_PROVIDER_NOT_CONFIGURED' },
    ));

    const response = await request(app)
      .put('/api/pos/payment-settings')
      .set('x-pos-permissions', 'pos.payment.settings')
      .send({ enabledMethods: ['CASH', 'MTN_MOMO'] });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      success: false,
      code: 'POS_PAYMENT_PROVIDER_NOT_CONFIGURED',
      message: 'This payment method is not set up yet.',
    });
  });

  test('does not expose provider configuration in settings responses', async () => {
    const secret = 'never-return-this-provider-value';
    const settings = safeSettings({
      enabledMethods: ['CASH', 'MTN_MOMO'],
      registerOverrides: { '507f1f77bcf86cd799439012': ['CASH', 'AIRTEL_MONEY'] },
      providerConfig: { secretReference: secret },
    });
    posPaymentService.getPaymentSettings.mockResolvedValue(settings);
    posPaymentService.listPaymentRegisters.mockResolvedValue([{
      id: '507f1f77bcf86cd799439012',
      code: 'REGISTER-1',
      name: 'Main',
      isActive: true,
    }]);

    const response = await request(app)
      .get('/api/pos/payment-settings')
      .set('x-pos-permissions', 'pos.payment.settings');

    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain(secret);
    expect(response.body.data.settings.providers).toEqual({
      MTN_MOMO: { configured: false },
      AIRTEL_MONEY: { configured: false },
    });
    expect(response.body.data.settings.enabledMethods).toEqual(['CASH']);
    expect(response.body.data.settings.registerOverrides).toEqual({
      '507f1f77bcf86cd799439012': ['CASH'],
    });
    expect(response.body.data.settings).not.toHaveProperty('providerConfig');
    expect(response.body.data.registers).toEqual([{
      id: '507f1f77bcf86cd799439012',
      code: 'REGISTER-1',
      name: 'Main',
      isActive: true,
    }]);
  });

  test('returns a validation response when settings exceed the supported register limit', async () => {
    posPaymentService.getPaymentSettings.mockResolvedValue(safeSettings());
    posPaymentService.listPaymentRegisters.mockRejectedValue(Object.assign(
      new Error('Payment settings cannot be loaded for more than 500 POS registers.'),
      { code: 'POS_PAYMENT_SETTINGS_INVALID' },
    ));

    const response = await request(app)
      .get('/api/pos/payment-settings')
      .set('x-pos-permissions', 'pos.payment.settings');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      success: false,
      code: 'POS_PAYMENT_SETTINGS_INVALID',
      message: 'Payment settings cannot be loaded for more than 500 POS registers.',
    });
  });

  test('does not expose provider configuration in successful update responses', async () => {
    const secret = 'never-return-this-update-value';
    posPaymentService.savePaymentSettings.mockResolvedValue(safeSettings({
      providerConfig: { secretReference: secret },
    }));

    const response = await request(app)
      .put('/api/pos/payment-settings')
      .set('x-pos-permissions', 'pos.payment.settings')
      .send({ enabledMethods: ['CASH'] });

    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain(secret);
    expect(response.body.data).not.toHaveProperty('providerConfig');
  });

  test('scopes settings reads to the authenticated POS company, not a caller company header', async () => {
    posPaymentService.getPaymentSettings.mockResolvedValue(safeSettings());
    posPaymentService.listPaymentRegisters.mockResolvedValue([]);

    const response = await request(app)
      .get('/api/pos/payment-settings')
      .set('x-session-company', 'company-a')
      .set('x-company-id', 'company-b')
      .set('x-pos-permissions', 'pos.payment.settings');

    expect(response.status).toBe(200);
    expect(posPaymentService.getPaymentSettings).toHaveBeenCalledWith('company-a');
    expect(posPaymentService.getPaymentSettings).not.toHaveBeenCalledWith('company-b');
  });

  test('scopes settings updates to the authenticated POS company', async () => {
    posPaymentService.savePaymentSettings.mockResolvedValue(safeSettings());

    const response = await request(app)
      .put('/api/pos/payment-settings')
      .set('x-session-company', 'company-a')
      .set('x-company-id', 'company-b')
      .set('x-pos-permissions', 'pos.payment.settings')
      .send({ enabledMethods: ['CASH'] });

    expect(response.status).toBe(200);
    expect(posPaymentService.savePaymentSettings).toHaveBeenCalledWith(expect.objectContaining({
      companyId: 'company-a',
      userId: '507f1f77bcf86cd799439013',
      registerId: '507f1f77bcf86cd799439012',
    }));
  });
});
