'use strict';

const service = require('../services/customerService');
const JournalService = require('../services/journalService');

const companyA = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const companyB = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const userId = 'cccccccccccccccccccccccc';
const customerA = 'dddddddddddddddddddddddd';

function transactionalDb(tx) {
  return { $transaction: jest.fn((callback) => callback(tx)) };
}

describe('customer master service', () => {
  afterEach(() => jest.restoreAllMocks());
  test('normalizes equivalent Rwanda phone formats for company uniqueness', () => {
    expect(service.normalizeRwandaPhone('078 123 4567')).toBe('+250781234567');
    expect(service.normalizeRwandaPhone('250781234567')).toBe('+250781234567');
    expect(service.normalizeRwandaPhone('+250 781 234 567')).toBe('+250781234567');
  });

  test('tenant-scoped lookup does not reveal a customer from another company', async () => {
    const db = { client: { findFirst: jest.fn().mockResolvedValue(null) } };
    await expect(service.getCustomer({ companyId: companyA, customerId: customerA, client: db }))
      .rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND', statusCode: 404 });
    expect(db.client.findFirst).toHaveBeenCalledWith({ where: { id: customerA, companyId: companyA } });
  });

  test('customer ledgers include merged history and stay scoped to the company', async () => {
    const db = {
      client: {
        findFirst: jest.fn(async ({ where }) => where.id === customerA && where.companyId === companyA ? { id: customerA, mergedIntoClientId: null } : null),
        findMany: jest.fn(async ({ where }) => where.companyId === companyA ? [{ id: customerA }, { id: 'eeeeeeeeeeeeeeeeeeeeeeee' }] : []),
      },
      posCustomerCreditLedger: { findMany: jest.fn().mockResolvedValue([{ id: 'credit-1', clientId: customerA }]) },
      posCustomerLoyaltyLedger: { findMany: jest.fn().mockResolvedValue([{ id: 'loyalty-1', clientId: customerA }]) },
      $queryRawUnsafe: jest.fn(async (sql) => String(sql).includes('credit_ledger') ? [{ balance: '1250' }] : [{ balance: 40 }]),
    };
    const result = await service.getCustomerLedgers({ companyId: companyA, customerId: customerA, client: db });
    expect(result).toMatchObject({ customerId: customerA, creditBalance: 1250, loyaltyPoints: 40 });
    expect(db.posCustomerCreditLedger.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { companyId: companyA, clientId: { in: [customerA, 'eeeeeeeeeeeeeeeeeeeeeeee'] } } }));
    expect(db.posCustomerLoyaltyLedger.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { companyId: companyA, clientId: { in: [customerA, 'eeeeeeeeeeeeeeeeeeeeeeee'] } } }));
  });

  test('creates a company-specific protected walk-in customer with consent off', async () => {
    const db = {
      client: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(async ({ data }) => ({ ...data, createdAt: new Date(), updatedAt: new Date() })),
      },
    };
    const row = await service.ensureWalkInCustomer(companyA, null, db);
    expect(row).toMatchObject({
      companyId: companyA, code: `WALKIN-${companyA.toUpperCase()}`, isWalkIn: true,
      isActive: true, marketingConsent: false, digitalReceiptConsent: false,
    });
    expect(db.client.findFirst).toHaveBeenCalledWith({ where: { companyId: companyA, isWalkIn: true, mergedIntoClientId: null } });
  });

  test('phone search matches a partial normalized phone within one company', async () => {
    const db = { client: { findMany: jest.fn().mockResolvedValue([]) } };
    await service.searchCustomers({ companyId: companyA, query: '078 12', client: db });
    expect(db.client.findMany.mock.calls[0][0].where).toMatchObject({
      companyId: companyA, isActive: true,
      OR: expect.arrayContaining([{ phoneNormalized: { contains: '+2507812' } }]),
    });
  });

  test('phone duplicate detection prevents a duplicate customer before insert', async () => {
    const db = {
      client: { findMany: jest.fn().mockResolvedValue([{
        id: customerA, companyId: companyA, name: 'Existing', code: 'CUS-EXIST', type: 'individual',
        contact: { phone: '+250781234567' }, phoneNormalized: '+250781234567', isActive: true,
      }]),
      create: jest.fn(),
    } };
    await expect(service.quickAddCustomer({
      companyId: companyA, userId, input: { name: 'New', phone: '078 123 4567' }, client: db,
    })).rejects.toMatchObject({ code: 'CUSTOMER_DUPLICATE', statusCode: 409, duplicates: [{ id: customerA }] });
    expect(db.client.create).not.toHaveBeenCalled();
    expect(db.client.findMany.mock.calls[0][0].where.companyId).toBe(companyA);
  });

  test('maps a concurrent database phone-uniqueness conflict to a clear customer error', async () => {
    const tx = { client: { create: jest.fn().mockRejectedValue({ code: 'P2002' }) } };
    const db = {
      client: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn((callback) => callback(tx)),
    };
    await expect(service.quickAddCustomer({
      companyId: companyA, userId, input: { name: 'Customer', phone: '078 123 4567' }, client: db,
    })).rejects.toMatchObject({ code: 'CUSTOMER_PHONE_IN_USE', statusCode: 409 });
  });

  test('merge soft-deactivates the source, preserves it, and audits the action', async () => {
    const source = { id: customerA, companyId: companyA, name: 'Old Name', code: 'CUS-OLD', isWalkIn: false, isActive: true, mergedIntoClientId: null };
    const survivorId = 'eeeeeeeeeeeeeeeeeeeeeeee';
    const survivor = { id: survivorId, companyId: companyA, name: 'New Name', code: 'CUS-NEW', isWalkIn: false, isActive: true, mergedIntoClientId: null };
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ correlationId: null }]),
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      client: {
        findFirst: jest.fn(async ({ where }) => where.id === source.id ? source : survivor),
        update: jest.fn().mockResolvedValue({}), updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      posAuditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-id' }), findFirst: jest.fn().mockResolvedValue(null) },
    };
    const db = transactionalDb(tx);
    const merged = await service.mergeCustomers({
      companyId: companyA, sourceId: customerA, survivorId, userId, reason: 'Duplicate records', client: db,
    });
    expect(merged.id).toBe(survivorId);
    expect(tx.client.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: customerA }, data: expect.objectContaining({ isActive: false, mergedIntoClientId: survivorId, mergedById: userId }),
    }));
    expect(tx.posAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ event: 'CUSTOMER_MERGED' }),
    }));
    expect(tx.client.updateMany).toHaveBeenCalled();
  });

  test('merge rejects a source outside the active company', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      client: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    await expect(service.mergeCustomers({
      companyId: companyA, sourceId: customerA, survivorId: 'eeeeeeeeeeeeeeeeeeeeeeee',
      userId, reason: 'Duplicate records', client: transactionalDb(tx),
    })).rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND' });
  });

  test('loyalty ledger is append-only through the service and idempotent by key', async () => {
    const saved = { id: 'ledger-row', points: 10, idempotencyKey: 'sale-123' };
    let existing = null;
    const tx = {
      $queryRawUnsafe: jest.fn(async (sql) => sql.includes('SUM(points)') ? [{ balance: 0 }] : []),
      posCustomerLoyaltyLedger: {
        findFirst: jest.fn(async () => existing),
        create: jest.fn(async ({ data }) => { existing = { ...data, id: saved.id }; return existing; }),
      },
      client: {
        findFirst: jest.fn().mockResolvedValue({ id: customerA, mergedIntoClientId: null }),
        findMany: jest.fn().mockResolvedValue([{ id: customerA }]),
      },
    };
    const db = transactionalDb(tx);
    const input = { companyId: companyA, customerId: customerA, userId, entryType: 'EARN', points: 10, idempotencyKey: 'sale-123', client: db };
    const first = await service.appendLoyaltyEntry(input);
    const replay = await service.appendLoyaltyEntry(input);
    expect(first).toEqual(replay);
    expect(tx.posCustomerLoyaltyLedger.create).toHaveBeenCalledTimes(1);
    await expect(service.appendLoyaltyEntry({ ...input, points: 11 }))
      .rejects.toMatchObject({ code: 'CUSTOMER_LEDGER_IDEMPOTENCY_CONFLICT', statusCode: 409 });
    expect(tx.posCustomerLoyaltyLedger.create).toHaveBeenCalledTimes(1);
  });

  test('loyalty adjustment uses the RWF 1 default when the settings migration is absent', async () => {
    jest.spyOn(JournalService, 'getMappedAccountCode').mockResolvedValue('2860');
    const journalSpy = jest.spyOn(JournalService, 'createEntriesAtomic').mockResolvedValue([{ _id: 'journal-entry' }]);
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ correlationId: null }]),
      $queryRawUnsafe: jest.fn(async (sql) => String(sql).includes('SUM(points)') ? [{ balance: 0 }] : []),
      client: {
        findFirst: jest.fn().mockResolvedValue({ id: customerA, mergedIntoClientId: null }),
        findMany: jest.fn().mockResolvedValue([{ id: customerA }]),
      },
      posCustomerLoyaltyLedger: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(async ({ data }) => ({ ...data, id: 'adjustment-entry' })),
      },
      posAuditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-entry' }), findFirst: jest.fn().mockResolvedValue(null) },
    };
    const result = await service.appendLoyaltyEntry({
      companyId: companyA, customerId: customerA, userId, entryType: 'ADJUST', points: 10,
      reason: 'Loyal customer', idempotencyKey: 'loyalty-adjust-1', client: transactionalDb(tx),
    });
    expect(result).toMatchObject({ entryType: 'ADJUST', points: 10, balanceAfter: 10 });
    expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(expect.stringContaining('information_schema.columns'));
    expect(journalSpy).toHaveBeenCalledWith(companyA, userId, expect.any(Array), { session: tx });
    expect(tx.posAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ event: 'CUSTOMER_LOYALTY_ADJUSTED' }),
    }));
  });

  test('credit ledger rejects cross-company invoices before creating a row', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn(),
      posCustomerCreditLedger: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
      invoice: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    await expect(service.appendCreditEntry({
      companyId: companyA, customerId: customerA, userId, entryType: 'CHARGE', direction: 'INCREASE',
      amount: 250, invoiceId: 'ffffffffffffffffffffffff', idempotencyKey: 'credit-1', client: transactionalDb(tx),
    })).rejects.toMatchObject({ code: 'CUSTOMER_LEDGER_INVOICE_TENANT_MISMATCH' });
    expect(tx.posCustomerCreditLedger.create).not.toHaveBeenCalled();
  });
});
