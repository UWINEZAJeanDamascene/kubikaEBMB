'use strict';

const express = require('express');
const request = require('supertest');

const mockPermissionChecks = [];
let mockRegisterTillType = 'retail';
const mockMethodRegistry = {
  methods: [],
  company: {},
  tillTypeOverrides: {},
  registerOverrides: {},
};
jest.mock('../middleware/posAuthMiddleware', () => ({
  requirePosSession: () => (req, _res, next) => {
    req.posAuthContext = {
      company: { id: req.get('x-session-company') || 'company-a' },
      register: {
        id: '507f1f77bcf86cd799439012',
        systemTillType: mockRegisterTillType,
      },
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
  getEffectiveMethodRegistry: jest.fn(() => mockMethodRegistry),
  savePaymentSettings: jest.fn(),
}));

const posPaymentService = require('../services/posPaymentService');
const paymentSettingsController = require('../controllers/posPaymentSettingsController');
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

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

describe('POS payment settings routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRegisterTillType = 'retail';
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

  test('returns a clear service error when the method registry migration is missing', async () => {
    posPaymentService.getPaymentSettings.mockRejectedValue({
      code: 'POS_PAYMENT_METHOD_REGISTRY_MIGRATION_REQUIRED',
      message: 'Migration required.',
    });

    const result = await request(app)
      .get('/api/pos/payment-settings')
      .set('x-pos-permissions', 'pos.payment.settings');

    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({
      success: false,
      code: 'POS_PAYMENT_METHOD_REGISTRY_MIGRATION_REQUIRED',
      message: expect.stringContaining('database migrations'),
    });
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
      methodRegistry: mockMethodRegistry,
      paymentFlow: 'LEGACY',
      providerEnvironment: 'sandbox',
      automaticConfirmationAvailable: false,
    });
    expect(posPaymentService.getPaymentSettings).toHaveBeenCalledWith('company-a');
    expect(posPaymentService.resolveEnabledMethods).toHaveBeenCalledWith(
      settings,
      '507f1f77bcf86cd799439012',
      'retail',
    );
  });

  test('passes the current restaurant till type to payment-method resolution', async () => {
    mockRegisterTillType = 'restaurant';
    const settings = safeSettings();
    posPaymentService.getPaymentSettings.mockResolvedValue(settings);

    const response = await request(app)
      .get('/api/pos/payment-settings/methods')
      .set('x-pos-permissions', 'pos.payment.take');

    expect(response.status).toBe(200);
    expect(posPaymentService.resolveEnabledMethods).toHaveBeenCalledWith(
      settings,
      '507f1f77bcf86cd799439012',
      'restaurant',
    );
    expect(posPaymentService.getEffectiveMethodRegistry).toHaveBeenCalledWith(settings, {
      registerId: '507f1f77bcf86cd799439012',
      tillType: 'restaurant',
    });
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
      systemTillType: 'retail',
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

  test('admin payment settings read is scoped to the signed-in company', async () => {
    const settings = safeSettings({ enabledMethods: ['CARD'] });
    posPaymentService.getPaymentSettings.mockResolvedValue(settings);
    posPaymentService.listPaymentRegisters.mockResolvedValue([{
      id: '507f1f77bcf86cd799439012',
      code: 'REGISTER-1',
      name: 'Main',
      isActive: true,
      systemTillType: 'retail',
    }]);
    const res = response();

    await paymentSettingsController.getAdminSettings({
      user: { company: { _id: 'company-admin' } },
    }, res, (error) => { throw error; });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.settings.enabledMethods).toEqual(['CARD']);
    expect(res.body.data.registers).toEqual([expect.objectContaining({
      id: '507f1f77bcf86cd799439012',
      systemTillType: 'retail',
    })]);
    expect(posPaymentService.getPaymentSettings).toHaveBeenCalledWith('company-admin');
  });

  test('returns an actionable validation response when enabling an unmapped method', async () => {
    const registerId = '507f1f77bcf86cd799439012';
    posPaymentService.listPaymentRegisters.mockResolvedValue([{ id: registerId, isActive: true }]);
    posPaymentService.savePaymentSettings.mockRejectedValue(Object.assign(
      new TypeError('Configure Card clearing before enabling this payment method.'),
      { code: 'POS_PAYMENT_ACCOUNT_MAPPING_REQUIRED' },
    ));
    const res = response();

    await paymentSettingsController.updateAdminSettings({
      user: { id: 'manager-user', companyId: 'company-admin' },
      body: { registerId, settings: safeSettings({ enabledMethods: ['CASH', 'CARD'] }) },
      headers: {},
    }, res, (error) => { throw error; });

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({
      success: false,
      code: 'POS_PAYMENT_ACCOUNT_MAPPING_REQUIRED',
      message: expect.stringContaining('Card clearing'),
    });
  });

  test('admin payment settings save is tied to a company register and authenticated manager audit identity', async () => {
    const registerId = '507f1f77bcf86cd799439012';
    const settings = safeSettings({ enabledMethods: ['CARD', 'CASH'] });
    posPaymentService.listPaymentRegisters.mockResolvedValue([{ id: registerId, isActive: true }]);
    posPaymentService.savePaymentSettings.mockResolvedValue(settings);
    const res = response();

    await paymentSettingsController.updateAdminSettings({
      user: { id: 'manager-user', companyId: 'company-admin' },
      body: { registerId, settings },
      ip: '127.0.0.2',
      headers: {},
    }, res, (error) => { throw error; });

    expect(res.statusCode).toBe(200);
    expect(posPaymentService.savePaymentSettings).toHaveBeenCalledWith({
      companyId: 'company-admin',
      settings,
      userId: 'manager-user',
      registerId,
      ip: '127.0.0.2',
    });
  });

  test('admin payment settings save rejects registers outside the authenticated company', async () => {
    posPaymentService.listPaymentRegisters.mockResolvedValue([]);
    const res = response();

    await paymentSettingsController.updateAdminSettings({
      user: { id: 'manager-user', companyId: 'company-admin' },
      body: {
        registerId: '507f1f77bcf86cd799439099',
        settings: safeSettings(),
      },
      headers: {},
    }, res, (error) => { throw error; });

    expect(res.statusCode).toBe(404);
    expect(res.body.code).toBe('POS_PAYMENT_REGISTER_NOT_FOUND');
    expect(posPaymentService.savePaymentSettings).not.toHaveBeenCalled();
  });
});
