'use strict';

let mockReleaseClientLock;
jest.mock('../services/journalService', () => ({
  getMappedAccountCode: jest.fn(async () => '1100'),
  createDebitLine: jest.fn((accountCode, amount, description) => ({ accountCode, debit: amount, credit: 0, description })),
  createCreditLine: jest.fn((accountCode, amount, description) => ({ accountCode, debit: 0, credit: amount, description })),
  createEntry: jest.fn(async () => ({ id: 'journal-1' })),
}));
jest.mock('../services/posAuditService', () => ({
  writePosAuditLog: jest.fn(async (_entry, tx) => { mockReleaseClientLock?.(); mockReleaseClientLock = null; return { id: 'audit-1' }; }),
}));
const { allocatePayment, refundedInvoiceBalance, buildCreditPaymentReceipt } = require('../services/posCreditAccountService');
const { writePosAuditLog } = require('../services/posAuditService');
const JournalService = require('../services/journalService');

describe('POS credit account service', () => {
  test('allocates a partial payment and leaves an overpayment unapplied', () => {
    const result = allocatePayment(120, [
      { id: 'invoice-1', amountOutstanding: 50 },
      { id: 'invoice-2', amountOutstanding: 40 },
    ]);
    expect(result).toEqual({
      allocations: [{ invoiceId: 'invoice-1', amount: 50 }, { invoiceId: 'invoice-2', amount: 40 }],
      allocated: 90,
      unapplied: 30,
    });
  });

  test('supports cashier-selected partial allocation and rejects invoice over-allocation', () => {
    const result = allocatePayment(100, [{ id: 'invoice-1', amountOutstanding: 80 }], [
      { invoiceId: 'invoice-1', amount: 25 },
    ]);
    expect(result).toEqual({ allocations: [{ invoiceId: 'invoice-1', amount: 25 }], allocated: 25, unapplied: 75 });
    expect(() => allocatePayment(100, [{ id: 'invoice-1', amountOutstanding: 20 }], [
      { invoiceId: 'invoice-1', amount: 21 },
    ])).toThrow('An allocation is larger than that invoice’s outstanding balance.');
  });

  test('refund restores invoice debt from the allocated portion only', () => {
    expect(refundedInvoiceBalance({ amountPaid: 50, amountOutstanding: 0 }, 50)).toEqual({
      amountPaid: 0, amountOutstanding: 50, status: 'confirmed',
    });
    expect(refundedInvoiceBalance({ amountPaid: 80, amountOutstanding: 20 }, 30)).toEqual({
      amountPaid: 50, amountOutstanding: 50, status: 'partially_paid',
    });
  });

  test('renders account collections as a canonical CREDIT_PAYMENT receipt', () => {
    const document = buildCreditPaymentReceipt({
      receipt: { id: 'receipt-1', referenceNo: 'CP-0001', receiptDate: '2026-11-02T10:00:00.000Z' },
      client: { name: 'Acme Shop', taxId: 'TIN-123' },
      company: { name: 'Kubika Demo', tin: 'TIN-900' },
      register: { name: 'Till 1' },
      cashier: { name: 'Cashier One' },
      amount: 12500,
    });
    expect(document.version).toBe(1);
    expect(document.flags.receiptType).toBe('CREDIT_PAYMENT');
    expect(document.receipt.number).toBe('CP-0001');
    expect(document.customer).toEqual({ name: 'Acme Shop', tin: 'TIN-123' });
    expect(document.payments).toEqual([{ method: 'cash', amountRwf: 12500, reference: null, kind: 'CREDIT_PAYMENT' }]);
    expect(document.totals.grandTotalRwf).toBe(12500);
  });

  test('concurrent retries with the same key create one receipt, one drawer movement, and one audit event', async () => {
    const receipts = [];
    const movements = [];
    const allocations = [];
    const ledgers = [];
    let lockTail = Promise.resolve();
    let currentUnlock = null;
    const tx = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        if (String(sql).includes('FROM "clients"')) {
          const previous = lockTail;
          let unlock;
          lockTail = new Promise((resolve) => { unlock = resolve; });
          await previous;
          currentUnlock = unlock;
          return [{ id: 'client-1' }];
        }
        if (String(sql).includes('FROM "pos_shifts"')) return [{ id: 'shift-1' }];
        return [{ id: 'invoice-1' }];
      }),
      aRReceipt: {
        findFirst: jest.fn(async ({ where }) => receipts.find((row) => row.companyId === where.companyId && row.posIdempotencyKey === where.posIdempotencyKey) || null),
        create: jest.fn(async ({ data }) => { receipts.push(data); return data; }),
        update: jest.fn(async ({ data }) => ({ ...receipts[0], ...data })),
      },
      aRReceiptAllocation: { createMany: jest.fn(async ({ data }) => { allocations.push(...data); }) },
      arTransactionLedger: { create: jest.fn(async () => ({ id: 'ar-ledger-1' })) },
      client: {
        findFirst: jest.fn(async () => ({ id: 'client-1', name: 'Customer', taxId: null })),
        update: jest.fn(async () => ({})),
      },
      invoice: {
        findMany: jest.fn(async () => [{ id: 'invoice-1', referenceNo: 'INV-1', amountOutstanding: 80, currencyCode: 'RWF' }]),
        updateMany: jest.fn(async () => ({ count: 1 })),
        findUnique: jest.fn(async () => ({ amountOutstanding: 0 })),
        update: jest.fn(async () => ({})),
        aggregate: jest.fn(async () => ({ _sum: { amountOutstanding: 0 } })),
      },
      posRegister: { findFirst: jest.fn(async () => ({ id: 'register-1', code: 'REG-1', name: 'Till 1' })) },
      posShift: { findFirst: jest.fn(async () => ({ id: 'shift-1', openedById: 'cashier-1', openedAt: new Date() })) },
      company: { findUnique: jest.fn(async () => ({ id: 'company-1', name: 'Shop', tin: null })) },
      user: { findFirst: jest.fn(async () => ({ id: 'cashier-1', name: 'Cashier' })) },
      posCashMovement: {
        findFirst: jest.fn(async ({ where }) => movements.find((row) => row.companyId === where.companyId && row.idempotencyKey === where.idempotencyKey) || null),
        create: jest.fn(async ({ data }) => { movements.push(data); return data; }),
        update: jest.fn(async ({ where, data }) => { const row = movements.find((item) => item.id === where.id); Object.assign(row, data); return row; }),
      },
      tillSession: {
        findFirst: jest.fn(async () => ({ id: 'till-1', expectedCash: 0, cashActivity: [] })),
        update: jest.fn(async () => ({})),
      },
      posCustomerCreditLedger: { create: jest.fn(async ({ data }) => { ledgers.push(data); return data; }) },
    };
    mockReleaseClientLock = () => { currentUnlock?.(); currentUnlock = null; };
    writePosAuditLog.mockClear();
    const input = { tx, companyId: 'company-1', registerId: 'register-1', shiftId: 'shift-1', userId: 'cashier-1', clientId: 'client-1', key: 'payment-request-0001', amount: 100, requestedAllocations: null };
    const results = await Promise.all([
      require('../services/posCreditAccountService').postCreditPayment(input),
      require('../services/posCreditAccountService').postCreditPayment(input),
    ]);
    expect(receipts).toHaveLength(1);
    expect(movements).toHaveLength(1);
    expect(allocations).toHaveLength(1);
    expect(ledgers).toHaveLength(1);
    expect(results.filter((result) => result.replayed)).toHaveLength(1);
    expect(results.find((result) => result.replayed).receiptDocument.flags.receiptType).toBe('CREDIT_PAYMENT');
    expect(writePosAuditLog).toHaveBeenCalledTimes(1);
    expect(tx.tillSession.update).toHaveBeenCalledTimes(1);
    expect(tx.tillSession.update.mock.calls[0][0].data.expectedCash).toBe(100);
    expect(movements[0]).toEqual(expect.objectContaining({ type: 'cash_in', amount: 100, reasonCode: 'CREDIT_PAYMENT' }));
  });

  test('collects cash against a legacy customer balance when no open invoice rows exist', async () => {
    const savedReceipt = [];
    const ledgerEntries = [];
    const tillUpdates = [];
    const tx = {
      $queryRawUnsafe: jest.fn(async (sql) => String(sql).includes('FROM "clients"') ? [{ id: 'client-1' }] : [{ id: 'shift-1' }]),
      aRReceipt: {
        findFirst: jest.fn(async () => null),
        create: jest.fn(async ({ data }) => { savedReceipt.push(data); return data; }),
        update: jest.fn(async ({ data }) => ({ ...savedReceipt[0], ...data })),
      },
      client: {
        findFirst: jest.fn(async () => ({ id: 'client-1', name: 'Aline Store', outstandingBalance: 129000 })),
        update: jest.fn(async ({ where, data }) => ({ where, data })),
      },
      invoice: { findMany: jest.fn(async () => []) },
      posRegister: { findFirst: jest.fn(async () => ({ id: 'register-1', code: 'REG-1', name: 'Till 1' })) },
      posShift: { findFirst: jest.fn(async () => ({ id: 'shift-1', openedById: 'cashier-1', openedAt: new Date() })) },
      company: { findUnique: jest.fn(async () => ({ id: 'company-1', name: 'Shop' })) },
      user: { findFirst: jest.fn(async () => ({ id: 'cashier-1', name: 'Cashier' })) },
      aRReceiptAllocation: { createMany: jest.fn() },
      arTransactionLedger: { create: jest.fn() },
      posCashMovement: {
        create: jest.fn(async ({ data }) => ({ id: 'movement-1', ...data })),
        update: jest.fn(async ({ where, data }) => ({ id: where.id, ...data })),
      },
      tillSession: {
        findFirst: jest.fn(async () => ({ id: 'till-1', expectedCash: 0, cashActivity: [] })),
        update: jest.fn(async ({ data }) => { tillUpdates.push(data); return data; }),
      },
      posCustomerCreditLedger: { create: jest.fn(async ({ data }) => { ledgerEntries.push(data); return data; }) },
    };

    const result = await require('../services/posCreditAccountService').postCreditPayment({
      tx, companyId: 'company-1', registerId: 'register-1', userId: 'cashier-1',
      clientId: 'client-1', key: 'legacy-balance-payment-1', amount: 129000,
      requestedAllocations: null,
    });

    expect(result).toEqual(expect.objectContaining({ allocated: 129000, invoiceAllocated: 0, legacyAllocated: 129000, unapplied: 0, balanceAfter: 0 }));
    expect(tx.client.update).toHaveBeenCalledWith({ where: { id: 'client-1', companyId: 'company-1' }, data: { outstandingBalance: 0 } });
    expect(ledgerEntries).toHaveLength(1);
    expect(ledgerEntries[0]).toEqual(expect.objectContaining({ entryType: 'PAYMENT', direction: 'DECREASE', amount: 129000, balanceAfter: 0 }));
    expect(tillUpdates).toHaveLength(1);
    expect(tillUpdates[0].expectedCash).toBe(129000);
    expect(JournalService.createEntry).toHaveBeenCalledWith('company-1', 'cashier-1', expect.objectContaining({
      sourceType: 'ar_receipt',
      lines: expect.arrayContaining([expect.objectContaining({ credit: 129000 })]),
    }));
  });

  test('does not write a zero-value credit-ledger row for an unapplied customer advance', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn(async (sql) => String(sql).includes('FROM "clients"') ? [{ id: 'client-1' }] : [{ id: 'shift-1' }]),
      aRReceipt: {
        findFirst: jest.fn(async () => null),
        create: jest.fn(async ({ data }) => data),
        update: jest.fn(async ({ data }) => data),
      },
      client: {
        findFirst: jest.fn(async () => ({ id: 'client-1', name: 'Aline Store', outstandingBalance: 0 })),
        update: jest.fn(async ({ data }) => data),
      },
      invoice: { findMany: jest.fn(async () => []) },
      posRegister: { findFirst: jest.fn(async () => ({ id: 'register-1', code: 'REG-1', name: 'Till 1' })) },
      posShift: { findFirst: jest.fn(async () => ({ id: 'shift-1', openedById: 'cashier-1', openedAt: new Date() })) },
      company: { findUnique: jest.fn(async () => ({ id: 'company-1', name: 'Shop' })) },
      user: { findFirst: jest.fn(async () => ({ id: 'cashier-1', name: 'Cashier' })) },
      posCashMovement: {
        create: jest.fn(async ({ data }) => ({ id: 'movement-1', ...data })),
        update: jest.fn(async ({ where, data }) => ({ id: where.id, ...data })),
      },
      tillSession: {
        findFirst: jest.fn(async () => ({ id: 'till-1', expectedCash: 0, cashActivity: [] })),
        update: jest.fn(async ({ data }) => data),
      },
      posCustomerCreditLedger: { create: jest.fn() },
    };

    const result = await require('../services/posCreditAccountService').postCreditPayment({
      tx, companyId: 'company-1', registerId: 'register-1', userId: 'cashier-1',
      clientId: 'client-1', key: 'customer-advance-payment-1', amount: 5000,
      requestedAllocations: null,
    });

    expect(result).toEqual(expect.objectContaining({ allocated: 0, unapplied: 5000 }));
    expect(tx.posCustomerCreditLedger.create).not.toHaveBeenCalled();
    expect(tx.aRReceipt.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ unallocatedAmount: 5000 }) }));
  });
});
