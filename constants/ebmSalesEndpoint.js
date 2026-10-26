const DEFAULT_SAVE_SALES_ENDPOINT = '/transactions/saveSales';
const SPEC_PRINTED_SAVE_SALES_ENDPOINT = '/trnsSales/saveSales';

// These are the two paths already evidenced in this repository: the current
// application path and the path printed in RRA VSDC v1.0.5 §3.3.6.1. Keeping
// the choice in deployment configuration lets an authorized operator select
// the confirmed path without editing application code. It does not itself
// assert that either path is accepted by RRA.
const SAVE_SALES_ENDPOINTS = Object.freeze([
  DEFAULT_SAVE_SALES_ENDPOINT,
  SPEC_PRINTED_SAVE_SALES_ENDPOINT,
]);

function resolveSaveSalesEndpoint(value = process.env.RRA_VSDC_SAVE_SALES_ENDPOINT) {
  if (value == null || String(value).trim() === '') return DEFAULT_SAVE_SALES_ENDPOINT;
  const endpoint = String(value).trim();
  if (!SAVE_SALES_ENDPOINTS.includes(endpoint)) {
    const error = new Error(
      `Invalid RRA_VSDC_SAVE_SALES_ENDPOINT. Choose one of the documented paths: ${SAVE_SALES_ENDPOINTS.join(', ')}.`,
    );
    error.code = 'EBM_SAVE_SALES_ENDPOINT_INVALID';
    throw error;
  }
  return endpoint;
}

const SAVE_SALES_ENDPOINT = resolveSaveSalesEndpoint();

module.exports = {
  DEFAULT_SAVE_SALES_ENDPOINT,
  SPEC_PRINTED_SAVE_SALES_ENDPOINT,
  SAVE_SALES_ENDPOINTS,
  SAVE_SALES_ENDPOINT,
  resolveSaveSalesEndpoint,
};
