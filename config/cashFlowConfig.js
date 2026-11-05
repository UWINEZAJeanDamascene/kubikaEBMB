/**
 * Cash Flow Classification Configuration
 *
 * Maps sourceType from journal entries to IAS 7 cash flow statement sections.
 * Drives CashFlowService classification logic.
 *
 * IAS 7 — Statement of Cash Flows
 *   §10  Three sections: Operating, Investing, Financing
 *   §31  Interest paid: Operating or Financing (policy choice — Financing here)
 *   §33  Dividends paid: Operating or Financing (policy choice — Financing here)
 *   §22  Internal transfers between cash accounts: EXCLUDED (not cash flows)
 */

module.exports = {
  /**
   * Classification mapping by sourceType.
   * Used by CashFlowService to categorize cash movements.
   *
   * EXCLUDED entries are internal transfers (bank-to-bank, bank-to-petty-cash)
   * that move cash between the entity's own accounts without changing total cash.
   * They must NOT appear in the statement — IAS 7 §22.
   */
  CASH_FLOW_CLASSIFICATION: {
    // ── EXCLUDED ────────────────────────────────────────────────────────
    // Internal transfers: zero net effect on total cash; omit from statement
    excluded: [
      "bank_transfer", // DR Bank B / CR Bank A — same entity, net 0
      "petty_cash_topup", // DR Petty Cash / CR Bank — internal movement
      "petty_cash_replenishment", // DR Petty Cash / CR Bank/Cash — internal
      "petty_cash_opening", // opening petty cash fund — internal
      "petty_cash", // legacy petty cash float opening — internal
      "opening_balance", // balance-sheet opening entries (not period flows)
      "pos_bank_deposit", // cash transfer from till to cash in transit
    ],

    // ── OPERATING ────────────────────────────────────────────────────────
    // Cash flows from principal revenue-producing activities (IAS 7 §14)

    operating_inflows: [
      "ar_receipt", // customer payments received (AR module)
      "payment", // invoice payment received (direct)
      "invoice", // invoice-linked cash receipt
      "sale", // direct sale cash receipt
      "purchase_return", // refund from supplier (return of goods)
      "purchase_return_refund", // explicit refund entry from purchase return
      "credit_note", // credit note cash settlement from customer
    ],

    operating_outflows: [
      "ap_payment", // supplier payments (AP module)
      "purchase", // direct purchase payment
      "expense", // operating expense payment
      "accrued_expense", // accrued expenses paid
      "accrual", // accrual payments
      "petty_cash_expense", // petty cash expenses paid
      "bank_charge", // bank service charges (finance cost, operating per policy)
      "payroll", // legacy payroll journal entry
      "payroll_run", // payroll run net salaries
      "payroll_salary", // individual salary payment
      "payroll_tax", // payroll-related tax (PAYE employer side)
      "payroll_employer", // employer statutory contributions (RSSB etc.)
      "tax_settlement", // corporate / withholding tax paid to authority
      "tax_payment", // generic tax payment
      "vat_settlement", // VAT paid to tax authority (net VAT)
      "paye_settlement", // PAYE remitted to authority
      "rssb_settlement", // RSSB contributions remitted
      "bank_deposit", // manual cash deposit (classified operating by default)
      "bank_withdrawal", // manual cash withdrawal (classified operating by default)
    ],

    // ── INVESTING ────────────────────────────────────────────────────────
    // Cash flows from acquisition and disposal of long-term assets (IAS 7 §16)

    investing_inflows: [
      "asset_disposal", // proceeds from disposal of PP&E
      "asset_disposal_proceeds", // alias
    ],

    investing_outflows: [
      "asset", // asset acquisition (generic)
      "asset_purchase", // explicit PP&E purchase
      "depreciation", // placeholder (non-cash; filtered before reaching here)
    ],

    // ── FINANCING ────────────────────────────────────────────────────────
    // Cash flows that change the size of equity and borrowings (IAS 7 §17)
    // Policy: Interest paid → Financing (IAS 7 §33 allows either; Financing preferred)
    // Policy: Dividends paid → Financing (IAS 7 §34 allows either; Financing preferred)

    financing_inflows: [
      "loan", // proceeds from new borrowings
      "liability_drawdown", // loan drawdown (AP/loan module)
      "capital_injection", // equity contributed by owners
      "share_capital", // share capital raised
    ],

    financing_outflows: [
      "liability_repayment", // principal repayment of borrowings
      "loan_repayment", // loan repayment alias
      "loan_payment", // loan payment alias
      "liability_interest", // interest paid on borrowings (IAS 7 §33 — Financing)
      "dividend", // dividends paid to shareholders (IAS 7 §34 — Financing)
      "owner_drawing", // owner drawings
    ],
  },

  /**
   * Direction-aware labels for sourceTypes that are SHARED between inflows and outflows.
   *
   * Problem: several JournalService methods reuse the same sourceType for opposite
   * cash directions (e.g. 'payment' is used for both customer receipts and supplier
   * payments; 'loan' for both drawdowns and repayments; 'asset' for both purchases
   * and disposal proceeds).
   *
   * When the cash flow service splits each aggregated row into separate DR (inflow)
   * and CR (outflow) line items, it uses SOURCE_TYPE_LABELS for inflows and
   * SOURCE_TYPE_OUTFLOW_LABELS for outflows, so each side gets the correct label.
   *
   * If a sourceType is NOT listed here, SOURCE_TYPE_LABELS is used for both directions.
   */
  SOURCE_TYPE_OUTFLOW_LABELS: {
    // 'payment' used for both customer receipts (inflow) and supplier payments (outflow)
    payment: "Payments to suppliers",
    // 'asset' used for both asset purchase (outflow) and disposal proceeds (inflow)
    asset: "Purchase of property, plant & equipment",
    // 'loan' used for both drawdown (inflow) and repayment (outflow)
    loan: "Repayment of borrowings",
    // 'credit_note' can be a refund paid out in cash (outflow) or settlement received (inflow)
    credit_note: "Customer refunds paid",
    // 'purchase_return' refund direction: normally inflow, but cover outflow edge case
    purchase_return: "Purchase return cash settlement paid",
  },

  /**
   * Human-readable labels for each sourceType.
   * Used in the Cash Flow Statement line items.
   * Keys map to journal entry sourceType values.
   */
  SOURCE_TYPE_LABELS: {
    // ── Operating Inflows ─────────────────────────────────────────────
    ar_receipt: "Receipts from customers",
    payment: "Receipts from customers",
    invoice: "Receipts from customers",
    sale: "Cash sales receipts",
    purchase_return: "Refunds received from suppliers",
    purchase_return_refund: "Refunds received from suppliers",
    credit_note: "Credit note settlements received",

    // ── Operating Outflows ────────────────────────────────────────────
    ap_payment: "Payments to suppliers",
    purchase: "Payments to suppliers",
    expense: "Operating expenses paid",
    petty_cash_expense: "Petty cash expenses paid",
    bank_charge: "Bank charges paid",
    payroll_run: "Salaries and wages paid",
    payroll_salary: "Salaries and wages paid",
    payroll_tax: "Payroll tax paid",
    payroll_employer: "Employer statutory contributions paid",
    tax_settlement: "Income and withholding taxes paid",
    tax_payment: "Taxes paid",
    vat_settlement: "VAT paid to tax authority",
    paye_settlement: "PAYE remitted to tax authority",
    rssb_settlement: "RSSB contributions remitted",
    bank_deposit: "Cash deposits (operating)",
    bank_withdrawal: "Cash withdrawals (operating)",

    // ── Investing ─────────────────────────────────────────────────────
    asset_disposal: "Proceeds from disposal of assets",
    asset_disposal_proceeds: "Proceeds from disposal of assets",
    asset: "Purchase of property, plant & equipment",
    asset_purchase: "Purchase of property, plant & equipment",

    // ── Financing ─────────────────────────────────────────────────────
    loan: "Proceeds from borrowings",
    liability_drawdown: "Proceeds from borrowings",
    capital_injection: "Capital contributions from owners",
    share_capital: "Proceeds from share issuance",
    liability_repayment: "Repayment of borrowings",
    liability_interest: "Interest paid on borrowings",
    dividend: "Dividends paid to shareholders",
    owner_drawing: "Owner drawings",

    // ── Excluded (internal — never shown in statement) ────────────────
    bank_transfer: "[Internal transfer — excluded]",
    petty_cash_topup: "[Internal transfer — excluded]",
    petty_cash_replenishment: "[Internal transfer — excluded]",
    petty_cash_opening: "[Internal transfer — excluded]",
    opening_balance: "[Opening entry — excluded]",

    // ── Non-cash (filtered by cash-account query, but listed for reference) ──
    depreciation: "[Non-cash — excluded]",
    cogs: "[Non-cash — excluded]",
    stock_adjustment: "[Non-cash — excluded]",
  },

  /**
   * Default label for any sourceType not in SOURCE_TYPE_LABELS.
   * Displayed in the statement when a new/unrecognised source type is encountered.
   */
  DEFAULT_LABEL: "Other cash movements",

  /**
   * Section display names for reports
   */
  SECTION_NAMES: {
    operating: "Operating Activities",
    investing: "Investing Activities",
    financing: "Financing Activities",
  },

  /**
   * Cash flow presentation method per IAS 7 §18.
   * 'direct'   — shows actual cash inflows and outflows per category.
   * 'indirect' — starts from net profit and adjusts for non-cash items.
   * This system uses the Direct Method.
   */
  CALCULATION_METHOD: "direct",

  /**
   * Policy disclosures per IAS 7 §31–34
   */
  POLICY: {
    interest_paid: "financing", // IAS 7 §33 — classified under Financing Activities
    interest_received: "operating", // IAS 7 §33 — classified under Operating Activities
    dividends_paid: "financing", // IAS 7 §34 — classified under Financing Activities
    dividends_received: "operating", // IAS 7 §34 — classified under Operating Activities
  },

  /**
   * Whether to verify Opening + NetChange = Closing (IAS 7 §45)
   */
  VERIFY_RECONCILIATION: true,

  /**
   * Tolerance for reconciliation difference (rounding — currency units)
   */
  RECONCILIATION_TOLERANCE: 0.01,
};
