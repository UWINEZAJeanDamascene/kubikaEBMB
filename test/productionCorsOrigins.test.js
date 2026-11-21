describe('production CORS origins', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  test('excludes loopback origins even when explicitly configured in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.ALLOWED_ORIGINS = 'https://kubika-ebmf.vercel.app,http://localhost:5173,http://127.0.0.1:3000';
    process.env.CORS_ORIGINS = 'https://kubika-ebmf.vercel.app,http://localhost:3000';
    jest.resetModules();
    const config = require('../src/config/environment');
    expect(config.server.allowedOrigins).toEqual(['https://kubika-ebmf.vercel.app']);
    expect(config.server.corsOrigins).toEqual(['https://kubika-ebmf.vercel.app']);
    expect(config.server.corsOrigins).not.toContain('https://kubikapos.up.railway.app');
  });

  test('keeps development loopback origins available', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.ALLOWED_ORIGINS;
    delete process.env.CORS_ORIGINS;
    jest.resetModules();
    const config = require('../src/config/environment');
    expect(config.server.corsOrigins).toContain('http://localhost:5173');
  });

  test('uses the deployed Vercel frontend as the production default', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.FRONTEND_URL;
    delete process.env.ALLOWED_ORIGINS;
    delete process.env.CORS_ORIGINS;
    jest.resetModules();
    const config = require('../src/config/environment');
    expect(config.server.frontendUrl).toBe('https://kubika-ebmf.vercel.app');
    expect(config.server.corsOrigins).toEqual(['https://kubika-ebmf.vercel.app']);
  });

  test('allows the configured frontend origin in production after removing its path', () => {
    process.env.NODE_ENV = 'production';
    process.env.FRONTEND_URL = 'https://app.example.com/workspace';
    delete process.env.ALLOWED_ORIGINS;
    delete process.env.CORS_ORIGINS;
    jest.resetModules();

    const config = require('../src/config/environment');

    expect(config.server.allowedOrigins).toContain('https://app.example.com');
    expect(config.server.corsOrigins).toContain('https://app.example.com');
    expect(config.server.corsOrigins).not.toContain('https://app.example.com/workspace');
  });

  test('does not add a loopback frontend origin to production CORS', () => {
    process.env.NODE_ENV = 'production';
    process.env.FRONTEND_URL = 'http://localhost:5173';
    delete process.env.ALLOWED_ORIGINS;
    delete process.env.CORS_ORIGINS;
    jest.resetModules();

    const config = require('../src/config/environment');

    expect(config.server.corsOrigins).not.toContain('http://localhost:5173');
  });
});
