const DEFAULT_POS_SHIFT_SETTINGS = Object.freeze({
  cashAccountability: 'REGISTER',
  denominations: Object.freeze([5000, 2000, 1000, 500, 100, 50]),
  defaultFloat: null,
  varianceTolerance: 500,
  varianceApprovalLimit: 5000,
  cashOutApprovalLimit: 50000,
  drawerWarnAmount: null,
  heldSalesOnClose: 'WARN',
});

const CASH_ACCOUNTABILITY_MODES = new Set(['REGISTER', 'CASHIER']);
const HELD_SALES_POLICIES = new Set(['WARN', 'BLOCK', 'CARRY_OVER']);

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function settingAmount(value, fallback, settingName) {
  if (value === undefined) return fallback;
  if (value === null && fallback === null) return null;
  if (!isNonNegativeInteger(value)) {
    throw new TypeError(`${settingName} must be a non-negative integer.`);
  }
  return value;
}

function normalizeDenominations(value) {
  if (value === undefined) return [...DEFAULT_POS_SHIFT_SETTINGS.denominations];
  if (!Array.isArray(value)
    || value.some((denomination) => !isNonNegativeInteger(denomination) || denomination === 0)
    || new Set(value).size !== value.length
    || value.some((denomination, index) => index > 0 && value[index - 1] <= denomination)) {
    throw new TypeError('denominations must be unique positive integers in descending order.');
  }
  return [...value];
}

function normalizePosShiftSettings(settings = {}) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new TypeError('POS shift settings must be an object.');
  }

  const cashAccountability = settings.posCashAccountability ?? settings.cashAccountability
    ?? DEFAULT_POS_SHIFT_SETTINGS.cashAccountability;
  const heldSalesOnClose = settings.posHeldSalesOnClose ?? settings.heldSalesOnClose
    ?? DEFAULT_POS_SHIFT_SETTINGS.heldSalesOnClose;
  if (!CASH_ACCOUNTABILITY_MODES.has(cashAccountability)) {
    throw new TypeError('cashAccountability must be REGISTER or CASHIER.');
  }
  if (!HELD_SALES_POLICIES.has(heldSalesOnClose)) {
    throw new TypeError('heldSalesOnClose must be WARN, BLOCK, or CARRY_OVER.');
  }

  const denominations = settings.posCashDenominations ?? settings.denominations;
  return {
    cashAccountability,
    denominations: normalizeDenominations(denominations),
    defaultFloat: settingAmount(
      settings.posDefaultFloat ?? settings.defaultFloat,
      DEFAULT_POS_SHIFT_SETTINGS.defaultFloat,
      'defaultFloat',
    ),
    varianceTolerance: settingAmount(
      settings.posVarianceTolerance ?? settings.varianceTolerance,
      DEFAULT_POS_SHIFT_SETTINGS.varianceTolerance,
      'varianceTolerance',
    ),
    varianceApprovalLimit: settingAmount(
      settings.posVarianceApprovalLimit ?? settings.varianceApprovalLimit,
      DEFAULT_POS_SHIFT_SETTINGS.varianceApprovalLimit,
      'varianceApprovalLimit',
    ),
    cashOutApprovalLimit: settingAmount(
      settings.posCashOutApprovalLimit ?? settings.cashOutApprovalLimit,
      DEFAULT_POS_SHIFT_SETTINGS.cashOutApprovalLimit,
      'cashOutApprovalLimit',
    ),
    drawerWarnAmount: settingAmount(
      settings.posDrawerWarnAmount ?? settings.drawerWarnAmount,
      DEFAULT_POS_SHIFT_SETTINGS.drawerWarnAmount,
      'drawerWarnAmount',
    ),
    heldSalesOnClose,
  };
}

function cashAmount(value, name, optional = false) {
  if (value === undefined && optional) return 0;
  if (!isNonNegativeInteger(value)) {
    throw new TypeError(`${name} must be a non-negative integer amount in RWF.`);
  }
  return value;
}

function calculateExpectedCash({
  openingFloat,
  cashSales = 0,
  cashGiftCardIssues = 0,
  cashRefunds = 0,
  cashIn = 0,
  cashOut = 0,
  safeDrops = 0,
} = {}) {
  const expectedCash = cashAmount(openingFloat, 'openingFloat')
    + cashAmount(cashSales, 'cashSales', true)
    + cashAmount(cashGiftCardIssues, 'cashGiftCardIssues', true)
    - cashAmount(cashRefunds, 'cashRefunds', true)
    + cashAmount(cashIn, 'cashIn', true)
    - cashAmount(cashOut, 'cashOut', true)
    - cashAmount(safeDrops, 'safeDrops', true);

  if (!Number.isSafeInteger(expectedCash)) {
    throw new RangeError('Expected cash exceeds the supported integer amount range.');
  }
  if (expectedCash < 0) {
    throw new RangeError('Cash refunds, cash outs, and safe drops cannot exceed available drawer cash.');
  }
  return expectedCash;
}

module.exports = {
  DEFAULT_POS_SHIFT_SETTINGS,
  calculateExpectedCash,
  normalizePosShiftSettings,
};
