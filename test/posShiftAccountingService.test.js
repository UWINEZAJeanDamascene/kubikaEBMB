jest.mock('../services/journalService', () => ({
  createCreditLine: jest.fn((accountCode, amount, description) => ({
    accountCode,
    debit: 0,
    credit: amount,
    description,
  })),
  createDebitLine: jest.fn((accountCode, amount, description) => ({
    accountCode,
    debit: amount,
    credit: 0,
    description,
  })),
  createEntry: jest.fn(),
  getMappedAccountCode: jest.fn(async (_companyId, _module, _key, fallback) => fallback),
}));
jest.mock('../services/posAccountingProfileService', () => ({
  getProfile: jest.fn(),
  resolveAccount: jest.fn(),
}));
jest.mock('../lib/prisma', () => ({ prisma: {} }));

const JournalService = require('../services/journalService');
const posAccountingProfileService = require('../services/posAccountingProfileService');
const {
  postCashMovement,
  postShiftVariance,
  reverseJournalEntry,
} = require('../services/posShiftAccountingService');

const COMPANY_ID = '507f1f77bcf86cd799439011';
const USER_ID = '507f1f77bcf86cd799439013';
const SHIFT_ID = '507f1f77bcf86cd799439014';

function transaction() {
  return {
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: 'journal-id' }]),
    journalEntry: {
      findFirst: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    posRegister: {
      findFirst: jest.fn().mockResolvedValue({ id: 'register-id', systemTillType: 'retail' }),
    },
    chartOfAccount: {
      findFirst: jest.fn().mockResolvedValue({
        code: '1130',
        type: 'asset',
        isActive: true,
        allowDirectPosting: true,
      }),
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  JournalService.getMappedAccountCode.mockImplementation(async (_companyId, _module, _key, fallback) => fallback);
  posAccountingProfileService.getProfile.mockResolvedValue({
    companyDefaults: { bankDepositClearing: '1130' },
    tillTypeOverrides: {},
    registerOverrides: {},
  });
  posAccountingProfileService.resolveAccount.mockReturnValue('1130');
});

describe('POS shift accounting service', () => {
  test.each([
    ['cash_in', 'EXTRA_CHANGE', '1000', '1050'],
    ['cash_in', 'OWNER_TOP_UP', '1000', '3000'],
    ['cash_in', 'OTHER', '1000', '4200'],
    ['cash_out', 'SUPPLIER_PAYMENT', '2000', '1000'],
    ['cash_out', 'DELIVERY', '5700', '1000'],
    ['cash_out', 'STAFF_ADVANCE', '1250', '1000'],
    ['cash_out', 'CLEANING_SUPPLIES', '5610', '1000'],
    ['cash_out', 'OTHER', '6100', '1000'],
    ['safe_drop', 'EXCESS_TO_SAFE', '1050', '1000'],
  ])('posts %s/%s through the journal service', async (type, reasonCode, debit, credit) => {
    const tx = transaction();
    const movement = {
      id: '507f1f77bcf86cd799439015',
      type,
      amount: 12500,
      reasonCode,
      createdAt: new Date('2026-10-29T08:30:00.000Z'),
      note: 'drawer activity',
    };
    JournalService.createEntry.mockResolvedValue({ _id: 'journal-id' });

    const result = await postCashMovement({ tx, companyId: COMPANY_ID, userId: USER_ID, movement });

    expect(result).toBe('journal-id');
    expect(JournalService.createEntry).toHaveBeenCalledWith(COMPANY_ID, USER_ID, expect.objectContaining({
      sourceType: 'pos_cash_movement',
      sourceId: movement.id,
      date: movement.createdAt,
      session: tx,
      skipBankTransactions: true,
      lines: [
        expect.objectContaining({ accountCode: debit, debit: movement.amount, credit: 0 }),
        expect.objectContaining({ accountCode: credit, debit: 0, credit: movement.amount }),
      ],
    }));
  });

  test('posts bank deposits to the scoped asset clearing account and preserves the slip reference', async () => {
    const tx = transaction();
    const movement = {
      id: '507f1f77bcf86cd799439015',
      registerId: 'register-id',
      type: 'cash_out',
      amount: 12500,
      reasonCode: 'BANK_DEPOSIT',
      reference: 'SLIP-2026-001',
      note: 'Sealed deposit bag.',
    };
    JournalService.createEntry.mockResolvedValue({ _id: 'journal-id' });

    await postCashMovement({ tx, companyId: COMPANY_ID, userId: USER_ID, movement });

    expect(posAccountingProfileService.getProfile).toHaveBeenCalledWith(COMPANY_ID, tx);
    expect(posAccountingProfileService.resolveAccount).toHaveBeenCalledWith(
      expect.any(Object),
      'bankDepositClearing',
      { tillType: 'retail', registerId: 'register-id' },
    );
    expect(tx.posRegister.findFirst).toHaveBeenCalledWith({
      where: { id: 'register-id', companyId: COMPANY_ID },
      select: { id: true, systemTillType: true },
    });
    expect(tx.chartOfAccount.findFirst).toHaveBeenCalledWith({
      where: { companyId: COMPANY_ID, code: '1130' },
      select: { code: true, type: true, isActive: true, allowDirectPosting: true },
    });
    expect(JournalService.createEntry).toHaveBeenCalledWith(COMPANY_ID, USER_ID, expect.objectContaining({
      sourceType: 'pos_bank_deposit',
      sourceReference: 'SLIP-2026-001',
      lines: [
        expect.objectContaining({ accountCode: '1130', debit: 12500, credit: 0, reference: 'SLIP-2026-001' }),
        expect.objectContaining({ accountCode: '1000', debit: 0, credit: 12500, reference: 'SLIP-2026-001' }),
      ],
    }));
  });

  test('blocks a deposit when its register-scoped clearing mapping is missing or not an asset', async () => {
    const tx = transaction();
    const movement = {
      id: '507f1f77bcf86cd799439015',
      registerId: 'register-id',
      type: 'cash_out',
      amount: 12500,
      reasonCode: 'BANK_DEPOSIT',
    };
    posAccountingProfileService.resolveAccount.mockReturnValue(null);

    await expect(postCashMovement({ tx, companyId: COMPANY_ID, userId: USER_ID, movement }))
      .rejects.toMatchObject({ code: 'POS_BANK_DEPOSIT_CLEARING_ACCOUNT_REQUIRED' });
    expect(JournalService.createEntry).not.toHaveBeenCalled();

    posAccountingProfileService.resolveAccount.mockReturnValue('1130');
    tx.chartOfAccount.findFirst.mockResolvedValueOnce({
      code: '1130',
      type: 'liability',
      isActive: true,
      allowDirectPosting: true,
    });
    await expect(postCashMovement({ tx, companyId: COMPANY_ID, userId: USER_ID, movement }))
      .rejects.toMatchObject({ code: 'POS_BANK_DEPOSIT_CLEARING_ACCOUNT_INVALID' });
    expect(JournalService.createEntry).not.toHaveBeenCalled();
  });

  test.each([
    [300, '1000', '4200'],
    [-300, '6100', '1000'],
  ])('posts signed cash variance %i in the correct direction', async (variance, debit, credit) => {
    const tx = transaction();
    JournalService.createEntry.mockResolvedValue({ id: 'variance-entry-id' });

    const result = await postShiftVariance({
      tx,
      companyId: COMPANY_ID,
      userId: USER_ID,
      shift: { id: SHIFT_ID, shiftNumber: 8, differenceReason: 'Count was checked twice.' },
      variance,
      reportNumber: 11,
      date: new Date('2026-10-29T18:00:00.000Z'),
    });

    expect(result).toBe('variance-entry-id');
    expect(JournalService.createEntry).toHaveBeenCalledWith(COMPANY_ID, USER_ID, expect.objectContaining({
      sourceType: 'pos_shift_close',
      sourceId: SHIFT_ID,
      sourceReference: 'Z-11',
      lines: [
        expect.objectContaining({ accountCode: debit, debit: Math.abs(variance), credit: 0 }),
        expect.objectContaining({ accountCode: credit, debit: 0, credit: Math.abs(variance) }),
      ],
    }));
  });

  test('does not post a zero cash variance', async () => {
    await expect(postShiftVariance({
      tx: transaction(),
      companyId: COMPANY_ID,
      userId: USER_ID,
      shift: { id: SHIFT_ID, shiftNumber: 8 },
      variance: 0,
      reportNumber: 11,
      date: new Date(),
    })).resolves.toBeNull();
    expect(JournalService.createEntry).not.toHaveBeenCalled();
  });

  test('creates one mirrored reversal and replays its saved ID on retry', async () => {
    const original = {
      id: '507f1f77bcf86cd799439015',
      companyId: COMPANY_ID,
      entryNumber: 'JE-001',
      sourceType: 'pos_shift_close',
      sourceReference: 'Z-11',
      status: 'posted',
      reversed: false,
      reversalOfId: null,
      lines: [
        { accountCode: '1000', accountName: 'Cash in Hand', debit: 300, credit: 0, description: 'Cash overage' },
        { accountCode: '4200', accountName: 'Other Income', debit: 0, credit: 300, description: 'Cash overage' },
      ],
    };
    const tx = transaction();
    tx.journalEntry.findFirst
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce({ ...original, reversalEntryId: 'reversal-id' })
      .mockResolvedValueOnce({
        id: 'reversal-id',
        sourceType: 'pos_shift_reversal',
        reversalOfId: original.id,
      });
    JournalService.createEntry.mockResolvedValue({ id: 'reversal-id' });

    const first = await reverseJournalEntry({
      tx,
      companyId: COMPANY_ID,
      userId: USER_ID,
      entryId: original.id,
      date: new Date('2026-10-30T08:00:00.000Z'),
      reason: 'Approved shift reopen',
    });
    const replay = await reverseJournalEntry({
      tx,
      companyId: COMPANY_ID,
      userId: USER_ID,
      entryId: original.id,
      date: new Date('2026-10-30T08:00:00.000Z'),
      reason: 'Approved shift reopen',
    });

    expect(first).toEqual({ journalEntryId: 'reversal-id', replayed: false });
    expect(replay).toEqual({ journalEntryId: 'reversal-id', replayed: true });
    expect(JournalService.createEntry).toHaveBeenCalledTimes(1);
    expect(JournalService.createEntry).toHaveBeenCalledWith(COMPANY_ID, USER_ID, expect.objectContaining({
      sourceType: 'pos_shift_reversal',
      sourceId: original.id,
      reversalOf: original.id,
      lines: [
        expect.objectContaining({ accountCode: '1000', debit: 0, credit: 300 }),
        expect.objectContaining({ accountCode: '4200', debit: 300, credit: 0 }),
      ],
    }));
    expect(tx.journalEntry.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: original.id, companyId: COMPANY_ID },
      data: expect.objectContaining({ reversalEntryId: 'reversal-id', reversedById: USER_ID }),
    }));
  });
});
