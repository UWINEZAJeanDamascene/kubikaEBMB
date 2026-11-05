'use strict';

const { getPosDiscountReports, reportFilters } = require('../services/posDiscountReportsService');

describe('POS discount reports service', () => {
  const from = '2026-11-01';
  const to = '2026-11-03';

  test('groups discounts, voucher net cost, approvals, and cashier exception rates within tenant filters', async () => {
    const sales = [
      {
        id: 'invoice-1', referenceNo: 'POS-1', cashierId: 'cashier-1', registerId: 'FRONT-01',
        invoiceDate: new Date('2026-11-02T10:00:00Z'), status: 'paid', totalDiscount: 20, totalAmount: 80,
        posCheckoutPayload: { items: [{ unitPrice: 80, catalogUnitPrice: 100 }] },
        lines: [{ qty: 1, unitPrice: 100, lineSubtotal: 100, discountPct: 20, discountReason: 'Damaged packaging' }],
      },
      {
        id: 'invoice-2', referenceNo: 'POS-2', cashierId: 'cashier-1', registerId: 'FRONT-01',
        invoiceDate: new Date('2026-11-02T11:00:00Z'), status: 'paid', totalDiscount: 0, totalAmount: 100,
        posCheckoutPayload: { items: [{ unitPrice: 100, catalogUnitPrice: 100 }] },
        lines: [{ qty: 1, unitPrice: 100, lineSubtotal: 100, discountPct: 0, discountReason: null }],
      },
    ];
    const redemptionRows = [
      {
        voucherId: 'voucher-1', invoiceId: 'invoice-1', cashierId: 'cashier-1', status: 'RESTORED', discountRwf: 100,
        redeemedAt: new Date('2026-11-02T10:00:00Z'), restoredAt: new Date('2026-11-03T10:00:00Z'), voucher: { name: 'November offer' },
      },
      {
        voucherId: 'voucher-2', invoiceId: 'invoice-1', cashierId: 'cashier-1', status: 'REDEEMED', discountRwf: 300,
        redeemedAt: new Date('2026-11-02T10:00:00Z'), restoredAt: null, voucher: { name: 'New customer' },
      },
    ];
    const client = {
      invoice: {
        findMany: jest.fn(async ({ where }) => (where.id ? [{ id: 'invoice-1', registerId: 'FRONT-01' }] : sales)),
      },
      posRegister: {
        findFirst: jest.fn().mockResolvedValue({ id: 'register-1', name: 'Front till', code: 'FRONT-01' }),
        findMany: jest.fn().mockResolvedValue([{ id: 'register-1', name: 'Front till', code: 'FRONT-01' }]),
      },
      user: {
        findMany: jest.fn().mockResolvedValue([{ id: 'cashier-1', name: 'Aline' }]),
      },
      posVoucherRedemption: { findMany: jest.fn().mockResolvedValue(redemptionRows) },
      posApprovalRequest: {
        findMany: jest.fn().mockResolvedValue([
          { action: 'discount', status: 'APPROVED' },
          { action: 'discount', status: 'REJECTED' },
        ]),
      },
      posApproval: {
        findMany: jest.fn().mockResolvedValue([{ action: 'PRICE_OVERRIDE' }]),
      },
    };

    const result = await getPosDiscountReports('company-1', {
      from, to, registerId: 'register-1', minDiscountRatePercent: 40, minOverrideRatePercent: 40,
    }, client);

    expect(result.summary).toMatchObject({
      salesCount: 2,
      discountedSales: 1,
      totalDiscountRwf: 20,
      voucherUsageCount: 2,
      voucherRestoredCount: 1,
      voucherNetCostRwf: 300,
    });
    expect(result.discountsByCashier[0]).toMatchObject({
      cashierName: 'Aline',
      salesCount: 2,
      discountedSales: 1,
      discountRwf: 20,
      discountRatePercent: 50,
      overrideSales: 1,
      overrideRatePercent: 50,
      highDiscountRate: true,
      highOverrideRate: true,
    });
    expect(result.discountsByRegister[0]).toMatchObject({
      registerId: 'register-1',
      registerName: 'Front till',
      salesCount: 2,
    });
    expect(result.discountsByReason).toEqual([
      { reason: 'Damaged packaging', discountRwf: 20, lineCount: 1 },
    ]);
    expect(result.vouchers.byVoucher).toEqual(expect.arrayContaining([
      expect.objectContaining({ voucherName: 'November offer', usageCount: 1, restoredCount: 1, netCostRwf: 0 }),
      expect.objectContaining({ voucherName: 'New customer', usageCount: 1, netCostRwf: 300 }),
    ]));
    expect(result.approvalsByAction).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'PRICE_OVERRIDE', approved: 1, pinApprovals: 1 }),
      expect.objectContaining({ action: 'discount', requests: 2, approved: 1, rejected: 1 }),
    ]));
    expect(client.invoice.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        companyId: 'company-1',
        posOrigin: true,
        registerId: { in: ['register-1', 'FRONT-01'] },
      }),
    }));
  });

  test('validates date ranges and rate thresholds', () => {
    expect(() => reportFilters({ from: '2026-02-31', to: '2026-03-01' })).toThrow(
      expect.objectContaining({ code: 'POS_REPORT_FILTER_INVALID' }),
    );
    expect(() => reportFilters({ from: '2025-01-01', to: '2026-12-31' })).toThrow(
      expect.objectContaining({ code: 'POS_REPORT_RANGE_TOO_LARGE' }),
    );
    expect(() => reportFilters({ minOverrideRatePercent: 101 })).toThrow(
      expect.objectContaining({ code: 'POS_REPORT_FILTER_INVALID' }),
    );
  });

  test('reads reports in batches within the HTTP query limit', async () => {
    const sales = Array.from({ length: 503 }, (_, index) => ({
      id: `invoice-${index}`,
      cashierId: 'cashier-1',
      registerId: 'register-1',
      invoiceDate: new Date('2026-11-02T10:00:00Z'),
      status: 'paid',
      totalDiscount: 0,
      lines: [],
    }));
    const client = {
      invoice: {
        findMany: jest.fn(async ({ skip = 0, take }) => sales.slice(skip, skip + take)),
      },
      posRegister: { findMany: jest.fn().mockResolvedValue([{ id: 'register-1', name: 'Front till' }]) },
      user: { findMany: jest.fn().mockResolvedValue([{ id: 'cashier-1', name: 'Aline' }]) },
      posVoucherRedemption: { findMany: jest.fn().mockResolvedValue([]) },
      posApprovalRequest: { findMany: jest.fn().mockResolvedValue([]) },
      posApproval: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const result = await getPosDiscountReports('company-1', { from, to }, client);

    expect(result.summary.salesCount).toBe(503);
    expect(client.invoice.findMany.mock.calls.map(([args]) => [args.skip, args.take])).toEqual([
      [0, 500],
      [500, 500],
    ]);
    for (const model of Object.values(client)) {
      if (model.findMany) {
        expect(model.findMany.mock.calls.every(([args]) => args.take <= 500)).toBe(true);
      }
    }
  });

  test('rejects report datasets above the configured row cap using bounded reads', async () => {
    const sales = Array.from({ length: 5001 }, (_, index) => ({
      id: `invoice-${index}`,
      cashierId: 'cashier-1',
      registerId: 'register-1',
      invoiceDate: new Date('2026-11-02T10:00:00Z'),
      status: 'paid',
      totalDiscount: 0,
      lines: [],
    }));
    const client = {
      invoice: {
        findMany: jest.fn(async ({ skip = 0, take }) => sales.slice(skip, skip + take)),
      },
    };

    await expect(getPosDiscountReports('company-1', { from, to }, client)).rejects.toMatchObject({
      statusCode: 413,
      code: 'POS_REPORT_RESULT_TOO_LARGE',
    });
    expect(client.invoice.findMany).toHaveBeenCalledTimes(11);
    expect(client.invoice.findMany.mock.calls.every(([args]) => args.take <= 500)).toBe(true);
  });

  test('applies cashier, register, reason, and action filters to their report sections', async () => {
    const sales = [
      {
        id: 'invoice-1', cashierId: 'cashier-1', registerId: 'REG-A',
        invoiceDate: new Date('2026-11-02T10:00:00Z'), status: 'paid', totalDiscount: 20,
        lines: [{ qty: 1, unitPrice: 100, lineSubtotal: 100, discountPct: 20, discountReason: 'Damaged packaging' }],
      },
      {
        id: 'invoice-2', cashierId: 'cashier-2', registerId: 'REG-B',
        invoiceDate: new Date('2026-11-02T11:00:00Z'), status: 'paid', totalDiscount: 10,
        lines: [{ qty: 1, unitPrice: 100, lineSubtotal: 100, discountPct: 10, discountReason: 'Promotion' }],
      },
    ];
    const client = {
      invoice: {
        findMany: jest.fn(async ({ where, skip = 0, take }) => {
          if (where.id) return [];
          const filtered = sales.filter((sale) =>
            (!where.cashierId || sale.cashierId === where.cashierId)
            && (!where.registerId || where.registerId.in.includes(sale.registerId)),
          );
          return filtered.slice(skip, skip + take);
        }),
      },
      posRegister: {
        findFirst: jest.fn().mockResolvedValue({ id: 'register-1', code: 'REG-A', name: 'Front till' }),
        findMany: jest.fn(async ({ where }) => {
          const refs = where.id?.in || where.code?.in || [];
          return refs.includes('REG-A') || refs.includes('register-1')
            ? [{ id: 'register-1', code: 'REG-A', name: 'Front till' }]
            : [];
        }),
      },
      user: {
        findMany: jest.fn(async ({ where }) => where.id.in
          .filter((id) => id === 'cashier-1' || id === 'cashier-2')
          .map((id) => ({ id, name: id === 'cashier-1' ? 'Aline' : 'Mina' }))),
      },
      posVoucherRedemption: { findMany: jest.fn().mockResolvedValue([]) },
      posApprovalRequest: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'request-1', action: 'discount', status: 'APPROVED' },
          { id: 'request-2', action: 'no sale', status: 'REJECTED' },
        ]),
      },
      posApproval: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'approval-1', action: 'discount' },
          { id: 'approval-2', action: 'refund' },
        ]),
      },
    };

    const result = await getPosDiscountReports('company-1', {
      from, to, cashierId: 'cashier-1', registerId: 'register-1',
      reason: 'Damaged packaging', action: 'discount',
    }, client);

    expect(result.summary).toMatchObject({ salesCount: 1, discountedSales: 1, totalDiscountRwf: 20 });
    expect(result.discountsByCashier.map((row) => row.cashierId)).toEqual(['cashier-1']);
    expect(result.discountsByRegister.map((row) => row.registerId)).toEqual(['register-1']);
    expect(result.discountsByReason).toEqual([
      { reason: 'Damaged packaging', discountRwf: 20, lineCount: 1 },
    ]);
    expect(result.approvalsByAction).toEqual([
      expect.objectContaining({ action: 'discount', requests: 1, approved: 2, rejected: 0 }),
    ]);
    expect(client.posApprovalRequest.findMany.mock.calls[0][0].where).toMatchObject({
      cashierId: 'cashier-1', registerId: 'register-1', action: 'discount',
    });
    expect(client.posApproval.findMany.mock.calls[0][0].where).toMatchObject({
      requestedBy: 'cashier-1', registerId: 'register-1', action: 'discount',
    });
  });

  test('minimum cashier rate filters narrow the exception table without changing sales totals', async () => {
    const client = {
      invoice: {
        findMany: jest.fn(async ({ where, skip = 0, take }) => {
          if (where.id) return [];
          return [
            {
              id: 'invoice-1', cashierId: 'cashier-1', registerId: 'register-1',
              invoiceDate: new Date('2026-11-02T10:00:00Z'), status: 'paid', totalDiscount: 20,
              posCheckoutPayload: { items: [{ unitPrice: 80, catalogUnitPrice: 100 }] },
              lines: [{ qty: 1, unitPrice: 100, lineSubtotal: 100, discountPct: 20, discountReason: 'Damaged packaging' }],
            },
            {
              id: 'invoice-2', cashierId: 'cashier-2', registerId: 'register-1',
              invoiceDate: new Date('2026-11-02T11:00:00Z'), status: 'paid', totalDiscount: 0,
              posCheckoutPayload: { items: [{ unitPrice: 100, catalogUnitPrice: 100 }] },
              lines: [],
            },
          ].slice(skip, skip + take);
        }),
      },
      posRegister: {
        findMany: jest.fn().mockResolvedValue([{ id: 'register-1', code: 'REG-1', name: 'Front till' }]),
      },
      user: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'cashier-1', name: 'Aline' },
          { id: 'cashier-2', name: 'Mina' },
        ]),
      },
      posVoucherRedemption: { findMany: jest.fn().mockResolvedValue([]) },
      posApprovalRequest: { findMany: jest.fn().mockResolvedValue([]) },
      posApproval: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const result = await getPosDiscountReports('company-1', {
      from, to, minDiscountRatePercent: 50, minOverrideRatePercent: 50,
    }, client);

    expect(result.summary.salesCount).toBe(2);
    expect(result.discountsByCashier).toHaveLength(1);
    expect(result.discountsByCashier[0]).toMatchObject({
      cashierName: 'Aline',
      discountRatePercent: 100,
      overrideRatePercent: 100,
      highDiscountRate: true,
      highOverrideRate: true,
    });
  });
});
