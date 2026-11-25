const requireCompanyHeader = require('../middleware/requireCompanyHeader');

describe('requireCompanyHeader', () => {
  const response = () => {
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    return res;
  };

  it('rejects a selected company that differs from the authenticated company', () => {
    const req = {
      headers: { 'x-company-id': 'company-b' },
      company: { _id: 'company-a' },
      isPlatformAdmin: false,
    };
    const res = response();
    const next = jest.fn();

    requireCompanyHeader(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('continues only when the selected company matches the authenticated company', () => {
    const req = {
      headers: { 'x-company-id': 'company-a' },
      company: { _id: 'company-a' },
      isPlatformAdmin: false,
    };
    const res = response();
    const next = jest.fn();

    requireCompanyHeader(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
