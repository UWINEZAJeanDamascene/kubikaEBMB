'use strict';

const { buildTenantModel } = require('../utils/masterDataCommon');
const { generateObjectId, toIdString } = require('../utils/objectId');

const map = { company: 'companyId', name: 'name', type: 'type', status: 'status', storageLocation: 'storageLocation', cloudUrl: 'cloudUrl', filePath: 'filePath', fileSize: 'fileSize', compressionFormat: 'compressionFormat', mongoVersion: 'sourceVersion', pointInTime: 'pointInTime', collections: 'collections', verification: 'verification', errorMessage: 'errorMessage', restore: 'restore', schedule: 'schedule', retention: 'retention', createdBy: 'createdBy', cloudConfig: 'cloudConfig' };
const FIELD_MAP = { _id: { target: 'id', isId: true }, id: { target: 'id', isId: true } };
for (const [source, target] of Object.entries(map)) FIELD_MAP[source] = { target, isId: /Id$/.test(target) || target === 'companyId' || target === 'createdBy' };

const defaults = {
  verification: { verified: false, verifiedAt: null, verifiedBy: null, checksum: null, integrityStatus: 'not_verified', errorMessage: null },
  restore: { restoredAt: null, restoredBy: null, originalBackupId: null },
  schedule: { enabled: false, frequency: 'daily', cronExpression: null, lastRun: null, nextRun: null, autoVerify: true },
  retention: { keepForDays: 30, autoDelete: true },
  cloudConfig: { provider: 'local', bucket: null, region: null },
};

function toApi(row) {
  if (!row) return null;
  const result = { _id: row.id };
  for (const [source, target] of Object.entries(map)) result[source] = row[target];
  result.verification = { ...defaults.verification, ...(row.verification || {}) };
  result.restore = { ...defaults.restore, ...(row.restore || {}) };
  result.schedule = { ...defaults.schedule, ...(row.schedule || {}) };
  result.retention = { ...defaults.retention, ...(row.retention || {}) };
  result.cloudConfig = { ...defaults.cloudConfig, ...(row.cloudConfig || {}) };
  result.collections = row.collections || [];
  result.createdAt = row.createdAt;
  result.updatedAt = row.updatedAt;
  result.formattedSize = formatSize(result.fileSize || 0);
  return result;
}

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${parseFloat((bytes / Math.pow(1024, index)).toFixed(2))} ${sizes[index]}`;
}

function translateCreate(data = {}) {
  return {
    id: toIdString(data._id || data.id) || generateObjectId(),
    companyId: toIdString(data.company),
    name: data.name,
    type: data.type || 'manual',
    status: data.status || 'pending',
    storageLocation: data.storageLocation || 'local',
    cloudUrl: data.cloudUrl || null,
    filePath: data.filePath || null,
    fileSize: data.fileSize || 0,
    compressionFormat: data.compressionFormat || 'gzip',
    sourceVersion: data.mongoVersion || '',
    pointInTime: data.pointInTime || null,
    collections: data.collections || [],
    verification: { ...defaults.verification, ...(data.verification || {}) },
    errorMessage: data.errorMessage || null,
    restore: { ...defaults.restore, ...(data.restore || {}) },
    schedule: { ...defaults.schedule, ...(data.schedule || {}) },
    retention: { ...defaults.retention, ...(data.retention || {}) },
    createdBy: data.createdBy ? toIdString(data.createdBy) : null,
    cloudConfig: { ...defaults.cloudConfig, ...(data.cloudConfig || {}) },
  };
}

function translateUpdate(update = {}) {
  const source = update.$set ? { ...update, ...update.$set } : { ...update };
  delete source.$set;
  delete source.$unset;
  const data = {};
  for (const [sourceKey, target] of Object.entries(map)) {
    if (source[sourceKey] !== undefined) data[target] = ['companyId', 'createdBy'].includes(target) ? (source[sourceKey] ? toIdString(source[sourceKey]) : null) : source[sourceKey];
  }
  return data;
}

const Backup = buildTenantModel({
  name: 'Backup',
  collection: 'backups',
  delegateName: 'backup',
  fieldMap: FIELD_MAP,
  toApi,
  translateCreate,
  translateUpdate,
  tenantField: 'companyId',
  mutable: true,
  instanceMethods: {
    markAsVerified(verifiedBy, checksum) {
      this.verification = { ...(this.verification || {}), verified: true, verifiedAt: new Date(), verifiedBy, checksum, integrityStatus: 'valid' };
      if (this.status !== 'completed_with_errors') this.status = 'verified';
      return this.save();
    },
    markAsFailed(errorMessage) {
      this.status = 'failed';
      this.errorMessage = errorMessage;
      return this.save();
    },
  },
});

module.exports = Backup;
