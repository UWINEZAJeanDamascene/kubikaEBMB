const bcrypt = require('bcryptjs');

const PIN_LENGTH_MIN = 4;
const PIN_LENGTH_MAX = 6;
const PIN_HASH_ROUNDS = 12;
const PIN_FAILURE_LIMIT = 5;
const PIN_LOCKOUT_DURATION_MS = 5 * 60 * 1000;

function pinError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  return error;
}

function validatePin(pin) {
  if (typeof pin !== 'string' || !new RegExp(`^\\d{${PIN_LENGTH_MIN},${PIN_LENGTH_MAX}}$`).test(pin)) {
    throw pinError('POS_PIN_INVALID', `PIN must contain ${PIN_LENGTH_MIN} to ${PIN_LENGTH_MAX} digits.`);
  }
  if (isWeakPin(pin)) {
    throw pinError('POS_PIN_WEAK', 'Choose a PIN that is not repeated or sequential.');
  }
  return true;
}

function isWeakPin(pin) {
  if (typeof pin !== 'string' || !new RegExp(`^\\d{${PIN_LENGTH_MIN},${PIN_LENGTH_MAX}}$`).test(pin)) {
    return false;
  }
  if (/^(\d)\1+$/.test(pin)) return true;

  const digits = [...pin].map(Number);
  const firstDifference = (digits[1] - digits[0] + 10) % 10;
  return (firstDifference === 1 || firstDifference === 9)
    && digits.every((digit, index) => index === 0 || (digit - digits[index - 1] + 10) % 10 === firstDifference);
}

async function hashPin(pin) {
  validatePin(pin);
  return bcrypt.hash(pin, PIN_HASH_ROUNDS);
}

async function verifyPin(pin, pinHash) {
  if (typeof pin !== 'string' || !new RegExp(`^\\d{${PIN_LENGTH_MIN},${PIN_LENGTH_MAX}}$`).test(pin)) {
    return false;
  }
  if (typeof pinHash !== 'string' || !pinHash) {
    throw new TypeError('A PIN hash is required for verification.');
  }
  return bcrypt.compare(pin, pinHash);
}

function getPinFailureState(failedAttempts, lockedUntil, now = new Date(), options = {}) {
  if (!Number.isInteger(failedAttempts) || failedAttempts < 0 || !(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('PIN failure state requires a non-negative attempt count and valid time.');
  }

  const lockExpiry = lockedUntil == null ? null : new Date(lockedUntil);
  if (lockExpiry && Number.isNaN(lockExpiry.getTime())) {
    throw new TypeError('PIN lock expiry must be a valid date.');
  }
  if (lockExpiry && lockExpiry > now) {
    return { failedAttempts, lockedUntil: lockExpiry, isLocked: true, lockoutCount: Math.max(0, Number(options.lockoutCount) || 0) };
  }

  const attempts = lockExpiry ? 0 : failedAttempts;
  const nextAttempts = attempts + 1;
  const failureLimit = Number.isInteger(options.failureLimit) && options.failureLimit >= 3 && options.failureLimit <= 20
    ? options.failureLimit : PIN_FAILURE_LIMIT;
  const lockoutDurationMs = Number.isInteger(options.lockoutDurationMs) && options.lockoutDurationMs >= 60_000 && options.lockoutDurationMs <= 3_600_000
    ? options.lockoutDurationMs : PIN_LOCKOUT_DURATION_MS;
  const isLocked = nextAttempts >= failureLimit;
  const lockoutCount = isLocked ? Math.max(0, Number(options.lockoutCount) || 0) + 1 : Math.max(0, Number(options.lockoutCount) || 0);
  const progressiveDurationMs = Math.min(60 * 60 * 1000, lockoutDurationMs * (2 ** Math.min(10, Math.max(0, lockoutCount - 1))));
  const nextLockExpiry = isLocked ? new Date(now.getTime() + progressiveDurationMs) : null;

  return {
    failedAttempts: nextAttempts,
    lockedUntil: nextLockExpiry,
    isLocked,
    lockoutCount,
    lockoutDurationMs: isLocked ? progressiveDurationMs : 0,
  };
}

function resetPinFailureState() {
  return { failedAttempts: 0, lockedUntil: null, isLocked: false, lockoutCount: 0 };
}

module.exports = {
  PIN_FAILURE_LIMIT,
  PIN_HASH_ROUNDS,
  PIN_LENGTH_MAX,
  PIN_LENGTH_MIN,
  PIN_LOCKOUT_DURATION_MS,
  getPinFailureState,
  hashPin,
  isWeakPin,
  resetPinFailureState,
  validatePin,
  verifyPin,
};
