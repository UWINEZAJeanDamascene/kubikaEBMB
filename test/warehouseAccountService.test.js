jest.mock('../services/accountMappingService', () => ({
  resolve: jest.fn(),
}));

const accountMappingService = require('../services/accountMappingService');
const { DEFAULT_ACCOUNTS } = require('../constants/chartOfAccounts');
const { getDefaultWarehouseInventoryAccount } = require('../services/warehouseAccountService');

describe('getDefaultWarehouseInventoryAccount', () => {
  it('uses the company inventory account mapping with the standard inventory account as fallback', async () => {
    accountMappingService.resolve.mockResolvedValue('1410');

    await expect(getDefaultWarehouseInventoryAccount('company-1')).resolves.toBe('1410');
    expect(accountMappingService.resolve).toHaveBeenCalledWith(
      'company-1',
      'inventory',
      'inventory',
      DEFAULT_ACCOUNTS.inventory,
    );
  });
});
