jest.mock('../lib/prisma', () => ({
  prisma: {
    $queryRawUnsafe: jest.fn(),
    posEbmSettings: {
      findUnique: jest.fn().mockResolvedValue({ shiftCloseFiscalPolicy: 'REQUIRE_APPROVAL' }),
    },
  },
}));

const { prisma } = require('../lib/prisma');
const { buildReport } = require('../controllers/tillZReportController');

const COMPANY_ID = '507f1f77bcf86cd799439011';
const CASHIER_ID = '507f1f77bcf86cd799439012';
const SECOND_CASHIER_ID = '507f1f77bcf86cd799439013';
const SHIFT_ID = '507f1f77bcf86cd799439014';
const OPENED_AT = new Date('2026-10-29T08:00:00.000Z');
const CLOSED_AT = new Date('2026-10-29T16:00:00.000Z');

function till(closed = true) {
  return {
    id: SHIFT_ID,
    companyId: COMPANY_ID,
    openedById: CASHIER_ID,
    handoverToId: SECOND_CASHIER_ID,
    registerId: 'POS-1234',
    registerName: 'Till fallback',
    status: closed ? 'closed' : 'open',
    openingFloat: 10000,
    expectedCash: 14076,
    closingCount: closed ? 14000 : null,
    cashActivity: [
      { type: 'opening_float', amount: 10000, posShiftId: SHIFT_ID, recordedBy: CASHIER_ID },
      { type: 'cash_sale', amount: 5000 },
      { type: 'cash_in', amount: 300 },
      { type: 'cash_out', amount: 100 },
      { type: 'safe_drop', amount: 200 },
      { type: 'no_sale', recordedBy: CASHIER_ID },
    ],
    openedAt: OPENED_AT,
    closedAt: closed ? CLOSED_AT : null,
    openedBy: { id: CASHIER_ID, name: 'Cashier One', email: 'one@example.test' },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  prisma.$queryRawUnsafe.mockImplementation(async (sql) => {
    if (sql.includes('FROM pos_cash_movements movement')) {
      return [
        { type: 'cash_in', amount: 50 },
        { type: 'cash_out', amount: 25 },
        { type: 'safe_drop', amount: 20 },
      ];
    }
    if (sql.includes('FROM pos_payments payment')) return [{ amount: 0 }];
    if (sql.includes('FROM pos_payment_refunds refund')) return [];
    if (sql.includes('FROM invoices') && sql.includes('till_session_id = $2')) {
      return [
        {
          id: 'invoice-1',
          shift_id: SHIFT_ID,
          reference_no: 'INV-1',
          status: 'confirmed',
          subtotal: 12000,
          total_discount: 200,
          tax_amount: 2124,
          total_amount: 13924,
          amount_outstanding: 3000,
          payments: [
            { paymentMethod: 'cash', amount: 5000 },
            { paymentMethod: 'mobile_money', provider: 'momo', amount: 4924 },
            { paymentMethod: 'mobile_money', provider: 'airtel', amount: 1000 },
          ],
          cashier_id: CASHIER_ID,
          created_by: CASHIER_ID,
        },
        {
          id: 'invoice-void',
          shift_id: SHIFT_ID,
          reference_no: 'INV-VOID',
          status: 'cancelled',
          subtotal: 1000,
          total_discount: 0,
          tax_amount: 180,
          total_amount: 1180,
          amount_outstanding: 0,
          payments: [],
          cancelled_at: new Date('2026-10-29T12:00:00.000Z'),
          cashier_id: CASHIER_ID,
          created_by: CASHIER_ID,
        },
      ];
    }
    if (sql.includes('FROM invoice_lines')) {
      return [{ tax_code: 'B', tax_rate: 18, taxable: 11800, tax: 2124 }];
    }
    if (sql.includes('FROM credit_notes')) {
      return [{
        payment_method: 'cash',
        amount: 924,
        refunded_by: SECOND_CASHIER_ID,
      }];
    }
    if (sql.includes('FROM ebm_submission_queues')) {
      return [
        {
          id: 'receipt-signed', documentType: 'pos', documentId: 'invoice-1', ebmStatus: 'submitted',
          isRetryable: false, signedAt: CLOSED_AT, fiscalDataSource: 'MANAGER_ENTRY',
          managerEvidenceNote: 'Verified with RRA support', receiptType: 'S', amount: '12000',
        },
        {
          id: 'receipt-waiting', documentType: 'pos', documentId: 'invoice-2', ebmStatus: 'pending',
          isRetryable: true, signedAt: null, fiscalDataSource: null, managerEvidenceNote: null,
          receiptType: 'S', amount: '500',
        },
        {
          id: 'receipt-failed', documentType: 'pos', documentId: 'invoice-3', ebmStatus: 'failed',
          isRetryable: false, signedAt: null, fiscalDataSource: null, managerEvidenceNote: null,
          receiptType: 'S', amount: '250',
        },
      ];
    }
    if (sql.includes('FROM companies')) {
      return [{
        businessName: 'Kubika Store',
        legalName: null,
        tin: '123456789',
        registerName: 'Front Register',
        registerLocation: 'Main store',
        branchName: 'Main branch',
        branchCode: '00',
      }];
    }
    if (sql.includes('COUNT(*)::int AS number') && sql.includes("status = 'closed'")) {
      return [{ number: 7 }];
    }
    if (sql.includes('COUNT(*)::int AS number')) return [{ number: 12 }];
    if (sql.includes('SELECT id, name, email FROM users')) {
      return [
        { id: CASHIER_ID, name: 'Cashier One', email: 'one@example.test' },
        { id: SECOND_CASHIER_ID, name: 'Cashier Two', email: 'two@example.test' },
      ];
    }
    if (sql.includes('COUNT(*)::int AS count FROM invoices')) return [{ count: 0 }];
    if (sql.includes('COUNT(*)::int AS count')) return [{ count: 0 }];
    throw new Error(`Unexpected report query: ${sql}`);
  });
});

describe('POS X/Z report snapshot', () => {
  test('builds a complete FINAL Z report with business, sales, tax, tenders, cash, voids, and cashier subtotals', async () => {
    const report = await buildReport(COMPANY_ID, till());
    const cashMovementQuery = prisma.$queryRawUnsafe.mock.calls
      .find(([sql]) => sql.includes('FROM pos_cash_movements movement'))?.[0];

    expect(report).toMatchObject({
      reportType: 'Z',
      label: 'FINAL',
      zNumber: 7,
      business: { name: 'Kubika Store', tin: '123456789' },
      branch: { name: 'Main branch', code: '00' },
      shift: { number: 12, registerName: 'Front Register', closedAt: CLOSED_AT },
      sales: {
        transactionCount: 1,
        gross: 12000,
        discounts: 200,
        tax: 2124,
        total: 13924,
        netSales: 13000,
      },
      paymentMethods: {
        cash: 5000,
        momo: 4924,
        airtel: 1000,
        credit: 3000,
      },
      taxBuckets: [{ code: 'B', ratePct: 18, taxable: 11800, tax: 2124 }],
      voids: { count: 1, total: 1180 },
      refunds: { count: 1, total: 924 },
      noSales: { count: 1 },
      cash: {
        openingFloat: 10000,
        cashIn: 350,
        cashOut: 125,
        safeDrops: 220,
        expectedCash: 14076,
        count: 14000,
        variance: -76,
        computedExpectedCash: 14081,
        ledgerDifference: -5,
      },
      fiscalReceipts: {
        policy: 'REQUIRE_APPROVAL',
        signed: {
          count: 1,
          amount: 12000,
          managerEnteredCount: 1,
          managerEntered: [expect.objectContaining({ evidenceNote: 'Verified with RRA support' })],
        },
        waiting: { count: 1, amount: 500 },
        failed: { count: 1, amount: 250 },
        unsent: [
          expect.objectContaining({ id: 'receipt-waiting', status: 'waiting' }),
          expect.objectContaining({ id: 'receipt-failed', status: 'failed' }),
        ],
      },
    });
    expect(report.shift.cashiers.map(({ name }) => name)).toEqual(['Cashier One', 'Cashier Two']);
    expect(report.cashiers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        cashier: expect.objectContaining({ name: 'Cashier One' }),
        transactionCount: 1,
        gross: 12000,
        netSales: 13924,
      }),
      expect.objectContaining({
        cashier: expect.objectContaining({ name: 'Cashier Two' }),
        transactionCount: 0,
        refunds: 924,
        netSales: -924,
      }),
    ]));
    expect(cashMovementQuery).toContain('movement.shift_id = ANY($2::char(24)[])');
    expect(prisma.$queryRawUnsafe.mock.calls.find(([sql]) => sql === cashMovementQuery)[2]).toContain(SHIFT_ID);
  });

  test('does not count a POS cash movement twice when it is also mirrored in till activity', async () => {
    prisma.$queryRawUnsafe.mockImplementation(async (sql) => {
      if (sql.includes('FROM pos_cash_movements movement')) return [{ type: 'cash_in', amount: 50 }];
      if (sql.includes('FROM pos_payments payment')) return [{ amount: 0 }];
      if (sql.includes('FROM pos_payment_refunds refund')) return [];
      if (sql.includes('FROM ebm_submission_queues')) return [];
      if (sql.includes('FROM invoices') && sql.includes('till_session_id = $2')) return [];
      if (sql.includes('FROM invoice_lines')) return [];
      if (sql.includes('FROM credit_notes')) return [];
      if (sql.includes('FROM companies')) return [];
      if (sql.includes('COUNT(*)::int AS number')) return [{ number: 1 }];
      if (sql.includes('SELECT id, name, email FROM users')) return [{ id: CASHIER_ID, name: 'Cashier One', email: 'one@example.test' }];
      if (sql.includes('COUNT(*)::int AS count')) return [{ count: 0 }];
      throw new Error(`Unexpected report query: ${sql}`);
    });
    const activeTill = {
      ...till(false),
      cashActivity: [
        { type: 'opening_float', amount: 10000, posShiftId: SHIFT_ID, recordedBy: CASHIER_ID },
        { type: 'cash_in', amount: 50, posShiftId: SHIFT_ID, recordedBy: CASHIER_ID },
      ],
    };

    const report = await buildReport(COMPANY_ID, activeTill);

    expect(report.cash.cashIn).toBe(50);
    expect(report.cash.computedExpectedCash).toBe(10050);
  });

  test('builds an X report preview without closed-only fields', async () => {
    const report = await buildReport(COMPANY_ID, till(false));

    expect(report.reportType).toBe('X');
    expect(report.label).toBe('X REPORT');
    expect(report.zNumber).toBeNull();
    expect(report.shift).not.toHaveProperty('closedAt');
    expect(report.cash.count).toBeNull();
    expect(report.cash.variance).toBeNull();
  });
});
