jest.mock('../services/ebmDeviceService', () => ({
  ensureInitialized: jest.fn().mockResolvedValue({}),
}));

const { EBMService, VSDC_ENDPOINTS } = require('../services/ebmService');

describe('VSDC import response numeric preservation', () => {
  it('keeps unquoted imported foreign-currency amount and rate digits exact through the HTTP response path', async () => {
    const amount = '1234567890123456.78';
    const rate = '9876543210987654.32';
    const raw = `{"resultCd":"000","resultMsg":"It is succeeded","resultDt":"20260705123456","data":{"itemList":[{"invcFcurAmt":${amount},"invcFcurCd":"USD","invcFcurExcrt":${rate},"qty":12.5,"label":"amount 123.45"}]}}`;
    const service = new EBMService({ mode: 'sandbox' });
    service.http.post = jest.fn(async (_endpoint, _payload, config) => ({
      data: config.transformResponse[0](raw),
    }));

    const response = await service.call(VSDC_ENDPOINTS.SELECT_IMPORT_ITEMS, {
      tin: '999991130', bhfId: '00', lastReqDt: '20200101000000',
    });

    expect(service.http.post).toHaveBeenCalledWith(
      VSDC_ENDPOINTS.SELECT_IMPORT_ITEMS,
      expect.any(Object),
      expect.objectContaining({ responseType: 'text', transformResponse: expect.any(Array) }),
    );
    expect(response.data.itemList[0]).toMatchObject({
      invcFcurAmt: amount,
      invcFcurCd: 'USD',
      invcFcurExcrt: rate,
      qty: 12.5,
      label: 'amount 123.45',
    });
  });

  it('marks malformed import response JSON without partially accepting it', async () => {
    const service = new EBMService({ mode: 'sandbox' });
    service.http.post = jest.fn(async (_endpoint, _payload, config) => ({
      data: config.transformResponse[0]('{invalid json'),
    }));

    await expect(service.call(VSDC_ENDPOINTS.SELECT_IMPORT_ITEMS, {
      tin: '999991130', bhfId: '00', lastReqDt: '20200101000000',
    })).rejects.toMatchObject({ code: 'EBM_VSDC_REJECTED' });
  });
});
