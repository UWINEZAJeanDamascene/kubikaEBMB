const mockPrisma = {
  $transaction: jest.fn(),
  systemSettings: { findUnique: jest.fn() },
  ebmSubmissionQueue: { findFirst: jest.fn() },
  posRegister: { findFirst: jest.fn() },
  posPublicReceiptToken: { create: jest.fn(), findMany: jest.fn(), findFirst: jest.fn(), updateMany: jest.fn() },
};

jest.mock('../lib/prisma', () => ({ prisma: mockPrisma }));
jest.mock('../models/Invoice', () => ({ findOne: jest.fn() }));
jest.mock('../models/Company', () => ({ findById: jest.fn() }));
jest.mock('../services/posAuditService', () => ({
  requestIp: jest.fn(() => '127.0.0.1'),
  writePosAuditLog: jest.fn(),
}));
jest.mock('../src/config/environment', () => ({ getConfig: () => ({ server: { frontendUrl: 'http://localhost:5173' } }) }));

const Invoice = require('../models/Invoice');
const Company = require('../models/Company');
const PDFDocument = require('pdfkit');
const { writePosAuditLog } = require('../services/posAuditService');
const {
  PUBLIC_RECEIPT_NOT_FOUND,
  loadSavedReceipt,
  publicReceiptDocument,
  receiptPdfBuffer,
  tokenHash,
} = require('../services/posPublicReceiptService');

const COMPANY_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const INVOICE_A = '111111111111111111111111';
const TOKEN = 'A'.repeat(43);

function invoiceQuery(invoice) {
  const query = {
    populate: jest.fn(() => query),
    then: (resolve, reject) => Promise.resolve(invoice).then(resolve, reject),
  };
  return query;
}

function configureSavedSale({ companyId = COMPANY_A, invoiceId = INVOICE_A, ebm = {} } = {}) {
  const sale = {
    _id: invoiceId,
    company: companyId,
    status: 'paid',
    invoiceNumber: 'POS-1001',
    createdAt: new Date('2026-11-02T09:00:00.000Z'),
    client: { name: 'Customer Name', taxId: '123456789', digitalReceiptConsent: true },
    createdBy: { name: 'Private Cashier' },
    warehouseName: 'Private Warehouse',
    items: [{ product: { name: 'Tea', sku: 'TEA-1', barcode: '5901234123457' }, quantity: 1, unitPrice: 5000, lineTotal: 5000 }],
    payments: [{ paymentMethod: 'cash', amount: 5000, reference: 'PRIVATE-TENDER-REFERENCE' }],
    amountPaid: 5000,
    ebm,
    toObject: () => ({
      _id: invoiceId, company: companyId, status: 'paid', invoiceNumber: 'POS-1001',
      createdAt: sale.createdAt, client: sale.client, createdBy: sale.createdBy,
      warehouseName: sale.warehouseName, items: sale.items, payments: sale.payments, amountPaid: 5000, ebm: sale.ebm,
    }),
  };
  Invoice.findOne.mockReturnValue(invoiceQuery(sale));
  Company.findById.mockReturnValue({ lean: jest.fn().mockResolvedValue({
    name: 'Tenant A Shop', tax_identification_number: '987654321', address: 'Kigali', phone: '+250700000000',
  }) });
  mockPrisma.systemSettings.findUnique.mockResolvedValue({ posReceiptSettings: { digitalReceiptsEnabled: true } });
  mockPrisma.ebmSubmissionQueue.findFirst.mockResolvedValue(null);
  mockPrisma.posRegister.findFirst.mockResolvedValue(null);
  return sale;
}

beforeEach(() => {
  jest.clearAllMocks();
  configureSavedSale();
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: '333333333333333333333333', companyId: COMPANY_A, invoiceId: INVOICE_A }]),
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
  mockPrisma.$transaction.mockImplementation((callback) => callback(tx));
});

describe('public POS receipt protections', () => {
  it('renders downloaded receipts with all item and section labels in reading order', async () => {
    const textSpy = jest.spyOn(PDFDocument.prototype, 'text');
    const buffer = await receiptPdfBuffer({
      business: { name: 'Example Shop' },
      receipt: { number: 'INV-1', localDateTime: '2026-11-02 10:00' },
      customer: { name: 'Walk-in' },
      lines: [
        { name: 'First item', quantity: 1, unitPriceRwf: 1000, totalRwf: 1000 },
        { name: 'Second item', quantity: 2, unitPriceRwf: 500, totalRwf: 1000 },
      ],
      totals: { currency: 'RWF', subtotalRwf: 2000, taxTotalRwf: 0, grandTotalRwf: 2000, taxes: [] },
      payments: [{ method: 'Cash', amountRwf: 2000 }],
      paymentSummary: { amountPaidRwf: 2000, changeGivenRwf: 0 },
    });

    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
    const optionsFor = (label) => textSpy.mock.calls.find(([value]) => value === label)?.[1];
    expect(optionsFor('Second item').x).toBe(42);
    expect(optionsFor('Totals').x).toBe(42);
    expect(optionsFor('Payments').x).toBe(42);
    textSpy.mockRestore();
  });

  it('blocks digital access when the saved customer has not consented', async () => {
    const sale = configureSavedSale();
    const noConsentSale = {
      ...sale,
      client: { ...sale.client, digitalReceiptConsent: false },
      toObject: () => ({ ...sale.toObject(), client: { ...sale.client, digitalReceiptConsent: false } }),
    };
    Invoice.findOne.mockReturnValue(invoiceQuery(noConsentSale));

    await expect(loadSavedReceipt(COMPANY_A, INVOICE_A)).rejects.toMatchObject({
      code: 'POS_CUSTOMER_DIGITAL_RECEIPT_CONSENT_REQUIRED', statusCode: 403,
    });
  });

  it('scopes receipt lookup to the requested tenant and conceals cross-company invoices', async () => {
    Invoice.findOne.mockReturnValue(invoiceQuery(null));

    await expect(loadSavedReceipt(COMPANY_A, INVOICE_A)).rejects.toBe(PUBLIC_RECEIPT_NOT_FOUND);

    expect(Invoice.findOne).toHaveBeenCalledWith({ _id: INVOICE_A, company: COMPANY_A });
    expect(Company.findById).not.toHaveBeenCalled();
  });

  it.each([
    ['expired token', 'expires_at" > NOW()'],
    ['revoked token', 'revoked_at" IS NULL'],
  ])('rejects an unavailable token (%s)', async (_label, expectedPredicate) => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest.fn(),
    };
    mockPrisma.$transaction.mockImplementation((callback) => callback(tx));

    await expect(publicReceiptDocument(TOKEN)).rejects.toBe(PUBLIC_RECEIPT_NOT_FOUND);

    const [query, digest] = tx.$queryRaw.mock.calls[0];
    expect(query.join('?')).toContain(expectedPredicate);
    expect(query.join('?')).toContain('token_hash');
    expect(digest).toBe(tokenHash(TOKEN));
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('masks customer TIN and omits cashier, payment reference, and internal warehouse data', async () => {
    configureSavedSale();
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: '333333333333333333333333', companyId: COMPANY_A, invoiceId: INVOICE_A }]),
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    mockPrisma.$transaction.mockImplementation((callback) => callback(tx));

    const { receiptDocument } = await publicReceiptDocument(TOKEN);
    const serialized = JSON.stringify(receiptDocument);

    expect(receiptDocument.customer.tin).toBe('******789');
    expect(receiptDocument.receipt.cashier).toBeNull();
    expect(receiptDocument.extension.data).toEqual({});
    expect(serialized).not.toContain('123456789');
    expect(serialized).not.toContain('PRIVATE-TENDER-REFERENCE');
    expect(serialized).not.toContain('Private Cashier');
    expect(serialized).not.toContain('Private Warehouse');
  });

  it('stores only the token hash, never the plaintext public token', async () => {
    const { createPublicReceiptLink } = require('../services/posPublicReceiptService');
    const tx = { posPublicReceiptToken: { create: jest.fn().mockImplementation(({ data }) => data) } };
    mockPrisma.$transaction.mockImplementation((callback) => callback(tx));

    const link = await createPublicReceiptLink({
      companyId: COMPANY_A, invoiceId: INVOICE_A, userId: '444444444444444444444444',
      req: { ip: '127.0.0.1', get: () => '' },
    });
    const stored = tx.posPublicReceiptToken.create.mock.calls[0][0].data;
    const token = new URL(link.url).pathname.split('/').pop();

    expect(token).toHaveLength(43);
    expect(stored.tokenHash).toBe(tokenHash(token));
    expect(stored.tokenHash).not.toBe(token);
    expect(stored.companyId).toBe(COMPANY_A);
    expect(stored.invoiceId).toBe(INVOICE_A);
    expect(writePosAuditLog).toHaveBeenCalled();
  });

  it('allows sharing a saved sale while EBM is pending without exposing unsigned fiscal data', async () => {
    configureSavedSale({
      ebm: {
        ebmEnabled: true,
        mode: 'production',
        ebmStatus: 'not_submitted',
        rcptSign: 'unsigned-signature',
        intrlData: 'unsigned-internal-data',
        salesPayload: { itemList: [{ itemNm: 'Unconfirmed item', qty: 99, prc: 1, totAmt: 99 }] },
      },
    });
    mockPrisma.ebmSubmissionQueue.findFirst.mockResolvedValue({
      id: 'pending-submission',
      ebmStatus: 'queued',
      signedAt: null,
      environment: 'production',
      fiscalResponse: null,
      payload: { itemList: [{ itemNm: 'Unconfirmed item', qty: 99, prc: 1, totAmt: 99 }] },
    });
    const tx = {
      posPublicReceiptToken: {
        create: jest.fn().mockImplementation(({ data }) => ({ ...data, id: '333333333333333333333333' })),
      },
    };
    mockPrisma.$transaction.mockImplementation((callback) => callback(tx));

    const receipt = await loadSavedReceipt(COMPANY_A, INVOICE_A);
    const { createPublicReceiptLink } = require('../services/posPublicReceiptService');
    const link = await createPublicReceiptLink({
      companyId: COMPANY_A,
      invoiceId: INVOICE_A,
      userId: '444444444444444444444444',
      req: { ip: '127.0.0.1', get: () => '' },
    });
    const serialized = JSON.stringify(receipt.receiptDocument);

    expect(link.url).toContain('/public/receipt/');
    expect(receipt.receiptDocument.fiscal).toBeNull();
    expect(receipt.receiptDocument.lines[0]).toMatchObject({
      name: 'Tea',
      quantity: 1,
      unitPriceRwf: 5000,
      totalRwf: 5000,
    });
    expect(serialized).not.toContain('unsigned-signature');
    expect(serialized).not.toContain('unsigned-internal-data');
    expect(serialized).not.toContain('Unconfirmed item');
  });

  it('allows a legacy saved sale with EBM not submitted and omits its unsigned data', async () => {
    configureSavedSale({
      ebm: {
        ebmEnabled: true,
        mode: 'production',
        ebmStatus: 'not_submitted',
        rcptSign: 'unsigned-signature',
      },
    });

    const { receiptDocument } = await loadSavedReceipt(COMPANY_A, INVOICE_A);

    expect(receiptDocument.fiscal).toBeNull();
    expect(JSON.stringify(receiptDocument)).not.toContain('unsigned-signature');
  });
});
