'use strict';

const { generateKeyPairSync } = require('crypto');
const {
  POS_SYNC_ERROR_CODES,
  POS_SYNC_OPERATION_STATES,
  POS_SYNC_OPERATION_TYPES,
  POS_SYNC_PAYMENT_FLOWS,
  POS_SYNC_SCHEMA_VERSION,
  POS_APP_CURRENT_VERSION,
  POS_APP_MINIMUM_VERSION,
  isSupportedPosAppVersion,
  validPosDevicePublicKey,
  signOperationEnvelope,
  validateOperationEnvelope,
  verifyOperationSignature,
  validateOperationDependency,
} = require('../services/posSyncOperationContract');

const validEnvelope = () => ({
  operationId: 'offline-sale-uuid',
  deviceId: 'device-uuid',
  registerId: 'register-id',
  companyId: 'company-id',
  sequence: 1,
  type: 'SALE_COMPLETE',
  paymentFlow: 'LEGACY',
  payload: { sale: true },
  deviceTime: '2026-11-07T08:00:00.000Z',
  schemaVersion: POS_SYNC_SCHEMA_VERSION,
  appVersion: '1.2.3',
  snapshotVersion: 'snapshot-version',
  signature: null,
});

describe('POS sync operation contract', () => {
  test('accepts a structurally valid operation without executing it', () => {
    expect(validateOperationEnvelope(validEnvelope())).toEqual({
      valid: true,
      code: null,
      message: null,
    });
  });

  test.each([
    ['schema version', { schemaVersion: POS_SYNC_SCHEMA_VERSION + 1 }, 'POS_SYNC_SCHEMA_UNSUPPORTED'],
    ['operation type', { type: 'PAYMENT_RECORD' }, 'POS_SYNC_OPERATION_TYPE_UNSUPPORTED'],
    ['payment flow', { paymentFlow: 'V2' }, 'POS_SYNC_PAYMENT_FLOW_INVALID'],
    ['sequence', { sequence: 0 }, 'POS_SYNC_SEQUENCE_INVALID'],
    ['dependency identifier', { dependencyOperationId: 'invalid', sequence: 2 }, 'POS_SYNC_DEPENDENCY_INVALID'],
    ['first sequence dependency', { dependencyOperationId: 'offline-operation-0001' }, 'POS_SYNC_DEPENDENCY_INVALID'],
    ['identity', { companyId: '' }, 'POS_SYNC_ENVELOPE_INVALID'],
    ['short operation identifier', { operationId: 'too-short' }, 'POS_SYNC_ENVELOPE_INVALID'],
    ['operation identifier', { operationId: 'offline.operation.1' }, 'POS_SYNC_ENVELOPE_INVALID'],
    ['device time', { deviceTime: 'not-a-date' }, 'POS_SYNC_ENVELOPE_INVALID'],
    ['payload', { payload: [] }, 'POS_SYNC_ENVELOPE_INVALID'],
    ['signature shape', { signature: 5 }, 'POS_SYNC_ENVELOPE_INVALID'],
  ])('rejects invalid %s fields with the contract error code', (_label, change, expectedCode) => {
    expect(validateOperationEnvelope({ ...validEnvelope(), ...change }).code).toBe(expectedCode);
  });

  test('publishes the Stage B schema, operation states, and reserved processing errors', () => {
    expect(POS_SYNC_SCHEMA_VERSION).toBe(2);
    expect(POS_SYNC_PAYMENT_FLOWS).toEqual(['LEGACY', 'PAYMENTS_V2']);
    expect(POS_SYNC_OPERATION_TYPES).toEqual(['SALE_COMPLETE', 'CASH_MOVEMENT']);
    expect(POS_SYNC_OPERATION_STATES).toEqual([
      'pending', 'syncing', 'synced', 'retry_wait', 'needs_review', 'quarantined',
    ]);
    expect(POS_SYNC_ERROR_CODES).toContain('POS_SYNC_IDEMPOTENCY_CONFLICT');
  });

  test('signs canonical operation data with an enrolled P-256 key and rejects tampering', () => {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const envelope = validEnvelope();
    const signed = { ...envelope, signature: signOperationEnvelope(envelope, pair.privateKey) };
    const reordered = {
      ...signed,
      payload: { sale: true },
    };

    expect(verifyOperationSignature(signed, publicKey)).toBe(true);
    expect(verifyOperationSignature(reordered, publicKey)).toBe(true);
    expect(verifyOperationSignature({ ...signed, payload: { sale: false } }, publicKey)).toBe(false);
    expect(verifyOperationSignature(signed, 'not-a-public-key')).toBe(false);
  });

  test('accepts only P-256 public keys and app versions in the supported window', () => {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    expect(validPosDevicePublicKey(publicKey)).toBe(true);
    expect(validPosDevicePublicKey('not-a-public-key')).toBe(false);
    expect(isSupportedPosAppVersion(POS_APP_MINIMUM_VERSION)).toBe(true);
    expect(isSupportedPosAppVersion(POS_APP_CURRENT_VERSION)).toBe(true);
    expect(isSupportedPosAppVersion('0.0.0')).toBe(false);
    expect(isSupportedPosAppVersion('unknown')).toBe(false);
  });

  test('requires contiguous predecessor success before accepting later device sequence numbers', () => {
    const operation = { sequence: 3, dependencyOperationId: 'operation-0002' };
    expect(validateOperationDependency(operation, null)).toMatchObject({
      valid: false, blocked: true, code: 'POS_SYNC_DEPENDENCY_MISSING',
    });
    expect(validateOperationDependency(operation, {
      operationId: 'operation-0001', sequence: 1, state: 'synced',
    })).toMatchObject({ valid: false, code: 'POS_SYNC_DEPENDENCY_MISSING' });
    expect(validateOperationDependency(operation, {
      operationId: 'operation-0002', sequence: 2, state: 'needs_review',
    })).toMatchObject({ valid: false, blocked: true, code: 'POS_SYNC_DEPENDENCY_PENDING' });
    expect(validateOperationDependency(operation, {
      operationId: 'operation-0002', sequence: 2, state: 'synced',
    })).toMatchObject({ valid: true });
    expect(validateOperationDependency({ ...operation, dependencyOperationId: 'wrong-operation-000' }, {
      operationId: 'operation-0002', sequence: 2, state: 'synced',
    })).toMatchObject({ valid: false, blocked: false, code: 'POS_SYNC_DEPENDENCY_INVALID' });
  });
});
