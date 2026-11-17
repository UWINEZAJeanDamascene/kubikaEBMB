const mockPrisma = {
  posPrintDocument: { findFirst: jest.fn(), create: jest.fn() },
  posPrintJob: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), groupBy: jest.fn() },
  posStoredValueAccount: { findFirst: jest.fn() },
  posCashMovement: { findFirst: jest.fn() },
  posZReport: { findFirst: jest.fn() },
  invoice: { findFirst: jest.fn() },
  posShift: { findFirst: jest.fn() },
  posEbmReceiptReprint: { findFirst: jest.fn() },
  posPrintAgent: { findMany: jest.fn() },
  posPrintPrinter: { findMany: jest.fn(), update: jest.fn() },
  $queryRawUnsafe: jest.fn(),
};

jest.mock('../lib/prisma', () => ({ prisma: mockPrisma }));
jest.mock('../services/posAuditService', () => ({
  requestIp: jest.fn(() => '127.0.0.1'),
  writePosAuditLog: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../controllers/invoiceController', () => ({
  renderInvoicePdfBuffer: jest.fn(),
}));
jest.mock('../controllers/tillZReportController', () => ({ buildReport: jest.fn() }));

const controller = require('../controllers/posPrintJobController');
const { buildReport } = require('../controllers/tillZReportController');

function response() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader(name, value) { this.headers[name] = value; return this; },
  };
}

function cashierRequest(body = {}, params = {}) {
  return {
    body,
    params,
    posAuthContext: {
      company: { id: 'a'.repeat(24), name: 'Kubika Shop' },
      register: { id: 'b'.repeat(24), code: 'front-register' },
      user: { id: 'c'.repeat(24) },
    },
  };
}

describe('stored POS thermal print documents', () => {
  const originalSecret = process.env.JWT_SECRET;
  const companyId = 'a'.repeat(24);
  const registerId = 'b'.repeat(24);
  const userId = 'c'.repeat(24);

  beforeAll(() => { process.env.JWT_SECRET = 'test-secret-with-more-than-thirty-two-characters'; });
  afterAll(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
  });
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.posPrintDocument.findFirst.mockResolvedValue(null);
    mockPrisma.posPrintDocument.create.mockImplementation(async ({ data }) => data);
    mockPrisma.posPrintJob.findFirst.mockResolvedValue(null);
    mockPrisma.posPrintJob.create.mockImplementation(async ({ data }) => data);
  });

  test('encrypts the one-time gift-card code and creates a reference-only print job', async () => {
    const code = 'KB-ABCD-EFGH';
    mockPrisma.posStoredValueAccount.findFirst.mockResolvedValue({
      id: 'd'.repeat(24),
      balance: 1200,
      currencyCode: 'RWF',
      expiresAt: null,
      codeSuffix: 'EFGH',
    });
    const res = response();

    await controller.createGiftCardPrintJob(
      cashierRequest({ code, paperWidthMm: 58, reprint: false, idempotencyKey: 'gift-print-1' }),
      res,
      jest.fn(),
    );

    const stored = mockPrisma.posPrintDocument.create.mock.calls[0][0].data;
    const job = mockPrisma.posPrintJob.create.mock.calls[0][0].data;
    expect(res.statusCode).toBe(201);
    expect(stored.payloadJson.giftCard.code).toBeUndefined();
    expect(stored.payloadJson.giftCard.codeEncrypted.algorithm).toBe('aes-256-gcm');
    expect(stored.payloadJson.giftCard.value).toBe('RWF 1,200');
    expect(JSON.stringify(stored.payloadJson)).not.toContain(code);
    expect(stored.payloadJson.columns).toBe(32);
    expect(job).toMatchObject({
      companyId,
      registerId,
      jobType: 'gift-card-slip',
      payloadJson: {},
      documentId: stored.id,
      documentVersion: stored.version,
      copyNumber: 0,
      copyRequired: false,
    });
    expect(res.body.data).toMatchObject({ documentId: stored.id, documentVersion: stored.version });

    mockPrisma.posPrintDocument.findFirst.mockResolvedValue(stored);
    mockPrisma.posPrintJob.findFirst.mockResolvedValue({ id: job.id });
    const agentRes = response();
    await controller.getAgentPrintDocument({
      params: { documentId: stored.id, version: String(stored.version) },
      printAgent: { id: 'e'.repeat(24), companyId, registerId },
    }, agentRes, jest.fn());

    expect(agentRes.body.data.payloadJson.giftCard.code).toBe(code);
    expect(agentRes.headers['Cache-Control']).toContain('no-store');
    expect(mockPrisma.posPrintDocument.findFirst.mock.calls[1][0].where).toMatchObject({
      id: stored.id,
      companyId,
      registerId,
      version: stored.version,
    });
  });

  test('stores only the code suffix for gift-card reprints', async () => {
    mockPrisma.posStoredValueAccount.findFirst.mockResolvedValue({
      id: 'd'.repeat(24),
      balance: 1200,
      currencyCode: 'RWF',
      expiresAt: null,
      codeSuffix: 'EFGH',
    });
    const res = response();

    await controller.createGiftCardPrintJob(
      cashierRequest({ code: 'KB-ABCD-EFGH', paperWidthMm: 80, reprint: true, idempotencyKey: 'gift-print-copy-1' }),
      res,
      jest.fn(),
    );

    const stored = mockPrisma.posPrintDocument.create.mock.calls[0][0].data;
    const job = mockPrisma.posPrintJob.create.mock.calls[0][0].data;
    expect(stored.payloadJson.giftCard).toMatchObject({ code: 'EFGH', value: 'RWF 1,200' });
    expect(stored.payloadJson.giftCard.codeEncrypted).toBeUndefined();
    expect(JSON.stringify(stored.payloadJson)).not.toContain('KB-ABCD-EFGH');
    expect(job).toMatchObject({ copyNumber: 1, copyRequired: true, payloadJson: {} });
  });

  test('builds cash-movement slips from the saved movement and references its document', async () => {
    mockPrisma.posCashMovement.findFirst.mockResolvedValue({
      id: 'd'.repeat(24),
      shiftId: 'e'.repeat(24),
      type: 'cash_out',
      amount: 5000,
      reasonCode: 'BANK_DEPOSIT',
      reference: 'KUBIKA-DEP-42',
      bankSlipReference: 'BANK-42',
      note: 'Deposit to bank',
      createdAt: new Date('2026-11-16T08:00:00.000Z'),
      shift: { shiftNumber: 7 },
    });
    const res = response();

    await controller.createCashMovementPrintJob(
      cashierRequest({ idempotencyKey: 'movement-print-1' }, { movementId: 'd'.repeat(24) }),
      res,
      jest.fn(),
    );

    const document = mockPrisma.posPrintDocument.create.mock.calls[0][0].data;
    const job = mockPrisma.posPrintJob.create.mock.calls[0][0].data;
    expect(document.payloadJson).toMatchObject({
      jobType: 'cash-movement-slip',
      movementNumber: 'd'.repeat(24),
      shiftNumber: 7,
      total: 'RWF 5,000',
    });
    expect(document.payloadJson.lines[0].total).toBe('RWF 5,000');
    expect(job).toMatchObject({
      sourceDocumentId: 'd'.repeat(24),
      shiftId: 'e'.repeat(24),
      payloadJson: {},
      documentId: document.id,
      documentVersion: document.version,
    });
  });

  test('builds Z-report slips from the persisted snapshot, not a recalculation', async () => {
    mockPrisma.posZReport.findFirst.mockResolvedValue({
      id: 'd'.repeat(24),
      zNumber: 17,
      generatedAt: new Date('2026-11-16T09:00:00.000Z'),
      snapshot: {
        reportType: 'Z',
        business: { name: 'Kubika Shop' },
        shift: { id: 'e'.repeat(24), number: 7 },
        sales: { transactionCount: 3, gross: 14000, discounts: 1000, tax: 1200, total: 14200 },
        cash: { expectedCash: 9200, count: 9100, variance: -100 },
        paymentMethods: { cash: 9000, momo: 5200 },
      },
    });
    const res = response();

    await controller.createZReportPrintJob(
      cashierRequest({ paperWidthMm: 80, idempotencyKey: 'z-report-print-1' }, { shiftId: 'e'.repeat(24) }),
      res,
      jest.fn(),
    );

    const document = mockPrisma.posPrintDocument.create.mock.calls[0][0].data;
    const job = mockPrisma.posPrintJob.create.mock.calls[0][0].data;
    expect(document.payloadJson).toMatchObject({
      jobType: 'z-report',
      reportNumber: 17,
      total: 'RWF 14,200',
    });
    expect(document.payloadJson.lines).toEqual(expect.arrayContaining([
      { name: 'Expected cash', quantity: 1, total: 'RWF 9,200' },
      { name: 'cash', quantity: 1, total: 'RWF 9,000' },
    ]));
    expect(job).toMatchObject({
      sourceDocumentId: 'd'.repeat(24),
      shiftId: 'e'.repeat(24),
      payloadJson: {},
      documentId: document.id,
      documentVersion: document.version,
    });
  });

  test('builds a live X-report from the register open shift and stores a reference-only job', async () => {
    const shiftId = 'e'.repeat(24);
    const generatedAt = '2026-11-16T10:00:00.000Z';
    mockPrisma.$queryRawUnsafe.mockResolvedValue([{
      id: shiftId,
      companyId,
      registerId: 'front-register',
      status: 'open',
      openedAt: new Date('2026-11-16T08:00:00.000Z'),
      cashierId: userId,
      cashierName: 'Cashier name must not be stored in the thermal summary',
    }]);
    buildReport.mockResolvedValue({
      reportType: 'X',
      generatedAt,
      business: { name: 'Kubika Shop' },
      branch: { name: 'Kigali' },
      shift: { id: shiftId, number: 7 },
      sales: { transactionCount: 3, gross: 14000, discounts: 1000, netBeforeTax: 13000, tax: 1200, total: 14200, netSales: 14200 },
      cash: { expectedCash: 9200, ledgerDifference: -100 },
      refunds: { count: 1 },
      voids: { count: 2 },
      noSales: { count: 1 },
      paymentMethods: { cash: 9000, momo: 5200 },
      cashiers: [{ cashier: { name: 'Cashier name must not be stored in the thermal summary' } }],
    });
    const res = response();

    await controller.createXReportPrintJob(
      cashierRequest({ paperWidthMm: 80, idempotencyKey: `x-report:${shiftId}:${Date.parse(generatedAt)}` }, { shiftId }),
      res,
      jest.fn(),
    );

    expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledWith(expect.stringContaining("ts.status = 'open'"), shiftId, companyId, 'front-register');
    expect(buildReport).toHaveBeenCalledWith(companyId, expect.objectContaining({ id: shiftId, status: 'open' }));
    const document = mockPrisma.posPrintDocument.create.mock.calls[0][0].data;
    const job = mockPrisma.posPrintJob.create.mock.calls[0][0].data;
    expect(document.payloadJson).toMatchObject({
      jobType: 'x-report',
      title: 'X REPORT',
      columns: 42,
      total: 'RWF 14,200',
      footer: `Shift 7`,
    });
    expect(document.payloadJson.lines).toEqual(expect.arrayContaining([
      { name: 'Transactions', quantity: 1, total: '3' },
      { name: 'Expected cash', quantity: 1, total: 'RWF 9,200' },
      { name: 'cash', quantity: 1, total: 'RWF 9,000' },
    ]));
    expect(JSON.stringify(document.payloadJson)).not.toContain('Cashier name must not be stored');
    expect(job).toMatchObject({
      jobType: 'x-report',
      sourceDocumentId: shiftId,
      shiftId,
      payloadJson: {},
      documentId: document.id,
      documentVersion: document.version,
    });
    expect(res.statusCode).toBe(201);
  });

  test('refuses X-report jobs for shifts that are no longer open', async () => {
    const shiftId = 'e'.repeat(24);
    mockPrisma.$queryRawUnsafe.mockResolvedValue([]);
    const res = response();

    await controller.createXReportPrintJob(
      cashierRequest({ paperWidthMm: 58, idempotencyKey: `x-report:${shiftId}:${Date.now()}` }, { shiftId }),
      res,
      jest.fn(),
    );

    expect(res.statusCode).toBe(404);
    expect(res.body.code).toBe('POS_X_REPORT_NOT_FOUND');
    expect(mockPrisma.posPrintDocument.create).not.toHaveBeenCalled();
  });

  test('stores receipt attempts as versioned references and strips public bearer links', async () => {
    const invoiceId = 'd'.repeat(24);
    mockPrisma.invoice.findFirst.mockResolvedValue({ id: invoiceId });
    mockPrisma.posShift.findFirst.mockResolvedValue({ id: 'e'.repeat(24) });
    mockPrisma.posPrintJob.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.posPrintJob.update.mockResolvedValue({});
    const receiptDocument = {
      version: 1,
      receipt: { number: 'INV-42' },
      digital: { url: 'https://receipt.example.test/secret-token', qrDataUrl: 'data:image/png;base64,private' },
      flags: { copyNumber: 0, isCopy: false, receiptType: 'REFUND' },
    };
    const res = response();

    await controller.beginCashierReceiptAttempt(
      cashierRequest({
        sourceDocumentId: invoiceId,
        jobType: 'refund-receipt',
        copyNumber: 0,
        receiptDocument,
      }),
      res,
      jest.fn(),
    );

    const document = mockPrisma.posPrintDocument.create.mock.calls[0][0].data;
    const job = mockPrisma.posPrintJob.create.mock.calls[0][0].data;
    expect(document.payloadJson.receipt.digital).toBeUndefined();
    expect(JSON.stringify(document.payloadJson)).not.toContain('secret-token');
    expect(job).toMatchObject({
      localOnly: true,
      payloadJson: {},
      documentId: document.id,
      documentVersion: document.version,
      jobType: 'refund-receipt',
    });
    expect(res.body.data).toMatchObject({ documentId: document.id, documentVersion: document.version });
  });

  test('refuses document retrieval outside the authenticated agent register', async () => {
    mockPrisma.posPrintDocument.findFirst.mockResolvedValue(null);
    const res = response();

    await controller.getAgentPrintDocument({
      params: { documentId: 'd'.repeat(24), version: '1' },
      printAgent: { id: 'e'.repeat(24), companyId, registerId: 'f'.repeat(24) },
    }, res, jest.fn());

    expect(res.statusCode).toBe(404);
    expect(res.body.code).toBe('PRINT_DOCUMENT_NOT_FOUND');
    expect(mockPrisma.posPrintJob.findFirst).not.toHaveBeenCalled();
  });

  test('stores only status from printers registered to the reporting agent', async () => {
    mockPrisma.posPrintPrinter.findMany.mockResolvedValue([
      { id: 'd'.repeat(24), name: 'Receipt', address: 'Receipt', transport: 'windows-spooler' },
    ]);
    mockPrisma.posPrintPrinter.update.mockImplementation(async ({ data }) => data);
    mockPrisma.posPrintAgent.updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const res = response();
    await controller.reportAgentStatus({
      printAgent: { id: 'e'.repeat(24), companyId },
      body: { version: '0.1.5', printers: [
        { name: 'Receipt', address: 'Receipt', status: 'paper-out', lastError: 'Paper out' },
        { name: 'Unregistered', address: 'Unregistered', status: 'ready' },
      ] },
    }, res, jest.fn());
    expect(res.body).toMatchObject({ success: true, data: { updated: 1 } });
    expect(mockPrisma.posPrintPrinter.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'd'.repeat(24) }, data: expect.objectContaining({ status: 'paper-out', lastError: 'Paper out' }),
    }));
    expect(mockPrisma.posPrintAgent.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'e'.repeat(24), companyId }, data: expect.objectContaining({ version: '0.1.5', lastSeenAt: expect.any(Date) }),
    }));
  });

  test('surfaces offline, repeated-failure, backlog and printer-health alerts to managers', async () => {
    mockPrisma.posPrintAgent.findMany.mockResolvedValue([{
      id: 'e'.repeat(24), status: 'active', lastSeenAt: new Date(0),
      printers: [{ id: 'd'.repeat(24), status: 'offline', lastError: 'Printer is offline.' }],
    }]);
    mockPrisma.posPrintJob.groupBy.mockResolvedValue([
      { agentId: 'e'.repeat(24), status: 'queued', _count: { _all: 10 } },
      { agentId: 'e'.repeat(24), status: 'failed', _count: { _all: 3 } },
    ]);
    const res = response();
    await controller.listAgents({ user: { companyId } }, res, jest.fn());
    expect(res.body.data[0].alerts.map((alert) => alert.code)).toEqual(expect.arrayContaining([
      'AGENT_OFFLINE', 'REPEATED_PRINT_FAILURES', 'PRINT_BACKLOG_GROWING', 'PRINTER_NEEDS_ATTENTION',
    ]));
  });
});
