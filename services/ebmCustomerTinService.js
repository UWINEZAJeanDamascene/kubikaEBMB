const Company = require('../models/Company');
const Warehouse = require('../models/Warehouse');
const Client = require('../models/Client');
const Invoice = require('../models/Invoice');
const EBMTIN = require('../models/EBMTIN');
const ebmService = require('./ebmService');
const { validateLookupResponse, VSDC_ENDPOINTS } = require('../utils/vsdcPayloadSanitizer');
const CODE_DEFINITION_BASELINE = require('../fixtures/rraVsdc/v1.0.5/code-definitions-4.1-4.3.json');

function getTaxpayerStatusDefinition(statusCode) {
  const statusClass = CODE_DEFINITION_BASELINE.classifications.find((item) => item.codeClass === '15');
  return statusClass?.details.find((item) => item.code === statusCode) || null;
}

function normalizeTin(value) {
  if (typeof value !== 'string') return '';
  const input = String(value ?? '').trim();
  return /^\d{9}$/.test(input) ? input : '';
}

function normalizeStoredTin(value) {
  if (typeof value !== 'string') return '';
  const input = value.trim();
  if (/^\d{3}-\d{3}-\d{3}$/.test(input)) return input.replace(/-/g, '');
  return normalizeTin(input);
}

function normalizeBranchId(value) {
  const branchId = String(value ?? '00').trim();
  if (!/^[A-Za-z0-9]{2}$/.test(branchId)) {
    const error = new Error('Branch ID must be exactly 2 characters for RRA VSDC lookup.');
    error.code = 'EBM_LOOKUP_REQUEST_INVALID';
    error.statusCode = 422;
    error.field = 'bhfId';
    throw error;
  }
  return branchId;
}

function getCompanyTin(company) {
  return normalizeTin(company?.tax_identification_number || company?.registration_number || company?.tin);
}

async function resolveBranchId(companyId, requestedBranchId = null) {
  if (requestedBranchId) {
    const branchId = normalizeBranchId(requestedBranchId);
    const warehouse = await Warehouse.findOne({ company: companyId, rraBranchId: branchId }).lean();
    if (!warehouse) {
      const error = new Error('The requested RRA branch is not configured for this company.');
      error.code = 'EBM_LOOKUP_BRANCH_NOT_CONFIGURED';
      error.statusCode = 422;
      error.retryable = false;
      throw error;
    }
    return branchId;
  }
  const warehouse = await Warehouse.findOne({ company: companyId, isDefault: true }).lean()
    || await Warehouse.findOne({ company: companyId }).sort({ createdAt: 1 }).lean();
  if (!warehouse?.rraBranchId) {
    const error = new Error('Configure an RRA branch ID on a company warehouse before customer TIN lookup.');
    error.code = 'EBM_LOOKUP_BRANCH_NOT_CONFIGURED';
    error.statusCode = 422;
    error.retryable = false;
    throw error;
  }
  return normalizeBranchId(warehouse.rraBranchId);
}

function getRawResponse(response, error) {
  const candidate = response || error?.response || error?.cause?.response || null;
  return candidate?.raw || candidate;
}

function validateCustomerRecord(record, index) {
  const malformed = (field, detail) => {
    const error = new Error(`RRA customer record ${index + 1} has invalid ${field}: ${detail}.`);
    error.code = 'EBM_CUSTOMER_TIN_RESPONSE_INVALID';
    error.statusCode = 502;
    error.retryable = false;
    throw error;
  };
  if (!record || typeof record !== 'object' || Array.isArray(record)) malformed('record', 'expected an object');
  if (typeof record.tin !== 'string' || !/^\d{9}$/.test(record.tin)) malformed('tin', 'expected a 9-digit string');
  if (typeof record.taxprNm !== 'string' || !record.taxprNm.trim() || record.taxprNm.length > 60) {
    malformed('taxprNm', 'expected a non-empty string of at most 60 characters');
  }
  if (typeof record.taxprSttsCd !== 'string' || !record.taxprSttsCd.trim() || record.taxprSttsCd.length > 5) {
    malformed('taxprSttsCd', 'expected a non-empty status code string of at most 5 characters');
  }
  for (const [field, maxLength] of Object.entries({ prvncNm: 100, dstrtNm: 100, sctrNm: 100 })) {
    if (record[field] != null && (typeof record[field] !== 'string' || record[field].length > maxLength)) {
      malformed(field, `expected a string of at most ${maxLength} characters or null`);
    }
  }
  // locDesc is shown in the example only. Keep it in source without assuming a schema.
  return record;
}

function buildVerification({ customerTin, branchId, companyId, response, record, outcome, status, error = null }) {
  const raw = getRawResponse(response, error);
  const mode = ebmService.getConfig().mode;
  const taxpayerStatus = record ? getTaxpayerStatusDefinition(record.taxprSttsCd) : null;
  return {
    tin: customerTin,
    branchId,
    companyId: String(companyId),
    status: status || (record ? 'valid' : 'invalid'),
    outcome,
    lookupStatus: record ? 'matched' : outcome,
    recordMatched: Boolean(record),
    mode,
    verificationSource: mode === 'mock' ? 'mock' : 'vsdc',
    taxpayerName: record?.taxprNm || null,
    statusCode: record?.taxprSttsCd || null,
    taxpayerStatusCode: record?.taxprSttsCd || null,
    taxpayerStatusLabel: taxpayerStatus?.name || null,
    taxpayerStatusKnown: Boolean(taxpayerStatus),
    taxpayerEligibility: 'not_evaluated',
    provinceName: record?.prvncNm ?? null,
    districtName: record?.dstrtNm ?? null,
    sectorName: record?.sctrNm ?? null,
    verifiedAt: new Date(),
    resultCd: raw?.resultCd ?? error?.resultCd ?? null,
    resultMsg: raw?.resultMsg ?? error?.resultMsg ?? error?.message ?? null,
    resultDt: raw?.resultDt ?? null,
    source: record || null,
  };
}

async function upsertTin(companyId, branchId, record) {
  return EBMTIN.findOneAndUpdate(
    { company: companyId, branchId, tin: record.tin },
    {
      $set: {
        company: companyId,
        branchId,
        tin: record.tin,
        taxpayerName: record.taxprNm,
        statusCode: record.taxprSttsCd,
        provinceName: record.prvncNm ?? null,
        districtName: record.dstrtNm ?? null,
        sectorName: record.sctrNm ?? null,
        verificationMode: ebmService.getConfig().mode,
        // This flag describes a cached lookup row, not taxpayer eligibility or
        // the meaning of RRA's taxprSttsCd. Keep that code in its own field.
        active: true,
        source: record,
        lastSyncedAt: new Date(),
      },
    },
    { upsert: true, new: true },
  );
}

async function verifyTin(companyId, customerTinValue, options = {}) {
  const customerTin = normalizeTin(customerTinValue);
  if (!customerTin) {
    const error = new Error('Customer TIN must be a 9 digit Rwanda TIN before RRA verification.');
    error.code = 'EBM_CUSTOMER_TIN_INVALID_FORMAT';
    error.retryable = false;
    throw error;
  }

  const company = await Company.findById(companyId).lean();
  const tin = getCompanyTin(company);
  if (!tin) {
    const error = new Error('Company TIN must be a valid 9-digit Rwanda TIN before verifying a customer.');
    error.code = 'EBM_COMPANY_TIN_INVALID_FORMAT';
    error.retryable = false;
    throw error;
  }

  const branchId = await resolveBranchId(companyId, options.branchId || options.bhfId);
  let response = null;
  try {
    response = await ebmService.selectCustomer({ companyId, tin, bhfId: branchId, custmTin: customerTin });
    const raw = getRawResponse(response);
    const validated = validateLookupResponse(VSDC_ENDPOINTS.SELECT_CUSTOMER, raw);
    const list = validated.data.custList;
    const records = list.map(validateCustomerRecord);
    const record = records.find((item) => item.tin === customerTin) || null;
    if (!record) {
      const error = new Error('RRA completed the customer lookup but returned no record matching the requested TIN.');
      error.code = 'EBM_CUSTOMER_TIN_NOT_FOUND';
      error.statusCode = 404;
      error.retryable = false;
      error.response = raw;
      error.verification = buildVerification({ customerTin, branchId, companyId, response: raw, outcome: 'not_found', error });
      throw error;
    }
    await upsertTin(companyId, branchId, record);
    return buildVerification({ customerTin, branchId, companyId, response: raw, record, outcome: 'matched', status: 'valid' });
  } catch (error) {
    if (error.code === 'EBM_CUSTOMER_TIN_INVALID_FORMAT' || error.code === 'EBM_COMPANY_TIN_INVALID_FORMAT') throw error;
    if (error.verification) throw error;
    const raw = getRawResponse(null, error);
    const rejected = Boolean(raw?.resultCd && raw.resultCd !== '000');
    const outcome = raw?.resultCd === '884'
      ? 'invalid_tin'
      : (error.code === 'EBM_CUSTOMER_TIN_RESPONSE_INVALID' || error.code === 'EBM_LOOKUP_RESPONSE_MALFORMED'
      ? 'invalid_response'
      : (rejected ? 'rra_rejected' : 'transport_error'));
    error.verification = buildVerification({ customerTin, branchId, companyId, response: raw, outcome, status: 'invalid', error });
    error.retryable = false;
    if (!error.statusCode) error.statusCode = outcome === 'invalid_tin' ? 422 : 502;
    if (!error.code) error.code = rejected ? `EBM_VSDC_${raw.resultCd}` : 'EBM_CUSTOMER_TIN_VERIFY_FAILED';
    throw error;
  }
}

async function verifyClientTin(companyId, clientId, options = {}) {
  const client = await Client.findOne({ _id: clientId, company: companyId });
  if (!client) {
    const error = new Error('Client not found for RRA TIN verification.');
    error.code = 'EBM_CLIENT_NOT_FOUND';
    error.retryable = false;
    throw error;
  }
  const verification = await verifyTin(companyId, normalizeStoredTin(client.taxId), options).catch(async (error) => {
    if (error.verification) {
      client.ebmTinVerification = error.verification;
      await client.save();
    }
    throw error;
  });
  client.ebmTinVerification = verification;
  await client.save();
  return { client, verification };
}

async function verifyInvoiceCustomerTin(companyId, invoiceId, options = {}) {
  const invoice = await Invoice.findOne({ _id: invoiceId, company: companyId }).populate('client');
  if (!invoice) {
    const error = new Error('Invoice not found for RRA customer TIN verification.');
    error.code = 'EBM_INVOICE_NOT_FOUND';
    error.retryable = false;
    throw error;
  }
  const customerTin = normalizeStoredTin(invoice.customerTin || invoice.client?.taxId);
  const verification = await verifyTin(companyId, customerTin, options).catch(async (error) => {
    if (error.verification) {
      invoice.ebmCustomerTinVerification = error.verification;
      invoice.ebm = invoice.ebm || {};
      invoice.ebm.customerTinVerification = error.verification;
      await invoice.save();
    }
    throw error;
  });
  invoice.customerTin = verification.tin;
  invoice.ebmCustomerTinVerification = verification;
  invoice.ebm = invoice.ebm || {};
  invoice.ebm.customerTinVerification = verification;
  await invoice.save();
  if (invoice.client?._id) {
    await Client.updateOne(
      { _id: invoice.client._id, company: companyId, taxId: verification.tin },
      { $set: { ebmTinVerification: verification } },
    );
  }
  return { invoice, verification };
}

module.exports = { normalizeTin, normalizeBranchId, resolveBranchId, verifyTin, verifyClientTin, verifyInvoiceCustomerTin };
