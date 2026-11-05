jest.mock('../services/posDiscountReportsService', () => ({
  getPosDiscountReports: jest.fn(),
}));

const { getPosDiscountReports } = require('../services/posDiscountReportsService');
const controller = require('../controllers/posDiscountReportsController');

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

describe('POS discount reports controller', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns reports for the authenticated company and supplied filters', async () => {
    const data = { summary: { salesCount: 4 } };
    getPosDiscountReports.mockResolvedValue(data);
    const res = response();

    await controller.getReports({
      user: { company: { id: 'company-1' } },
      query: { from: '2026-11-01', to: '2026-11-03' },
    }, res, jest.fn());

    expect(getPosDiscountReports).toHaveBeenCalledWith('company-1', { from: '2026-11-01', to: '2026-11-03' });
    expect(res.body).toEqual({ success: true, data });
  });

  test('returns report validation errors explicitly', async () => {
    getPosDiscountReports.mockRejectedValue(Object.assign(new Error('Choose a shorter date range.'), {
      statusCode: 400,
      code: 'POS_REPORT_RANGE_TOO_LARGE',
    }));
    const res = response();
    const next = jest.fn();

    await controller.getReports({ user: { companyId: 'company-1' }, query: {} }, res, next);

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: 'POS_REPORT_RANGE_TOO_LARGE' });
    expect(next).not.toHaveBeenCalled();
  });
});
