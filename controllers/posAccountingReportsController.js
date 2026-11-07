'use strict';

const { prisma, dbClient } = require('../lib/prisma');
const { requestIp, writePosAuditLog } = require('../services/posAuditService');
const postingService = require('../services/posAccountingPostingService');
const accountingProfileService = require('../services/posAccountingProfileService');
const { getBankDepositClearingBalances } = require('../services/posBankDepositClearingService');
const { DEFAULT_ACCOUNTS } = require('../constants/chartOfAccounts');

const REPORTS = new Set([
  'reconciliation',
  'sales-journal',
  'payments-by-method',
  'gift-card-liability',
  'cash-over-short',
  'write-off-losses',
]);
const STATUSES = new Set(['pending', 'posted', 'failed', 'not_required']);

function companyIdFrom(req) {
  const company = req.user?.company;
  return String(req.user?.companyId || (typeof company === 'string' ? company : company?.id || company?._id) || '');
}

function parseDate(value, endOfDate = false) {
  if (value === undefined || value === null || value === '') return null;
  const input = String(value);
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    if (date.toISOString().slice(0, 10) !== input) return undefined;
    if (endOfDate) date.setUTCHours(23, 59, 59, 999);
  }
  return date;
}

function reportFilters(req) {
  const from = parseDate(req.query?.from);
  const to = parseDate(req.query?.to, true);
  if (from === undefined || to === undefined || (from && to && from > to)) return null;
  return {
    from,
    to,
    registerId: req.query?.registerId ? String(req.query.registerId) : null,
    tillType: req.query?.tillType ? String(req.query.tillType) : null,
  };
}

function errorResponse(res, status, code, message) {
  return res.status(status).json({ success: false, code, message });
}

function number(value) {
  const result = Number(value || 0);
  return Number.isFinite(result) ? result : 0;
}

async function getGiftCardLiability(companyId, client) {
  const [accounts, profile, registers] = await Promise.all([
    client.posStoredValueAccount.findMany({
      where: { companyId, kind: 'gift_card' },
      select: { balance: true, isActive: true, currencyCode: true },
    }),
    accountingProfileService.getProfile(companyId, client),
    client.posRegister.findMany({ where: { companyId }, select: { id: true, systemTillType: true } }),
  ]);
  const accountCodes = new Set();
  const defaultCode = accountingProfileService.resolveAccount(profile, 'giftCardLiability');
  accountCodes.add(DEFAULT_ACCOUNTS.deferredRevenue);
  if (defaultCode) accountCodes.add(defaultCode);
  for (const register of registers) {
    const code = accountingProfileService.resolveAccount(profile, 'giftCardLiability', {
      registerId: register.id,
      tillType: register.systemTillType,
    });
    if (code) accountCodes.add(code);
  }
  const codes = [...accountCodes];
  const ledgerRows = codes.length ? await client.$queryRawUnsafe(
    `WITH gift_card_postings AS (
       SELECT DISTINCT ledger."journal_entry_id"
         FROM "pos_stored_value_ledger" ledger
         JOIN "pos_stored_value_accounts" stored_value
           ON stored_value."id" = ledger."account_id"
          AND stored_value."company_id" = ledger."company_id"
        WHERE ledger."company_id" = $1
          AND stored_value."kind" = 'gift_card'
          AND ledger."posting_status" = 'posted'
          AND ledger."journal_entry_id" IS NOT NULL
     )
     SELECT line."account_code" AS "accountCode",
            COALESCE(SUM(line."credit" - line."debit"), 0)::numeric AS balance
       FROM "journal_entry_lines" line
       JOIN "journal_entries" entry
         ON entry."id" = line."journal_entry_id" AND entry."company_id" = line."company_id"
       JOIN gift_card_postings posting
         ON posting."journal_entry_id" = entry."id"
      WHERE line."company_id" = $1 AND line."account_code" = ANY($2::text[])
        AND entry."status" = 'posted'
      GROUP BY line."account_code"`,
    companyId, codes,
  ) : [];
  const storedBalance = accounts.reduce((sum, account) => sum + number(account.balance), 0);
  const ledgerBalance = ledgerRows.reduce((sum, row) => sum + number(row.balance), 0);
  const difference = Number((storedBalance - ledgerBalance).toFixed(2));
  return {
    currencyCode: accounts[0]?.currencyCode || 'RWF',
    activeGiftCardAccounts: accounts.filter((account) => account.isActive).length,
    storedValueBalance: storedBalance,
    ledgerLiabilityBalance: ledgerBalance,
    difference,
    isZeroDifference: codes.length > 0 && difference === 0,
    mappedAccountCodes: codes,
    mappingConfigured: codes.length > 0,
  };
}

async function getMappedClearingBalances(companyId, client) {
  const keys = ['cardClearing', 'mtnMoMo', 'airtelMoney', 'cashAtBank', 'chequesInHand', 'bankDepositClearing'];
  const fallbacks = {
    cardClearing: DEFAULT_ACCOUNTS.cashAtBank,
    mtnMoMo: DEFAULT_ACCOUNTS.mtnMoMo,
    airtelMoney: DEFAULT_ACCOUNTS.airtelMoney,
    cashAtBank: DEFAULT_ACCOUNTS.cashAtBank,
  };
  const [profile, registers] = await Promise.all([
    accountingProfileService.getProfile(companyId, client),
    client.posRegister.findMany({ where: { companyId }, select: { id: true, systemTillType: true } }),
  ]);
  const labelsByCode = new Map();
  const addMapping = (key, scope) => {
    const code = accountingProfileService.resolveAccount(profile, key, scope) || fallbacks[key];
    if (!code) return;
    const labels = labelsByCode.get(String(code)) || new Set();
    labels.add(key);
    labelsByCode.set(String(code), labels);
  };
  for (const key of keys) addMapping(key, {});
  for (const register of registers) {
    for (const key of keys) {
      addMapping(key, { registerId: register.id, tillType: register.systemTillType });
    }
  }
  const codes = [...labelsByCode.keys()];
  if (!codes.length) return [];
  const balances = await client.$queryRawUnsafe(
    `SELECT line."account_code" AS "accountCode",
            COALESCE(SUM(line."debit" - line."credit"), 0)::numeric AS balance
       FROM "journal_entry_lines" line
       JOIN "journal_entries" entry
         ON entry."id" = line."journal_entry_id" AND entry."company_id" = line."company_id"
      WHERE line."company_id" = $1 AND line."account_code" = ANY($2::text[])
        AND entry."status" = 'posted'
      GROUP BY line."account_code"`,
    companyId,
    codes,
  );
  const balanceByCode = new Map(balances.map((row) => [String(row.accountCode), number(row.balance)]));
  return codes.map((accountCode) => ({
    accountCode,
    mappings: [...labelsByCode.get(accountCode)],
    balance: balanceByCode.get(accountCode) || 0,
  }));
}

exports.listPostings = async (req, res, next) => {
  const companyId = companyIdFrom(req);
  const filters = reportFilters(req);
  const status = req.query?.status ? String(req.query.status).toLowerCase() : null;
  const sourceType = req.query?.sourceType ? String(req.query.sourceType).trim() : null;
  const registerId = req.query?.registerId ? String(req.query.registerId) : null;
  const tillType = req.query?.tillType ? String(req.query.tillType) : null;
  const limit = Math.min(200, Math.max(1, Number.parseInt(String(req.query?.limit || '50'), 10) || 50));
  const page = Math.max(1, Number.parseInt(String(req.query?.page || '1'), 10) || 1);
  if (!companyId) return errorResponse(res, 401, 'UNAUTHORIZED', 'A company session is required.');
  if (!filters) return errorResponse(res, 400, 'POS_REPORT_DATE_INVALID', 'Use valid report dates.');
  if (status && !STATUSES.has(status)) return errorResponse(res, 400, 'POS_POSTING_FILTER_INVALID', 'Choose a supported posting status.');
  if (sourceType && !/^[a-z0-9_]{1,64}$/i.test(sourceType)) {
    return errorResponse(res, 400, 'POS_POSTING_FILTER_INVALID', 'Choose a valid source type.');
  }

  try {
    const client = dbClient();
    const params = [
      companyId,
      filters.from,
      filters.to,
      status,
      sourceType,
      registerId,
      tillType,
      limit,
      (page - 1) * limit,
    ];
    const baseFrom = `
      FROM "pos_accounting_postings" p
      LEFT JOIN "invoices" invoice
        ON p."source_type" = 'pos_sale' AND invoice."id" = p."source_id" AND invoice."company_id" = p."company_id"
      LEFT JOIN "pos_cash_movements" movement
        ON p."source_type" IN ('pos_cash_movement', 'pos_bank_deposit') AND movement."id" = p."source_id" AND movement."company_id" = p."company_id"
      LEFT JOIN "pos_cash_movements" linked_movement
        ON linked_movement."id"::text = p."payload"->>'relatedCashMovementId' AND linked_movement."company_id" = p."company_id"
      LEFT JOIN "pos_shifts" shift
        ON p."source_type" IN ('pos_shift_close', 'pos_shift_reversal') AND shift."id" = p."source_id" AND shift."company_id" = p."company_id"
      LEFT JOIN "pos_shift_correction_reports" correction
        ON p."source_type" = 'pos_shift_correction' AND correction."id" = p."source_id" AND correction."company_id" = p."company_id"
      LEFT JOIN "credit_notes" credit_note
        ON p."source_type" IN ('pos_credit_note', 'pos_credit_note_application', 'pos_credit_note_refund')
       AND credit_note."id" = CASE
         WHEN p."source_type" = 'pos_credit_note' THEN p."source_id"::text
         ELSE p."payload"->>'creditNoteId'
       END
       AND credit_note."company_id" = p."company_id"
      LEFT JOIN "invoices" credit_invoice
        ON credit_invoice."id" = credit_note."invoice_id" AND credit_invoice."company_id" = p."company_id"
      LEFT JOIN "pos_cheques" cheque
        ON p."source_type" = 'pos_cheque_bounce' AND cheque."id" = p."source_id" AND cheque."company_id" = p."company_id"
      LEFT JOIN "invoices" cheque_invoice
        ON cheque_invoice."id" = cheque."invoice_id" AND cheque_invoice."company_id" = p."company_id"
      LEFT JOIN "pos_cheque_deposits" cheque_deposit
        ON p."source_type" = 'pos_cheque_deposit' AND cheque_deposit."id" = p."source_id" AND cheque_deposit."company_id" = p."company_id"
      LEFT JOIN LATERAL (
        SELECT array_agg(DISTINCT deposit_invoice."register_id"::text) AS register_ids
          FROM "pos_cheques" deposited_cheque
          JOIN "invoices" deposit_invoice
            ON deposit_invoice."id" = deposited_cheque."invoice_id"
           AND deposit_invoice."company_id" = deposited_cheque."company_id"
         WHERE p."source_type" = 'pos_cheque_deposit'
           AND deposited_cheque."deposit_id" = p."source_id"
           AND deposited_cheque."company_id" = p."company_id"
      ) deposit_scope ON TRUE
      LEFT JOIN "pos_registers" register
        ON register."id"::text = COALESCE(
          invoice."register_id"::text, movement."register_id"::text, linked_movement."register_id"::text,
          shift."register_id"::text, correction."register_id"::text, credit_invoice."register_id"::text,
          cheque_invoice."register_id"::text,
          CASE WHEN cardinality(deposit_scope.register_ids) = 1 THEN deposit_scope.register_ids[1] ELSE NULL END
        )
       AND register."company_id" = p."company_id"
      WHERE p."company_id" = $1
        AND ($2::timestamptz IS NULL OR p."created_at" >= $2)
        AND ($3::timestamptz IS NULL OR p."created_at" <= $3)
        AND ($4::text IS NULL OR p."status" = $4)
        AND ($5::text IS NULL OR p."source_type" = $5)
        AND ($6::text IS NULL OR register."id"::text = $6 OR $6 = ANY(COALESCE(deposit_scope.register_ids, ARRAY[]::text[])))
        AND ($7::text IS NULL OR register."system_till_type" = $7 OR EXISTS (
          SELECT 1
            FROM unnest(COALESCE(deposit_scope.register_ids, ARRAY[]::text[])) deposit_register_id
            JOIN "pos_registers" deposit_register
              ON deposit_register."id"::text = deposit_register_id
             AND deposit_register."company_id" = p."company_id"
           WHERE deposit_register."system_till_type" = $7
        ))`;
    const [rows, counts] = await Promise.all([
      client.$queryRawUnsafe(
        `SELECT p."id", p."source_type" AS "sourceType", p."source_id" AS "sourceId",
                p."status", p."journal_entry_id" AS "journalEntryId",
                p."journal_entry_ids" AS "journalEntryIds", p."attempt_count" AS "attemptCount",
                p."max_attempts" AS "maxAttempts", p."next_retry_at" AS "nextRetryAt",
                p."last_attempt_at" AS "lastAttemptAt", p."posted_at" AS "postedAt",
                p."failed_at" AS "failedAt", p."last_error" AS "lastError",
                p."created_at" AS "createdAt", register."id" AS "registerId",
                register."name" AS "registerName", register."system_till_type" AS "tillType",
                COALESCE(
                  invoice."reference_no", credit_note."reference_no", credit_invoice."reference_no",
                  cheque_invoice."reference_no", cheque."reference", cheque_deposit."bank_slip_reference",
                  p."payload"->>'reference'
                ) AS "sourceReference"
         ${baseFrom}
         ORDER BY p."created_at" DESC, p."id" DESC
         LIMIT $8 OFFSET $9`,
        ...params,
      ),
      client.$queryRawUnsafe(`SELECT COUNT(*)::int AS total ${baseFrom}`, ...params.slice(0, 7)),
    ]);
    return res.json({
      success: true,
      data: {
        postings: rows,
        pagination: { page, limit, total: Number(counts[0]?.total || 0) },
        filters: { from: filters.from, to: filters.to, status, sourceType, registerId, tillType },
      },
    });
  } catch (error) {
    return next(error);
  }
};

exports.retryPosting = async (req, res, next) => {
  const companyId = companyIdFrom(req);
  const postingId = String(req.params.postingId || '');
  if (!companyId) return errorResponse(res, 401, 'UNAUTHORIZED', 'A company session is required.');
  if (!/^[0-9a-f]{24}$/i.test(postingId)) {
    return errorResponse(res, 400, 'POS_POSTING_ID_INVALID', 'A valid posting ID is required.');
  }
  try {
    const result = await prisma.$transaction(async (tx) => {
      const retried = await postingService.retryFailedPosting(companyId, postingId, tx);
      await writePosAuditLog({
        companyId,
        userId: String(req.user?.id || req.user?._id || ''),
        event: 'POS_ACCOUNTING_POSTING_RETRY_REQUESTED',
        ip: requestIp(req),
        metadata: {
          action: 'retry',
          status: retried.status,
          postingId: retried.id,
          sourceType: retried.sourceType,
          sourceId: retried.sourceId,
        },
      }, tx);
      return retried;
    });
    return res.json({ success: true, data: result });
  } catch (error) {
    if (error.code === 'POS_POSTING_NOT_FOUND') {
      return errorResponse(res, 404, error.code, error.message);
    }
    if (error.code === 'POS_POSTING_NOT_RETRYABLE') {
      return errorResponse(res, 409, error.code, error.message);
    }
    return next(error);
  }
};

exports.getReport = async (req, res, next) => {
  const companyId = companyIdFrom(req);
  const report = String(req.query?.report || '');
  const filters = reportFilters(req);
  if (!companyId) return errorResponse(res, 401, 'UNAUTHORIZED', 'A company session is required.');
  if (!REPORTS.has(report)) return errorResponse(res, 400, 'POS_REPORT_TYPE_INVALID', 'Choose a supported POS report.');
  if (!filters) return errorResponse(res, 400, 'POS_REPORT_DATE_INVALID', 'Use valid report dates.');

  try {
    const client = dbClient();
    const { from, to, registerId, tillType } = filters;
    const registers = await client.posRegister.findMany({
      where: { companyId, ...(registerId ? { id: registerId } : {}), ...(tillType ? { systemTillType: tillType } : {}) },
      select: { id: true, name: true, systemTillType: true },
      orderBy: { name: 'asc' },
    });
    const selectedRegisterIds = registers.map((register) => String(register.id));
    const effectiveRegisterId = registerId || null;
    let data;
    if (report === 'reconciliation') {
      const accountingProfile = await accountingProfileService.getProfile(companyId, client);
      const accountMappings = [
        ...registers.map((register) => ({
          registerId: String(register.id),
          salesRevenue: accountingProfileService.resolveAccount(accountingProfile, 'salesRevenue', {
            registerId: register.id,
            tillType: register.systemTillType,
          }) || DEFAULT_ACCOUNTS.salesRevenue,
          vatOutput: accountingProfileService.resolveAccount(accountingProfile, 'vatOutput', {
            registerId: register.id,
            tillType: register.systemTillType,
          }) || DEFAULT_ACCOUNTS.vatOutput,
        })),
        {
          registerId: null,
          salesRevenue: accountingProfileService.resolveAccount(accountingProfile, 'salesRevenue')
            || DEFAULT_ACCOUNTS.salesRevenue,
          vatOutput: accountingProfileService.resolveAccount(accountingProfile, 'vatOutput')
            || DEFAULT_ACCOUNTS.vatOutput,
        },
      ];
      const [sourceRows, ledgerRows, clearings, clearingBalances] = await Promise.all([
        client.$queryRawUnsafe(
          `WITH invoice_totals AS (
             SELECT invoice."register_id" AS "registerId", COUNT(*)::int AS "saleCount",
                    COALESCE(SUM(invoice."total_amount"), 0)::numeric AS amount
               FROM "invoices" invoice
               LEFT JOIN "pos_registers" register
                 ON register."id" = invoice."register_id" AND register."company_id" = invoice."company_id"
              WHERE invoice."company_id" = $1 AND invoice."pos_origin" = TRUE
                AND invoice."status" <> 'cancelled'
                AND ($2::timestamptz IS NULL OR invoice."invoice_date" >= $2)
                AND ($3::timestamptz IS NULL OR invoice."invoice_date" <= $3)
                AND ($4::text IS NULL OR invoice."register_id" = $4)
                AND ($5::text IS NULL OR register."system_till_type" = $5)
              GROUP BY invoice."register_id"
           ), credit_totals AS (
             SELECT invoice."register_id" AS "registerId",
                    COALESCE(SUM(note."total_amount"), 0)::numeric AS amount
               FROM "credit_notes" note
               JOIN "invoices" invoice
                 ON invoice."id" = note."invoice_id" AND invoice."company_id" = note."company_id"
               LEFT JOIN "pos_registers" register
                 ON register."id" = invoice."register_id" AND register."company_id" = invoice."company_id"
              WHERE note."company_id" = $1 AND note."pos_origin" = TRUE
                AND note."status" NOT IN ('draft', 'cancelled')
                AND ($2::timestamptz IS NULL OR note."credit_date" >= $2)
                AND ($3::timestamptz IS NULL OR note."credit_date" <= $3)
                AND ($4::text IS NULL OR invoice."register_id" = $4)
                AND ($5::text IS NULL OR register."system_till_type" = $5)
              GROUP BY invoice."register_id"
           ), register_totals AS (
             SELECT "registerId", SUM("saleCount")::int AS "saleCount", SUM(amount) AS "posTotal"
               FROM (
                 SELECT "registerId", "saleCount", amount FROM invoice_totals
                 UNION ALL
                 SELECT "registerId", 0 AS "saleCount", -amount AS amount FROM credit_totals
               ) combined
              GROUP BY "registerId"
           )
           SELECT totals."registerId", register."name" AS "registerName",
                  register."system_till_type" AS "tillType", totals."saleCount",
                  totals."posTotal"
             FROM register_totals totals
             LEFT JOIN "pos_registers" register
               ON register."id" = totals."registerId" AND register."company_id" = $1`,
          companyId, from, to, effectiveRegisterId, tillType,
        ),
        client.$queryRawUnsafe(
          `WITH account_mappings AS (
             SELECT *
                FROM jsonb_to_recordset($6::jsonb)
                AS mapping("registerId" text, "salesRevenue" text, "vatOutput" text)
           ), sales AS (
             SELECT invoice."register_id" AS "registerId",
                     COALESCE(SUM(line."credit" - line."debit"), 0)::numeric AS amount
                FROM "journal_entries" entry
                JOIN "invoices" invoice
                  ON entry."source_type" = 'invoice' AND entry."source_id" = invoice."id"
                 AND entry."company_id" = invoice."company_id" AND invoice."pos_origin" = TRUE
                JOIN account_mappings mapping
                  ON mapping."registerId" IS NOT DISTINCT FROM invoice."register_id"
                JOIN "journal_entry_lines" line
                  ON line."journal_entry_id" = entry."id" AND line."company_id" = entry."company_id"
               LEFT JOIN "pos_registers" register
                 ON register."id" = invoice."register_id" AND register."company_id" = invoice."company_id"
               WHERE entry."company_id" = $1 AND entry."status" = 'posted'
                 AND line."account_code" IN (mapping."salesRevenue", mapping."vatOutput")
                 AND ($2::timestamptz IS NULL OR invoice."invoice_date" >= $2)
                 AND ($3::timestamptz IS NULL OR invoice."invoice_date" <= $3)
                 AND ($4::text IS NULL OR invoice."register_id" = $4)
                 AND ($5::text IS NULL OR register."system_till_type" = $5)
               GROUP BY invoice."register_id"
           ), credits AS (
             SELECT invoice."register_id" AS "registerId",
                     COALESCE(SUM(line."credit" - line."debit"), 0)::numeric AS amount
                FROM "journal_entries" entry
                JOIN "credit_notes" note
                  ON entry."source_type" = 'credit_note' AND entry."source_id" = note."id"
                 AND entry."company_id" = note."company_id" AND note."pos_origin" = TRUE
                JOIN "invoices" invoice
                  ON invoice."id" = note."invoice_id" AND invoice."company_id" = note."company_id"
                JOIN account_mappings mapping
                  ON mapping."registerId" IS NOT DISTINCT FROM invoice."register_id"
                JOIN "journal_entry_lines" line
                  ON line."journal_entry_id" = entry."id" AND line."company_id" = entry."company_id"
               LEFT JOIN "pos_registers" register
                 ON register."id" = invoice."register_id" AND register."company_id" = invoice."company_id"
               WHERE entry."company_id" = $1 AND entry."status" = 'posted'
                 AND line."account_code" IN (mapping."salesRevenue", mapping."vatOutput")
                 AND note."status" NOT IN ('draft', 'cancelled')
                 AND ($2::timestamptz IS NULL OR note."credit_date" >= $2)
                 AND ($3::timestamptz IS NULL OR note."credit_date" <= $3)
                AND ($4::text IS NULL OR invoice."register_id" = $4)
                AND ($5::text IS NULL OR register."system_till_type" = $5)
              GROUP BY invoice."register_id"
           )
           SELECT combined."registerId", SUM(combined.amount) AS "ledgerTotal"
             FROM (
               SELECT "registerId", amount FROM sales
               UNION ALL
               SELECT "registerId", amount FROM credits
             ) combined
            GROUP BY combined."registerId"`,
          companyId, from, to, effectiveRegisterId, tillType, JSON.stringify(accountMappings),
        ),
        getBankDepositClearingBalances(companyId, client),
        getMappedClearingBalances(companyId, client),
      ]);
      const giftCardLiability = await getGiftCardLiability(companyId, client);
      const ledgerByRegister = new Map(ledgerRows.map((row) => [String(row.registerId || ''), number(row.ledgerTotal)]));
      const sourceByRegister = new Map(sourceRows.map((row) => [String(row.registerId || ''), row]));
      const ledgerOnlyIds = [...ledgerByRegister.keys()].filter((id) => !sourceByRegister.has(id));
      const results = [...sourceByRegister.values()].map((row) => {
        const id = String(row.registerId || '');
        const posTotal = number(row.posTotal);
        const ledgerTotal = ledgerByRegister.get(id) || 0;
        const difference = Number((posTotal - ledgerTotal).toFixed(2));
        return {
          registerId: id || null,
          registerName: row.registerName || 'Unassigned',
          tillType: row.tillType || null,
          saleCount: Number(row.saleCount || 0),
          posSalesTotal: posTotal,
          ledgerSalesTotal: ledgerTotal,
          difference,
          isZeroDifference: difference === 0,
          bankDepositClearingBalance: clearings.get(id) || 0,
        };
      });
      for (const id of ledgerOnlyIds) {
        const register = registers.find((item) => String(item.id) === id);
        const ledgerTotal = ledgerByRegister.get(id) || 0;
        results.push({
          registerId: id,
          registerName: register?.name || 'Unknown register',
          tillType: register?.systemTillType || null,
          saleCount: 0,
          posSalesTotal: 0,
          ledgerSalesTotal: ledgerTotal,
          difference: Number((-ledgerTotal).toFixed(2)),
          isZeroDifference: ledgerTotal === 0,
          bankDepositClearingBalance: clearings.get(id) || 0,
        });
      }
      const includedRegisters = new Set(results.map((row) => row.registerId));
      for (const register of registers) {
        if (includedRegisters.has(String(register.id))) continue;
        results.push({
          registerId: String(register.id),
          registerName: register.name,
          tillType: register.systemTillType,
          saleCount: 0,
          posSalesTotal: 0,
          ledgerSalesTotal: 0,
          difference: 0,
          isZeroDifference: true,
          bankDepositClearingBalance: clearings.get(String(register.id)) || 0,
        });
      }
      data = {
        rows: results,
        giftCardLiability,
        clearingBalances,
        totals: results.reduce((totals, row) => ({
          saleCount: totals.saleCount + row.saleCount,
          posSalesTotal: Number((totals.posSalesTotal + row.posSalesTotal).toFixed(2)),
          ledgerSalesTotal: Number((totals.ledgerSalesTotal + row.ledgerSalesTotal).toFixed(2)),
          difference: Number((totals.difference + row.difference).toFixed(2)),
          bankDepositClearingBalance: totals.bankDepositClearingBalance + row.bankDepositClearingBalance,
        }), { saleCount: 0, posSalesTotal: 0, ledgerSalesTotal: 0, difference: 0, bankDepositClearingBalance: 0 }),
      };
      data.totals.isZeroDifference = data.totals.difference === 0;
    } else if (report === 'sales-journal') {
      data = await client.$queryRawUnsafe(
        `SELECT entry."id" AS "journalEntryId", entry."entry_number" AS "entryNumber",
                entry."date", entry."source_type" AS "sourceType", entry."source_id" AS "sourceId",
                entry."description", entry."status", invoice."reference_no" AS "invoiceReference",
                invoice."register_id" AS "registerId", register."name" AS "registerName",
                COALESCE(jsonb_agg(jsonb_build_object(
                  'accountCode', line."account_code", 'accountName', line."account_name",
                  'description', line."description", 'debit', line."debit", 'credit', line."credit"
                ) ORDER BY line."line_order") FILTER (WHERE line."id" IS NOT NULL), '[]'::jsonb) AS lines
           FROM "journal_entries" entry
           JOIN "invoices" invoice
             ON invoice."id" = entry."source_id" AND invoice."company_id" = entry."company_id" AND invoice."pos_origin" = TRUE
           LEFT JOIN "pos_registers" register
             ON register."id" = invoice."register_id" AND register."company_id" = invoice."company_id"
           LEFT JOIN "journal_entry_lines" line
             ON line."journal_entry_id" = entry."id" AND line."company_id" = entry."company_id"
          WHERE entry."company_id" = $1 AND entry."source_type" IN ('invoice', 'invoice_cogs')
            AND ($2::timestamptz IS NULL OR invoice."invoice_date" >= $2)
            AND ($3::timestamptz IS NULL OR invoice."invoice_date" <= $3)
            AND ($4::text IS NULL OR invoice."register_id" = $4)
            AND ($5::text IS NULL OR register."system_till_type" = $5)
          GROUP BY entry."id", invoice."reference_no", invoice."register_id", register."name"
          ORDER BY entry."date" DESC, entry."id" DESC
          LIMIT 500`,
        companyId, from, to, effectiveRegisterId, tillType,
      );
    } else if (report === 'payments-by-method') {
      const paymentRows = await client.posPayment.groupBy({
        by: ['method', 'status'],
        where: {
          companyId,
          ...(tillType ? { registerId: { in: selectedRegisterIds } } : registerId ? { registerId } : {}),
          ...((from || to) ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
        },
        _count: { _all: true },
        _sum: { amount: true },
      });
      data = paymentRows.reduce((result, row) => {
        const method = String(row.method);
        const status = String(row.status);
        const methodRow = result.byMethod[method] || (result.byMethod[method] = { count: 0, amount: 0, statuses: {} });
        const count = Number(row._count?._all || 0);
        const amount = number(row._sum?.amount);
        methodRow.count += count;
        methodRow.amount += amount;
        methodRow.statuses[status] = { count, amount };
        result.totalPayments += count;
        result.totalAmount += amount;
        return result;
      }, { byMethod: {}, totalPayments: 0, totalAmount: 0 });
    } else if (report === 'gift-card-liability') {
      data = await getGiftCardLiability(companyId, client);
    } else if (report === 'cash-over-short') {
      const shifts = await client.$queryRawUnsafe(
        `SELECT shift."id" AS "shiftId", shift."shift_number" AS "shiftNumber",
                shift."register_id" AS "registerId", register."name" AS "registerName",
                shift."closed_at" AS "closedAt", shift."expected_cash" AS "expectedCash",
                shift."counted_cash" AS "countedCash", shift."difference",
                shift."posting_status" AS "postingStatus", shift."journal_entry_id" AS "journalEntryId",
                shift."difference_reason" AS "reason"
           FROM "pos_shifts" shift
           JOIN "pos_registers" register
             ON register."id" = shift."register_id" AND register."company_id" = shift."company_id"
          WHERE shift."company_id" = $1 AND shift."status" = 'closed'
            AND shift."difference" IS NOT NULL
            AND ($2::timestamptz IS NULL OR shift."closed_at" >= $2)
            AND ($3::timestamptz IS NULL OR shift."closed_at" <= $3)
            AND ($4::text IS NULL OR shift."register_id" = $4)
            AND ($5::text IS NULL OR register."system_till_type" = $5)
          ORDER BY shift."closed_at" DESC, shift."id" DESC
          LIMIT 500`,
        companyId, from, to, effectiveRegisterId, tillType,
      );
      data = {
        shifts,
        totals: shifts.reduce((totals, shift) => {
          totals.variance += number(shift.difference);
          totals.posted += shift.postingStatus === 'posted' ? number(shift.difference) : 0;
          return totals;
        }, { variance: 0, posted: 0 }),
      };
    } else {
      data = await client.$queryRawUnsafe(
        `SELECT note."id" AS "creditNoteId", note."reference_no" AS "creditNoteReference",
                note."credit_date" AS "creditDate", note."total_amount" AS "creditTotal",
                note."write_off_reversal_entry_id" AS "journalEntryId",
                note."pos_posting_status" AS "postingStatus",
                invoice."id" AS "invoiceId", invoice."reference_no" AS "invoiceReference",
                invoice."register_id" AS "registerId", register."name" AS "registerName",
                entry."entry_number" AS "entryNumber", entry."status" AS "journalStatus",
                COALESCE(SUM(line."debit"), 0)::numeric AS "lossDebit",
                COALESCE(SUM(line."credit"), 0)::numeric AS "lossCredit"
           FROM "credit_notes" note
           JOIN "invoices" invoice
             ON invoice."id" = note."invoice_id" AND invoice."company_id" = note."company_id"
           LEFT JOIN "pos_registers" register
             ON register."id" = invoice."register_id" AND register."company_id" = invoice."company_id"
           LEFT JOIN "journal_entries" entry
             ON entry."id" = note."write_off_reversal_entry_id" AND entry."company_id" = note."company_id"
           LEFT JOIN "journal_entry_lines" line
             ON line."journal_entry_id" = entry."id" AND line."company_id" = entry."company_id"
          WHERE note."company_id" = $1 AND note."pos_origin" = TRUE
            AND note."write_off_reversal_entry_id" IS NOT NULL
            AND ($2::timestamptz IS NULL OR note."credit_date" >= $2)
            AND ($3::timestamptz IS NULL OR note."credit_date" <= $3)
            AND ($4::text IS NULL OR invoice."register_id" = $4)
            AND ($5::text IS NULL OR register."system_till_type" = $5)
          GROUP BY note."id", invoice."id", invoice."reference_no", invoice."register_id",
                   register."name", entry."entry_number", entry."status"
          ORDER BY note."credit_date" DESC, note."id" DESC
          LIMIT 500`,
        companyId, from, to, effectiveRegisterId, tillType,
      );
    }

    return res.json({
      success: true,
      data,
      registers,
      filters: { report, from, to, registerId, tillType, balancesAreCurrent: report === 'reconciliation' || report === 'gift-card-liability' },
    });
  } catch (error) {
    return next(error);
  }
};
