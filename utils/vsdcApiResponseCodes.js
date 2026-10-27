const baseline = require('../fixtures/rraVsdc/v1.0.5/api-response-codes-4.14.json');

const VSDC_API_RESPONSE_CODES = Object.freeze(baseline.codes.map((record) => Object.freeze({ ...record })));
const codesByValue = new Map(VSDC_API_RESPONSE_CODES.map((record) => [record.code, record]));

function getVsdcApiResponseCode(value) {
  if (typeof value !== 'string') return null;
  return codesByValue.get(value) || null;
}

module.exports = {
  VSDC_API_RESPONSE_CODES,
  getVsdcApiResponseCode,
};
