'use strict';

const {
  DEFAULT_SCANNER_SETTINGS,
  normalizeScannerConfiguration,
  normalizeSettings,
  resolveScannerSettings,
} = require('../services/posScannerSettingsService');

describe('POS scanner settings', () => {
  test('uses register overrides over till-type and company defaults', () => {
    const configuration = normalizeScannerConfiguration({
      companyDefaults: { ...DEFAULT_SCANNER_SETTINGS, terminator: 'Enter' },
      tillTypeOverrides: { retail: { terminator: 'Tab', speedThresholdMs: 40 } },
      registerOverrides: { register1: { speedThresholdMs: 25 } },
    });
    expect(resolveScannerSettings(configuration, { tillType: 'retail', registerId: 'register1' })).toMatchObject({
      terminator: 'Tab',
      speedThresholdMs: 25,
    });
  });

  test('rejects invalid limits and malformed symbology lists', () => {
    expect(() => normalizeSettings({ ...DEFAULT_SCANNER_SETTINGS, speedThresholdMs: 500 })).toThrow(/speed threshold/i);
    expect(() => normalizeSettings({ ...DEFAULT_SCANNER_SETTINGS, enabledSymbologies: ['NOT_A_CODE'] })).toThrow(/symbologies/i);
  });

  test('preserves a valid configured open-price product and rejects malformed IDs', () => {
    const productId = 'a'.repeat(24);
    expect(normalizeScannerConfiguration({ openPriceProductId: productId }).openPriceProductId).toBe(productId);
    expect(() => normalizeScannerConfiguration({ openPriceProductId: 'not-an-id' })).toThrow(/open-price product ID/i);
  });
});
