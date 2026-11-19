'use strict';

const mockPrisma = {
  posRegister: { findFirst: jest.fn() },
  posNonPostingDocument: { create: jest.fn() },
};
const mockDatabase = {
  systemSettings: { findUnique: jest.fn() },
  category: { findMany: jest.fn() },
  warehouse: { findFirst: jest.fn() },
};
const mockProducts = { find: jest.fn() };
const mockClient = { findOne: jest.fn() };

jest.mock('../lib/prisma', () => ({
  prisma: mockPrisma,
  dbClient: jest.fn(() => mockDatabase),
}));
jest.mock('../models/Product', () => mockProducts);
jest.mock('../models/Client', () => mockClient);
jest.mock('../utils/objectId', () => ({ generateObjectId: jest.fn(() => 'eeeeeeeeeeeeeeeeeeeeeeee') }));

const { createDocument } = require('../services/posNonPostingDocumentService');

const companyId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const registerId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const userId = 'cccccccccccccccccccccccc';
const regularProductId = 'dddddddddddddddddddddd01';
const restrictedProductId = 'dddddddddddddddddddddd02';

function configureProducts() {
  const products = [
    {
      _id: regularProductId,
      name: 'Tea',
      sku: 'TEA',
      sellingPrice: 100,
      taxRate: 0,
      category: 'regular-category',
      isNoDiscount: false,
    },
    {
      _id: restrictedProductId,
      name: 'Rice',
      sku: 'RICE',
      sellingPrice: 50,
      taxRate: 0,
      category: 'restricted-category',
      isNoDiscount: false,
    },
  ];

  mockProducts.find.mockImplementation((query) => ({
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(products.filter((product) => query._id.$in.includes(product._id))),
    }),
  }));
}

describe('POS non-posting document service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.posRegister.findFirst.mockResolvedValue({ id: registerId, trainingMode: false });
    mockPrisma.posNonPostingDocument.create.mockImplementation(({ data }) => Promise.resolve(data));
    mockDatabase.systemSettings.findUnique.mockResolvedValue({
      posDiscountSettings: {
        defaultLimits: { maxLineDiscountPercent: null, maxCartDiscountPercent: null, maxSaleDiscountRwf: null },
        rules: [],
        discountReasons: ['Damaged packaging'],
        systemTillTypes: ['retail'],
        registerLabels: [],
      },
    });
    mockDatabase.category.findMany.mockResolvedValue([{ id: 'restricted-category' }]);
    mockDatabase.warehouse.findFirst.mockResolvedValue({ id: 'ffffffffffffffffffffffff' });
    configureProducts();
  });

  test('saves cart savings and excludes no-discount categories from proformas', async () => {
    await createDocument({
      companyId,
      registerId,
      userId,
      kind: 'PROFORMA',
      input: {
        warehouseId: 'ffffffffffffffffffffffff',
        cartDiscountPct: 10,
        cartDiscountReason: 'Damaged packaging',
        items: [
          { productId: regularProductId, quantity: 1, unitPrice: 100 },
          { productId: restrictedProductId, quantity: 1, unitPrice: 50 },
        ],
      },
    });

    const saved = mockPrisma.posNonPostingDocument.create.mock.calls[0][0].data.documentData;
    expect(saved.items.map((item) => [item.discountPct, item.discountAmount, item.discountReason])).toEqual([
      [10, 10, 'Damaged packaging'],
      [0, 0, ''],
    ]);
    expect(saved).toMatchObject({
      cartDiscountPct: 10,
      cartDiscountReason: 'Damaged packaging',
      subtotal: 150,
      discountAmount: 10,
      totalAmount: 140,
    });
  });

  test('rejects cart discounts without a configured reason', async () => {
    await expect(createDocument({
      companyId,
      registerId,
      userId,
      kind: 'PROFORMA',
      input: {
        cartDiscountPct: 10,
        cartDiscountReason: 'Unconfigured',
        items: [{ productId: regularProductId, quantity: 1, unitPrice: 100 }],
      },
    })).rejects.toMatchObject({ code: 'POS_DISCOUNT_REASON_REQUIRED' });

    expect(mockPrisma.posNonPostingDocument.create).not.toHaveBeenCalled();
  });

  test('saves draft delivery notes as informational documents without conversion state', async () => {
    mockClient.findOne.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ name: 'Wholesale Customer', contact: {}, address: null }),
      }),
    });

    await createDocument({
      companyId,
      registerId,
      userId,
      kind: 'DELIVERY_NOTE',
      input: {
        clientId: 'ffffffffffffffffffffff01',
        warehouseId: 'ffffffffffffffffffffffff',
        items: [{ productId: regularProductId, quantity: 1, unitPrice: 100 }],
      },
    });

    expect(mockPrisma.posNonPostingDocument.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        documentType: 'DELIVERY_NOTE',
        status: 'open',
        conversionKey: null,
        documentData: expect.objectContaining({
          informationalOnly: true,
          stockMovementPosted: false,
          warehouseId: 'ffffffffffffffffffffffff',
        }),
      }),
    });
  });
});
