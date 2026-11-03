'use strict';

const { prisma } = require('../lib/prisma');

function parseDate(value, fallback) {
  const dateText = String(value || fallback);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) return null;
  const date = new Date(`${dateText}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === dateText ? date : null;
}

function isoDay(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function round(value) {
  const amount = Number(value || 0);
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

function amount(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? round(number) : 0;
}

function emptyDay(day) {
  return {
    date: day,
    sales: { count: 0, gross: 0, discounts: 0, tax: 0, total: 0 },
    refunds: { count: 0, tax: 0, total: 0 },
    fiscal: {
      signed: { count: 0, amount: 0, tax: 0 },
      waiting: { count: 0, amount: 0, tax: 0 },
      failed: { count: 0, amount: 0, tax: 0 },
      missingSales: 0,
      missingRefunds: 0,
      orphaned: 0,
      amountVariance: 0,
      taxVariance: 0,
      unmatched: 0,
    },
    taxCategories: {},
    _sales: [],
    _refunds: [],
    _queue: [],
  };
}

function taxCategory(day, code) {
  const key = String(code || 'UNASSIGNED');
  if (!day.taxCategories[key]) day.taxCategories[key] = {
    code: key, localTaxable: 0, localTax: 0, vsdcTaxable: 0, vsdcTax: 0,
  };
  return day.taxCategories[key];
}

exports.daily = async (req, res, next) => {
  try {
    const companyId = String(req.user?.company?._id || req.user?.companyId || '');
    if (!companyId) return res.status(400).json({ success: false, code: 'COMPANY_CONTEXT_REQUIRED', message: 'A company is required to reconcile POS fiscal activity.' });
    const today = new Date().toISOString().slice(0, 10);
    const from = parseDate(req.query.from, today);
    const to = parseDate(req.query.to, today);
    if (!from || !to || from > to) return res.status(400).json({ success: false, code: 'POS_FISCAL_RECONCILIATION_DATES_INVALID', message: 'Choose a valid date range.' });
    if ((to.getTime() - from.getTime()) / 86400000 > 92) return res.status(400).json({ success: false, code: 'POS_FISCAL_RECONCILIATION_RANGE_TOO_LARGE', message: 'Choose a range of 93 days or less.' });
    const until = new Date(to.getTime() + 86400000);
    const fromText = from.toISOString();
    const untilText = until.toISOString();
    const [sales, refunds, salesTax, refundTax, fiscalRows] = await Promise.all([
      prisma.$queryRawUnsafe(
        `SELECT id, reference_no AS "referenceNo", (invoice_date AT TIME ZONE 'UTC')::date::text AS day,
                subtotal, total_discount AS discounts, tax_amount AS tax, total_amount AS total
           FROM invoices WHERE company_id = $1 AND pos_origin = TRUE
            AND status NOT IN ('draft', 'cancelled', 'PENDING_PAYMENT')
            AND invoice_date >= $2 AND invoice_date < $3 ORDER BY invoice_date, id`,
        companyId, fromText, untilText,
      ),
      prisma.$queryRawUnsafe(
        `SELECT id, reference_no AS "referenceNo", (credit_date AT TIME ZONE 'UTC')::date::text AS day,
                tax_amount AS tax, total_amount AS total
           FROM credit_notes WHERE company_id = $1 AND pos_origin = TRUE
            AND status NOT IN ('draft', 'cancelled') AND credit_date >= $2 AND credit_date < $3
          ORDER BY credit_date, id`,
        companyId, fromText, untilText,
      ),
      prisma.$queryRawUnsafe(
        `SELECT (i.invoice_date AT TIME ZONE 'UTC')::date::text AS day,
                il.tax_code AS code, il.tax_rate AS rate,
                SUM(il.line_subtotal * (1 - il.discount_pct / 100)) AS taxable, SUM(il.line_tax) AS tax
           FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id AND i.company_id = il.company_id
          WHERE i.company_id = $1 AND i.pos_origin = TRUE AND i.status NOT IN ('draft', 'cancelled', 'PENDING_PAYMENT')
            AND i.invoice_date >= $2 AND i.invoice_date < $3
          GROUP BY day, il.tax_code, il.tax_rate ORDER BY day, il.tax_code, il.tax_rate`,
        companyId, fromText, untilText,
      ),
      prisma.$queryRawUnsafe(
        `SELECT (cn.credit_date AT TIME ZONE 'UTC')::date::text AS day,
                COALESCE(il.tax_code, p.tax_code, 'UNASSIGNED') AS code,
                cl.tax_rate AS rate,
                SUM(cl.line_subtotal * (1 - cl.discount_pct / 100)) AS taxable, SUM(cl.line_tax) AS tax
           FROM credit_note_lines cl JOIN credit_notes cn ON cn.id = cl.credit_note_id AND cn.company_id = cl.company_id
           LEFT JOIN invoice_lines il ON il.id = cl.invoice_line_id AND il.company_id = cl.company_id
           LEFT JOIN products p ON p.id = cl.product_id AND p.company_id = cl.company_id
          WHERE cn.company_id = $1 AND cn.pos_origin = TRUE AND cn.status NOT IN ('draft', 'cancelled')
            AND cn.credit_date >= $2 AND cn.credit_date < $3
          GROUP BY day, COALESCE(il.tax_code, p.tax_code, 'UNASSIGNED'), cl.tax_rate
          ORDER BY day, code, rate`,
        companyId, fromText, untilText,
      ),
      prisma.$queryRawUnsafe(
        `SELECT q.id, q.document_type AS "documentType", q.document_id AS "documentId",
                q.ebm_status AS status, q.is_retryable AS "isRetryable", q.signed_at AS "signedAt",
                q.created_at AS "createdAt", q.payload,
                COALESCE((i.invoice_date AT TIME ZONE 'UTC')::date::text,
                         (cn.credit_date AT TIME ZONE 'UTC')::date::text,
                         (q.created_at AT TIME ZONE 'UTC')::date::text) AS day
           FROM ebm_submission_queues q
           LEFT JOIN invoices i ON q.document_type = 'pos' AND i.id = q.document_id AND i.company_id = q.company_id AND i.pos_origin = TRUE
           LEFT JOIN credit_notes cn ON q.document_type = 'creditNote' AND cn.id = q.document_id AND cn.company_id = q.company_id AND cn.pos_origin = TRUE
          WHERE q.company_id = $1 AND q.document_type IN ('pos', 'creditNote')
            AND q.endpoint = '/transactions/saveSales'
            AND ((q.document_type = 'pos' AND (q.rcpt_ty_cd IS NULL OR q.rcpt_ty_cd = 'S'))
              OR (q.document_type = 'creditNote' AND (q.rcpt_ty_cd IS NULL OR q.rcpt_ty_cd = 'R')))
            AND COALESCE(i.invoice_date, cn.credit_date, q.created_at) >= $2
            AND COALESCE(i.invoice_date, cn.credit_date, q.created_at) < $3
          ORDER BY day, q.created_at, q.id`,
        companyId, fromText, untilText,
      ),
    ]);

    const days = new Map();
    const ensure = (day) => {
      if (!days.has(day)) days.set(day, emptyDay(day));
      return days.get(day);
    };
    for (const row of sales) {
      const day = ensure(String(row.day));
      day.sales.count += 1;
      day.sales.gross += amount(row.subtotal);
      day.sales.discounts += amount(row.discounts);
      day.sales.tax += amount(row.tax);
      day.sales.total += amount(row.total);
      day._sales.push({ id: String(row.id), total: amount(row.total), tax: amount(row.tax) });
    }
    for (const row of refunds) {
      const day = ensure(String(row.day));
      day.refunds.count += 1;
      day.refunds.tax += amount(row.tax);
      day.refunds.total += amount(row.total);
      day._refunds.push({ id: String(row.id), total: amount(row.total), tax: amount(row.tax) });
    }
    for (const row of [...salesTax, ...refundTax]) {
      const bucket = taxCategory(ensure(String(row.day)), row.code);
      bucket.localTaxable += amount(row.taxable);
      bucket.localTax += amount(row.tax);
    }
    const queueByDoc = new Map();
    for (const row of fiscalRows) {
      const day = ensure(String(row.day));
      const type = row.documentType === 'creditNote' ? 'refund' : 'sale';
      const key = `${type}:${row.documentId}`;
      const payload = row.payload || {};
      const signed = row.status === 'submitted' && row.signedAt;
      const status = signed ? 'signed' : ['pending', 'submitting'].includes(String(row.status)) ? 'waiting' : 'failed';
      const record = {
        id: String(row.id), key, type, documentId: String(row.documentId), day,
        status, amount: amount(payload.totAmt), tax: amount(payload.totTaxAmt), payload,
      };
      const prior = queueByDoc.get(key);
      if (!prior || (record.status === 'signed' && prior.status !== 'signed')) queueByDoc.set(key, record);
    }
    for (const record of queueByDoc.values()) {
      const day = ensure(record.day);
      day._queue.push(record);
      day.fiscal[record.status].count += 1;
      day.fiscal[record.status].amount += record.amount;
      day.fiscal[record.status].tax += record.tax;
      if (record.status === 'signed') {
        for (const code of ['A', 'B', 'C', 'D']) {
          const bucket = taxCategory(day, code);
          bucket.vsdcTaxable += amount(record.payload[`taxblAmt${code}`]);
          bucket.vsdcTax += amount(record.payload[`taxAmt${code}`]);
        }
      }
    }
    for (const day of days.values()) {
      const localDocumentKeys = new Set([
        ...day._sales.map((item) => `sale:${item.id}`),
        ...day._refunds.map((item) => `refund:${item.id}`),
      ]);
      day.fiscal.orphaned = day._queue.filter((item) => !localDocumentKeys.has(item.key)).length;
      for (const document of [...day._sales.map((item) => ({ ...item, kind: 'sale' })), ...day._refunds.map((item) => ({ ...item, kind: 'refund' }))]) {
        const matched = queueByDoc.get(`${document.kind}:${document.id}`);
        if (!matched) {
          if (document.kind === 'sale') day.fiscal.missingSales += 1;
          else day.fiscal.missingRefunds += 1;
          continue;
        }
        if (matched.status === 'signed') {
          day.fiscal.amountVariance += matched.amount - document.total;
          day.fiscal.taxVariance += matched.tax - document.tax;
        } else day.fiscal.unmatched += 1;
      }
      day.sales.gross = round(day.sales.gross);
      day.sales.discounts = round(day.sales.discounts);
      day.sales.tax = round(day.sales.tax);
      day.sales.total = round(day.sales.total);
      day.refunds.tax = round(day.refunds.tax);
      day.refunds.total = round(day.refunds.total);
      for (const status of ['signed', 'waiting', 'failed']) {
        day.fiscal[status].amount = round(day.fiscal[status].amount);
        day.fiscal[status].tax = round(day.fiscal[status].tax);
      }
      day.fiscal.amountVariance = round(day.fiscal.amountVariance);
      day.fiscal.taxVariance = round(day.fiscal.taxVariance);
      day.taxCategories = Object.values(day.taxCategories).map((bucket) => ({
        ...bucket,
        localTaxable: round(bucket.localTaxable), localTax: round(bucket.localTax),
        vsdcTaxable: round(bucket.vsdcTaxable), vsdcTax: round(bucket.vsdcTax),
        taxableVariance: round(bucket.vsdcTaxable - bucket.localTaxable),
        taxVariance: round(bucket.vsdcTax - bucket.localTax),
      })).sort((left, right) => left.code.localeCompare(right.code));
      day.status = day.fiscal.missingSales || day.fiscal.missingRefunds || day.fiscal.waiting.count || day.fiscal.failed.count
        || day.fiscal.unmatched || day.fiscal.orphaned || Math.abs(day.fiscal.amountVariance) > 0.01 || Math.abs(day.fiscal.taxVariance) > 0.01
        || day.taxCategories.some((bucket) => Math.abs(bucket.taxVariance) > 0.01 || Math.abs(bucket.taxableVariance) > 0.01)
        ? 'REVIEW' : 'RECONCILED';
      delete day._sales;
      delete day._refunds;
      delete day._queue;
    }

    res.json({ success: true, data: {
      range: { from: isoDay(from), to: isoDay(to), timeZone: 'UTC' },
      generatedAt: new Date().toISOString(),
      days: [...days.values()].sort((left, right) => right.date.localeCompare(left.date)),
    } });
  } catch (error) { next(error); }
};

exports.unsent = async (req, res, next) => {
  try {
    const companyId = String(req.user?.company?._id || req.user?.companyId || '');
    const rows = await prisma.ebmSubmissionQueue.findMany({
      where: {
        companyId, registerId: { not: null }, salesTyCd: { not: null }, rcptTyCd: { not: null },
        ebmStatus: { in: ['pending', 'submitting', 'failed'] },
        OR: [{ signedAt: null }, { ebmStatus: { not: 'submitted' } }],
      },
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
      take: Math.max(1, Math.min(Number(req.query.limit) || 200, 500)),
      select: {
        id: true, documentType: true, documentId: true, registerId: true, shiftId: true,
        cashierId: true, ebmStatus: true, isRetryable: true, salesTyCd: true, rcptTyCd: true,
        lastError: true, payload: true, createdAt: true, updatedAt: true,
      },
    });
    res.json({ success: true, data: rows.map((row) => ({
      ...row,
      amount: amount(row.payload?.totAmt),
      tax: amount(row.payload?.totTaxAmt),
      payload: undefined,
    })) });
  } catch (error) { next(error); }
};
