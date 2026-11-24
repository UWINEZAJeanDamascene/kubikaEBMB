'use strict';

const { dbClient } = require('../lib/prisma');
const Product = require('../models/Product');

describe('Pharmacy product filtering', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('translates Pharmacy status filters into Prisma JSON-path conditions', async () => {
    const findMany = jest.spyOn(dbClient().product, 'findMany').mockResolvedValue([]);

    await Product.find({
      $and: [
        { company: 'company-1', isActive: true },
        {
          'customFields.pharmacy.prescriptionStatus': {
            $in: ['OTC', 'PRESCRIPTION', 'RESTRICTED'],
          },
        },
      ],
    }).limit(50);

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        AND: [
          { companyId: 'company-1', isActive: true },
          {
            OR: [
              { customFields: { path: ['pharmacy', 'prescriptionStatus'], equals: 'OTC' } },
              { customFields: { path: ['pharmacy', 'prescriptionStatus'], equals: 'PRESCRIPTION' } },
              { customFields: { path: ['pharmacy', 'prescriptionStatus'], equals: 'RESTRICTED' } },
            ],
          },
        ],
      }),
    }));
  });
});
