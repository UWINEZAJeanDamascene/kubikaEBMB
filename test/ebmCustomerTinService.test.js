jest.mock('../models/Company', () => ({ findById: jest.fn() }));
jest.mock('../models/Warehouse', () => ({ findOne: jest.fn() }));
jest.mock('../models/Client', () => ({ findOne: jest.fn(), updateOne: jest.fn() }));
jest.mock('../models/Invoice', () => ({ findOne: jest.fn() }));
jest.mock('../models/EBMTIN', () => ({ findOneAndUpdate: jest.fn() }));
jest.mock('../services/ebmService', () => ({ selectCustomer: jest.fn(), getConfig: jest.fn(() => ({ mode: 'mock' })) }));

const Company = require('../models/Company');
const Warehouse = require('../models/Warehouse');
const EBMTIN = require('../models/EBMTIN');
const ebmService = require('../services/ebmService');
const EBMTinService = require('../services/ebmCustomerTinService');

const leanResult = (value) => ({ lean: jest.fn().mockResolvedValue(value) });

beforeEach(() => {
  jest.clearAllMocks();
  Company.findById.mockReturnValue(leanResult({
    _id: 'company-1',
    tax_identification_number: '999991130',
  }));
  Warehouse.findOne.mockReturnValue(leanResult({
    _id: 'warehouse-1',
    rraBranchId: '00',
  }));
  EBMTIN.findOneAndUpdate.mockResolvedValue({});
  ebmService.selectCustomer.mockResolvedValue({
    resultCd: '000',
    resultMsg: 'Successful',
    resultDt: '20260705120000',
    data: {
      custList: [
        {
          tin: '100000003',
          taxprNm: 'ACME Rwanda Ltd',
          taxprSttsCd: 'A',
          prvncNm: 'Kigali',
          dstrtNm: 'Gasabo',
          sctrNm: 'Gasabo',
          locDesc: 'Sample-only location detail',
        },
      ],
    },
  });
});

describe('EBM customer TIN verification', () => {
  it('builds the RRA VSDC selectCustomer payload with company TIN and customer TIN separated', async () => {
    const verification = await EBMTinService.verifyTin('company-1', '100000003', { branchId: '00' });

    expect(ebmService.selectCustomer).toHaveBeenCalledWith(expect.objectContaining({
      companyId: 'company-1',
      tin: '999991130',
      bhfId: '00',
      custmTin: '100000003',
    }));
    expect(ebmService.selectCustomer.mock.calls[0][0]).not.toHaveProperty('lastReqDt');
    expect(verification).toEqual(expect.objectContaining({
      tin: '100000003',
      branchId: '00',
      status: 'valid',
      taxpayerName: 'ACME Rwanda Ltd',
      resultCd: '000',
      statusCode: 'A',
      outcome: 'matched',
      mode: 'mock',
      source: expect.objectContaining({ locDesc: 'Sample-only location detail' }),
    }));
    expect(EBMTIN.findOneAndUpdate).toHaveBeenCalledWith(
      { company: 'company-1', branchId: '00', tin: '100000003' },
      { $set: expect.objectContaining({ taxpayerName: 'ACME Rwanda Ltd', statusCode: 'A', verificationMode: 'mock', active: true }) },
      { upsert: true, new: true },
    );
  });

  it.each([
    ['A', 'Active', true],
    ['D', 'Discard', true],
    ['X', null, false],
  ])('keeps taxpayer status %s separate from a matched lookup and eligibility', async (statusCode, label, known) => {
    ebmService.selectCustomer.mockResolvedValue({
      resultCd: '000', resultMsg: 'Successful', resultDt: '20261021120000', data: {
        custList: [{
          tin: '100000003', taxprNm: 'ACME Rwanda Ltd', taxprSttsCd: statusCode,
          prvncNm: null, dstrtNm: null, sctrNm: null,
        }],
      },
    });

    const result = await EBMTinService.verifyTin('company-1', '100000003', { branchId: '00' });

    expect(result).toMatchObject({
      outcome: 'matched',
      recordMatched: true,
      status: 'valid',
      statusCode,
      taxpayerStatusCode: statusCode,
      taxpayerStatusLabel: label,
      taxpayerStatusKnown: known,
      taxpayerEligibility: 'not_evaluated',
      source: expect.objectContaining({ taxprSttsCd: statusCode }),
    });
    expect(EBMTIN.findOneAndUpdate).toHaveBeenCalledWith(
      { company: 'company-1', branchId: '00', tin: '100000003' },
      { $set: expect.objectContaining({ statusCode, active: true }) },
      { upsert: true, new: true },
    );
  });

  it('rejects invalid customer TIN before calling VSDC', async () => {
    await expect(EBMTinService.verifyTin('company-1', '12345', { branchId: '00' }))
      .rejects.toMatchObject({ code: 'EBM_CUSTOMER_TIN_INVALID_FORMAT', retryable: false });

    expect(ebmService.selectCustomer).not.toHaveBeenCalled();
  });

  it('does not truncate an overlong TIN into a different valid taxpayer number', async () => {
    await expect(EBMTinService.verifyTin('company-1', '1000000039', { branchId: '00' }))
      .rejects.toMatchObject({ code: 'EBM_CUSTOMER_TIN_INVALID_FORMAT', retryable: false });

    expect(ebmService.selectCustomer).not.toHaveBeenCalled();
  });

  it('rejects malformed branch IDs instead of padding or truncating them into another branch', async () => {
    await expect(EBMTinService.verifyTin('company-1', '100000003', { branchId: '000' }))
      .rejects.toMatchObject({ code: 'EBM_LOOKUP_REQUEST_INVALID', field: 'bhfId' });

    expect(ebmService.selectCustomer).not.toHaveBeenCalled();
  });

  it.each([
    ['taxprNm', 'N'.repeat(61)],
    ['taxprSttsCd', 'S'.repeat(6)],
    ['prvncNm', 'P'.repeat(101)],
    ['dstrtNm', 'D'.repeat(101)],
    ['sctrNm', 'S'.repeat(101)],
  ])('rejects a customer response field exceeding its PDF maximum: %s', async (field, value) => {
    ebmService.selectCustomer.mockResolvedValue({
      resultCd: '000',
      resultMsg: 'Successful',
      resultDt: '20261013120000',
      data: {
        custList: [{
          tin: '100000003',
          taxprNm: 'Valid name',
          taxprSttsCd: 'A',
          prvncNm: 'Kigali',
          dstrtNm: 'Gasabo',
          sctrNm: 'Kacyiru',
          [field]: value,
        }],
      },
    });

    await expect(EBMTinService.verifyTin('company-1', '100000003', { branchId: '00' }))
      .rejects.toMatchObject({ code: 'EBM_CUSTOMER_TIN_RESPONSE_INVALID', statusCode: 502 });
    expect(EBMTIN.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('accepts nullable optional customer location fields and preserves sample-only locDesc', async () => {
    ebmService.selectCustomer.mockResolvedValue({
      resultCd: '000',
      resultMsg: 'Successful',
      resultDt: '20261013120000',
      data: {
        custList: [{
          tin: '100000003',
          taxprNm: 'ACME Rwanda Ltd',
          taxprSttsCd: 'A',
          prvncNm: null,
          dstrtNm: null,
          sctrNm: null,
          locDesc: ' Kicukiro ',
        }],
      },
    });
    const result = await EBMTinService.verifyTin('company-1', '100000003', { branchId: '00' });
    expect(result.source).toMatchObject({ locDesc: ' Kicukiro ' });
    expect(result.provinceName).toBeNull();
  });
});
