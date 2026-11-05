jest.mock('../lib/prisma', () => ({ prisma: {} }));

const { getBankDepositClearingBalances } = require('../services/posBankDepositClearingService');

test('reports posted bank-deposit clearing balances by register within one company', async () => {
  const client = {
    $queryRawUnsafe: jest.fn().mockResolvedValue([
      { registerId: 'register-a', balance: '15000' },
      { registerId: 'register-b', balance: '7000' },
    ]),
  };

  await expect(getBankDepositClearingBalances('company-a', client)).resolves.toEqual(
    new Map([['register-a', 15000], ['register-b', 7000]]),
  );
  expect(client.$queryRawUnsafe).toHaveBeenCalledWith(
    expect.stringContaining('movement.company_id = $1'),
    'company-a',
  );
});
