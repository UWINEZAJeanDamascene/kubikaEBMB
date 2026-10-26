const { DEFAULT_ACCOUNTS } = require('../constants/chartOfAccounts');
const accountMappingService = require('./accountMappingService');

async function getDefaultWarehouseInventoryAccount(companyId) {
  return accountMappingService.resolve(
    companyId,
    'inventory',
    'inventory',
    DEFAULT_ACCOUNTS.inventory,
  );
}

module.exports = { getDefaultWarehouseInventoryAccount };
