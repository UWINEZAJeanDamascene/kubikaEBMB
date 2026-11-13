'use strict';

const {
  buildPricing,
  canonicalCart,
  cartHash,
  createVouchers,
  generateCode,
  hash,
  prepareVoucherRules,
  redeemReservation,
  reserveVoucher,
} = require('../services/posVoucherService');

jest.mock('../lib/prisma', () => ({ dbClient: jest.fn() }));
jest.mock('../services/transactionService', () => ({ runInTransaction: jest.fn() }));
jest.mock('../services/posAuditService', () => ({
  writePosAuditLog: jest.fn().mockResolvedValue(undefined),
  writePosDenialAudit: jest.fn().mockResolvedValue(undefined),
}));

const { dbClient } = require('../lib/prisma');
const { runInTransaction } = require('../services/transactionService');
const { writePosAuditLog, writePosDenialAudit } = require('../services/posAuditService');

describe('POS voucher service', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('generates short, grouped codes without ambiguous characters', () => {
    const code = generateCode();

    expect(code).toMatch(/^VCH-[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}$/);
    expect(code).toHaveLength(15);
  });

  test('commits voucher creation and its audit event in one transaction', async () => {
    const tx = {
      posVoucher: {
        create: jest.fn(async ({ data }) => ({ ...data, createdAt: new Date(), updatedAt: new Date() })),
      },
    };
    dbClient.mockReturnValue({ $transaction: jest.fn(async (callback) => callback(tx)) });

    const result = await createVouchers('company-1', 'manager-1', {
      name: 'Spring voucher',
      discountType: 'fixed',
      value: 100,
      startsAt: new Date(Date.now() + 60_000).toISOString(),
      endsAt: new Date(Date.now() + 86_400_000).toISOString(),
    }, 1);

    expect(result).toHaveLength(1);
    expect(tx.posVoucher.create).toHaveBeenCalledTimes(1);
    expect(writePosAuditLog).toHaveBeenCalledTimes(1);
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'VOUCHER_CREATED',
      companyId: 'company-1',
      userId: 'manager-1',
    }), tx);
  });

  test('normalizes cart data and hashes all pricing-relevant fields', () => {
    const cart = canonicalCart({
      items: [{ productId: 'item-1', quantity: 2, unitPrice: 1000, discountPct: 0 }],
      clientId: 'client-1',
      warehouseId: 'warehouse-1',
    });

    expect(cart.items[0].catalogUnitPrice).toBe(1000);
    expect(cart.clientId).toBe('client-1');
    expect(cartHash(cart)).not.toBe(cartHash({
      ...cart,
      items: [{ ...cart.items[0], quantity: 1 }],
    }));
  });

  test('rejects invalid discount and single-use limits', () => {
    const dates = {
      name: 'Spring voucher',
      discountType: 'percent',
      value: 10,
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      endsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    };

    expect(() => prepareVoucherRules({ ...dates, value: 101 })).toThrow(
      expect.objectContaining({ code: 'POS_VOUCHER_RULES_INVALID' }),
    );
    expect(prepareVoucherRules({ ...dates, singleUse: true }).totalUsageLimit).toBe(1);
  });

  test('allocates voucher discounts only to eligible, non-excluded lines', () => {
    const cart = canonicalCart({
      items: [
        { productId: 'eligible', quantity: 1, unitPrice: 1000 },
        { productId: 'excluded', quantity: 1, unitPrice: 500 },
      ],
    });
    const pricing = buildPricing({
      cart,
      productsById: new Map([
        ['eligible', { price: 1000, taxCode: 'A' }],
        ['excluded', { price: 500, taxCode: 'A' }],
      ]),
      voucher: {
        id: 'voucher-1',
        name: 'Spring voucher',
        codeSuffix: 'ABCD',
        discountType: 'percent',
        value: 20,
        maxDiscountRwf: 150,
        minSpendRwf: 0,
        canCombineWithDiscounts: true,
        excludedProductIds: ['excluded'],
      },
    });

    expect(pricing.voucherRedemption.amountRwf).toBe(150);
    expect(pricing.voucherRedemption.maskedCode).toBe('****ABCD');
    expect(pricing.lines.map((line) => line.voucherDiscountRwf)).toEqual([150, 0]);
  });

  test('does not allocate voucher discounts to items the catalog marks non-discountable', () => {
    const cart = canonicalCart({
      items: [{ productId: 'no-discount', quantity: 1, unitPrice: 1000 }],
    });

    const pricing = buildPricing({
      cart,
      productsById: new Map([['no-discount', { price: 1000, isNoDiscount: true }]]),
      voucher: {
        id: 'voucher-1',
        name: 'Spring voucher',
        codeSuffix: 'ABCD',
        discountType: 'fixed',
        value: 100,
        minSpendRwf: 0,
        canCombineWithDiscounts: true,
      },
    });

    expect(pricing.voucherRedemption.amountRwf).toBe(0);
    expect(pricing.lines[0].voucherDiscountRwf).toBe(0);
  });

  test('locks voucher and reservation rows before consuming a reservation', async () => {
    const token = 'reservation-token';
    const cartInput = {
      items: [{ productId: 'item-1', quantity: 1, unitPrice: 1000 }],
    };
    const cart = canonicalCart(cartInput);
    const operations = [];
    const redemption = {
      id: 'redemption-1',
      voucherId: 'voucher-1',
      companyId: 'company-1',
      cashierId: 'cashier-1',
      clientId: null,
      reservationTokenHash: hash(token),
      invoiceId: null,
      status: 'RESERVED',
      expiresAt: new Date(Date.now() + 60_000),
      cartKeyHash: cartHash(cart),
      discountRwf: 100,
    };
    const tx = {
      $queryRaw: jest.fn(async (query) => {
        operations.push(query.join(' '));
        return [];
      }),
      posVoucherRedemption: {
        findMany: jest.fn(async () => {
          operations.push('findMany');
          return [redemption];
        }),
        update: jest.fn(async () => {
          operations.push('update');
          return redemption;
        }),
      },
      posVoucher: {
        findFirst: jest.fn(async () => ({
          id: 'voucher-1',
          companyId: 'company-1',
          name: 'Spring Offer',
          status: 'ACTIVE',
          startsAt: new Date(Date.now() - 60_000),
          endsAt: new Date(Date.now() + 60_000),
          discountType: 'fixed',
          value: 100,
          maxDiscountRwf: null,
          minSpendRwf: 0,
          canCombineWithDiscounts: true,
          excludedProductIds: [],
          excludedCategoryIds: [],
          codeSuffix: 'AB12',
        })),
      },
    };

    await redeemReservation(tx, 'company-1', 'cashier-1', {
      token,
      cartInput,
      productsById: new Map([['item-1', { price: 1000, taxCode: 'A' }]]),
      invoiceId: 'invoice-1',
    });

    expect(operations[0]).toBe('findMany');
    expect(operations[1]).toContain('pos_vouchers');
    expect(operations[2]).toContain('pos_voucher_redemptions');
    expect(operations.indexOf('update')).toBeGreaterThan(2);
    expect(tx.posVoucherRedemption.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'redemption-1' },
      data: expect.objectContaining({ status: 'REDEEMED', invoiceId: 'invoice-1' }),
    }));
  });

  test('locks out repeated invalid voucher lookups without logging the entered code', async () => {
    let attempt = null;
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ locked: '1' }]),
      posVoucherCodeAttempt: {
        findUnique: jest.fn(async () => attempt),
        create: jest.fn(async ({ data }) => {
          attempt = data;
          return attempt;
        }),
        update: jest.fn(async ({ data }) => {
          attempt = { ...attempt, ...data };
          return attempt;
        }),
      },
    };
    const client = {
      $queryRaw: tx.$queryRaw,
      posVoucherCodeAttempt: {
        findUnique: jest.fn(async () => attempt),
      },
      posVoucher: { findFirst: jest.fn().mockResolvedValue(null) },
      systemSettings: {
        findUnique: jest.fn().mockResolvedValue({
          posVoucherSettings: { invalidAttemptsBeforeLockout: 3, lockoutMinutes: 1 },
        }),
      },
    };
    dbClient.mockReturnValue(client);
    runInTransaction.mockImplementation((callback) => callback(tx));

    await expect(reserveVoucher('company-1', 'cashier-1', { code: 'SECRET-CODE' }))
      .rejects.toMatchObject({ code: 'POS_VOUCHER_INVALID' });
    await expect(reserveVoucher('company-1', 'cashier-1', { code: 'SECRET-CODE' }))
      .rejects.toMatchObject({ code: 'POS_VOUCHER_INVALID' });
    await expect(reserveVoucher('company-1', 'cashier-1', { code: 'SECRET-CODE' }))
      .rejects.toMatchObject({ code: 'POS_VOUCHER_LOOKUP_LOCKED' });
    await expect(reserveVoucher('company-1', 'cashier-1', { code: 'SECRET-CODE' }))
      .rejects.toMatchObject({ code: 'POS_VOUCHER_LOOKUP_LOCKED' });

    expect(attempt.attemptCount).toBe(3);
    expect(client.posVoucher.findFirst).toHaveBeenCalledTimes(3);
    expect(writePosDenialAudit).toHaveBeenCalledWith(expect.objectContaining({
      event: 'VOUCHER_INVALID_ATTEMPT',
      metadata: expect.objectContaining({ result: 'NOT_FOUND' }),
    }));
    expect(writePosDenialAudit.mock.calls[0][0].metadata).not.toHaveProperty('code', 'SECRET-CODE');
  });
});
