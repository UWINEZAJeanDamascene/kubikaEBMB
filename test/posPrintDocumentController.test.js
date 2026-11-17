const mockPrisma = {
  invoice: { findFirst: jest.fn() },
  posPrintDocument: { findFirst: jest.fn(), create: jest.fn(), findUnique: jest.fn() },
};

jest.mock('../lib/prisma', () => ({ prisma: mockPrisma }));
jest.mock('../services/posAuditService', () => ({
  requestIp: jest.fn(() => '127.0.0.1'),
  writePosAuditLog: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../controllers/invoiceController', () => ({
  renderInvoicePdfBuffer: jest.fn(),
}));

const controller = require('../controllers/posPrintJobController');
const invoiceController = require('../controllers/invoiceController');

function response() {
  const res = {
    statusCode: 200,
    body: undefined,
    headers: {},
    sent: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader(name, value) { this.headers[name] = value; return this; },
    end(body) { this.sent = body; return this; },
  };
  return res;
}

describe('stored POS invoice print documents', () => {
  const originalSecret = process.env.JWT_SECRET;
  const companyId = 'a'.repeat(24);
  const registerId = 'b'.repeat(24);
  const invoiceId = 'c'.repeat(24);

  beforeAll(() => { process.env.JWT_SECRET = 'test-secret-with-more-than-thirty-two-characters'; });
  afterAll(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
  });
  beforeEach(() => jest.clearAllMocks());

  test('stores the generated PDF and returns a short-lived URL bound to its register', async () => {
    const pdfBytes = Buffer.from('%PDF-test');
    mockPrisma.invoice.findFirst.mockResolvedValue({ id: invoiceId });
    mockPrisma.posPrintDocument.findFirst.mockResolvedValue(null);
    mockPrisma.posPrintDocument.create.mockImplementation(async ({ data }) => data);
    invoiceController.renderInvoicePdfBuffer.mockResolvedValue(pdfBytes);
    const req = {
      posAuthContext: {
        company: { id: companyId },
        register: { id: registerId, code: 'front-register' },
        user: { id: 'd'.repeat(24) },
      },
      params: { invoiceId },
      protocol: 'https',
      get: () => 'pos.example.test',
    };
    const res = response();

    await controller.createInvoicePrintDocument(req, res, jest.fn());

    expect(res.statusCode).toBe(201);
    const stored = mockPrisma.posPrintDocument.create.mock.calls[0][0].data;
    expect(stored).toMatchObject({
      companyId,
      registerId,
      documentType: 'invoice-pdf',
      sourceDocumentId: invoiceId,
      version: 1,
      pdfBytes,
    });
    const signedUrl = new URL(res.body.data.url);
    expect(signedUrl.pathname).toContain(stored.id);
    expect(Number(signedUrl.searchParams.get('expires'))).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(Number(signedUrl.searchParams.get('expires'))).toBeLessThanOrEqual(Math.floor((Date.now() + 2 * 60 * 1000) / 1000));

    mockPrisma.posPrintDocument.findUnique.mockResolvedValue({
      ...stored,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const downloadResponse = response();
    await controller.downloadSignedDocument({
      params: { documentId: stored.id },
      query: {
        expires: signedUrl.searchParams.get('expires'),
        signature: signedUrl.searchParams.get('signature'),
      },
    }, downloadResponse, jest.fn());

    expect(downloadResponse.headers['Content-Type']).toBe('application/pdf');
    expect(downloadResponse.sent).toEqual(pdfBytes);
  });

  test('rejects expired signed URLs before looking up the stored document', async () => {
    const res = response();
    await controller.downloadSignedDocument({
      params: { documentId: 'e'.repeat(24) },
      query: { expires: String(Math.floor(Date.now() / 1000) - 1), signature: 'a'.repeat(64) },
    }, res, jest.fn());

    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('PRINT_DOCUMENT_URL_INVALID');
    expect(mockPrisma.posPrintDocument.findUnique).not.toHaveBeenCalled();
  });
});
