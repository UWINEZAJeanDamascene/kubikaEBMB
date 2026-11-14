const mockPrisma = {
  posPrintAgent: { updateMany: jest.fn() },
  posRegister: { findFirst: jest.fn() },
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
        idempotencyKey: 'receipt-1',
        payload: {
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
      receiptNumber: 'R-100',
      items: [{ description: 'Tea', total: 100 }],
    });
    expect(JSON.stringify(storedPayload)).not.toMatch(/Sensitive Customer|customer@example|123456789|250788123456/);
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
    expect(purge.where.status.in).toEqual(['transmitted', 'confirmed', 'failed', 'expired', 'uncertain']);
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
