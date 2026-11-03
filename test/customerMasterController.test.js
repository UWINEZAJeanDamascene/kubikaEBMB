'use strict';

jest.mock('../services/customerService', () => ({
  searchCustomers: jest.fn(),
  quickAddCustomer: jest.fn(),
  requireCompanyId: jest.fn((id) => id),
  findCustomerDuplicates: jest.fn(),
  getCustomerLedgers: jest.fn(),
}));

const service = require('../services/customerService');
const controller = require('../controllers/customerMasterController');

function response() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

describe('customer master API controller', () => {
  beforeEach(() => jest.clearAllMocks());

  test('quick-add is scoped to the signed-in company and actor', async () => {
    service.quickAddCustomer.mockResolvedValue({ id: 'customer-a', name: 'Customer' });
    const req = {
      user: { id: 'user-a', company: { _id: 'company-a' } },
      body: { name: 'Customer', phone: '078 123 4567' },
    };
    const res = response();
    await controller.quickAdd(req, res);
    expect(service.quickAddCustomer).toHaveBeenCalledWith({
      companyId: 'company-a', userId: 'user-a', input: req.body,
    });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { id: 'customer-a', name: 'Customer' } });
  });

  test('search scopes by company and supports a query and bounded limit input', async () => {
    service.searchCustomers.mockResolvedValue([]);
    const res = response();
    await controller.search({ user: { company: { id: 'company-a' } }, query: { query: '07812', limit: '100' } }, res);
    expect(service.searchCustomers).toHaveBeenCalledWith({ companyId: 'company-a', query: '07812', limit: '100' });
    expect(res.json).toHaveBeenCalledWith({ success: true, data: [] });
  });

  test('ledger endpoint scopes the customer by the signed-in company', async () => {
    service.getCustomerLedgers.mockResolvedValue({ customerId: 'customer-a', creditEntries: [], loyaltyEntries: [] });
    const res = response();
    await controller.ledgers({ user: { company: { id: 'company-a' } }, params: { id: 'customer-a' }, query: { limit: '50' } }, res);
    expect(service.getCustomerLedgers).toHaveBeenCalledWith({ companyId: 'company-a', customerId: 'customer-a', limit: '50' });
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { customerId: 'customer-a', creditEntries: [], loyaltyEntries: [] } });
  });
});
