const { EBMService } = require('../services/ebmService');

function expectConfigError(callback, code) {
  try {
    callback();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected configuration error ${code}`);
}

describe('EBM environment configuration', () => {
  const originalBaseUrl = process.env.VSDC_BASE_URL;
  const originalMode = process.env.EBM_MODE;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalBaseUrl === undefined) delete process.env.VSDC_BASE_URL;
    else process.env.VSDC_BASE_URL = originalBaseUrl;
    if (originalMode === undefined) delete process.env.EBM_MODE;
    else process.env.EBM_MODE = originalMode;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  test('mock mode works without a configured VSDC and is clearly marked as non-fiscal', () => {
    delete process.env.VSDC_BASE_URL;
    const service = new EBMService({ mode: 'mock' });
    expect(service.getConfig()).toMatchObject({
      mode: 'mock',
      isMock: true,
      transportConfigured: true,
      modeLabel: 'Mock (development only)',
    });
  });

  test('production deployment cannot silently fall back to mock mode', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.EBM_MODE;
    expectConfigError(() => new EBMService(), 'EBM_MODE_REQUIRED');
  });

  test.each(['sandbox', 'production'])('%s requires an explicit VSDC URL', (mode) => {
    delete process.env.VSDC_BASE_URL;
    expectConfigError(() => new EBMService({ mode }), 'EBM_VSDC_URL_REQUIRED');
  });

  test.each(['sandbox', 'production'])('%s uses the same configured VSDC transport without code-specific branching', (mode) => {
    delete process.env.VSDC_BASE_URL;
    const service = new EBMService({ mode, vsdcBaseUrl: 'http://127.0.0.1:8080/vsdc' });
    expect(service.getConfig()).toMatchObject({
      mode,
      transportConfigured: true,
      vsdcBaseUrl: 'http://127.0.0.1:8080/vsdc',
    });
  });

  test('rejects URLs containing credentials or non-HTTP protocols', () => {
    expectConfigError(() => new EBMService({ mode: 'sandbox', vsdcBaseUrl: 'ftp://127.0.0.1/vsdc' }), 'EBM_VSDC_URL_INVALID');
    expectConfigError(() => new EBMService({ mode: 'production', vsdcBaseUrl: 'http://user:pass@127.0.0.1/vsdc' }), 'EBM_VSDC_URL_INVALID');
  });

  test('rejects invalid HTTP timeout configuration', () => {
    expectConfigError(() => new EBMService({ mode: 'mock', timeoutMs: 10 }), 'EBM_HTTP_TIMEOUT_INVALID');
    expectConfigError(() => new EBMService({ mode: 'mock', timeoutMs: Number.NaN }), 'EBM_HTTP_TIMEOUT_INVALID');
  });
});
