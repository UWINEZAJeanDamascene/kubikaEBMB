'use strict';

jest.mock('../services/systemSettingsService', () => ({
  get: jest.fn(),
  update: jest.fn(),
}));

const SystemSettingsService = require('../services/systemSettingsService');
const { updateSettings } = require('../controllers/systemSettingsController');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

describe('general settings offline limit validation', () => {
  beforeEach(() => jest.clearAllMocks());

  test('rejects fractional offline total-value limits before the database update', async () => {
    const res = response();
    await updateSettings({
      companyId: 'company', user: { _id: 'manager' }, body: { pos_offline_queue_limit: 100.5 },
    }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/whole RWF amount/i);
    expect(SystemSettingsService.update).not.toHaveBeenCalled();
  });

  test('rejects a total-value change below the existing single-sale limit', async () => {
    SystemSettingsService.get.mockResolvedValue({
      pos_offline_queue_limit: 1_000_000,
      pos_offline_max_single_sale: 500_000,
    });
    const res = response();
    await updateSettings({
      companyId: 'company', user: { _id: 'manager' }, body: { pos_offline_queue_limit: 400_000 },
    }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/single offline sale cannot exceed/i);
    expect(SystemSettingsService.update).not.toHaveBeenCalled();
  });

  test('accepts a consistent company offline limit pair', async () => {
    SystemSettingsService.get.mockResolvedValue({
      pos_offline_queue_limit: 1_000_000,
      pos_offline_max_single_sale: 500_000,
    });
    SystemSettingsService.update.mockResolvedValue({});
    const res = response();
    await updateSettings({
      companyId: 'company', user: { _id: 'manager' },
      body: { pos_offline_queue_limit: 750_000, pos_offline_max_single_sale: 700_000 },
    }, res);
    expect(res.statusCode).toBe(200);
    expect(SystemSettingsService.update).toHaveBeenCalledWith('company', {
      pos_offline_queue_limit: 750_000,
      pos_offline_max_single_sale: 700_000,
    }, 'manager');
  });
});
