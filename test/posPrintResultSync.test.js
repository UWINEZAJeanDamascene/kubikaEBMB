const mockPrisma = {
  posPrintJob: {
    create: jest.fn(),
    findFirst: jest.fn(),
    updateMany: jest.fn(),
  },
};

jest.mock('../lib/prisma', () => ({ prisma: mockPrisma }));
jest.mock('../services/posAuditService', () => ({
  requestIp: jest.fn(() => '127.0.0.1'),
  writePosAuditLog: jest.fn().mockResolvedValue(undefined),
}));

const { writePosAuditLog } = require('../services/posAuditService');
const controller = require('../controllers/posPrintJobController');

function response() {
  const res = {
    status: jest.fn(),
    json: jest.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

describe('offline print result synchronization', () => {
  beforeEach(() => jest.clearAllMocks());

  test('records an offline receipt result without uploading its receipt payload', async () => {
    const companyId = 'a'.repeat(24);
    const registerId = 'b'.repeat(24);
    const sourceDocumentId = 'c'.repeat(24);
    const idempotencyKey = `${sourceDocumentId}:0:receipt`;
    mockPrisma.posPrintJob.findFirst.mockResolvedValue(null);
    mockPrisma.posPrintJob.create.mockImplementation(async ({ data }) => data);
    const req = {
      printAgent: { id: 'd'.repeat(24), companyId, registerId },
      body: {
        results: [{
          idempotencyKey,
          jobType: 'receipt',
          status: 'transmitted',
          printedAt: new Date().toISOString(),
        }],
      },
    };
    const res = response();

    await controller.syncLocalResults(req, res, jest.fn());

    const { data: create } = mockPrisma.posPrintJob.create.mock.calls[0][0];
    expect(create).toMatchObject({
      companyId,
      registerId,
      idempotencyKey,
      jobType: 'receipt',
      status: 'transmitted',
      localOnly: true,
      sourceDocumentId,
      copyNumber: 0,
      payloadJson: {},
    });
    expect(create.payloadHash).toMatch(/^[a-f\d]{64}$/);
    expect(Object.keys(create)).not.toContain('receipt');
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { syncedKeys: [idempotencyKey], rejected: [] },
    });
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'PRINT_JOB_TRANSMITTED',
      metadata: expect.objectContaining({ offlineSync: true, sourceDocumentId }),
    }));
  });

  test('atomically advances an online-created local-only attempt to its agent result', async () => {
    const companyId = 'a'.repeat(24);
    const registerId = 'b'.repeat(24);
    const sourceDocumentId = 'c'.repeat(24);
    const idempotencyKey = `${sourceDocumentId}:0:receipt`;
    const payloadHash = require('crypto').createHash('sha256')
      .update(JSON.stringify({ sourceDocumentId, copyNumber: 0, jobType: 'receipt' }))
      .digest('hex');
    mockPrisma.posPrintJob.findFirst.mockResolvedValue({
      id: 'e'.repeat(24),
      companyId,
      registerId,
      idempotencyKey,
      jobType: 'receipt',
      status: 'transmitting',
      localOnly: true,
      payloadHash,
      createdById: 'f'.repeat(24),
    });
    mockPrisma.posPrintJob.updateMany.mockResolvedValue({ count: 1 });
    const req = {
      printAgent: { id: 'd'.repeat(24), companyId, registerId },
      body: { results: [{ idempotencyKey, jobType: 'receipt', status: 'uncertain' }] },
    };
    const res = response();

    await controller.syncLocalResults(req, res, jest.fn());

    expect(mockPrisma.posPrintJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'e'.repeat(24), status: 'transmitting', localOnly: true }),
      data: expect.objectContaining({
        status: 'uncertain',
        lastError: 'The print agent could not confirm whether the receipt printed.',
      }),
    }));
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'f'.repeat(24),
      event: 'PRINT_JOB_UNCERTAIN',
    }));
  });

  test('syncs five offline receipt outcomes idempotently without creating sale records', async () => {
    const companyId = 'a'.repeat(24);
    const registerId = 'b'.repeat(24);
    const jobs = new Map();
    mockPrisma.posPrintJob.findFirst.mockImplementation(async ({ where }) => jobs.get(where.idempotencyKey) || null);
    mockPrisma.posPrintJob.create.mockImplementation(async ({ data }) => {
      jobs.set(data.idempotencyKey, data);
      return data;
    });
    const results = Array.from({ length: 5 }, (_, index) => ({
      idempotencyKey: `${String(index + 1).repeat(24)}:0:receipt`,
      jobType: 'receipt',
      status: 'transmitted',
      printedAt: new Date().toISOString(),
    }));
    const req = { printAgent: { id: 'd'.repeat(24), companyId, registerId }, body: { results } };

    const firstResponse = response();
    await controller.syncLocalResults(req, firstResponse, jest.fn());
    const repeatedResponse = response();
    await controller.syncLocalResults(req, repeatedResponse, jest.fn());

    expect(mockPrisma.posPrintJob.create).toHaveBeenCalledTimes(5);
    expect(jobs.size).toBe(5);
    expect(firstResponse.json).toHaveBeenCalledWith({
      success: true,
      data: { syncedKeys: results.map((result) => result.idempotencyKey), rejected: [] },
    });
    expect(repeatedResponse.json).toHaveBeenCalledWith({
      success: true,
      data: { syncedKeys: results.map((result) => result.idempotencyKey), rejected: [] },
    });
    expect([...jobs.values()].every((job) => job.payloadJson && Object.keys(job.payloadJson).length === 0)).toBe(true);
  });
});
