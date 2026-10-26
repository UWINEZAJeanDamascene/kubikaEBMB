const MOCK_MODE = 'mock';

function cursorSemanticsConfirmed(mode, confirmationFlag) {
  return mode === MOCK_MODE || process.env[confirmationFlag] === 'true';
}

function assertResultTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{14}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const hour = Number(value.slice(8, 10));
  const minute = Number(value.slice(10, 12));
  const second = Number(value.slice(12, 14));
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
    && date.getUTCHours() === hour
    && date.getUTCMinutes() === minute
    && date.getUTCSeconds() === second;
}

function cursorRegressionError(name) {
  const error = new Error(`${name} returned an invalid or regressing resultDt; records and cursor were not committed.`);
  error.code = 'EBM_LOOKUP_CURSOR_REGRESSION';
  error.statusCode = 502;
  error.retryable = false;
  return error;
}

module.exports = { cursorSemanticsConfirmed, assertResultTimestamp, cursorRegressionError };
