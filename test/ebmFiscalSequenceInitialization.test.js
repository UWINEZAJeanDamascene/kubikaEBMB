jest.mock('../services/postgresSequenceStore', () => ({
  MAX_VSDC_NUMBER: '99999999999999999999999999999999999999',
  allocateEbmSequence: jest.fn(),
  seedEbmSequence: jest.fn().mockResolvedValue(0),
}));
jest.mock('../lib/prisma', () => {
  const transactionClient = {};
  return {
    prisma: {
      transactionClient,
      $transaction: jest.fn((callback) => callback(transactionClient)),
    },
  };
});

const sequenceStore = require('../services/postgresSequenceStore');
const { prisma } = require('../lib/prisma');
const { seedFromInitInfo, ensureSalesNumbers } = require('../services/ebmFiscalSequenceService');
const { preserveInitCounterPrecision } = require('../services/ebmService');

describe('initialization fiscal sequence persistence', () => {
  beforeEach(() => jest.clearAllMocks());

  it('preserves 38-digit JSON counters exactly as decimal strings before parsing', () => {
    const counter = '12345678901234567890123456789012345678';
    const source = `{"resultCd":"000","data":{"info":{"lastSaleInvcNo":${counter},"lastPchsInvcNo":${counter},"lastSaleRcptNo":${counter},"lastInvcNo":${counter},"lastTrainInvcNo":${counter},"lastProfrmInvcNo":${counter},"lastCopyInvcNo":${counter}}}}`;
    const parsed = preserveInitCounterPrecision(source);
    for (const field of [
      'lastSaleInvcNo', 'lastPchsInvcNo', 'lastSaleRcptNo', 'lastInvcNo',
      'lastTrainInvcNo', 'lastProfrmInvcNo', 'lastCopyInvcNo',
    ]) expect(parsed.data.info[field]).toBe(counter);
  });

  it('expands scientific-notation integer counters exactly before parsing', () => {
    const parsed = preserveInitCounterPrecision(
      '{"resultCd":"000","data":{"info":{"lastSaleInvcNo":1.2345678901234567890123456789012345678e37}}}',
    );
    expect(parsed.data.info.lastSaleInvcNo).toBe('12345678901234567890123456789012345678');
  });

  it('seeds every supported RRA initialization counter into its own exact integer sequence', async () => {
    await seedFromInitInfo('company-1', '00', {
      lastSaleInvcNo: '9000000001',
      lastInvcNo: '9000000002',
      lastPchsInvcNo: '9000000003',
      lastSaleRcptNo: '9000000004',
      lastTrainInvcNo: '9000000005',
      lastProfrmInvcNo: '9000000006',
      lastCopyInvcNo: '9000000007',
    });

    expect(sequenceStore.seedEbmSequence).toHaveBeenCalledTimes(7);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(sequenceStore.seedEbmSequence).toHaveBeenCalledWith('company-1', '00', 'sales_invoice', 9000000002n, 'vsdc_init', prisma.transactionClient);
    expect(sequenceStore.seedEbmSequence).toHaveBeenCalledWith('company-1', '00', 'purchase_invoice', 9000000003n, 'vsdc_init', prisma.transactionClient);
    expect(sequenceStore.seedEbmSequence).toHaveBeenCalledWith('company-1', '00', 'receipt', 9000000004n, 'vsdc_init', prisma.transactionClient);
    expect(sequenceStore.seedEbmSequence).toHaveBeenCalledWith('company-1', '00', 'report', 9000000004n, 'vsdc_init', prisma.transactionClient);
    expect(sequenceStore.seedEbmSequence).toHaveBeenCalledWith('company-1', '00', 'training_invoice', 9000000005n, 'vsdc_init', prisma.transactionClient);
    expect(sequenceStore.seedEbmSequence).toHaveBeenCalledWith('company-1', '00', 'proforma_invoice', 9000000006n, 'vsdc_init', prisma.transactionClient);
    expect(sequenceStore.seedEbmSequence).toHaveBeenCalledWith('company-1', '00', 'copy_invoice', 9000000007n, 'vsdc_init', prisma.transactionClient);
  });

  it('seeds a 38-digit counter without rounding or clamping it', async () => {
    const counter = '12345678901234567890123456789012345678';
    await seedFromInitInfo('company-1', '00', {
      lastSaleInvcNo: counter,
      lastInvcNo: counter,
      lastPchsInvcNo: counter,
      lastSaleRcptNo: counter,
      lastTrainInvcNo: counter,
      lastProfrmInvcNo: counter,
      lastCopyInvcNo: counter,
    });

    for (const sequenceType of [
      'sales_invoice', 'purchase_invoice', 'receipt', 'report',
      'training_invoice', 'proforma_invoice', 'copy_invoice',
    ]) {
      expect(sequenceStore.seedEbmSequence).toHaveBeenCalledWith(
        'company-1', '00', sequenceType, BigInt(counter), 'vsdc_init', prisma.transactionClient,
      );
    }
  });

  it('keeps 38-digit allocated invoice and receipt numbers exact when persisting a sale', async () => {
    const invoiceNumber = '12345678901234567890123456789012345678';
    const receiptNumber = '22345678901234567890123456789012345678';
    const reportNumber = '32345678901234567890123456789012345678';
    sequenceStore.allocateEbmSequence
      .mockResolvedValueOnce(invoiceNumber)
      .mockResolvedValueOnce(receiptNumber)
      .mockResolvedValueOnce(reportNumber);
    const persist = jest.fn().mockResolvedValue(undefined);

    const allocated = await ensureSalesNumbers({}, 'company-1', '00', persist);

    expect(allocated).toEqual({
      invcNo: invoiceNumber,
      curRcptNo: receiptNumber,
      totRcptNo: receiptNumber,
      rptNo: reportNumber,
    });
    expect(persist).toHaveBeenCalledWith({
      'ebm.invcNo': invoiceNumber,
      'ebm.curRcptNo': receiptNumber,
      'ebm.totRcptNo': receiptNumber,
      'ebm.rptNo': reportNumber,
    });
  });

  it('seeds counters idempotently using the store upsert semantics and does not write zeros', async () => {
    await seedFromInitInfo('company-1', '00', {
      lastSaleInvcNo: '0', lastInvcNo: null, lastSaleRcptNo: undefined,
    });
    expect(sequenceStore.seedEbmSequence).not.toHaveBeenCalled();
  });
});
