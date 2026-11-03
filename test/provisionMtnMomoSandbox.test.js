'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  isValidCallbackHost,
  provisionMtnMomoSandbox,
} = require('../scripts/provisionMtnMomoSandbox');

const API_USER = '6ba7b810-9dad-4d80-8000-00aabbcc0001';
const RETRY_API_USER = '6ba7b810-9dad-4d80-8000-00aabbcc0002';
const API_KEY = 'sandbox-api-key-never-log';
const ACCESS_TOKEN = 'sandbox-token-never-log';

describe('MTN MoMo sandbox provisioning script', () => {
  let directory;
  let envPath;
  let originalEnv;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-provision-test-'));
    envPath = path.join(directory, '.env.local');
    originalEnv = [
      'MOMO_SANDBOX_SUBSCRIPTION_KEY=sandbox-primary-subscription',
      'MOMO_SANDBOX_SUBSCRIPTION_KEY_SECONDARY=sandbox-secondary-subscription',
      'MOMO_CALLBACK_HOST=dev-tunnel.kubika.dev',
      '',
    ].join('\n');
    fs.writeFileSync(envPath, originalEnv);
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function successfulAxiosClient() {
    return {
      post: jest.fn(async (url) => {
        if (url.endsWith('/v1_0/apiuser')) return { status: 201, data: undefined };
        if (url.endsWith('/apikey')) return { status: 201, data: { apiKey: API_KEY } };
        if (url.endsWith('/collection/token/')) {
          return {
            status: 200,
            data: { access_token: ACCESS_TOKEN, expires_in: 3600 },
          };
        }
        throw new Error('Unexpected mocked endpoint');
      }),
    };
  }

  function provisionOptions(overrides = {}) {
    return {
      envPath,
      gitRoot: directory,
      axiosClient: successfulAxiosClient(),
      uuidFactory: jest.fn()
        .mockReturnValueOnce(API_USER)
        .mockReturnValueOnce(RETRY_API_USER),
      sleep: jest.fn().mockResolvedValue(undefined),
      output: jest.fn(),
      ignoreCheck: jest.fn(),
      ...overrides,
    };
  }

  test('validates callback hosts as bare public domain names', () => {
    expect(isValidCallbackHost('dev-tunnel.kubika.dev')).toBe(true);
    for (const host of [
      '',
      'https://dev-tunnel.example.net',
      'dev-tunnel.example.net/path',
      'dev-tunnel.example.net:3000',
      'localhost',
      'api.localhost',
      '127.0.0.1',
      '::1',
      '<put your host here>',
      'example.com',
    ]) {
      expect(isValidCallbackHost(host)).toBe(false);
    }
  });

  test('provisions and validates credentials, then writes only the generated values', async () => {
    const options = provisionOptions();
    const result = await provisionMtnMomoSandbox(options);
    const written = fs.readFileSync(envPath, 'utf8');

    expect(options.axiosClient.post).toHaveBeenNthCalledWith(
      1,
      'https://sandbox.momodeveloper.mtn.co.rw/v1_0/apiuser',
      { providerCallbackHost: 'dev-tunnel.kubika.dev' },
      expect.objectContaining({
        headers: {
          'Ocp-Apim-Subscription-Key': 'sandbox-primary-subscription',
          'X-Reference-Id': API_USER,
        },
      }),
    );
    expect(options.axiosClient.post).toHaveBeenNthCalledWith(
      2,
      `https://sandbox.momodeveloper.mtn.co.rw/v1_0/apiuser/${API_USER}/apikey`,
      null,
      expect.objectContaining({
        headers: { 'Ocp-Apim-Subscription-Key': 'sandbox-primary-subscription' },
      }),
    );
    expect(options.axiosClient.post.mock.calls[2][0])
      .toBe('https://sandbox.momodeveloper.mtn.co.rw/collection/token/');
    expect(options.axiosClient.post.mock.calls[2][2].headers).toMatchObject({
      'Ocp-Apim-Subscription-Key': 'sandbox-primary-subscription',
      'X-Target-Environment': 'sandbox',
    });
    expect(result).toEqual({
      skipped: false,
      createUserStatus: 201,
      createApiKeyStatus: 201,
      tokenStatus: 200,
      expiresIn: 3600,
      secondaryUsed: false,
    });
    expect(written).toContain(`MOMO_SANDBOX_API_USER="${API_USER}"`);
    expect(written).toContain(`MOMO_SANDBOX_API_KEY="${API_KEY}"`);
    expect(written).toContain('MOMO_SANDBOX_SUBSCRIPTION_KEY=sandbox-primary-subscription');
    expect(JSON.stringify(options.output.mock.calls)).not.toContain(API_KEY);
    expect(JSON.stringify(options.output.mock.calls)).not.toContain(API_USER);
    expect(JSON.stringify(options.output.mock.calls)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(result)).not.toContain(API_KEY);
    expect(JSON.stringify(result)).not.toContain(API_USER);
    expect(JSON.stringify(result)).not.toContain(ACCESS_TOKEN);
    expect(options.ignoreCheck).toHaveBeenCalledTimes(2);
  });

  test('does nothing when both credentials exist unless regenerate is set', async () => {
    fs.appendFileSync(
      envPath,
      `MOMO_SANDBOX_API_USER="${API_USER}"\nMOMO_SANDBOX_API_KEY="${API_KEY}"\n`,
    );
    const options = provisionOptions();

    await expect(provisionMtnMomoSandbox(options)).resolves.toEqual({ skipped: true });
    expect(options.axiosClient.post).not.toHaveBeenCalled();
    expect(options.ignoreCheck).not.toHaveBeenCalled();
  });

  test.each([
    ['network failure', Object.assign(new Error('private network detail'), { code: 'ECONNRESET' })],
    ['HTTP 500', { response: { status: 500 } }],
  ])('retries a %s with a fresh UUID', async (_label, failure) => {
    const axiosClient = successfulAxiosClient();
    axiosClient.post
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ status: 201 })
      .mockResolvedValueOnce({ status: 201, data: { apiKey: API_KEY } })
      .mockResolvedValueOnce({
        status: 200,
        data: { access_token: ACCESS_TOKEN, expires_in: 2400 },
      });
    const uuidFactory = jest.fn()
      .mockReturnValueOnce(API_USER)
      .mockReturnValueOnce(RETRY_API_USER);
    const options = provisionOptions({ axiosClient, uuidFactory });

    await expect(provisionMtnMomoSandbox(options)).resolves.toMatchObject({
      createUserStatus: 201,
      createApiKeyStatus: 201,
      tokenStatus: 200,
      expiresIn: 2400,
    });
    expect(axiosClient.post.mock.calls[0][2].headers['X-Reference-Id']).toBe(API_USER);
    expect(axiosClient.post.mock.calls[1][2].headers['X-Reference-Id']).toBe(RETRY_API_USER);
    expect(uuidFactory).toHaveBeenCalledTimes(2);
  });

  test('supports the old subscription variable names only as a temporary fallback', async () => {
    fs.writeFileSync(envPath, originalEnv
      .replace('MOMO_SANDBOX_SUBSCRIPTION_KEY=', 'Primary_key=')
      .replace('MOMO_SANDBOX_SUBSCRIPTION_KEY_SECONDARY=', 'Secondary_key='));
    const options = provisionOptions();

    await provisionMtnMomoSandbox(options);
    expect(options.axiosClient.post.mock.calls[0][2].headers['Ocp-Apim-Subscription-Key'])
      .toBe('sandbox-primary-subscription');
  });

  test('uses the secondary subscription key only after primary authorization failure', async () => {
    const axiosClient = successfulAxiosClient();
    axiosClient.post
      .mockRejectedValueOnce({ response: { status: 403 } })
      .mockResolvedValueOnce({ status: 201 })
      .mockResolvedValueOnce({ status: 201, data: { apiKey: API_KEY } })
      .mockResolvedValueOnce({
        status: 200,
        data: { access_token: ACCESS_TOKEN, expires_in: 3600 },
      });
    const options = provisionOptions({ axiosClient });

    await expect(provisionMtnMomoSandbox(options)).resolves.toMatchObject({
      secondaryUsed: true,
    });
    expect(axiosClient.post.mock.calls[0][2].headers['Ocp-Apim-Subscription-Key'])
      .toBe('sandbox-primary-subscription');
    expect(axiosClient.post.mock.calls[1][2].headers['Ocp-Apim-Subscription-Key'])
      .toBe('sandbox-secondary-subscription');
    expect(options.output).toHaveBeenCalledWith('secondary subscription key used');
    expect(JSON.stringify(options.output.mock.calls)).not.toContain('sandbox-secondary-subscription');
  });

  test('does not write partial credentials when token validation fails after retries', async () => {
    const axiosClient = successfulAxiosClient();
    axiosClient.post
      .mockResolvedValueOnce({ status: 201 })
      .mockResolvedValueOnce({ status: 201, data: { apiKey: API_KEY } })
      .mockRejectedValue({ response: { status: 500 } });
    const options = provisionOptions({ axiosClient });

    await expect(provisionMtnMomoSandbox({ ...options, regenerate: true })).rejects.toMatchObject({
      code: 'TOKEN_VALIDATION_FAILED',
      message: expect.stringContaining('--regenerate'),
    });
    expect(axiosClient.post).toHaveBeenCalledTimes(5);
    expect(fs.readFileSync(envPath, 'utf8')).toBe(originalEnv);
    expect(options.sleep).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(options.output.mock.calls)).not.toContain(API_KEY);
    expect(JSON.stringify(options.output.mock.calls)).not.toContain(ACCESS_TOKEN);
  });

  test('reports token authorization failure as a likely portal mismatch without writing credentials', async () => {
    const axiosClient = successfulAxiosClient();
    axiosClient.post
      .mockResolvedValueOnce({ status: 201 })
      .mockResolvedValueOnce({ status: 201, data: { apiKey: API_KEY } })
      .mockRejectedValue({ response: { status: 401 } });
    const options = provisionOptions({ axiosClient });

    await expect(provisionMtnMomoSandbox(options)).rejects.toMatchObject({
      code: 'TOKEN_VALIDATION_AUTH_REJECTED',
      message: expect.stringContaining('likely a subscription-key/portal mismatch'),
    });
    expect(axiosClient.post).toHaveBeenCalledTimes(6);
    expect(fs.readFileSync(envPath, 'utf8')).toBe(originalEnv);
    expect(JSON.stringify(options.output.mock.calls)).not.toContain(API_KEY);
    expect(JSON.stringify(options.output.mock.calls)).not.toContain(ACCESS_TOKEN);
  });

  test('fails before any HTTP call when callback host is missing or unsafe', async () => {
    fs.writeFileSync(envPath, originalEnv.replace('dev-tunnel.kubika.dev', 'localhost'));
    const options = provisionOptions();

    await expect(provisionMtnMomoSandbox(options)).rejects.toMatchObject({
      code: 'CALLBACK_HOST_INVALID',
    });
    expect(options.axiosClient.post).not.toHaveBeenCalled();
  });

  test('reports a likely portal mismatch for authorization rejection without exposing values', async () => {
    const axiosClient = {
      post: jest.fn().mockRejectedValue({ response: { status: 401 } }),
    };
    const options = provisionOptions({ axiosClient });

    await expect(provisionMtnMomoSandbox(options)).rejects.toMatchObject({
      code: 'SANDBOX_AUTH_REJECTED',
      message: expect.stringContaining('likely a subscription-key/portal mismatch'),
    });
    expect(JSON.stringify(options.output.mock.calls)).not.toContain('sandbox-primary-subscription');
  });
});
