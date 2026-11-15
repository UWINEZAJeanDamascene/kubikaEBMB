const crypto = require('crypto');

const mockPrisma = {
  posPrintAgent: { updateMany: jest.fn() },
  posRegister: { findFirst: jest.fn() },
  posShift: { findFirst: jest.fn() },
  invoice: { findFirst: jest.fn() },
  posEbmReceiptReprint: { findFirst: jest.fn(), findMany: jest.fn() },
  posPrintJob: {
    findFirst: jest.fn(),
    create: jest.fn(),
    findMany: jest.fn(),
    updateMany: jest.fn(),
    update: jest.fn(),
    deleteMany: jest.fn(),
  },
};

jest.mock('../lib/prisma', () => ({ prisma: mockPrisma }));
jest.mock('../services/posAuditService', () => ({
  requestIp: jest.fn(() => '127.0.0.1'),
  writePosAuditLog: jest.fn().mockResolvedValue(undefined),
}));

const controller = require('../controllers/posPrintJobController');
const { expireAndCleanup } = require('../services/posPrintMaintenanceService');
const { writePosAuditLog } = require('../services/posAuditService');

function response() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return res;
}

describe('POS print-job privacy and retention', () => {
  beforeEach(() => jest.clearAllMocks());

  test('removes customer fields before storing a print job', async () => {
    mockPrisma.posRegister.findFirst.mockResolvedValue({ id: 'b'.repeat(24) });
    mockPrisma.posPrintJob.findFirst.mockResolvedValue(null);
    mockPrisma.posPrintJob.create.mockResolvedValue({
      id: 'c'.repeat(24),
      status: 'queued',
      expiresAt: new Date(),
    });
    const req = {
      user: { companyId: 'a'.repeat(24), id: 'd'.repeat(24) },
      body: {
        registerId: 'b'.repeat(24),
        jobType: 'receipt',
        idempotencyKey: `${'e'.repeat(24)}:0:receipt`,
        payload: {
          version: 1,
          flags: { isCopy: false, copyNumber: 0, receiptType: 'SALE' },
          receiptNumber: 'R-100',
          customer: { name: 'Sensitive Customer', email: 'customer@example.test' },
          customerPhone: '+250788123456',
          buyerTin: '123456789',
          items: [{ description: 'Tea', total: 100 }],
        },
      },
    };
    const res = response();

    await controller.createJob(req, res, jest.fn());

    expect(res.statusCode).toBe(201);
    const storedPayload = mockPrisma.posPrintJob.create.mock.calls[0][0].data.payloadJson;
    expect(storedPayload).toEqual({
      version: 1,
      flags: { isCopy: false, copyNumber: 0, receiptType: 'SALE' },
      receiptNumber: 'R-100',
      items: [{ description: 'Tea', total: 100 }],
    });
    expect(mockPrisma.posPrintJob.create.mock.calls[0][0].data).toEqual(expect.objectContaining({
      sourceDocumentId: 'e'.repeat(24),
      copyNumber: 0,
      copyRequired: false,
    }));
    expect(JSON.stringify(storedPayload)).not.toMatch(/Sensitive Customer|customer@example|123456789|250788123456/);
  });

  test('rejects a receipt key whose copy number does not match the document', async () => {
    const req = {
      user: { companyId: 'a'.repeat(24), id: 'd'.repeat(24) },
      body: {
        registerId: 'b'.repeat(24),
        jobType: 'receipt',
        idempotencyKey: `${'e'.repeat(24)}:0:receipt`,
        payload: {
          version: 1,
          flags: { isCopy: true, copyNumber: 1, receiptType: 'SALE' },
        },
      },
    };
    const res = response();

    await controller.createJob(req, res, jest.fn());

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('PRINT_JOB_COPY_KEY_MISMATCH');
    expect(mockPrisma.posRegister.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.posPrintJob.create).not.toHaveBeenCalled();
  });

  test('applies the document-specific print job TTL and retry limits', async () => {
    mockPrisma.posRegister.findFirst.mockResolvedValue({ id: 'b'.repeat(24) });
    mockPrisma.posPrintJob.findFirst.mockResolvedValue(null);
    mockPrisma.posPrintJob.create.mockResolvedValue({ id: 'c'.repeat(24), status: 'queued', expiresAt: new Date() });
    const cases = [
      { jobType: 'receipt', ttlSeconds: 120, maxAttempts: 9, payload: { version: 1, flags: { isCopy: false, copyNumber: 0, receiptType: 'SALE' } }, key: `${'e'.repeat(24)}:0:receipt` },
      { jobType: 'gift-card-slip', ttlSeconds: 120, maxAttempts: 9, payload: { code: 'TEST' }, key: 'gift-card-test' },
      { jobType: 'x-report', ttlSeconds: 600, maxAttempts: 8, payload: { report: 'test' }, key: 'x-report-test' },
      { jobType: 'test-print', ttlSeconds: 30, maxAttempts: 3, payload: { test: true }, key: 'test-print-test' },
      { jobType: 'invoice-pdf', ttlSeconds: 86400, maxAttempts: 12, payload: { pdfBase64: 'dGVzdA==' }, key: 'invoice-test' },
    ];

    for (const [index, item] of cases.entries()) {
      const req = {
        user: { companyId: 'a'.repeat(24), id: 'd'.repeat(24) },
        body: { registerId: 'b'.repeat(24), jobType: item.jobType, idempotencyKey: item.key, payload: item.payload },
      };
      const res = response();
      await controller.createJob(req, res, jest.fn());
      const data = mockPrisma.posPrintJob.create.mock.calls[index][0].data;
      expect(Math.round((data.expiresAt.getTime() - Date.now()) / 1000)).toBe(item.ttlSeconds);
      expect(data.maxAttempts).toBe(item.maxAttempts);
    }
  });

  test('starts a shift-scoped cashier attempt without storing the receipt body', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue({ id: 'e'.repeat(24) });
    mockPrisma.posShift.findFirst.mockResolvedValue({ id: 'f'.repeat(24) });
    mockPrisma.posPrintJob.findFirst.mockResolvedValue(null);
    mockPrisma.posPrintJob.create.mockImplementation(async ({ data }) => ({ id: data.id, status: data.status }));
    const req = {
      posAuthContext: {
        company: { id: 'a'.repeat(24) },
        register: { id: 'b'.repeat(24) },
        user: { id: 'd'.repeat(24) },
      },
      body: { sourceDocumentId: 'e'.repeat(24), jobType: 'receipt', copyNumber: 0 },
      ip: '127.0.0.1',
    };
    const res = response();

    await controller.beginCashierReceiptAttempt(req, res, jest.fn());

    const created = mockPrisma.posPrintJob.create.mock.calls[0][0].data;
    expect(res.statusCode).toBe(201);
    expect(created).toEqual(expect.objectContaining({
      registerId: 'b'.repeat(24),
      shiftId: 'f'.repeat(24),
      idempotencyKey: `${'e'.repeat(24)}:0:receipt`,
      sourceDocumentId: 'e'.repeat(24),
      status: 'transmitting',
      localOnly: true,
      payloadJson: {},
    }));
    expect(JSON.stringify(created.payloadJson)).not.toMatch(/customer|email|phone|receiptLines/i);
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'PRINT_ATTEMPT_STARTED',
      metadata: expect.objectContaining({ shiftId: 'f'.repeat(24), sourceDocumentId: 'e'.repeat(24) }),
    }));
  });

  test('allows a receipt linked by the authenticated register code for legacy sales', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue({ id: 'e'.repeat(24) });
    mockPrisma.posShift.findFirst.mockResolvedValue({ id: 'f'.repeat(24) });
    mockPrisma.posPrintJob.findFirst.mockResolvedValue(null);
    mockPrisma.posPrintJob.create.mockImplementation(async ({ data }) => ({ id: data.id, status: data.status }));
    const req = {
      posAuthContext: {
        company: { id: 'a'.repeat(24) },
        register: { id: 'b'.repeat(24), code: 'REGISTER-01' },
        user: { id: 'd'.repeat(24) },
      },
      body: { sourceDocumentId: 'e'.repeat(24), jobType: 'receipt', copyNumber: 0 },
      ip: '127.0.0.1',
    };
    const res = response();

    await controller.beginCashierReceiptAttempt(req, res, jest.fn());

    expect(mockPrisma.invoice.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: expect.arrayContaining([
          { registerId: 'b'.repeat(24) },
          { registerId: 'REGISTER-01' },
          { registerId: null },
        ]),
      }),
    }));
    expect(res.statusCode).toBe(201);
  });

  test('does not reuse a company-wide receipt key from a different register', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue({ id: 'e'.repeat(24) });
    mockPrisma.posShift.findFirst.mockResolvedValue({ id: 'f'.repeat(24) });
    mockPrisma.posPrintJob.findFirst.mockResolvedValue({
      id: 'c'.repeat(24),
      registerId: '9'.repeat(24),
      payloadHash: crypto.createHash('sha256')
        .update(JSON.stringify({ sourceDocumentId: 'e'.repeat(24), copyNumber: 0, jobType: 'receipt' }))
        .digest('hex'),
      localOnly: true,
      status: 'queued',
    });
    const req = {
      posAuthContext: {
        company: { id: 'a'.repeat(24) },
        register: { id: 'b'.repeat(24) },
        user: { id: 'd'.repeat(24) },
      },
      body: { sourceDocumentId: 'e'.repeat(24), jobType: 'receipt', copyNumber: 0 },
    };
    const res = response();

    await controller.beginCashierReceiptAttempt(req, res, jest.fn());

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('PRINT_IDEMPOTENCY_CONFLICT');
    expect(mockPrisma.posPrintJob.updateMany).not.toHaveBeenCalled();
  });

  test('requires a prepared signed copy before creating a copy-number attempt', async () => {
    mockPrisma.invoice.findFirst.mockResolvedValue({ id: 'e'.repeat(24) });
    mockPrisma.posShift.findFirst.mockResolvedValue({ id: 'f'.repeat(24) });
    mockPrisma.posEbmReceiptReprint.findFirst.mockResolvedValue(null);
    const req = {
      posAuthContext: {
        company: { id: 'a'.repeat(24) },
        register: { id: 'b'.repeat(24) },
        user: { id: 'd'.repeat(24) },
      },
      body: { sourceDocumentId: 'e'.repeat(24), jobType: 'receipt', copyNumber: 1 },
    };
    const res = response();

    await controller.beginCashierReceiptAttempt(req, res, jest.fn());

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('POS_RECEIPT_COPY_NOT_FOUND');
    expect(mockPrisma.posPrintJob.create).not.toHaveBeenCalled();
  });

  test('records cashier confirmation and cancellation as audited state transitions', async () => {
    mockPrisma.posPrintJob.findFirst.mockResolvedValue({
      id: 'c'.repeat(24), status: 'uncertain', shiftId: 'f'.repeat(24),
      sourceDocumentId: 'e'.repeat(24), copyNumber: 0, jobType: 'receipt',
    });
    mockPrisma.posPrintJob.updateMany.mockResolvedValue({ count: 1 });
    const req = {
      params: { jobId: 'c'.repeat(24) },
      body: { outcome: 'confirm' },
      posAuthContext: {
        company: { id: 'a'.repeat(24) },
        register: { id: 'b'.repeat(24) },
        user: { id: 'd'.repeat(24) },
      },
      ip: '127.0.0.1',
    };
    const res = response();

    await controller.recordCashierReceiptOutcome(req, res, jest.fn());

    expect(mockPrisma.posPrintJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'c'.repeat(24), status: 'uncertain', localOnly: true }),
      data: expect.objectContaining({ status: 'confirmed', confirmedAt: expect.any(Date) }),
    }));
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'PRINT_JOB_CONFIRMED',
      metadata: expect.objectContaining({ jobId: 'c'.repeat(24), shiftId: 'f'.repeat(24) }),
    }));
    expect(res.body.data.status).toBe('confirmed');
  });

  test('cancels a cashier-selected receipt and retains the reason in the audit event', async () => {
    mockPrisma.posPrintJob.findFirst.mockResolvedValue({
      id: 'c'.repeat(24), status: 'queued', shiftId: 'f'.repeat(24),
      sourceDocumentId: 'e'.repeat(24), copyNumber: 0, jobType: 'receipt',
    });
    mockPrisma.posPrintJob.updateMany.mockResolvedValue({ count: 1 });
    const req = {
      params: { jobId: 'c'.repeat(24) },
      body: { outcome: 'cancel', reason: 'Cashier skipped the receipt.' },
      posAuthContext: { company: { id: 'a'.repeat(24) }, register: { id: 'b'.repeat(24) }, user: { id: 'd'.repeat(24) } },
      ip: '127.0.0.1',
    };
    const res = response();

    await controller.recordCashierReceiptOutcome(req, res, jest.fn());

    expect(mockPrisma.posPrintJob.updateMany.mock.calls[0][0].data).toEqual(expect.objectContaining({
      status: 'cancelled',
      lastError: 'Cashier skipped the receipt.',
    }));
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'PRINT_JOB_CANCELLED',
      metadata: expect.objectContaining({ reason: 'Cashier skipped the receipt.' }),
    }));
  });

  test('deferring an uncertain transmission preserves its uncertain state', async () => {
    mockPrisma.posPrintJob.findFirst.mockResolvedValue({
      id: 'c'.repeat(24), status: 'uncertain', shiftId: 'f'.repeat(24),
      sourceDocumentId: 'e'.repeat(24), copyNumber: 0, jobType: 'receipt',
    });
    mockPrisma.posPrintJob.updateMany.mockResolvedValue({ count: 1 });
    const req = {
      params: { jobId: 'c'.repeat(24) },
      body: { outcome: 'defer', reason: 'Check the printer after this sale.' },
      posAuthContext: { company: { id: 'a'.repeat(24) }, register: { id: 'b'.repeat(24) }, user: { id: 'd'.repeat(24) } },
      ip: '127.0.0.1',
    };
    const res = response();

    await controller.recordCashierReceiptOutcome(req, res, jest.fn());

    expect(mockPrisma.posPrintJob.updateMany.mock.calls[0][0].data.status).toBe('uncertain');
    expect(res.body.data.status).toBe('uncertain');
  });

  test.each([
    ['confirm', 'confirmed'],
    ['defer', 'uncertain'],
  ])('allows %s to resolve a stale transmitting cashier attempt', async (outcome, expectedStatus) => {
    mockPrisma.posPrintJob.findFirst.mockResolvedValue({
      id: 'c'.repeat(24), status: 'transmitting', shiftId: 'f'.repeat(24),
      sourceDocumentId: 'e'.repeat(24), copyNumber: 0, jobType: 'receipt',
    });
    mockPrisma.posPrintJob.updateMany.mockResolvedValue({ count: 1 });
    const req = {
      params: { jobId: 'c'.repeat(24) },
      body: { outcome, reason: 'Cashier checked the receipt.' },
      posAuthContext: { company: { id: 'a'.repeat(24) }, register: { id: 'b'.repeat(24) }, user: { id: 'd'.repeat(24) } },
      ip: '127.0.0.1',
    };
    const res = response();

    await controller.recordCashierReceiptOutcome(req, res, jest.fn());

    expect(res.statusCode).toBe(200);
    expect(mockPrisma.posPrintJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'c'.repeat(24), status: 'transmitting', localOnly: true }),
      data: expect.objectContaining({ status: expectedStatus }),
    }));
    expect(res.body.data.status).toBe(expectedStatus);
  });

  test('does not cancel a receipt with an uncertain transmission outcome', async () => {
    mockPrisma.posPrintJob.findFirst.mockResolvedValue({
      id: 'c'.repeat(24), status: 'uncertain', shiftId: 'f'.repeat(24),
      sourceDocumentId: 'e'.repeat(24), copyNumber: 0, jobType: 'receipt',
    });
    const req = {
      params: { jobId: 'c'.repeat(24) },
      body: { outcome: 'cancel', reason: 'Cashier skipped the receipt.' },
      posAuthContext: { company: { id: 'a'.repeat(24) }, register: { id: 'b'.repeat(24) }, user: { id: 'd'.repeat(24) } },
      ip: '127.0.0.1',
    };
    const res = response();

    await controller.recordCashierReceiptOutcome(req, res, jest.fn());

    expect(res.statusCode).toBe(409);
    expect(mockPrisma.posPrintJob.updateMany).not.toHaveBeenCalled();
  });

  test('lists shift-scoped cashier attempts without returning printable payloads', async () => {
    mockPrisma.posPrintJob.findMany.mockResolvedValue([{
      id: 'c'.repeat(24), sourceDocumentId: 'e'.repeat(24), copyNumber: 1,
      jobType: 'receipt', status: 'queued', shiftId: 'f'.repeat(24),
      createdAt: new Date(), lastError: null, shift: { shiftNumber: 7 }, payloadJson: { secret: true },
    }]);
    mockPrisma.posEbmReceiptReprint.findMany.mockResolvedValue([{
      invoiceId: 'e'.repeat(24), copyNumber: 1, idempotencyKey: 'copy-key-123456',
    }]);
    const req = {
      posAuthContext: { company: { id: 'a'.repeat(24) }, register: { id: 'b'.repeat(24) } },
    };
    const res = response();

    await controller.listCashierReceiptAttempts(req, res, jest.fn());

    expect(mockPrisma.posPrintJob.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        companyId: 'a'.repeat(24),
        registerId: 'b'.repeat(24),
        localOnly: true,
        status: { in: ['queued', 'failed', 'transmitting', 'transmitted', 'uncertain'] },
      }),
    }));
    expect(res.body.data[0].copyKey).toBe('copy-key-123456');
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });

  test('omits stored payloads from list responses', async () => {
    mockPrisma.posPrintJob.findMany.mockResolvedValue([{
      id: 'c'.repeat(24),
      jobType: 'receipt',
      payloadJson: { customer: 'Sensitive Customer' },
    }]);
    const req = { user: { companyId: 'a'.repeat(24) }, query: {} };
    const res = response();

    await controller.listJobs(req, res, jest.fn());

    expect(res.body.data[0].payloadJson).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('Sensitive Customer');
  });

  test('purges terminal print jobs after the retention window', async () => {
    mockPrisma.posPrintJob.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.posPrintJob.deleteMany.mockResolvedValue({ count: 1 });

    await expireAndCleanup();

    const staleLease = mockPrisma.posPrintJob.updateMany.mock.calls[1][0];
    expect(staleLease).toEqual(expect.objectContaining({
      where: expect.objectContaining({ status: { in: ['leased', 'transmitting'] } }),
      data: expect.objectContaining({ status: 'uncertain' }),
    }));
    const purge = mockPrisma.posPrintJob.deleteMany.mock.calls[0][0];
    expect(purge.where.status.in).toEqual(['transmitted', 'confirmed', 'failed', 'expired', 'uncertain', 'cancelled']);
    expect(purge.where.updatedAt.lt).toBeInstanceOf(Date);
    expect(mockPrisma.posPrintJob.deleteMany).toHaveBeenCalledTimes(1);
  });

  test('marks expired leases uncertain instead of requeueing potentially printed jobs', async () => {
    mockPrisma.posPrintJob.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.posPrintJob.findMany.mockResolvedValue([]);
    const req = { printAgent: { id: 'd'.repeat(24), companyId: 'a'.repeat(24), registerId: 'b'.repeat(24) } };
    const res = response();

    await controller.poll(req, res, jest.fn());

    expect(mockPrisma.posPrintJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: { in: ['leased', 'transmitting'] } }),
      data: expect.objectContaining({ status: 'uncertain' }),
    }));
  });

  test('server polling never picks up cashier-local print attempts', async () => {
    mockPrisma.posPrintAgent.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.posPrintJob.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.posPrintJob.findMany.mockResolvedValue([]);
    const req = { printAgent: { id: 'd'.repeat(24), companyId: 'a'.repeat(24), registerId: 'b'.repeat(24) } };
    const res = response();

    await controller.poll(req, res, jest.fn());

    expect(mockPrisma.posPrintJob.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ localOnly: false }),
    }));
  });

  test('records an agent-reported uncertain print outcome and audits it', async () => {
    mockPrisma.posPrintJob.findFirst.mockResolvedValue({ id: 'c'.repeat(24) });
    mockPrisma.posPrintJob.update.mockResolvedValue({ id: 'c'.repeat(24), status: 'uncertain' });
    const req = {
      params: { jobId: 'c'.repeat(24) },
      body: { leaseToken: 'lease-token', error: 'Agent restarted during output' },
      printAgent: { id: 'd'.repeat(24), companyId: 'a'.repeat(24), registerId: 'b'.repeat(24) },
    };
    const res = response();

    await controller.uncertain(req, res, jest.fn());

    expect(mockPrisma.posPrintJob.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'c'.repeat(24) },
      data: expect.objectContaining({ status: 'uncertain', leaseTokenHash: null }),
    }));
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'PRINT_JOB_UNCERTAIN',
      metadata: expect.objectContaining({ jobId: 'c'.repeat(24), agentId: 'd'.repeat(24) }),
    }));
    expect(res.body.data.status).toBe('uncertain');
  });
});
