const {
  PIN_FAILURE_LIMIT,
  PIN_HASH_ROUNDS,
  PIN_LOCKOUT_DURATION_MS,
  getPinFailureState,
  hashPin,
  isWeakPin,
  resetPinFailureState,
  validatePin,
  verifyPin,
} = require('../services/posPinService');

describe('POS PIN service', () => {
  test.each(['0000', '1111', '1234', '4321', '7890', '987654'])('rejects weak PIN %s', (pin) => {
    expect(isWeakPin(pin)).toBe(true);
    expect(() => validatePin(pin)).toThrow(expect.objectContaining({ code: 'POS_PIN_WEAK' }));
  });

  test.each(['12', '123', '1234567', '12a4', '', null])('rejects invalid PIN %s', (pin) => {
    expect(() => validatePin(pin)).toThrow(expect.objectContaining({ code: 'POS_PIN_INVALID' }));
  });

  test.each(['2580', '4826', '731905'])('accepts a non-sequential PIN %s', (pin) => {
    expect(validatePin(pin)).toBe(true);
    expect(isWeakPin(pin)).toBe(false);
  });

  test('hashes PINs with bcrypt and verifies without exposing the PIN', async () => {
    const pin = '2580';
    const pinHash = await hashPin(pin);

    expect(pinHash).not.toBe(pin);
    expect(pinHash).toMatch(/^\$2[aby]\$/);
    expect(Number(pinHash.split('$')[2])).toBe(PIN_HASH_ROUNDS);
    await expect(verifyPin(pin, pinHash)).resolves.toBe(true);
    await expect(verifyPin('4826', pinHash)).resolves.toBe(false);
    await expect(verifyPin('123', pinHash)).resolves.toBe(false);
  });

  test('locks on the fifth wrong attempt for five minutes', () => {
    const now = new Date('2026-10-29T13:00:00.000Z');
    let state = resetPinFailureState();

    for (let attempt = 1; attempt < PIN_FAILURE_LIMIT; attempt += 1) {
      state = getPinFailureState(state.failedAttempts, state.lockedUntil, now);
      expect(state.failedAttempts).toBe(attempt);
      expect(state.isLocked).toBe(false);
      expect(state.lockedUntil).toBeNull();
    }

    state = getPinFailureState(state.failedAttempts, state.lockedUntil, now);
    expect(state.failedAttempts).toBe(PIN_FAILURE_LIMIT);
    expect(state.isLocked).toBe(true);
    expect(state.lockedUntil.getTime() - now.getTime()).toBe(PIN_LOCKOUT_DURATION_MS);
    expect(state.lockoutCount).toBe(1);
  });

  test('doubles the duration of each consecutive lockout up to one hour', () => {
    const now = new Date('2026-10-29T13:00:00.000Z');
    const first = getPinFailureState(4, null, now, { failureLimit: 5, lockoutDurationMs: 60_000, lockoutCount: 0 });
    const second = getPinFailureState(4, null, now, { failureLimit: 5, lockoutDurationMs: 60_000, lockoutCount: first.lockoutCount });
    const capped = getPinFailureState(4, null, now, { failureLimit: 5, lockoutDurationMs: 3_600_000, lockoutCount: 3 });
    expect(first.lockedUntil.getTime() - now.getTime()).toBe(60_000);
    expect(second.lockedUntil.getTime() - now.getTime()).toBe(120_000);
    expect(capped.lockedUntil.getTime() - now.getTime()).toBe(3_600_000);
  });

  test('keeps an active lockout and resets attempts after it expires', () => {
    const now = new Date('2026-10-29T13:00:00.000Z');
    const lockedUntil = new Date(now.getTime() + PIN_LOCKOUT_DURATION_MS);

    expect(getPinFailureState(PIN_FAILURE_LIMIT, lockedUntil, now)).toEqual({
      failedAttempts: PIN_FAILURE_LIMIT,
      lockedUntil,
      isLocked: true,
      lockoutCount: 0,
    });
    expect(getPinFailureState(PIN_FAILURE_LIMIT, lockedUntil, lockedUntil)).toEqual({
      failedAttempts: 1,
      lockedUntil: null,
      isLocked: false,
      lockoutCount: 0,
      lockoutDurationMs: 0,
    });
  });

  test('resets the failure counter after a successful PIN', () => {
    expect(resetPinFailureState()).toEqual({
      failedAttempts: 0,
      lockedUntil: null,
      isLocked: false,
      lockoutCount: 0,
    });
  });
});
