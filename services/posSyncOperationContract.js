'use strict';

const {
  createPublicKey,
  sign,
  verify,
} = require('crypto');

const POS_SYNC_SCHEMA_VERSION = 2;
const POS_APP_MINIMUM_VERSION = '0.0.1';
const POS_APP_CURRENT_VERSION = '0.0.1';
const POS_SYNC_PAYMENT_FLOWS = Object.freeze(['LEGACY', 'PAYMENTS_V2']);
const POS_SYNC_OPERATION_TYPES = Object.freeze(['SALE_COMPLETE', 'CASH_MOVEMENT']);
const POS_SYNC_OPERATION_STATES = Object.freeze([
  'pending',
  'syncing',
  'synced',
  'retry_wait',
  'needs_review',
  'quarantined',
]);
const POS_SYNC_ERROR_CODES = Object.freeze([
  'POS_SYNC_ENVELOPE_INVALID',
  'POS_SYNC_SCHEMA_UNSUPPORTED',
  'POS_SYNC_OPERATION_TYPE_UNSUPPORTED',
  'POS_SYNC_SEQUENCE_INVALID',
  'POS_SYNC_DEPENDENCY_INVALID',
  'POS_SYNC_DEPENDENCY_MISSING',
  'POS_SYNC_DEPENDENCY_PENDING',
  'POS_SYNC_SIGNATURE_INVALID',
  'POS_SYNC_DEVICE_REVOKED',
  'POS_SYNC_TENANT_MISMATCH',
  'POS_SYNC_REGISTER_MISMATCH',
  'POS_SYNC_IDEMPOTENCY_CONFLICT',
  'POS_SYNC_VERSION_UNSUPPORTED',
  'POS_SYNC_PAYMENT_FLOW_INVALID',
]);

function envelopeError(code, message) {
  return { valid: false, code, message };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = canonicalize(value[key]);
      return result;
    }, {});
  }
  return value;
}

function operationSigningPayload(envelope) {
  const { signature: _signature, ...unsigned } = envelope;
  return JSON.stringify(canonicalize(unsigned));
}

function signOperationEnvelope(envelope, privateKey) {
  if (!privateKey) {
    throw new Error('An enrolled POS device private key is required to sign an operation.');
  }
  return sign(
    'sha256',
    Buffer.from(operationSigningPayload(envelope)),
    { key: privateKey, dsaEncoding: 'ieee-p1363' },
  ).toString('base64url');
}

function validPosDevicePublicKey(value) {
  if (typeof value !== 'string' || value.length > 4096) return false;
  try {
    const der = Buffer.from(value, 'base64');
    if (!der.length || der.toString('base64') !== value) return false;
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ec'
      && key.asymmetricKeyDetails?.namedCurve === 'prime256v1';
  } catch {
    return false;
  }
}

function isSupportedPosAppVersion(value) {
  const parsed = (version) => {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$/.exec(version);
    return match ? match.slice(1, 4).map(Number) : null;
  };
  const compare = (left, right) => {
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
    }
    return 0;
  };
  const supplied = parsed(String(value || ''));
  const minimum = parsed(POS_APP_MINIMUM_VERSION);
  const current = parsed(POS_APP_CURRENT_VERSION);
  return Boolean(supplied && minimum && current
    && compare(supplied, minimum) >= 0
    && compare(supplied, current) <= 0);
}

function verifyOperationSignature(envelope, publicKey) {
  if (typeof envelope?.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(envelope.signature)) {
    return false;
  }
  const provided = Buffer.from(envelope.signature, 'base64url');
  if (provided.length !== 64 || !validPosDevicePublicKey(publicKey)) return false;
  try {
    return verify(
      'sha256',
      Buffer.from(operationSigningPayload(envelope)),
      {
        key: createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }),
        dsaEncoding: 'ieee-p1363',
      },
      provided,
    );
  } catch {
    return false;
  }
}

function validateOperationEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return envelopeError('POS_SYNC_ENVELOPE_INVALID', 'Operation envelope must be an object.');
  }
  if (envelope.schemaVersion !== POS_SYNC_SCHEMA_VERSION) {
    return envelopeError('POS_SYNC_SCHEMA_UNSUPPORTED', 'Operation schema version is not supported.');
  }
  if (!POS_SYNC_PAYMENT_FLOWS.includes(envelope.paymentFlow)) {
    return envelopeError('POS_SYNC_PAYMENT_FLOW_INVALID', 'Operation payment flow must be LEGACY or PAYMENTS_V2.');
  }
  if (!POS_SYNC_OPERATION_TYPES.includes(envelope.type)) {
    return envelopeError('POS_SYNC_OPERATION_TYPE_UNSUPPORTED', 'Operation type is not supported.');
  }
  if (!Number.isSafeInteger(envelope.sequence) || envelope.sequence < 1) {
    return envelopeError('POS_SYNC_SEQUENCE_INVALID', 'Operation sequence must be a positive safe integer.');
  }
  if (envelope.dependencyOperationId != null
    && (typeof envelope.dependencyOperationId !== 'string'
      || envelope.dependencyOperationId.length < 16
      || envelope.dependencyOperationId.length > 100
      || !/^[a-zA-Z0-9_-]+$/.test(envelope.dependencyOperationId)
      || envelope.sequence < 2
      || envelope.dependencyOperationId === envelope.operationId)) {
    return envelopeError('POS_SYNC_DEPENDENCY_INVALID', 'Operation dependency is invalid.');
  }
  const nonEmptyStringFields = [
    'operationId',
    'deviceId',
    'registerId',
    'companyId',
    'deviceTime',
    'appVersion',
  ];
  if (nonEmptyStringFields.some((field) => (
    typeof envelope[field] !== 'string' || envelope[field].trim().length === 0
  ))) {
    return envelopeError('POS_SYNC_ENVELOPE_INVALID', 'Operation identity, time, and app version fields are required.');
  }
  // Sale completion uses the operation ID directly as the shared legacy/V2
  // checkout idempotency key, whose persisted request contract requires 16.
  if (envelope.operationId.length < 16
    || envelope.operationId.length > 100
    || !/^[a-zA-Z0-9_-]+$/.test(envelope.operationId)
    || envelope.deviceId.length > 160
    || envelope.registerId.length > 24
    || envelope.companyId.length > 24) {
    return envelopeError('POS_SYNC_ENVELOPE_INVALID', 'Operation identifiers have an invalid length or format.');
  }
  if (!Number.isFinite(Date.parse(envelope.deviceTime))) {
    return envelopeError('POS_SYNC_ENVELOPE_INVALID', 'Operation deviceTime must be a valid date string.');
  }
  if (envelope.appVersion.length > 80
    || envelope.snapshotVersion != null
      && (typeof envelope.snapshotVersion !== 'string' || envelope.snapshotVersion.length > 120)
    || envelope.signature != null
      && (typeof envelope.signature !== 'string' || envelope.signature.length > 4096)) {
    return envelopeError('POS_SYNC_ENVELOPE_INVALID', 'Operation version or signature fields exceed their allowed shape.');
  }
  if (!envelope.payload || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload)) {
    return envelopeError('POS_SYNC_ENVELOPE_INVALID', 'Operation payload must be an object.');
  }
  return { valid: true, code: null, message: null };
}

function validateOperationDependency(operation, predecessor) {
  if ((!predecessor && operation.sequence > 1)
    || (predecessor && Number(predecessor.sequence) !== operation.sequence - 1)) {
    return { valid: false, code: 'POS_SYNC_DEPENDENCY_MISSING', blocked: true };
  }
  if (predecessor && operation.dependencyOperationId
    && operation.dependencyOperationId !== predecessor.operationId) {
    return { valid: false, code: 'POS_SYNC_DEPENDENCY_INVALID', blocked: false };
  }
  if (predecessor && predecessor.state !== 'synced') {
    return { valid: false, code: 'POS_SYNC_DEPENDENCY_PENDING', blocked: true };
  }
  return { valid: true, code: null, blocked: false };
}

module.exports = {
  POS_SYNC_SCHEMA_VERSION,
  POS_APP_MINIMUM_VERSION,
  POS_APP_CURRENT_VERSION,
  POS_SYNC_PAYMENT_FLOWS,
  POS_SYNC_OPERATION_TYPES,
  POS_SYNC_OPERATION_STATES,
  POS_SYNC_ERROR_CODES,
  signOperationEnvelope,
  validPosDevicePublicKey,
  isSupportedPosAppVersion,
  validateOperationEnvelope,
  validateOperationDependency,
  verifyOperationSignature,
};
