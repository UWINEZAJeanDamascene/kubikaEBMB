const { Prisma } = require('@prisma/client');
const { dbClient } = require('../lib/prisma');
const Company = require("../models/Company");
const {
  CASH_FLOW_CLASSIFICATION,
  SOURCE_TYPE_LABELS,
  SOURCE_TYPE_OUTFLOW_LABELS,
  DEFAULT_LABEL,
  RECONCILIATION_TOLERANCE,
} = require("../config/cashFlowConfig");

/**
 * Cash Flow Statement Service — IAS 7 Compliant (Direct Method)
 *
 * Three sections per IAS 7 §10:
 *   1. Operating Activities  — core business cash receipts & payments
 *   2. Investing Activities  — acquisition / disposal of long-term assets
 *   3. Financing Activities  — equity & debt transactions
 *
 * Classification:
 *   - Primary  : by sourceType (cashFlowConfig.CASH_FLOW_CLASSIFICATION)
 *   - Fallback : unknown sourceTypes → Operating (most conservative default)
 *
 * Exclusions (IAS 7 §22):
 *   - Internal transfers between own cash accounts (bank_transfer, petty_cash_topup, …)
 *     are NOT cash flows — they move cash between accounts without changing total cash.
 *
 * Grouping:
 *   - Aggregated by sourceType only (not per account code) so the statement shows
 *     one "Salaries paid" line even when salary hits multiple bank accounts.
 *
 * Reconciliation (IAS 7 §45):
 *   Opening Cash + Net Change in Cash = Closing Cash
 */
class CashFlowService {
  // Known cash account codes — fallback when no bank/petty-cash records exist
  static CASH_ACCOUNT_CODES = ["1000", "1050", "1100", "1110", "1200"];

  // Source types to exclude entirely (internal transfers — IAS 7 §22)
  static EXCLUDED_SOURCE_TYPES = CASH_FLOW_CLASSIFICATION.excluded || [
    "bank_transfer",
    "petty_cash_topup",
    "petty_cash_replenishment",
    "petty_cash_opening",
    "opening_balance",
  ];

  // Non-cash source types that should never appear (won't touch cash accounts anyway,
  // but guard against misconfigured charts where they might)
  static NON_CASH_SOURCE_TYPES = ["depreciation", "cogs", "stock_adjustment"];

  /**
   * Human-readable label for a source type, direction-aware.
   *
   * Several JournalService methods reuse the same sourceType for BOTH inflows
   * and outflows (e.g. 'payment' for customer receipts AND supplier payments;
   * 'loan' for drawdowns AND repayments; 'asset' for purchases AND disposal).
   *
   * @param {string} sourceType
   * @param {'in'|'out'} direction - 'in' = DR on cash account, 'out' = CR on cash account
   */
  static _label(sourceType, direction = "in") {
    if (!sourceType) return DEFAULT_LABEL || "Other cash movements";
    // Use direction-specific outflow label when defined and direction is out
    if (
      direction === "out" &&
      SOURCE_TYPE_OUTFLOW_LABELS &&
      SOURCE_TYPE_OUTFLOW_LABELS[sourceType]
    ) {
      return SOURCE_TYPE_OUTFLOW_LABELS[sourceType];
    }
    return SOURCE_TYPE_LABELS[sourceType] || sourceType;
  }

  /**
   * Classify a sourceType into operating / investing / financing / excluded / null.
   * Returns null for non-cash items that somehow slipped through.
   */
  static _classifySourceType(sourceType) {
    const cf = CASH_FLOW_CLASSIFICATION;

    // Excluded (internal transfers)
    if (!sourceType) return "operating"; // unclassified → operating fallback
    if ((cf.excluded || []).includes(sourceType)) return "excluded";
    if (CashFlowService.NON_CASH_SOURCE_TYPES.includes(sourceType))
      return "excluded";

    if ((cf.operating_inflows || []).includes(sourceType)) return "operating";
    if ((cf.operating_outflows || []).includes(sourceType)) return "operating";
    if ((cf.investing_inflows || []).includes(sourceType)) return "investing";
    if ((cf.investing_outflows || []).includes(sourceType)) return "investing";
    if ((cf.financing_inflows || []).includes(sourceType)) return "financing";
    if ((cf.financing_outflows || []).includes(sourceType)) return "financing";

    // Unknown sourceType — default to operating per IAS 7 conservative approach
    return "operating";
  }

  /**
   * Generate Cash Flow Statement report
   */
  static async generate(
    companyId,
    { dateFrom, dateTo, comparativeDateFrom, comparativeDateTo },
  ) {
    if (!companyId) throw new Error("COMPANY_ID_REQUIRED");
    if (!dateFrom || !dateTo) throw new Error("DATE_RANGE_REQUIRED");

    const company = await Company.findById(companyId).lean();

    const [currentPeriod, comparativePeriod] = await Promise.all([
      CashFlowService._buildPeriodData(companyId, dateFrom, dateTo),
      comparativeDateFrom && comparativeDateTo
        ? CashFlowService._buildPeriodData(
            companyId,
            comparativeDateFrom,
            comparativeDateTo,
          )
        : null,
    ]);

    return {
      company_id: companyId,
      company_name: company?.name || "",
      date_from: dateFrom,
      date_to: dateTo,
      comparative_date_from: comparativeDateFrom || null,
      comparative_date_to: comparativeDateTo || null,
      current: currentPeriod,
      comparative: comparativePeriod,
      generated_at: new Date(),
    };
  }

  /**
   * Resolve configured cash accounts and always include register cash.
   * @private
   */
  static async _getCashAccountCodes(companyId) {
    let cashAccountCodes = [];
    try {
      const BankAccount = require("../models/BankAccount");
      const { PettyCashFloat } = require("../models/PettyCash");
      const ChartOfAccount = require("../models/ChartOfAccount");

      const [bankAccts, pettyCash, cashEquivalents] = await Promise.all([
        BankAccount.find({
          company: String(companyId),
          isActive: true,
        }).lean(),
        PettyCashFloat.find({
          company: String(companyId),
          isActive: true,
        }).lean(),
        ChartOfAccount.find({
          company: String(companyId),
          subtype: "cash_equivalent",
          isActive: true,
          allow_direct_posting: true,
        }).lean(),
      ]);

      cashAccountCodes = [
        ...bankAccts.map((account) => account.ledgerAccountId?.toString()).filter(Boolean),
        ...pettyCash.map((account) => account.ledgerAccountId?.toString()).filter(Boolean),
        ...cashEquivalents.map((account) => String(account.code)),
      ];
    } catch {
      // Models unavailable — fall through to defaults
    }

    if (cashAccountCodes.length === 0) {
      cashAccountCodes = CashFlowService.CASH_ACCOUNT_CODES;
    }
    return [...new Set([...cashAccountCodes, "1000"])];
  }

  /**
   * Build one period's cash flow data.
   * @private
   */
  static async _buildPeriodData(companyId, dateFrom, dateTo) {
    // ── Step 1: Resolve cash account codes ──────────────────────────
    const cashAccountCodes = await CashFlowService._getCashAccountCodes(companyId);

    // ── Step 2: Aggregate cash movements grouped by sourceType ───────
    // Exclude internal transfers at database level for efficiency.
    // Group by sourceType only (not accountCode) so duplicate bank-account
    // postings for the same transaction collapse into one line item.
    const allExcluded = [
      ...CashFlowService.EXCLUDED_SOURCE_TYPES,
      ...CashFlowService.NON_CASH_SOURCE_TYPES,
    ];

    const rawMovements = await dbClient().$queryRaw(Prisma.sql`
      SELECT je.source_type AS "sourceType",
             COALESCE(SUM(jel.debit), 0) AS total_dr,
             COALESCE(SUM(jel.credit), 0) AS total_cr,
             COUNT(*)::int AS entry_count
      FROM journal_entry_lines jel
      JOIN journal_entries je ON je.id = jel.journal_entry_id
      WHERE je.company_id = ${String(companyId)}
        AND je.status = 'posted'
        AND je.reversed = false
        AND je.date >= ${new Date(dateFrom)}
        AND je.date <= ${new Date(dateTo)}
        AND jel.account_code IN (${Prisma.join(cashAccountCodes)})
        AND (je.source_type IS NULL OR je.source_type NOT IN (${Prisma.join(allExcluded)}))
      GROUP BY je.source_type
    `);

    // ── Step 3: Classify into sections ──────────────────────────────
    const sections = {
      operating: { inflows: [], outflows: [] },
      investing: { inflows: [], outflows: [] },
      financing: { inflows: [], outflows: [] },
    };

    const round = (n) => Math.round(n * 100) / 100;
    // Tolerance for treating a value as zero (floating-point rounding)
    const ZERO_TOLERANCE = 0.005;

    for (const row of rawMovements) {
      const sourceType = row.sourceType;

      const section = CashFlowService._classifySourceType(sourceType);
      if (section === "excluded") continue; // internal / non-cash — skip

      const totalDR = round(parseFloat(row.total_dr?.toString() || "0"));
      const totalCR = round(parseFloat(row.total_cr?.toString() || "0"));

      // ── Split into SEPARATE inflow and outflow items ─────────────────
      //
      // Key design: DR and CR are treated independently rather than netting.
      // This is essential because some sourceTypes are shared for both directions:
      //   'payment'  → customer receipt (DR cash) AND supplier payment (CR cash)
      //   'asset'    → disposal proceeds (DR cash) AND asset purchase (CR cash)
      //   'loan'     → drawdown received (DR cash) AND repayment made (CR cash)
      //   'credit_note' → settlement received (DR) AND customer refund paid (CR)
      //
      // Netting these would hide both sides under one number and produce wrong labels.

      // Inflow: DR on cash accounts = money received
      if (totalDR > ZERO_TOLERANCE) {
        sections[section].inflows.push({
          source_type: sourceType || "unclassified",
          label: CashFlowService._label(sourceType, "in"),
          cash_in: totalDR,
          cash_out: 0,
          net: totalDR,
          entry_count: row.entry_count || 0,
        });
      }

      // Outflow: CR on cash accounts = money paid out
      if (totalCR > ZERO_TOLERANCE) {
        sections[section].outflows.push({
          source_type: sourceType || "unclassified",
          label: CashFlowService._label(sourceType, "out"),
          cash_in: 0,
          cash_out: totalCR,
          net: -totalCR,
          entry_count: row.entry_count || 0,
        });
      }
    }

    // ── Step 4: Sort by magnitude (largest first within each bucket) ─
    const sortByMag = (a, b) => Math.abs(b.net) - Math.abs(a.net);
    for (const sec of Object.values(sections)) {
      sec.inflows.sort(sortByMag);
      sec.outflows.sort(sortByMag);
    }

    // ── Step 5: Compute section totals ──────────────────────────────
    const netOfSection = (sec) =>
      round(
        sec.inflows.reduce((s, e) => s + e.net, 0) +
          sec.outflows.reduce((s, e) => s + e.net, 0),
      );

    const operatingTotal = netOfSection(sections.operating);
    const investingTotal = netOfSection(sections.investing);
    const financingTotal = netOfSection(sections.financing);
    const netCashChange = round(
      operatingTotal + investingTotal + financingTotal,
    );

    // ── Step 6: Opening & closing cash balances ──────────────────────
    // Opening = cumulative journal DR − CR on cash accounts up to the day before period start
    const openingCashBalance = await CashFlowService._getTotalCashBalance(
      companyId,
      cashAccountCodes,
      new Date("1900-01-01"),
      new Date(new Date(dateFrom).getTime() - 1), // exclusive: one ms before period start
    );

    // Closing = cumulative journal DR − CR on cash accounts up to period end
    const closingCashBalance = await CashFlowService._getTotalCashBalance(
      companyId,
      cashAccountCodes,
      new Date("1900-01-01"),
      new Date(dateTo),
    );

    // ── Step 7: Reconciliation check (IAS 7 §45) ────────────────────
    const computedClosing = round(openingCashBalance + netCashChange);
    const reconciliationDiff = round(
      Math.abs(closingCashBalance - computedClosing),
    );
    const isReconciled = reconciliationDiff < RECONCILIATION_TOLERANCE;

    // ── Step 8: Build section totals for inflows/outflows display ───
    const totalIn = (lines) => round(lines.reduce((s, e) => s + e.cash_in, 0));
    const totalOut = (lines) =>
      round(lines.reduce((s, e) => s + Math.abs(e.cash_out), 0));

    return {
      opening_cash_balance: round(openingCashBalance),

      operating: {
        inflows: sections.operating.inflows,
        outflows: sections.operating.outflows,
        total_inflows: totalIn(sections.operating.inflows),
        total_outflows: totalOut(sections.operating.outflows),
        net_cash_from_operating: operatingTotal,
      },

      investing: {
        inflows: sections.investing.inflows,
        outflows: sections.investing.outflows,
        total_inflows: totalIn(sections.investing.inflows),
        total_outflows: totalOut(sections.investing.outflows),
        net_cash_from_investing: investingTotal,
      },

      financing: {
        inflows: sections.financing.inflows,
        outflows: sections.financing.outflows,
        total_inflows: totalIn(sections.financing.inflows),
        total_outflows: totalOut(sections.financing.outflows),
        net_cash_from_financing: financingTotal,
      },

      net_change_in_cash: netCashChange,
      closing_cash_balance: round(closingCashBalance),
      computed_closing_balance: computedClosing,
      is_reconciled: isReconciled,
      reconciliation_diff: reconciliationDiff,
    };
  }

  /**
   * Get total cash balance (DR − CR) across cash accounts for a date range.
   * Cash accounts are asset accounts with debit normal balance.
   * @private
   */
  static async _getTotalCashBalance(
    companyId,
    cashAccountCodes,
    dateFrom,
    dateTo,
  ) {
    if (!cashAccountCodes.length) return 0;

    const result = await dbClient().$queryRaw(Prisma.sql`
      SELECT COALESCE(SUM(jel.debit), 0) AS total_dr,
             COALESCE(SUM(jel.credit), 0) AS total_cr
      FROM journal_entry_lines jel
      JOIN journal_entries je ON je.id = jel.journal_entry_id
      WHERE je.company_id = ${String(companyId)}
        AND je.status = 'posted'
        AND je.reversed = false
        AND je.date >= ${dateFrom}
        AND je.date <= ${dateTo}
        AND jel.account_code IN (${Prisma.join(cashAccountCodes)})
    `);

    // Asset account: balance = DR − CR (debit-normal)
    const dr = parseFloat(result[0]?.total_dr?.toString() || "0");
    const cr = parseFloat(result[0]?.total_cr?.toString() || "0");
    return Math.round((dr - cr) * 100) / 100;
  }
}

module.exports = CashFlowService;
