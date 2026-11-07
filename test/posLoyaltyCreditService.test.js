jest.mock('../services/posAuditService', () => ({
  writePosAuditLog: jest.fn().mockResolvedValue(undefined),
}));

const {
  calculateSaleRewardState,
  reverseSaleRewardForCreditNote,
} = require('../services/posLoyaltyCreditService');
const { writePosAuditLog } = require('../services/posAuditService');

const COMPANY_ID = '507f1f77bcf86cd799439011';
const SALE_ID = '507f1f77bcf86cd799439012';
const ACCOUNT_ID = '507f1f77bcf86cd799439013';
const CREDIT_NOTE_ID = '507f1f77bcf86cd799439014';

function event(id, invoiceId, entryType, amount, createdAt, notes = '') {
  return { id, invoiceId, entryType, amount: String(amount), createdAt: new Date(createdAt), notes };
}

function makeTransaction({ balance = 100, events = [], refundedTotal = 100, priorRows = [] } = {}) {
  const inserts = [];
  const queries = [];
  const tx = {
    inserts,
    queries,
    $queryRawUnsafe: jest.fn(async (sql, ...params) => {
      queries.push({ sql: String(sql), params });
      if (String(sql).includes('idempotency_key = $3')) return priorRows;
      if (String(sql).includes('FROM credit_notes')) return [{ amount: String(refundedTotal) }];
      if (String(sql).includes('SUM(amount)::text AS amount')) {
        return [{ accountId: ACCOUNT_ID, amount: '100' }];
      }
      if (String(sql).includes('FROM invoices')) return [{ totalAmount: '100' }];
      if (String(sql).includes('FROM pos_stored_value_accounts')) return [{ balance: String(balance) }];
      if (String(sql).includes('SELECT id, invoice_id AS "invoiceId"')) return events;
      if (String(sql).includes('UPDATE pos_stored_value_accounts')) {
        const updatedBalance = balance - Number(params[0]);
        return [{ balance: String(updatedBalance) }];
      }
      throw new Error(`Unexpected query: ${sql}`);
    }),
    $executeRawUnsafe: jest.fn(async (sql, ...params) => {
      if (String(sql).includes('INSERT INTO pos_stored_value_ledger')) inserts.push({ sql: String(sql), params });
      return 1;
    }),
  };
  return tx;
}

describe('POS loyalty credit note reversal', () => {
  beforeEach(() => jest.clearAllMocks());

  test('makes an unspent source-sale reward fully available for reversal', () => {
    expect(calculateSaleRewardState([
      event('earn-1', SALE_ID, 'earn', 100, '2026-01-01T10:00:00Z'),
    ], SALE_ID)).toEqual({ earnedCents: 10000, availableCents: 10000, reversedCents: 0 });
  });

  test('attributes redemption FIFO and leaves later-sale rewards untouched', () => {
    const state = calculateSaleRewardState([
      event('earn-1', SALE_ID, 'earn', 100, '2026-01-01T10:00:00Z'),
      event('redeem-1', '507f1f77bcf86cd799439015', 'redeem', 30, '2026-01-02T10:00:00Z'),
      event('earn-2', '507f1f77bcf86cd799439016', 'earn', 50, '2026-01-03T10:00:00Z'),
    ], SALE_ID);

    expect(state).toEqual({ earnedCents: 10000, availableCents: 7000, reversedCents: 0 });
    expect(calculateSaleRewardState([
      event('earn-1', SALE_ID, 'earn', 100, '2026-01-01T10:00:00Z'),
      event('redeem-1', 'other-sale', 'redeem', 100, '2026-01-02T10:00:00Z'),
      event('earn-2', 'later-sale', 'earn', 50, '2026-01-03T10:00:00Z'),
    ], 'later-sale').availableCents).toBe(5000);
  });

  test('reverses an unspent reward without creating a consumed-reward record', async () => {
    const tx = makeTransaction({
      events: [event('earn-1', SALE_ID, 'earn', 100, '2026-01-01T10:00:00Z')],
    });

    await expect(reverseSaleRewardForCreditNote(tx, {
      companyId: COMPANY_ID, saleId: SALE_ID, creditNoteId: CREDIT_NOTE_ID,
    })).resolves.toMatchObject({ amount: 100, consumedAmount: 0, replayed: false });

    expect(tx.inserts).toHaveLength(1);
    expect(tx.inserts[0].params[6]).toBe(0);
    expect(tx.inserts[0].params[8]).toContain('POS_LOYALTY_REWARD_REVERSAL:');
  });

  test('reverses only the unspent part and records the consumed shortfall', async () => {
    const tx = makeTransaction({
      balance: 135,
      events: [
        event('earn-1', SALE_ID, 'earn', 100, '2026-01-01T10:00:00Z'),
        event('redeem-1', 'other-sale', 'redeem', 25, '2026-01-02T10:00:00Z'),
        event('earn-2', 'later-sale', 'earn', 60, '2026-01-03T10:00:00Z'),
      ],
    });

    await expect(reverseSaleRewardForCreditNote(tx, {
      companyId: COMPANY_ID, saleId: SALE_ID, creditNoteId: CREDIT_NOTE_ID,
    })).resolves.toMatchObject({ amount: 75, consumedAmount: 25, unreversedSpentAmount: 25 });

    expect(tx.inserts).toHaveLength(2);
    const consumedEntry = tx.inserts.find((item) => item.params[5] === 25);
    expect(consumedEntry.params[3]).toContain(':consumed:');
    expect(consumedEntry.params[8]).toContain('POS_LOYALTY_REWARD_CONSUMED:');
    expect(consumedEntry.params[6]).toBe(60);
  });

  test('records a fully spent reward as consumed without making the wallet negative', async () => {
    const tx = makeTransaction({
      balance: 50,
      events: [
        event('earn-1', SALE_ID, 'earn', 100, '2026-01-01T10:00:00Z'),
        event('redeem-1', 'other-sale', 'redeem', 100, '2026-01-02T10:00:00Z'),
        event('earn-2', 'later-sale', 'earn', 50, '2026-01-03T10:00:00Z'),
      ],
    });

    await expect(reverseSaleRewardForCreditNote(tx, {
      companyId: COMPANY_ID, saleId: SALE_ID, creditNoteId: CREDIT_NOTE_ID,
    })).resolves.toMatchObject({ amount: 0, consumedAmount: 100 });

    expect(tx.inserts).toHaveLength(1);
    expect(tx.inserts[0].params[5]).toBe(100);
    expect(tx.inserts[0].params[6]).toBe(50);
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE pos_stored_value_accounts'),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  test('reverses successive partial returns proportionally and idempotently', async () => {
    const firstTx = makeTransaction({
      refundedTotal: 50,
      events: [event('earn-1', SALE_ID, 'earn', 100, '2026-01-01T10:00:00Z')],
    });
    const first = await reverseSaleRewardForCreditNote(firstTx, {
      companyId: COMPANY_ID, saleId: SALE_ID, creditNoteId: CREDIT_NOTE_ID,
    });
    expect(first.amount).toBe(50);

    const secondTx = makeTransaction({
      balance: 50,
      refundedTotal: 100,
      events: [
        event('earn-1', SALE_ID, 'earn', 100, '2026-01-01T10:00:00Z'),
        event('refund-1', SALE_ID, 'refund', 50, '2026-01-02T10:00:00Z', 'POS_LOYALTY_REWARD_REVERSAL: prior note'),
      ],
    });
    const second = await reverseSaleRewardForCreditNote(secondTx, {
      companyId: COMPANY_ID,
      saleId: SALE_ID,
      creditNoteId: '507f1f77bcf86cd799439017',
    });
    expect(second.amount).toBe(50);
    expect(secondTx.inserts).toHaveLength(1);

    const retryTx = makeTransaction({
      priorRows: [
        { entryType: 'refund', amount: '50' },
        { entryType: 'credit_note_consumed', amount: '0' },
      ],
    });
    await expect(reverseSaleRewardForCreditNote(retryTx, {
      companyId: COMPANY_ID,
      saleId: SALE_ID,
      creditNoteId: '507f1f77bcf86cd799439017',
    })).resolves.toMatchObject({ amount: 50, consumedAmount: 0, replayed: true });
    expect(retryTx.inserts).toHaveLength(0);
    expect(retryTx.queries[0].params[0]).toBe(COMPANY_ID);
    expect(retryTx.queries[0].params[1]).toBe(SALE_ID);
  });

  test('scopes every ledger query and audit event to the credit note tenant', async () => {
    const tx = makeTransaction({
      events: [event('earn-1', SALE_ID, 'earn', 100, '2026-01-01T10:00:00Z')],
    });
    await reverseSaleRewardForCreditNote(tx, {
      companyId: COMPANY_ID, saleId: SALE_ID, creditNoteId: CREDIT_NOTE_ID, actorId: 'user-1',
    });

    for (const query of tx.queries) {
      expect(query.params).toContain(COMPANY_ID);
    }
    expect(writePosAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      companyId: COMPANY_ID,
      event: 'POS_LOYALTY_CREDIT_REVERSED',
      metadata: expect.objectContaining({ saleId: SALE_ID, creditNoteId: CREDIT_NOTE_ID }),
    }), tx);
  });
});
