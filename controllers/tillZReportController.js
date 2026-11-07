const { prisma } = require('../lib/prisma');
const { getPosEbmSettings } = require('../services/posEbmSettingsService');

const number = (value) => Number(value || 0);
const roundMoney = (value) => Math.round((number(value) + Number.EPSILON) * 100) / 100;
const PAYMENT_METHODS = ['cash', 'momo', 'airtel', 'card', 'credit', 'giftCard', 'mobileMoneyUnspecified', 'other'];

function paymentCategory(method, reference = '', provider = '') {
  const normalized = String(method || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const paymentProvider = String(provider || '').trim().toLowerCase();
  const detail = `${normalized} ${String(reference || '').toLowerCase()}`;
  if (normalized === 'cash') return 'cash';
  if (normalized.includes('gift')) return 'giftCard';
  if (normalized.includes('credit') || normalized.includes('store_credit')) return 'credit';
  if (paymentProvider === 'airtel') return 'airtel';
  if (paymentProvider === 'momo') return 'momo';
  if (normalized.includes('airtel') || detail.includes('airtel')) return 'airtel';
  if (normalized.includes('momo') || normalized.includes('mtn')) return 'momo';
  if (normalized === 'mobile_money') return 'mobileMoneyUnspecified';
  if (normalized.includes('card')) return 'card';
  return 'other';
}

function emptyPaymentMethods() {
  return Object.fromEntries(PAYMENT_METHODS.map((method) => [method, 0]));
}

async function buildReport(companyId, till, queryClient = prisma) {
  const endAt = till.closedAt || new Date();
  const invoices = await queryClient.$queryRawUnsafe(
    `SELECT id, reference_no, status, subtotal, total_discount, tax_amount, total_amount,
            shift_id,
            payments, cancelled_at, invoice_date, cashier_id, created_by, amount_outstanding
       FROM invoices
      WHERE company_id = $1 AND till_session_id = $2 AND status <> 'PENDING_PAYMENT'
      ORDER BY invoice_date, id`,
    companyId, till.id,
  );
  const lineRows = await queryClient.$queryRawUnsafe(
    `SELECT il.tax_code, il.tax_rate, SUM(il.line_subtotal * (1 - il.discount_pct / 100)) AS taxable,
            SUM(il.line_tax) AS tax
       FROM invoice_lines il
       JOIN invoices i ON i.id = il.invoice_id AND i.company_id = il.company_id
      WHERE i.company_id = $1 AND i.till_session_id = $2 AND i.status NOT IN ('cancelled', 'PENDING_PAYMENT')
      GROUP BY il.tax_code, il.tax_rate ORDER BY il.tax_code, il.tax_rate`,
    companyId, till.id,
  );
  const refundRows = await queryClient.$queryRawUnsafe(
    `SELECT cn.reference_no, refund->>'paymentMethod' AS payment_method,
            refund->>'reference' AS payment_reference,
            COALESCE((refund->>'amount')::numeric, 0) AS amount,
            refund->>'refundedAt' AS refunded_at,
            refund->>'refundedBy' AS refunded_by
       FROM credit_notes cn
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(cn.payments, '[]'::jsonb)) AS refund
      WHERE cn.company_id = $1 AND refund->>'tillSessionId' = $2
      ORDER BY refund->>'refundedAt'`,
    companyId, till.id,
  );
  const identityRows = await queryClient.$queryRawUnsafe(
    `SELECT c.name AS "businessName", c.legal_name AS "legalName",
            c.tax_identification_number AS "tin",
            pr.name AS "registerName", pr.location AS "registerLocation",
            w.name AS "branchName", w.rra_branch_id AS "branchCode"
       FROM companies c
       LEFT JOIN pos_registers pr ON pr.company_id = c.id AND pr.code = $2
       LEFT JOIN warehouses w ON w.company_id = c.id AND w.id = pr.branch_id
      WHERE c.id = $1`,
    companyId, till.registerId,
  );
  const cashActivity = Array.isArray(till.cashActivity) ? till.cashActivity : [];
  const linkedShiftIds = [...new Set([
    ...cashActivity.map((activity) => activity.posShiftId),
    ...invoices.map((invoice) => invoice.shift_id),
  ].filter(Boolean).map(String))];
  const cashMovementRows = linkedShiftIds.length
    ? await queryClient.$queryRawUnsafe(
    `SELECT movement.type, SUM(movement.amount)::numeric AS amount
       FROM pos_cash_movements movement
      WHERE movement.company_id = $1
        AND movement.shift_id = ANY($2::char(24)[])
        AND movement.created_at >= $3 AND movement.created_at <= $4
      GROUP BY movement.type`,
    companyId, linkedShiftIds, till.openedAt, endAt,
  )
    : [];
  const pendingPosCashRows = linkedShiftIds.length
  ? await queryClient.$queryRawUnsafe(
    `SELECT COALESCE(SUM(payment.amount), 0)::numeric AS amount
       FROM pos_payments payment
       JOIN invoices invoice ON invoice.id = payment.sale_id AND invoice.company_id = payment.company_id
      WHERE payment.company_id = $1
        AND payment.shift_id = ANY($2::char(24)[])
        AND payment.method = 'CASH'
        AND payment.status = 'SUCCESS'
        AND invoice.pos_origin = true
        AND invoice.status IN ('PENDING_PAYMENT', 'cancelled')`,
    companyId,
    linkedShiftIds,
  )
  : [];
  const posPaymentRows = linkedShiftIds.length
    ? await queryClient.$queryRawUnsafe(
      `SELECT v2_payment.sale_id AS "saleId", v2_payment.cashier_id AS "cashierId",
              v2_payment.method, v2_payment.amount
         FROM pos_payments AS v2_payment
        WHERE v2_payment.company_id = $1
          AND v2_payment.shift_id = ANY($2::char(24)[])
          AND v2_payment.status = 'SUCCESS'`,
      companyId,
      linkedShiftIds,
    )
    : [];
  const cancelledAfterPaymentByCashier = linkedShiftIds.length
  ? await queryClient.$queryRawUnsafe(
    `SELECT paid_sales."cashierId",
            COALESCE(users.name, 'Cashier') AS "cashierName",
            COUNT(*)::int AS "saleCount",
            COALESCE(SUM(paid_sales."totalAmount"), 0)::numeric AS "totalAmount"
       FROM (
         SELECT invoice.id,
                COALESCE(invoice.cashier_id, payment.cashier_id) AS "cashierId",
                invoice.total_amount AS "totalAmount"
           FROM pos_payment_refunds refund
           JOIN pos_payments payment
             ON payment.id = refund.payment_id AND payment.company_id = refund.company_id
           JOIN invoices invoice
             ON invoice.id = refund.sale_id AND invoice.company_id = refund.company_id
          WHERE refund.company_id = $1
            AND payment.shift_id = ANY($2::char(24)[])
            AND refund.status = 'DONE'
            AND invoice.status = 'cancelled'
          GROUP BY invoice.id, invoice.cashier_id, payment.cashier_id, invoice.total_amount
       ) paid_sales
       LEFT JOIN users ON users.id = paid_sales."cashierId" AND users.company_id = $1
      GROUP BY paid_sales."cashierId", users.name
      ORDER BY users.name, paid_sales."cashierId"`,
    companyId,
    linkedShiftIds,
  )
  : [];
  const shiftNumberRows = await queryClient.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS number
       FROM till_sessions
      WHERE company_id = $1 AND register_id = $2 AND opened_at <= $3`,
    companyId, till.registerId, till.openedAt,
  );
  const zNumberRows = till.closedAt
    ? await queryClient.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS number
         FROM till_sessions
        WHERE company_id = $1 AND register_id = $2 AND status = 'closed' AND closed_at <= $3`,
      companyId, till.registerId, till.closedAt,
    )
    : [];
  const cashierIds = [...new Set([
    till.openedById,
    ...invoices.flatMap((invoice) => [invoice.cashier_id, invoice.created_by]),
    ...posPaymentRows.map((payment) => payment.cashierId),
    ...refundRows.map((refund) => refund.refunded_by),
    ...(Array.isArray(till.cashActivity) ? till.cashActivity.map((item) => item.recordedBy) : []),
  ].filter(Boolean).map(String))];
  const cashierRows = cashierIds.length
    ? await queryClient.$queryRawUnsafe(
      'SELECT id, name, email FROM users WHERE company_id = $1 AND id = ANY($2::char(24)[])',
      companyId, cashierIds,
    )
    : [];
  const cashiersById = new Map(cashierRows.map((cashier) => [String(cashier.id).trim(), {
    id: String(cashier.id).trim(),
    name: cashier.name,
    email: cashier.email,
  }]));
  const shiftNumber = Number(shiftNumberRows[0]?.number || 1);
  const identity = identityRows[0] || {};
  const legacySaleRows = await queryClient.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS count FROM invoices
      WHERE company_id = $1 AND pos_origin = true AND till_session_id IS NULL
        AND created_by = $2 AND invoice_date >= $3 AND invoice_date <= $4`,
    companyId, till.openedById, till.openedAt, endAt,
  );
  const legacyRefundRows = await queryClient.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS count
       FROM credit_notes cn
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(cn.payments, '[]'::jsonb)) AS refund
      WHERE cn.company_id = $1 AND cn.pos_origin = true
        AND refund->>'tillSessionId' IS NULL
        AND refund->>'refundedBy' = $2
        AND (refund->>'refundedAt')::timestamptz >= $3
        AND (refund->>'refundedAt')::timestamptz <= $4`,
    companyId, till.openedById, till.openedAt, endAt,
  );
  const fiscalRows = linkedShiftIds.length ? await queryClient.$queryRawUnsafe(
    `SELECT id, document_type AS "documentType", document_id AS "documentId",
            ebm_status AS "ebmStatus", is_retryable AS "isRetryable", signed_at AS "signedAt",
            fiscal_data_source AS "fiscalDataSource", manager_evidence_note AS "managerEvidenceNote",
            rcpt_ty_cd AS "receiptType", payload->>'totAmt' AS amount,
            last_error->>'code' AS "errorCode", last_error->>'message' AS "errorMessage"
       FROM ebm_submission_queues
      WHERE company_id = $1 AND shift_id = ANY($2::char(24)[])
        AND register_id IS NOT NULL AND sales_ty_cd IS NOT NULL AND rcpt_ty_cd IS NOT NULL
        AND (ebm_status IN ('pending', 'submitting', 'failed') OR (ebm_status = 'submitted' AND signed_at IS NOT NULL))
      ORDER BY created_at, id` ,
    companyId, linkedShiftIds,
  ) : [];
  const fiscalReceipts = {
    policy: (await getPosEbmSettings(queryClient, companyId)).shiftCloseFiscalPolicy,
    signed: { count: 0, amount: 0, managerEnteredCount: 0, managerEntered: [] },
    waiting: { count: 0, amount: 0 },
    failed: { count: 0, amount: 0 },
    unsent: [],
  };
  for (const row of fiscalRows) {
    const amount = roundMoney(row.amount);
    const signed = row.ebmStatus === 'submitted' && row.signedAt;
    const category = signed ? 'signed' : row.ebmStatus === 'pending' || row.ebmStatus === 'submitting' ? 'waiting' : 'failed';
    fiscalReceipts[category].count += 1;
    fiscalReceipts[category].amount = roundMoney(fiscalReceipts[category].amount + amount);
    if (signed && row.fiscalDataSource === 'MANAGER_ENTRY') {
      fiscalReceipts.signed.managerEnteredCount += 1;
      fiscalReceipts.signed.managerEntered.push({
        id: String(row.id), documentType: row.documentType, documentId: String(row.documentId),
        evidenceNote: row.managerEvidenceNote || null,
      });
    }
    if (!signed) fiscalReceipts.unsent.push({
      id: String(row.id), documentType: row.documentType, documentId: String(row.documentId),
      receiptType: row.receiptType, status: category, amount, retryable: Boolean(row.isRetryable),
      errorCode: row.errorCode || null, errorMessage: row.errorMessage || null,
    });
  }

  const completed = invoices.filter((invoice) => invoice.status !== 'cancelled');
  const voided = invoices.filter((invoice) => invoice.status === 'cancelled'
    && invoice.cancelled_at && new Date(invoice.cancelled_at) >= new Date(till.openedAt)
    && new Date(invoice.cancelled_at) <= new Date(endAt));
  const sales = completed.reduce((total, invoice) => ({
    gross: total.gross + number(invoice.subtotal),
    discounts: total.discounts + number(invoice.total_discount),
    tax: total.tax + number(invoice.tax_amount),
    total: total.total + number(invoice.total_amount),
  }), { gross: 0, discounts: 0, tax: 0, total: 0 });
  const tenderTotals = new Map();
  const paymentMethods = emptyPaymentMethods();
  const cashierTotals = new Map();
  const invoicesWithEmbeddedPayments = new Set();
  for (const invoice of invoices) {
    if (invoice.status === 'cancelled') continue;
    const cashierId = String(invoice.cashier_id || invoice.created_by || till.openedById);
    if (!cashierTotals.has(cashierId)) {
      cashierTotals.set(cashierId, {
        cashier: cashiersById.get(cashierId) || { id: cashierId, name: 'Cashier', email: null },
        transactionCount: 0,
        gross: 0,
        discounts: 0,
        refunds: 0,
        netSales: 0,
        tenders: emptyPaymentMethods(),
      });
    }
    const cashier = cashierTotals.get(cashierId);
    cashier.transactionCount += 1;
    cashier.gross += number(invoice.subtotal);
    cashier.discounts += number(invoice.total_discount);
    cashier.netSales += number(invoice.total_amount);
    const outstanding = number(invoice.amount_outstanding);
    if (outstanding > 0) {
      paymentMethods.credit += outstanding;
      cashier.tenders.credit += outstanding;
    }
    const payments = Array.isArray(invoice.payments) ? invoice.payments : [];
    if (payments.length) invoicesWithEmbeddedPayments.add(String(invoice.id));
    for (const payment of payments) {
      const amount = number(payment?.amount);
      if (amount <= 0) continue;
      const method = String(payment.paymentMethod || 'unknown').toLowerCase();
      tenderTotals.set(method, (tenderTotals.get(method) || 0) + amount);
      const category = paymentCategory(method, payment.reference, payment.provider);
      paymentMethods[category] += amount;
      cashier.tenders[category] += amount;
    }
  }
  const reportableInvoiceIds = new Set(invoices
    .filter((invoice) => invoice.status !== 'cancelled' && invoice.status !== 'PENDING_PAYMENT')
    .map((invoice) => String(invoice.id)));
  for (const payment of posPaymentRows) {
    const saleId = String(payment.saleId);
    if (!reportableInvoiceIds.has(saleId) || invoicesWithEmbeddedPayments.has(saleId)) continue;
    const amount = number(payment.amount);
    if (amount <= 0) continue;
    const method = String(payment.method || 'unknown').toLowerCase();
    tenderTotals.set(method, (tenderTotals.get(method) || 0) + amount);
    const category = paymentCategory(method);
    paymentMethods[category] += amount;
    const cashierId = String(payment.cashierId || till.openedById);
    if (!cashierTotals.has(cashierId)) {
      cashierTotals.set(cashierId, {
        cashier: cashiersById.get(cashierId) || { id: cashierId, name: 'Cashier', email: null },
        transactionCount: 0,
        gross: 0,
        discounts: 0,
        refunds: 0,
        netSales: 0,
        tenders: emptyPaymentMethods(),
      });
    }
    cashierTotals.get(cashierId).tenders[category] += amount;
  }
  const refundsByMethod = new Map();
  const refundsByCashier = new Map();
  let totalRefunds = 0;
  let cashRefunds = 0;
  for (const refund of refundRows) {
    const amount = number(refund.amount);
    const method = String(refund.payment_method || 'unknown').toLowerCase();
    refundsByMethod.set(method, (refundsByMethod.get(method) || 0) + amount);
    const cashierId = String(refund.refunded_by || till.openedById);
    refundsByCashier.set(cashierId, (refundsByCashier.get(cashierId) || 0) + amount);
    totalRefunds += amount;
    if (method === 'cash') cashRefunds += amount;
  }
  for (const [cashierId, amount] of refundsByCashier) {
    if (!cashierTotals.has(cashierId)) {
      cashierTotals.set(cashierId, {
        cashier: cashiersById.get(cashierId) || { id: cashierId, name: 'Cashier', email: null },
        transactionCount: 0,
        gross: 0,
        discounts: 0,
        refunds: 0,
        netSales: 0,
        tenders: emptyPaymentMethods(),
      });
    }
    const cashier = cashierTotals.get(cashierId);
    cashier.refunds += amount;
    cashier.netSales -= amount;
  }
  const methodNames = new Set([...tenderTotals.keys(), ...refundsByMethod.keys()]);
  const tenders = [...methodNames].sort().map((method) => {
    const received = roundMoney(tenderTotals.get(method) || 0);
    const refunded = roundMoney(refundsByMethod.get(method) || 0);
    return { method, received, refunded, net: roundMoney(received - refunded) };
  });
  const cashSales = roundMoney(cashActivity
    .filter((activity) => activity.type === 'cash_sale')
    .reduce((sum, activity) => sum + number(activity.amount), 0));
  const cashGiftCardIssues = roundMoney(cashActivity
    .filter((activity) => activity.type === 'gift_card_issue' && !activity.posShiftId)
    .reduce((sum, activity) => sum + number(activity.amount), 0));
  const openingFloat = roundMoney(till.openingFloat);
  const expectedCash = roundMoney(till.expectedCash ?? openingFloat);
  const noSaleCount = cashActivity.filter((activity) => activity.type === 'no_sale').length;
  const cashMovementTotals = cashActivity.reduce((totals, activity) => {
    if (activity.posShiftId) return totals;
    if (activity.type === 'cash_in') totals.cashIn += number(activity.amount);
    if (activity.type === 'cash_out' || activity.type === 'REFUND') totals.cashOut += number(activity.amount);
    if (activity.type === 'safe_drop') totals.safeDrops += number(activity.amount);
    return totals;
  }, { cashIn: 0, cashOut: 0, safeDrops: 0 });
  for (const movement of cashMovementRows) {
    if (movement.type === 'cash_in') cashMovementTotals.cashIn += number(movement.amount);
    if (movement.type === 'cash_out' || movement.type === 'REFUND') cashMovementTotals.cashOut += number(movement.amount);
    if (movement.type === 'safe_drop') cashMovementTotals.safeDrops += number(movement.amount);
  }
  const computedExpectedCash = roundMoney(
    openingFloat + cashSales + cashGiftCardIssues + number(pendingPosCashRows[0]?.amount) - cashRefunds
      + cashMovementTotals.cashIn - cashMovementTotals.cashOut - cashMovementTotals.safeDrops,
  );
  const countedCash = till.closingCount == null ? null : roundMoney(till.closingCount);
  const taxBuckets = lineRows.map((row) => ({
    code: row.tax_code || 'UNASSIGNED',
    ratePct: roundMoney(row.tax_rate),
    taxable: roundMoney(row.taxable),
    tax: roundMoney(row.tax),
  }));
  const voidTotal = voided.reduce((sum, invoice) => sum + number(invoice.total_amount), 0);
  const closed = Boolean(till.closedAt);

  return {
    version: 2,
    reportType: closed ? 'Z' : 'X',
    label: closed ? 'FINAL' : 'X REPORT',
    zNumber: closed ? Number(zNumberRows[0]?.number || 1) : null,
    generatedAt: new Date().toISOString(),
    business: {
      name: identity.legalName || identity.businessName || 'Business',
      tin: identity.tin || null,
    },
    branch: {
      name: identity.branchName || identity.registerLocation || null,
      code: identity.branchCode || null,
    },
    shift: {
      id: till.id,
      number: shiftNumber,
      registerId: till.registerId,
      registerName: identity.registerName || till.registerName,
      cashierId: till.openedById,
      cashier: cashiersById.get(String(till.openedById || '').trim())
        || (till.openedBy ? { id: till.openedBy.id, name: till.openedBy.name, email: till.openedBy.email } : null),
      cashiers: [...new Set(cashierIds)]
        .map((id) => cashiersById.get(String(id)))
        .filter(Boolean),
      status: till.status,
      openedAt: till.openedAt,
      ...(closed ? { closedAt: till.closedAt } : {}),
    },
    sales: {
      transactionCount: completed.length,
      gross: roundMoney(sales.gross),
      discounts: roundMoney(sales.discounts),
      netBeforeTax: roundMoney(sales.gross - sales.discounts),
      tax: roundMoney(sales.tax),
      total: roundMoney(sales.total),
      netSales: roundMoney(sales.total - totalRefunds),
    },
    tenders,
    paymentMethods: Object.fromEntries(PAYMENT_METHODS.map((method) => [method, roundMoney(paymentMethods[method])])),
    voids: { count: voided.length, total: roundMoney(voidTotal), invoices: voided.map((invoice) => ({ reference: invoice.reference_no, total: roundMoney(invoice.total_amount), voidedAt: invoice.cancelled_at })) },
    refunds: { count: refundRows.length, total: roundMoney(totalRefunds), byMethod: [...refundsByMethod].map(([method, amount]) => ({ method, amount: roundMoney(amount) })) },
    cancelledAfterPaymentByCashier: cancelledAfterPaymentByCashier.map((row) => ({
      cashierId: row.cashierId,
      cashierName: row.cashierName,
      saleCount: Number(row.saleCount || 0),
      totalAmount: roundMoney(row.totalAmount),
    })),
    taxBuckets,
    fiscalReceipts,
    cashiers: [...cashierTotals.values()].map((cashier) => ({
      ...cashier,
      gross: roundMoney(cashier.gross),
      discounts: roundMoney(cashier.discounts),
      refunds: roundMoney(cashier.refunds),
      netSales: roundMoney(cashier.netSales),
      tenders: Object.fromEntries(PAYMENT_METHODS.map((method) => [method, roundMoney(cashier.tenders[method])])),
    })),
    noSales: { count: noSaleCount },
    cash: {
      openingFloat,
      cashSales,
      pendingPaymentCashReceived: roundMoney(number(pendingPosCashRows[0]?.amount)),
      cashGiftCardIssues,
      cashRefunds: roundMoney(cashRefunds),
      cashIn: roundMoney(cashMovementTotals.cashIn),
      cashOut: roundMoney(cashMovementTotals.cashOut),
      safeDrops: roundMoney(cashMovementTotals.safeDrops),
      expectedCash,
      computedExpectedCash,
      count: countedCash,
      variance: countedCash == null ? null : roundMoney(countedCash - expectedCash),
      ledgerDifference: roundMoney(expectedCash - computedExpectedCash),
    },
    completeness: {
      linkedSales: invoices.length,
      unlinkedLegacySales: Number(legacySaleRows[0]?.count || 0),
      unlinkedLegacyRefunds: Number(legacyRefundRows[0]?.count || 0),
      hasLegacyUnlinkedSales: Number(legacySaleRows[0]?.count || 0) > 0,
      hasLegacyUnlinkedRefunds: Number(legacyRefundRows[0]?.count || 0) > 0,
      refundsLinked: refundRows.length,
    },
  };
}

exports.getTillZReport = async (req, res, next) => {
  try {
    const companyId = String(req.user.company?._id || req.user.companyId || '');
    const tillId = String(req.params.tillSessionId || '');
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ts.id, ts.company_id AS "companyId", ts.opened_by AS "openedById",
              ts.handover_to_id AS "handoverToId",
              ts.register_id AS "registerId", ts.register_name AS "registerName", ts.status,
              ts.opening_float AS "openingFloat", ts.expected_cash AS "expectedCash",
              ts.closing_count AS "closingCount", ts.cash_activity AS "cashActivity",
              ts.opened_at AS "openedAt", ts.closed_at AS "closedAt", ts.z_report AS "zReport",
              u.id AS "cashierId", u.name AS "cashierName", u.email AS "cashierEmail"
         FROM till_sessions ts LEFT JOIN users u ON u.id = ts.opened_by
        WHERE ts.id = $1 AND ts.company_id = $2
          AND ($3::text IS NULL OR ts.register_id = $3)`,
      tillId, companyId, req.posAuthContext ? String(req.posAuthContext.register.code) : null,
    );
    const till = rows[0] ? {
      ...rows[0],
      openedBy: rows[0].cashierId ? { id: rows[0].cashierId, name: rows[0].cashierName, email: rows[0].cashierEmail } : null,
    } : null;
    if (!till) return res.status(404).json({ success: false, code: 'POS_TILL_NOT_FOUND', message: 'Till shift not found.' });

    if (till.zReport) return res.json({ success: true, data: till.zReport });
    const report = await buildReport(companyId, till);
    if (till.status === 'closed') {
      const stored = await prisma.$queryRawUnsafe(
        'UPDATE till_sessions SET z_report = $1::jsonb, z_report_generated_at = CURRENT_TIMESTAMP WHERE id = $2 AND company_id = $3 AND status = \'closed\' AND z_report IS NULL RETURNING z_report',
        JSON.stringify(report), till.id, companyId,
      );
      if (!stored.length) {
        const currentRows = await prisma.$queryRawUnsafe(
          'SELECT z_report AS "zReport" FROM till_sessions WHERE id = $1 AND company_id = $2',
          till.id, companyId,
        );
        const current = currentRows[0];
        if (current?.zReport) return res.json({ success: true, data: current.zReport });
      }
    }
    return res.json({ success: true, data: report });
  } catch (error) {
    console.error('[getTillZReport] Failed to build or persist shift report:', error);
    return next(error);
  }
};

exports.buildReport = buildReport;
