const { getStockSaveBlock } = require('../services/ebmStockContractGate');

const FLAGS = [
  'EBM_STOCK_MOVEMENT_ENDPOINT_CONFIRMED',
  'EBM_STOCK_MOVEMENT_CONTRACT_CONFIRMED',
  'EBM_STOCK_MOVEMENT_SANDBOX_VERIFIED',
  'EBM_STOCK_MASTER_ENDPOINT_CONFIRMED',
  'EBM_STOCK_MASTER_CONTRACT_CONFIRMED',
  'EBM_STOCK_MASTER_SANDBOX_VERIFIED',
];

describe('EBM stock save release gates', () => {
  let original;
  beforeEach(() => {
    original = Object.fromEntries(FLAGS.map((flag) => [flag, process.env[flag]]));
    FLAGS.forEach((flag) => delete process.env[flag]);
  });
  afterEach(() => {
    FLAGS.forEach((flag) => {
      if (original[flag] === undefined) delete process.env[flag];
      else process.env[flag] = original[flag];
    });
  });

  it('keeps mock stock saves available without external approval flags', () => {
    expect(getStockSaveBlock('/stock/saveStockItems', 'mock')).toBeNull();
    expect(getStockSaveBlock('/stock/saveStockMaster', 'mock')).toBeNull();
  });

  it('requires endpoint and full contract confirmation before sandbox movement dispatch', () => {
    const endpoint = '/stock/saveStockItems';
    expect(getStockSaveBlock(endpoint, 'sandbox').code).toBe('EBM_STOCK_MOVEMENT_ENDPOINT_UNCONFIRMED');
    process.env.EBM_STOCK_MOVEMENT_ENDPOINT_CONFIRMED = 'true';
    expect(getStockSaveBlock(endpoint, 'sandbox').code).toBe('EBM_STOCK_MOVEMENT_CONTRACT_UNCONFIRMED');
    process.env.EBM_STOCK_MOVEMENT_CONTRACT_CONFIRMED = 'true';
    expect(getStockSaveBlock(endpoint, 'sandbox')).toBeNull();
  });

  it('requires a completed sandbox verification before production movement dispatch', () => {
    process.env.EBM_STOCK_MOVEMENT_ENDPOINT_CONFIRMED = 'true';
    process.env.EBM_STOCK_MOVEMENT_CONTRACT_CONFIRMED = 'true';
    expect(getStockSaveBlock('/stock/saveStockItems', 'production').code)
      .toBe('EBM_STOCK_MOVEMENT_SANDBOX_UNVERIFIED');
    process.env.EBM_STOCK_MOVEMENT_SANDBOX_VERIFIED = 'true';
    expect(getStockSaveBlock('/stock/saveStockItems', 'production')).toBeNull();
  });

  it('applies independent endpoint, contract, and sandbox gates to stock master', () => {
    const endpoint = '/stock/saveStockMaster';
    expect(getStockSaveBlock(endpoint, 'sandbox').code).toBe('EBM_STOCK_MASTER_ENDPOINT_UNCONFIRMED');
    process.env.EBM_STOCK_MASTER_ENDPOINT_CONFIRMED = 'true';
    expect(getStockSaveBlock(endpoint, 'sandbox').code).toBe('EBM_STOCK_MASTER_CONTRACT_UNCONFIRMED');
    process.env.EBM_STOCK_MASTER_CONTRACT_CONFIRMED = 'true';
    expect(getStockSaveBlock(endpoint, 'sandbox')).toBeNull();
    expect(getStockSaveBlock(endpoint, 'production').code).toBe('EBM_STOCK_MASTER_SANDBOX_UNVERIFIED');
  });
});
