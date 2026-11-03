'use strict';

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { execFileSync } = require('child_process');
const axios = require('axios');
const dotenv = require('dotenv');
const { MTN_MOMO_SANDBOX } = require('../services/posPaymentProviders/mtnMomoConfig');

const MAX_PROVISION_RETRIES = 3;
const TOKEN_VALIDATION_ATTEMPTS = 3;
const TOKEN_RETRY_DELAY_MS = 500;
const NETWORK_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'ENETUNREACH',
  'ENOTFOUND',
  'ERR_NETWORK',
  'ETIMEDOUT',
]);

function safeError(code, message) {
  return Object.assign(new Error(message), { code });
}

function responseStatus(error) {
  return error?.response?.status;
}

function isRetryableProvisionError(error) {
  return responseStatus(error) === 500 || NETWORK_ERROR_CODES.has(error?.code);
}

function isAuthorizationError(error) {
  return [401, 403].includes(responseStatus(error));
}

function readSubscriptionKey(env, currentName, legacyName) {
  return String(env[currentName] || env[legacyName] || '').trim();
}

function isValidCallbackHost(value) {
  if (typeof value !== 'string' || !value || value !== value.trim()
    || /[/:?#\s]/.test(value) || value.includes('://')
    || /(?:^|[.-])(?:example|placeholder|yourhost|your-domain)(?:[.-]|$)/i.test(value)
    || /^(?:localhost|.*\.localhost)$/i.test(value)
    || net.isIP(value)) {
    return false;
  }
  const labels = value.split('.');
  return labels.length >= 2 && labels[labels.length - 1].length >= 2
    && labels.every((label) => label.length > 0 && label.length <= 63
    && /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label));
}

function assertEnvLocalIgnored(envPath, gitRoot) {
  const relativePath = path.relative(gitRoot, envPath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw safeError('ENV_FILE_OUTSIDE_WORKSPACE', '.env.local must be inside the project workspace.');
  }
  try {
    execFileSync('git', ['check-ignore', '-q', '--', relativePath], {
      cwd: gitRoot,
      stdio: 'ignore',
    });
  } catch {
    throw safeError('ENV_FILE_NOT_IGNORED', '.env.local is not confirmed ignored by Git; no sandbox request was made.');
  }
}

function authHeaders(subscriptionKey, uuid) {
  return {
    'Ocp-Apim-Subscription-Key': subscriptionKey,
    ...(uuid ? { 'X-Reference-Id': uuid } : {}),
  };
}

function createUuidV4() {
  return crypto.randomUUID();
}

function updateEnvContent(original, updates) {
  const lines = original ? original.split(/\r?\n/) : [];
  for (const [name, value] of Object.entries(updates)) {
    const assignment = new RegExp(`^\\s*${name}\\s*=`);
    const existingIndex = lines.findIndex((line) => assignment.test(line));
    const nextLine = `${name}=${JSON.stringify(value)}`;
    if (existingIndex === -1) lines.push(nextLine);
    else lines[existingIndex] = nextLine;
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function writeCredentialsAtomically(envPath, fsImpl, apiUser, apiKey, uuidFactory) {
  const original = fsImpl.readFileSync(envPath, 'utf8');
  const nextContent = updateEnvContent(original, {
    MOMO_SANDBOX_API_USER: apiUser,
    MOMO_SANDBOX_API_KEY: apiKey,
  });
  const temporaryPath = `${envPath}.${crypto.randomUUID()}.tmp`;
  try {
    fsImpl.writeFileSync(temporaryPath, nextContent, { encoding: 'utf8', mode: 0o600 });
    fsImpl.renameSync(temporaryPath, envPath);
  } finally {
    if (fsImpl.existsSync(temporaryPath)) fsImpl.unlinkSync(temporaryPath);
  }
}

function validateTokenResponse(response) {
  const expiresIn = Number(response?.data?.expires_in);
  if (response?.status !== 200 || typeof response.data?.access_token !== 'string'
    || !response.data.access_token || !Number.isSafeInteger(expiresIn) || expiresIn <= 0) {
    throw safeError('TOKEN_RESPONSE_INVALID', 'Collections token validation returned an invalid response.');
  }
  return expiresIn;
}

function classifyProvisionError(error) {
  if (isAuthorizationError(error)) {
    return safeError(
      'SANDBOX_AUTH_REJECTED',
      `MTN sandbox authorization failed (HTTP ${responseStatus(error)}); this is likely a subscription-key/portal mismatch. Verify the key belongs to the Rwanda .co.rw sandbox.`,
    );
  }
  if (responseStatus(error) >= 400 && responseStatus(error) < 500) {
    return safeError(
      'SANDBOX_REQUEST_REJECTED',
      `MTN sandbox rejected the provisioning request (HTTP ${responseStatus(error)}); no credentials were written.`,
    );
  }
  return safeError(
    'SANDBOX_PROVISIONING_FAILED',
    'MTN sandbox provisioning failed; no credentials were written.',
  );
}

async function provisionMtnMomoSandbox({
  envPath = path.resolve(process.cwd(), '.env.local'),
  gitRoot = process.cwd(),
  regenerate = false,
  axiosClient = axios,
  fsImpl = fs,
  uuidFactory = createUuidV4,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  output = (message) => console.log(message),
  ignoreCheck = (filePath, root) => assertEnvLocalIgnored(filePath, root),
} = {}) {
  let original;
  try {
    original = fsImpl.readFileSync(envPath, 'utf8');
  } catch {
    throw safeError(
      'ENV_FILE_REQUIRED',
      'Create the Git-ignored .env.local file and add the sandbox subscription key and callback host before provisioning.',
    );
  }
  const env = dotenv.parse(original);
  const existingApiUser = String(env.MOMO_SANDBOX_API_USER || '').trim();
  const existingApiKey = String(env.MOMO_SANDBOX_API_KEY || '').trim();
  if (existingApiUser && existingApiKey && !regenerate) {
    output('Sandbox credentials already exist; pass --regenerate to replace them.');
    return { skipped: true };
  }

  const primaryKey = readSubscriptionKey(env, 'MOMO_SANDBOX_SUBSCRIPTION_KEY', 'Primary_key');
  const secondaryKey = readSubscriptionKey(
    env,
    'MOMO_SANDBOX_SUBSCRIPTION_KEY_SECONDARY',
    'Secondary_key',
  );
  if (!primaryKey) {
    throw safeError(
      'SUBSCRIPTION_KEY_REQUIRED',
      'Set MOMO_SANDBOX_SUBSCRIPTION_KEY in .env.local before provisioning.',
    );
  }

  const callbackHost = String(env.MOMO_CALLBACK_HOST || '').trim();
  if (!isValidCallbackHost(callbackHost)) {
    throw safeError(
      'CALLBACK_HOST_INVALID',
      'Set MOMO_CALLBACK_HOST in .env.local to a real bare domain (no scheme, path, port, localhost, IP address, or placeholder).',
    );
  }

  ignoreCheck(envPath, gitRoot);
  let activeSubscriptionKey = primaryKey;
  let secondaryUsed = false;
  let secondaryNoticePrinted = false;
  const markSecondaryUsed = () => {
    activeSubscriptionKey = secondaryKey;
    secondaryUsed = true;
    if (!secondaryNoticePrinted) {
      output('secondary subscription key used');
      secondaryNoticePrinted = true;
    }
  };
  const withFallback = async (operation) => {
    try {
      return await operation(activeSubscriptionKey);
    } catch (error) {
      if (!isAuthorizationError(error) || !secondaryKey || activeSubscriptionKey !== primaryKey) {
        throw error;
      }
      markSecondaryUsed();
      return operation(activeSubscriptionKey);
    }
  };

  let apiUser;
  let apiKey;
  let createUserStatus;
  let createApiKeyStatus;
  let tokenStatus;
  let expiresIn;

  for (let retry = 0; retry <= MAX_PROVISION_RETRIES; retry += 1) {
    apiUser = uuidFactory();
    try {
      const createUserResponse = await withFallback((subscriptionKey) => axiosClient.post(
        `${MTN_MOMO_SANDBOX.baseUrl}/v1_0/apiuser`,
        { providerCallbackHost: callbackHost },
        {
          timeout: 10000,
          headers: authHeaders(subscriptionKey, apiUser),
        },
      ));
      if (createUserResponse.status !== 201) {
        throw safeError('CREATE_USER_STATUS_INVALID', 'MTN sandbox returned an unexpected API-user status.');
      }
      createUserStatus = createUserResponse.status;

      const createApiKeyResponse = await withFallback((subscriptionKey) => axiosClient.post(
        `${MTN_MOMO_SANDBOX.baseUrl}/v1_0/apiuser/${encodeURIComponent(apiUser)}/apikey`,
        null,
        {
          timeout: 10000,
          headers: authHeaders(subscriptionKey),
        },
      ));
      if (createApiKeyResponse.status !== 201
        || typeof createApiKeyResponse.data?.apiKey !== 'string'
        || !createApiKeyResponse.data.apiKey.trim()
        || /[\r\n]/.test(createApiKeyResponse.data.apiKey)) {
        throw safeError('CREATE_API_KEY_RESPONSE_INVALID', 'MTN sandbox returned an invalid API-key response.');
      }
      createApiKeyStatus = createApiKeyResponse.status;
      apiKey = createApiKeyResponse.data.apiKey;
      break;
    } catch (error) {
      if (!isRetryableProvisionError(error) || retry === MAX_PROVISION_RETRIES) {
        throw classifyProvisionError(error);
      }
    }
  }

  for (let attempt = 0; attempt < TOKEN_VALIDATION_ATTEMPTS; attempt += 1) {
    try {
      const tokenResponse = await withFallback((subscriptionKey) => axiosClient.post(
        `${MTN_MOMO_SANDBOX.baseUrl}/collection/token/`,
        null,
        {
          timeout: 10000,
          headers: {
            Authorization: `Basic ${Buffer.from(`${apiUser}:${apiKey}`).toString('base64')}`,
            'Ocp-Apim-Subscription-Key': subscriptionKey,
            'X-Target-Environment': 'sandbox',
          },
        },
      ));
      expiresIn = validateTokenResponse(tokenResponse);
      tokenStatus = tokenResponse.status;
      break;
    } catch (error) {
      if (attempt + 1 === TOKEN_VALIDATION_ATTEMPTS) {
        if (isAuthorizationError(error)) {
          throw safeError(
            'TOKEN_VALIDATION_AUTH_REJECTED',
            `Collections token validation failed (HTTP ${responseStatus(error)}); this is likely a subscription-key/portal mismatch. No credentials were written. Verify the Rwanda .co.rw sandbox configuration, then re-run with --regenerate.`,
          );
        }
        throw safeError(
          'TOKEN_VALIDATION_FAILED',
          'Collections token validation failed; no credentials were written. Correct the sandbox configuration and re-run with --regenerate.',
        );
      }
      await sleep(TOKEN_RETRY_DELAY_MS);
    }
  }

  ignoreCheck(envPath, gitRoot);
  writeCredentialsAtomically(envPath, fsImpl, apiUser, apiKey, uuidFactory);
  if (secondaryUsed && !secondaryNoticePrinted) output('secondary subscription key used');
  output(`HTTP ${createUserStatus} OK`);
  output(`HTTP ${createApiKeyStatus} OK`);
  output(`token OK (HTTP ${tokenStatus}; expires_in ${expiresIn}s)`);
  return {
    skipped: false,
    createUserStatus,
    createApiKeyStatus,
    tokenStatus,
    expiresIn,
    secondaryUsed,
  };
}

function parseArguments(args) {
  if (args.length === 0) return { regenerate: false };
  if (args.length === 1 && args[0] === '--regenerate') return { regenerate: true };
  throw safeError('ARGUMENTS_INVALID', 'Usage: node scripts/provisionMtnMomoSandbox.js [--regenerate]');
}

if (require.main === module) {
  try {
    const options = parseArguments(process.argv.slice(2));
    provisionMtnMomoSandbox(options).catch((error) => {
      console.error(error?.message || 'MTN sandbox provisioning failed safely.');
      process.exitCode = 1;
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  isValidCallbackHost,
  provisionMtnMomoSandbox,
  updateEnvContent,
};
