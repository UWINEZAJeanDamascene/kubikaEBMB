const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_AGE_DAYS = 90;
const MAX_PASSWORD_AGE_MS = MAX_PASSWORD_AGE_DAYS * 24 * 60 * 60 * 1000;

const PASSWORD_POLICY = Object.freeze({
  minLength: MIN_PASSWORD_LENGTH,
  requireUppercase: true,
  requireLowercase: true,
  requireNumber: true,
  requireSpecial: false,
  maxAgeDays: MAX_PASSWORD_AGE_DAYS,
});

function getPasswordPolicyError(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return { code: 'PASSWORD_TOO_SHORT', message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
    return { code: 'PASSWORD_POLICY_VIOLATION', message: 'Password must include at least one uppercase letter, one lowercase letter, and one number' };
  }
  return null;
}

function isPasswordExpired(user, now = Date.now()) {
  if (!user) return false;
  const changedAt = user.passwordChangedAt || user.createdAt;
  if (!changedAt) return true;
  const timestamp = new Date(changedAt).getTime();
  return !Number.isFinite(timestamp) || now - timestamp >= MAX_PASSWORD_AGE_MS;
}

function passwordChangeRequired(user, now) {
  return Boolean(user?.mustChangePassword || isPasswordExpired(user, now));
}

module.exports = {
  PASSWORD_POLICY,
  MAX_PASSWORD_AGE_DAYS,
  getPasswordPolicyError,
  isPasswordExpired,
  passwordChangeRequired,
};
