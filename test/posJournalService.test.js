jest.mock('../models/JournalEntry', () => {
  const JournalEntry = jest.fn();
  JournalEntry.findOne = jest.fn();
  JournalEntry.generateEntryNumber = jest.fn();
  return JournalEntry;
});
jest.mock('../services/accountMappingService', () => ({ resolve: jest.fn() }));
jest.mock('../services/bankTransactionService', () => ({ createFromJournalEntry: jest.fn() }));
jest.mock('../services/cacheService', () => ({ bumpCompanyFinancialCaches: jest.fn() }));
jest.mock('../services/periodService', () => ({ isDateInClosedPeriod: jest.fn() }));
jest.mock('../services/taxTransactionService', () => ({ processJournalEntry: jest.fn() }));
jest.mock('../models/BankAccount', () => ({ BankAccount: { invalidateCacheForLedgerAccount: jest.fn() } }));
jest.mock('../models/PettyCash', () => ({ PettyCashFloat: { invalidateCacheForLedgerAccount: jest.fn() } }));

const JournalEntry = require('../models/JournalEntry');
const periodService = require('../services/periodService');
const JournalService = require('../services/journalService');

const COMPANY_ID = '507f1f77bcf86cd799439011';
const USER_ID = '507f1f77bcf86cd799439013';
const SOURCE_ID = '507f1f77bcf86cd799439015';
const ENTRY_OPTIONS = {
  date: new Date('2026-10-29T18:00:00.000Z'),
  description: 'POS cash movement',
  sourceType: 'pos_cash_movement',
  sourceId: SOURCE_ID,
  lines: [
    { accountCode: '1000', debit: 100, credit: 0 },
    { accountCode: '3000', debit: 0, credit: 100 },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  periodService.isDateInClosedPeriod.mockResolvedValue(false);
});

describe('JournalService POS source idempotency', () => {
  test('returns an existing source entry rather than creating a duplicate', async () => {
    const existing = { id: 'existing-entry' };
    JournalEntry.findOne.mockResolvedValue(existing);

    await expect(JournalService.createEntry(COMPANY_ID, USER_ID, ENTRY_OPTIONS)).resolves.toBe(existing);

    expect(JournalEntry.findOne).toHaveBeenCalledWith({
      company: COMPANY_ID,
      sourceType: 'pos_cash_movement',
      sourceId: SOURCE_ID,
    });
    expect(periodService.isDateInClosedPeriod).not.toHaveBeenCalled();
  });

  test('does not continue posting when the idempotency lookup fails', async () => {
    JournalEntry.findOne.mockRejectedValue(new Error('Journal lookup unavailable'));

    await expect(JournalService.createEntry(COMPANY_ID, USER_ID, ENTRY_OPTIONS))
      .rejects.toThrow('Journal lookup unavailable');
    expect(periodService.isDateInClosedPeriod).not.toHaveBeenCalled();
  });

  test('preserves the accounting-period error code for the POS endpoint', async () => {
    JournalEntry.findOne.mockResolvedValue(null);
    periodService.isDateInClosedPeriod.mockResolvedValue(true);

    await expect(JournalService.createEntry(COMPANY_ID, USER_ID, ENTRY_OPTIONS))
      .rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
  });
});
