'use strict';

const SYMBOLOGIES = ['EAN13', 'EAN8', 'UPCA', 'CODE128', 'CODE39', 'ITF14', 'QR'];
const SETTING_KEYS = [
  'terminator',
  'speedThresholdMs',
  'minimumLength',
  'maximumLength',
  'duplicateWindowMs',
  'duplicateBehavior',
  'prefixToStrip',
  'suffixToStrip',
  'feedbackSound',
  'enabledSymbologies',
];

const DEFAULT_SCANNER_SETTINGS = Object.freeze({
  terminator: 'Enter',
  speedThresholdMs: 50,
  minimumLength: 3,
  maximumLength: 128,
  duplicateWindowMs: 800,
  duplicateBehavior: 'add_quantity',
  prefixToStrip: '',
  suffixToStrip: '',
  feedbackSound: false,
  enabledSymbologies: SYMBOLOGIES,
});

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSettings(value, { partial = false } = {}) {
  if (!isRecord(value)) throw new TypeError('Scanner settings must be an object.');
  const result = {};
  const read = (key) => Object.prototype.hasOwnProperty.call(value, key);
  const defaultValue = (key) => read(key) ? value[key] : DEFAULT_SCANNER_SETTINGS[key];

  for (const key of SETTING_KEYS) {
    if (partial && !read(key)) continue;
    const candidate = defaultValue(key);
    if (key === 'terminator') {
      if (!['Enter', 'Tab'].includes(candidate)) throw new TypeError('Scanner terminator must be Enter or Tab.');
      result[key] = candidate;
    } else if (key === 'speedThresholdMs') {
      const number = candidate;
      if (typeof number !== 'number' || !Number.isInteger(number) || number < 10 || number > 250) throw new RangeError('Scanner speed threshold must be from 10 to 250 milliseconds.');
      result[key] = number;
    } else if (key === 'minimumLength') {
      const number = candidate;
      if (typeof number !== 'number' || !Number.isInteger(number) || number < 1 || number > 64) throw new RangeError('Scanner minimum length must be from 1 to 64 characters.');
      result[key] = number;
    } else if (key === 'maximumLength') {
      const number = candidate;
      if (typeof number !== 'number' || !Number.isInteger(number) || number < 8 || number > 512) throw new RangeError('Scanner maximum length must be from 8 to 512 characters.');
      result[key] = number;
    } else if (key === 'duplicateWindowMs') {
      const number = candidate;
      if (typeof number !== 'number' || !Number.isInteger(number) || number < 0 || number > 5000) throw new RangeError('Scanner duplicate window must be from 0 to 5000 milliseconds.');
      result[key] = number;
    } else if (key === 'duplicateBehavior') {
      if (!['ignore', 'add_quantity'].includes(candidate)) throw new TypeError('Choose whether duplicate scans are ignored or add quantity.');
      result[key] = candidate;
    } else if (key === 'prefixToStrip' || key === 'suffixToStrip') {
      if (typeof candidate !== 'string' || candidate.length > 32 || /[\u0000-\u001f\u007f-\u009f]/.test(candidate)) {
        throw new TypeError(`Scanner ${key === 'prefixToStrip' ? 'prefix' : 'suffix'} must be at most 32 printable characters.`);
      }
      result[key] = candidate;
    } else if (key === 'feedbackSound') {
      if (typeof candidate !== 'boolean') throw new TypeError('Scanner feedback sound must be enabled or disabled.');
      result[key] = candidate;
    } else if (key === 'enabledSymbologies') {
      if (!Array.isArray(candidate) || candidate.length > SYMBOLOGIES.length
        || candidate.some((item) => !SYMBOLOGIES.includes(item))
        || new Set(candidate).size !== candidate.length) {
        throw new TypeError('Choose valid scanner barcode symbologies.');
      }
      result[key] = [...candidate];
    }
  }

  return result;
}

function normalizeScannerConfiguration(value) {
  if (value != null && !isRecord(value)) throw new TypeError('Scanner settings configuration must be an object.');
  const raw = value || {};
  if (raw.companyDefaults != null && !isRecord(raw.companyDefaults)) throw new TypeError('Company scanner settings must be an object.');
  const openPriceProductId = raw.openPriceProductId == null || raw.openPriceProductId === ''
    ? null
    : String(raw.openPriceProductId);
  if (openPriceProductId !== null && !/^[a-f\d]{24}$/i.test(openPriceProductId)) {
    throw new TypeError('The configured POS open-price product ID is invalid.');
  }
  const companyDefaults = normalizeSettings(raw.companyDefaults || {});
  const normalizeOverrides = (overrides) => {
    if (overrides == null) return {};
    if (!isRecord(overrides)) throw new TypeError('Scanner setting overrides must be an object.');
    return Object.fromEntries(Object.entries(overrides).map(([key, settings]) => {
      if (!key || key.length > 80) throw new TypeError('Scanner setting override key is invalid.');
      return [key, normalizeSettings(settings, { partial: true })];
    }));
  };
  return {
    openPriceProductId,
    companyDefaults,
    tillTypeOverrides: normalizeOverrides(raw.tillTypeOverrides),
    registerOverrides: normalizeOverrides(raw.registerOverrides),
  };
}

function resolveScannerSettings(configuration, { tillType, registerId } = {}) {
  const normalized = normalizeScannerConfiguration(configuration);
  const settings = {
    ...normalized.companyDefaults,
    ...(tillType ? normalized.tillTypeOverrides[String(tillType)] || {} : {}),
    ...(registerId ? normalized.registerOverrides[String(registerId)] || {} : {}),
  };
  if (settings.minimumLength > settings.maximumLength) {
    throw new RangeError('Scanner maximum length must be at least its minimum length.');
  }
  return settings;
}

module.exports = {
  DEFAULT_SCANNER_SETTINGS,
  normalizeScannerConfiguration,
  normalizeSettings,
  resolveScannerSettings,
};
