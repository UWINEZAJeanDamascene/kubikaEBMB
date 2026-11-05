'use strict';

jest.mock('../lib/prisma', () => ({
  prisma: { $queryRawUnsafe: jest.fn() },
}));

const { prisma } = require('../lib/prisma');
const { create } = require('../controllers/posPromotionController');

function mockResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function request(discountType, value) {
  const startsAt = new Date(Date.now() + 60_000);
  const endsAt = new Date(Date.now() + 24 * 60 * 60_000);
  return {
    user: { id: 'user-id', company: { _id: 'company-id' } },
    body: {
      name: 'Manager promotion',
      code: 'MANAGER75',
      discountType,
      value,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
    },
  };
}

describe('POS promotion controller', () => {
  beforeEach(() => jest.clearAllMocks());

  test.each([
    ['percent', 75],
    ['fixed', 1500000],
  ])('accepts a valid %s discount above the former environment cap', async (discountType, value) => {
    prisma.$queryRawUnsafe.mockResolvedValue([{
      id: 'promotion-id',
      name: 'Manager promotion',
      code: 'MANAGER75',
      discount_type: discountType,
      value,
      starts_at: new Date(),
      ends_at: new Date(Date.now() + 24 * 60 * 60_000),
      is_active: true,
    }]);
    const res = mockResponse();

    await create(request(discountType, value), res, (error) => { throw error; });

    expect(res.statusCode).toBe(201);
    expect(res.body.data.value).toBe(value);
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO pos_promotions'),
      expect.any(String),
      'company-id',
      'Manager promotion',
      'MANAGER75',
      discountType,
      value,
      expect.any(Date),
      expect.any(Date),
      'user-id',
    );
  });
});
