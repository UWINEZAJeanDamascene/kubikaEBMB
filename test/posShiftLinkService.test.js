const {
  lockOpenPosShiftForRegister,
  lockOpenPosShiftForRegisterCode,
  lockRegisterForZNumber,
  findOpenPosShiftForRegisterCode,
} = require('../services/posShiftLinkService');

describe('POS shift links', () => {
  test('locks only an open shift for the exact tenant and register ID', async () => {
    const client = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: '507f1f77bcf86cd799439099 ' }]),
    };

    await expect(lockOpenPosShiftForRegister(
      client,
      '507f1f77bcf86cd799439011',
      '507f1f77bcf86cd799439012',
    )).resolves.toBe('507f1f77bcf86cd799439099');

    expect(client.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('FOR UPDATE'),
      '507f1f77bcf86cd799439011',
      '507f1f77bcf86cd799439012',
    );
    expect(client.$queryRawUnsafe.mock.calls[0][0]).toContain('"status" IN (\'open\', \'reopened\')');
  });

  test('returns null when the register has no open shift', async () => {
    const client = { $queryRawUnsafe: jest.fn().mockResolvedValue([]) };

    await expect(lockOpenPosShiftForRegister(
      client,
      '507f1f77bcf86cd799439011',
      '507f1f77bcf86cd799439012',
    )).resolves.toBeNull();
  });

  test('locks the tenant register row while allocating a Z number', async () => {
    const client = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: '507f1f77bcf86cd799439099 ' }]),
    };

    await expect(lockRegisterForZNumber(
      client,
      '507f1f77bcf86cd799439011',
      '507f1f77bcf86cd799439012',
    )).resolves.toBe('507f1f77bcf86cd799439099');

    expect(client.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('FOR UPDATE'),
      '507f1f77bcf86cd799439012',
      '507f1f77bcf86cd799439011',
    );
  });

  test('resolves refund shifts through the active register code', async () => {
    const client = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: '507f1f77bcf86cd799439099' }]),
    };

    await expect(lockOpenPosShiftForRegisterCode(
      client,
      '507f1f77bcf86cd799439011',
      'POS-REGISTER-1',
    )).resolves.toBe('507f1f77bcf86cd799439099');

    const [query, companyId, registerCode] = client.$queryRawUnsafe.mock.calls[0];
    expect(query).toContain('"code" = $2');
    expect(query).toContain('"is_active" = TRUE');
    expect(query).toContain('FOR UPDATE OF shift');
    expect([companyId, registerCode]).toEqual(['507f1f77bcf86cd799439011', 'POS-REGISTER-1']);
  });

  test('detects an open shift for legacy till-close protection', async () => {
    const client = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: '507f1f77bcf86cd799439099 ' }]),
    };

    await expect(findOpenPosShiftForRegisterCode(
      client,
      '507f1f77bcf86cd799439011',
      'POS-REGISTER-1',
    )).resolves.toBe('507f1f77bcf86cd799439099');

    const [query, companyId, registerCode] = client.$queryRawUnsafe.mock.calls[0];
    expect(query).toContain('"status" IN (\'open\', \'reopened\')');
    expect(query).not.toContain('FOR UPDATE');
    expect([companyId, registerCode]).toEqual(['507f1f77bcf86cd799439011', 'POS-REGISTER-1']);
  });
});
