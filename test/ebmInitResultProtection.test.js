const {
  ENCRYPTED_MARKER,
  protectInitResult,
  decryptInitResult,
} = require('../utils/ebmInitResultProtection');
const { ebmDeviceToApi } = require('../utils/phase10Mappers');

describe('VSDC initialization response key protection', () => {
  const previousKey = process.env.EBM_INIT_ENCRYPTION_KEY;

  afterEach(() => {
    if (previousKey === undefined) delete process.env.EBM_INIT_ENCRYPTION_KEY;
    else process.env.EBM_INIT_ENCRYPTION_KEY = previousKey;
  });

  it('encrypts returned device keys at rest and can recover them for authorized diagnostics', () => {
    process.env.EBM_INIT_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('hex');
    const response = {
      resultCd: '000',
      data: { info: { intrlKey: 'internal-secret', signKey: 'sign-secret', cmcKey: 'communication-secret', dvcId: 'device-1' } },
    };

    const protectedResponse = protectInitResult(response);
    const serialized = JSON.stringify(protectedResponse);
    expect(serialized).not.toContain('internal-secret');
    expect(serialized).not.toContain('sign-secret');
    expect(serialized).not.toContain('communication-secret');
    expect(protectedResponse.data.info.intrlKey[ENCRYPTED_MARKER]).toBe(true);
    expect(decryptInitResult(protectedResponse)).toEqual(response);
  });

  it('requires a configured key before processing live secret-bearing initialization results', () => {
    delete process.env.EBM_INIT_ENCRYPTION_KEY;
    expect(() => protectInitResult({ data: { info: { signKey: 'secret' } } }))
      .toThrow(expect.objectContaining({ code: 'EBM_INIT_ENCRYPTION_KEY_REQUIRED' }));
  });

  it('does not require encryption for mock responses that contain no key material', () => {
    delete process.env.EBM_INIT_ENCRYPTION_KEY;
    const response = { resultCd: '000', data: { info: { tin: '001234567', lastSaleInvcNo: '3' } } };
    expect(protectInitResult(response)).toBe(response);
  });

  it('does not expose the stored initialization response through the device API mapper', () => {
    const device = ebmDeviceToApi({
      id: 'device-1',
      companyId: 'company-1',
      initResult: { data: { info: { intrlKey: { [ENCRYPTED_MARKER]: true, value: 'ciphertext' } } } },
      sequenceSeedStatus: 'complete',
    });
    expect(device.sequenceSeedStatus).toBe('complete');
    expect(device).not.toHaveProperty('initResult');
  });
});
