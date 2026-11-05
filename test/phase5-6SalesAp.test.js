const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const {
  invoiceToApi,
  invoiceLineToApi,
  invoiceTranslateCreate,
  invoiceTranslateUpdate,
  quotationToApi,
  salesOrderToApi,
  purchaseOrderToApi,
  purchaseToApi,
  purchaseTranslateUpdate,
  grnTranslateCreate,
  grnToApi,
  arReceiptAllocationToApi,
  deliveryNoteToApi,
  deliveryNoteTranslateCreate,
} = require('../utils/salesApMappers');
const { buildLineInclude } = require('../utils/salesApCommon');
const { makeCompatModel } = require('../utils/prismaCompat');

describe('Phase 5+6 sales/AP mappers', () => {
  test('includes digital receipt consent when an invoice client is populated for a receipt', () => {
    const include = buildLineInclude()([{ path: 'client', select: 'name contact digitalReceiptConsent' }]);
    expect(include.client.select).toEqual({ id: true, name: true, contact: true, digitalReceiptConsent: true });
  });

  test('preserves delivery note line tax snapshots through database mapping', async () => {
    const source = {
      id: 'dn1',
      companyId: 'c1',
      referenceNo: 'DN-1',
      clientId: 'cl1',
      warehouseId: 'w1',
      status: 'draft',
      lines: [{
        id: 'dnl1',
        productId: 'p1',
        qtyToDeliver: 2,
        unitPrice: 100,
        discountPct: 10,
        taxRate: 18,
        taxCode: 'A',
        lineSubtotal: 180,
        lineTax: 32.4,
        lineTotal: 212.4,
      }],
    };

    const api = deliveryNoteToApi(source);
    const created = await deliveryNoteTranslateCreate({
      referenceNo: 'DN-TEST',
      company: 'c1',
      client: 'cl1',
      warehouse: 'w1',
      lines: [{
        product: 'p1',
        qtyToDeliver: 2,
        unitPrice: 100,
        discountPct: 10,
        taxRate: 18,
        taxCode: 'A',
        lineSubtotal: 180,
        lineTax: 32.4,
        lineTotal: 212.4,
      }],
    });

    expect(api.lines[0]).toEqual(expect.objectContaining({
      discountPct: 10,
      taxRate: 18,
      taxCode: 'A',
      lineSubtotal: 180,
      lineTax: 32.4,
      lineTotal: 212.4,
    }));
    expect(created.lines.create[0]).toEqual(expect.objectContaining({
      discountPct: 10,
      taxRate: 18,
      taxCode: 'A',
      lineSubtotal: 180,
      lineTax: 32.4,
      lineTotal: 212.4,
    }));
  });

  test('keeps sales order line count in a header-only list projection', async () => {
    let capturedQuery;
    const delegate = {
      name: 'SalesOrder',
      findMany: jest.fn(async (query) => {
        capturedQuery = query;
        return [{ id: 'so1', companyId: 'c1', _count: { lines: 2 } }];
      }),
    };
    const SalesOrder = makeCompatModel({
      delegate: () => delegate,
      delegateName: 'salesOrder',
      fieldMap: { _id: { target: 'id', isId: true } },
      toApi: salesOrderToApi,
      translateCreate: async (data) => data,
      translateUpdate: (update) => update,
      include: buildLineInclude(),
      tenantField: null,
    });

    const [order] = await SalesOrder.find({})
      .select({ referenceNo: 1, lineCount: 1 })
      .populate('-lines')
      .lean();

    expect(capturedQuery.select._count).toEqual({ select: { lines: true } });
    expect(order.lineCount).toBe(2);
  });

  test('invoiceToApi embeds lines and items alias', () => {
    const pricingSnapshot = {
      version: 1,
      currencyCode: 'RWF',
      totals: { totalDiscountRwf: 25 },
    };
    const api = invoiceToApi({
      id: 'inv1',
      companyId: 'c1',
      referenceNo: 'INV-2026-00001',
      clientId: 'cl1',
      status: 'confirmed',
      currencyCode: 'RWF',
      exchangeRate: 1,
      subtotal: 1000,
      taxAmount: 180,
      totalAmount: 1180,
      amountPaid: 0,
      amountOutstanding: 1180,
      totalAEx: 0,
      totalB18: 0,
      totalDiscount: 0,
      invoiceDate: new Date(),
      dueDate: new Date(),
      stockDeducted: false,
      autoConfirm: false,
      payments: [],
      posPricingSnapshot: pricingSnapshot,
      ebm: {},
      lines: [{
        id: 'l1',
        lineOrder: 0,
        productId: 'p1',
        productName: 'Widget',
        qty: 2,
        unitPrice: 500,
        discountPct: 0,
        taxRate: 18,
        taxCode: 'A',
        lineSubtotal: 1000,
        lineTax: 180,
        lineTotal: 1180,
        unitCost: 300,
        cogsAmount: 600,
        qtyCredited: 0,
      }],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(api.lines).toHaveLength(1);
    expect(api.items).toHaveLength(1);
    expect(api.lines[0].quantity).toBe(2);
    expect(api.totalAmount).toBe('1180.00');
    expect(api.posPricingSnapshot).toEqual(pricingSnapshot);
  });

  test('persists pricing snapshots on invoice creation and update', async () => {
    const pricingSnapshot = {
      version: 1,
      currencyCode: 'RWF',
      lines: [{ lineId: 'line-1', totalDiscountRwf: 25 }],
    };

    const created = await invoiceTranslateCreate({
      referenceNo: 'INV-PRICING-1',
      company: 'company-1',
      client: 'client-1',
      posPricingSnapshot: pricingSnapshot,
    });
    const updated = invoiceTranslateUpdate({ posPricingSnapshot: pricingSnapshot });

    expect(created.posPricingSnapshot).toEqual(pricingSnapshot);
    expect(updated.posPricingSnapshot).toEqual(pricingSnapshot);
  });

  test('maps invoice line discount reasons to the persisted line field', async () => {
    const created = await invoiceTranslateCreate({
      referenceNo: 'INV-DISCOUNT-REASON-1',
      company: 'company-1',
      client: 'client-1',
      lines: [{
        product: 'product-1',
        qty: 1,
        unitPrice: 55_000,
        discountPct: 9.09,
        discountReason: 'Voucher ****JWLQ',
      }],
    });

    expect(created.lines.create[0]).toMatchObject({
      productId: 'product-1',
      discountPct: 9.09,
      discountReason: 'Voucher ****JWLQ',
    });
  });

  test('invoiceLineToApi preserves product populate shape', () => {
    const line = invoiceLineToApi({
      id: 'l1',
      productId: 'p1',
      product: { id: 'p1', name: 'A', sku: 'SKU1', unit: 'pcs', trackingType: 'batch', isStockable: true },
      qty: 1,
      unitPrice: 10,
      discountPct: 0,
      taxRate: 0,
      taxCode: 'A',
      lineSubtotal: 10,
      lineTax: 0,
      lineTotal: 10,
      unitCost: 5,
      cogsAmount: 5,
      qtyCredited: 0,
    });
    expect(line.product.name).toBe('A');
    expect(line.product.trackingType).toBe('batch');
    expect(line.product.isStockable).toBe(true);
  });

  test('purchaseOrderToApi maps lines', () => {
    const api = purchaseOrderToApi({
      id: 'po1',
      companyId: 'c1',
      referenceNo: 'PO-2026-001',
      supplierId: 's1',
      orderDate: new Date(),
      status: 'approved',
      source: 'MANUAL',
      currencyCode: 'RWF',
      exchangeRate: 1,
      subtotal: 500,
      taxAmount: 90,
      totalAmount: 590,
      amountPaid: 0,
      balance: 590,
      paymentStatus: 'unpaid',
      payments: [],
      freight: {},
      ebm: {},
      lines: [{ id: 'pl1', lineOrder: 0, productId: 'p1', qtyOrdered: 10, qtyReceived: 0, unitCost: 50, taxRate: 18, taxAmount: 90, lineTotal: 590 }],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(api.lines[0].qtyOrdered).toBe(10);
  });

  test('purchaseToApi derives paid amount and balance from payment JSON with formatted strings', () => {
    const api = purchaseToApi({
      id: 'p1',
      companyId: 'c1',
      purchaseNumber: 'PO-2026-0001',
      supplierId: 's1',
      status: 'received',
      currency: 'RWF',
      subtotal: 55000,
      taxAmount: 9000,
      totalAmount: 64000,
      payments: [
        { amount: 15000 },
        { amount: '25000.00' },
        { amount: 'RWF 11,000' },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(api.amountPaid).toBe(51000);
    expect(api.balance).toBe(13000);
    expect(api.grandTotal).toBe(64000);
  });

  test('purchaseTranslateUpdate preserves payment array writes', () => {
    const update = purchaseTranslateUpdate({
      $set: {
        status: 'partial',
        payments: [{ amount: 5000, paymentMethod: 'cash', reference: 'cash-001' }],
      },
    });
    expect(update.status).toBe('partial');
    expect(update.payments).toEqual([{ amount: 5000, paymentMethod: 'cash', reference: 'cash-001' }]);
  });

  test('grnToApi AP fields as money strings', () => {
    const api = grnToApi({
      id: 'g1',
      companyId: 'c1',
      referenceNo: 'GRN-001',
      purchaseOrderId: 'po1',
      warehouseId: 'w1',
      supplierId: 's1',
      receivedDate: new Date(),
      status: 'confirmed',
      totalAmount: 590,
      balance: 590,
      amountPaid: 0,
      paymentStatus: 'pending',
      freight: {},
      ebm: {},
      lines: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(api.totalAmount).toBe('590.00');
  });

  test('grnTranslateCreate persists serial numbers on receipt lines', async () => {
    const payload = await grnTranslateCreate({
      company: 'company-1',
      referenceNo: 'GRN-2026-00001',
      purchaseOrder: 'po-1',
      warehouse: 'warehouse-1',
      supplier: 'supplier-1',
      lines: [{
        product: 'product-1',
        purchaseOrderLine: 'po-line-1',
        qtyReceived: 2,
        unitCost: 10,
        serialNumbers: ['SN-001', 'SN-002'],
      }],
    });

    expect(payload.lines.create[0].serialNumbers).toEqual(['SN-001', 'SN-002']);
  });

  test('arReceiptAllocationToApi', () => {
    const api = arReceiptAllocationToApi({
      id: 'a1',
      companyId: 'c1',
      receiptId: 'r1',
      invoiceId: 'inv1',
      amountAllocated: 500,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(api.amountAllocated).toBe('500.00');
  });
});

describe('document reference numbers', () => {
  const { withReferenceNo } = require('../utils/referenceNumbers');

  test('a caller-supplied number wins, under any legacy alias', async () => {
    const translate = withReferenceNo('INV', (d) => ({ companyId: d.company }), { model: 'invoice' });

    expect(await translate({ company: 'c1', referenceNo: 'INV-2026-00042' }))
      .toEqual({ companyId: 'c1', referenceNo: 'INV-2026-00042' });
    expect(await translate({ company: 'c1', invoiceNumber: 'MANUAL-7' }))
      .toEqual({ companyId: 'c1', referenceNo: 'MANUAL-7' });
  });

  test('a mapper that already emits the number is left alone', async () => {
    const translate = withReferenceNo('SO', () => ({ companyId: 'c1', referenceNo: 'SO-2026-00003' }));
    expect((await translate({})).referenceNo).toBe('SO-2026-00003');
  });

  test('without a company there is nothing to number against', async () => {
    const translate = withReferenceNo('INV', () => ({ companyId: null }));
    expect(await translate({})).toEqual({ companyId: null });
  });

  test('a custom field is honoured (StockTransfer.transferNumber)', async () => {
    const translate = withReferenceNo('TRF', (d) => ({ companyId: d.company }), { field: 'transferNumber' });
    expect(await translate({ company: 'c1', transferNumber: 'TRF-2026-00009' }))
      .toEqual({ companyId: 'c1', transferNumber: 'TRF-2026-00009' });
  });
});

describe('PickPack workflow persistence', () => {
  test('status-only transitions do not rewrite picking lines', async () => {
    const { prisma } = require('../lib/prisma');
    const PickPack = require('../models/PickPack');
    const packRow = {
      id: 'pick-pack-1',
      companyId: 'company-1',
      referenceNo: 'PK-2026-00001',
      salesOrderId: 'sales-order-1',
      clientId: 'client-1',
      warehouseId: 'warehouse-1',
      status: 'picking',
      lines: [{
        id: 'pick-line-1',
        salesOrderLineId: 'sales-order-line-1',
        productId: 'product-1',
        qtyToPick: 7,
        qtyPicked: 7,
        qtyPacked: 0,
        serialNumbers: [],
        status: 'picked',
        issues: [],
      }],
    };
    const findFirst = jest.spyOn(prisma.pickPack, 'findFirst').mockResolvedValue(packRow);
    const update = jest.spyOn(prisma.pickPack, 'update').mockImplementation(async ({ data }) => ({
      ...packRow,
      ...data,
      status: data.status,
      lines: packRow.lines,
    }));
    const findSalesOrder = jest.spyOn(prisma.salesOrder, 'findUnique').mockResolvedValue(null);

    try {
      const pickPack = await PickPack.findOne({ _id: packRow.id, company: packRow.companyId });
      pickPack.status = 'picked';
      pickPack.pickingCompletedAt = new Date();
      await pickPack.save();

      expect(update).toHaveBeenCalledTimes(1);
      expect(update.mock.calls[0][0].data).not.toHaveProperty('lines');
    } finally {
      findFirst.mockRestore();
      update.mockRestore();
      findSalesOrder.mockRestore();
    }
  });
});

describe('Phase 5+6 Neon integration', () => {
  const hasDb = Boolean(process.env.DATABASE_URL);

  (hasDb ? test : test.skip)('invoices table + index exist on Neon', async () => {
    const { prisma, connectPrisma, disconnectPrisma } = require('../lib/prisma');
    await connectPrisma();
    const tables = await prisma.$queryRawUnsafe(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('invoices', 'invoice_lines')`,
    );
    expect(tables.length).toBeGreaterThanOrEqual(2);
    await disconnectPrisma();
  });

  (hasDb ? test : test.skip)('purchase_orders table exists on Neon', async () => {
    const { prisma, connectPrisma, disconnectPrisma } = require('../lib/prisma');
    await connectPrisma();
    const tables = await prisma.$queryRawUnsafe(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('purchase_orders', 'goods_received_notes')`,
    );
    expect(tables.length).toBeGreaterThanOrEqual(2);
    await disconnectPrisma();
  });

  (hasDb ? test : test.skip)('ar_receipt_allocations table exists on Neon', async () => {
    const { prisma, connectPrisma, disconnectPrisma } = require('../lib/prisma');
    await connectPrisma();
    const tables = await prisma.$queryRawUnsafe(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'ar_receipt_allocations'`,
    );
    expect(tables.length).toBe(1);
    await disconnectPrisma();
  });
});
