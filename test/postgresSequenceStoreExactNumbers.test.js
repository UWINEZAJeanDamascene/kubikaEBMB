jest.mock('../lib/prisma', () => ({
  prisma: { $queryRawUnsafe: jest.fn() },
}));

const { prisma } = require('../lib/prisma');
const {
  MAX_VSDC_NUMBER,
  allocateEbmSequence,
  seedEbmSequence,
} = require('../services/postgresSequenceStore');

describe('exact NUMBER(38) EBM fiscal sequence storage', () => {
  beforeEach(() => jest.clearAllMocks());

  it('stores and returns a 38-digit initialization seed without Number conversion', async () => {
    const counter = '12345678901234567890123456789012345678';
    prisma.$queryRawUnsafe.mockResolvedValue([{
      last_number: { toString: () => '1.2345678901234567890123456789012345678e+37', toFixed: () => counter },
    }]);

    const seeded = await seedEbmSequence('company-1', '00', 'sales_invoice', BigInt(counter));

    expect(seeded).toBe(counter);
    expect(prisma.$queryRawUnsafe.mock.calls[0][0]).toContain('GREATEST(ebm_sequences.last_number, EXCLUDED.last_number)');
    expect(prisma.$queryRawUnsafe.mock.calls[0]).toContain(counter);
  });

  it('increments exact large counters and guards at the NUMBER(38) maximum', async () => {
    const next = '12345678901234567890123456789012345679';
    prisma.$queryRawUnsafe.mockResolvedValue([{ last_number: next }]);

    await expect(allocateEbmSequence('company-1', '00', 'receipt')).resolves.toBe(next);

    const [query, ...params] = prisma.$queryRawUnsafe.mock.calls[0];
    expect(query).toContain('WHERE ebm_sequences.last_number < $4::numeric');
    expect(params).toContain(MAX_VSDC_NUMBER);
  });

  it('fails closed when the exact counter is already at NUMBER(38) maximum', async () => {
    prisma.$queryRawUnsafe.mockResolvedValue([]);

    await expect(allocateEbmSequence('company-1', '00', 'receipt'))
      .rejects.toMatchObject({ code: 'EBM_FISCAL_SEQUENCE_EXHAUSTED' });
  });

  it('rejects values beyond the NUMBER(38) contract', async () => {
    await expect(seedEbmSequence('company-1', '00', 'sales_invoice', `${MAX_VSDC_NUMBER}0`))
      .rejects.toMatchObject({ code: 'EBM_FISCAL_SEQUENCE_INVALID' });
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});
