'use strict';

jest.mock('../lib/prisma', () => ({ dbClient: jest.fn() }));

const { dbClient } = require('../lib/prisma');
const { effectivePrice, getWarehousePriceListPrices } = require('../services/priceListService');

describe('price list pricing', () => {
  beforeEach(() => jest.clearAllMocks());

  test('loads only the assigned warehouse list and overrides explicit product prices', async () => {
    const effectiveAt = new Date('2026-10-15T12:00:00.000Z');
    const query = jest.fn().mockResolvedValue([
      { priceListId: '111111111111111111111111', productId: '222222222222222222222222', price: '75.50' },
      { priceListId: '111111111111111111111111', productId: null, price: null },
    ]);
    dbClient.mockReturnValue({ $queryRawUnsafe: query });

    const pricing = await getWarehousePriceListPrices(
      'aaaaaaaaaaaaaaaaaaaaaaaa',
      'bbbbbbbbbbbbbbbbbbbbbbbb',
      ['222222222222222222222222', '333333333333333333333333'],
      effectiveAt,
      null,
      false,
    );

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('w.price_list_id'),
      'bbbbbbbbbbbbbbbbbbbbbbbb',
      'aaaaaaaaaaaaaaaaaaaaaaaa',
      ['222222222222222222222222', '333333333333333333333333'],
      effectiveAt,
      false,
      null,
    );
    expect(pricing.priceListId).toBe('111111111111111111111111');
    expect(effectivePrice('222222222222222222222222', 100, pricing.priceByProduct)).toBe(75.5);
    expect(effectivePrice('333333333333333333333333', 100, pricing.priceByProduct)).toBe(100);
  });

  test('uses standard selling prices when no warehouse price list is assigned', async () => {
    const query = jest.fn().mockResolvedValue([{ priceListId: null, productId: null, price: null }]);
    dbClient.mockReturnValue({ $queryRawUnsafe: query });

    const pricing = await getWarehousePriceListPrices('aaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbb', []);

    expect(pricing.priceListId).toBeNull();
    expect(effectivePrice('cccccccccccccccccccccccc', 120, pricing.priceByProduct)).toBe(120);
  });

  test('splits effective-date lookups into query-safe batches of 500', async () => {
    const query = jest.fn().mockResolvedValue([]);
    dbClient.mockReturnValue({ $queryRawUnsafe: query });
    const productIds = Array.from({ length: 501 }, (_, index) => String(index).padStart(24, '0'));
    const effectiveAt = new Date('2026-10-15T12:00:00.000Z');

    await getWarehousePriceListPrices('company-id', 'warehouse-id', productIds, effectiveAt);

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][3]).toHaveLength(500);
    expect(query.mock.calls[1][3]).toHaveLength(1);
    expect(query.mock.calls[1][4]).toEqual(effectiveAt);
    expect(query.mock.calls.every(([sql]) => sql.includes('effective_from <= $4::timestamptz'))).toBe(true);
  });
});
