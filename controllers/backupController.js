// Retained ONLY for the Backup.aggregate() call in getBackupStats: `Backup` is
// itself still a Mongoose-only model, so its aggregate needs a real ObjectId.
// Everything else in this file is PostgreSQL-backed. Remove this import when
// Backup migrates to Prisma.
const mongoose = require('mongoose');
const { runInTransaction } = require('../services/transactionService');
const { parseOptionalPagination, paginationMeta } = require('../utils/pagination');
const Backup = require('../models/Backup');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const crypto = require('crypto');
const zlib = require('zlib');
const { google } = require('googleapis');
const { notifyBackupSuccess, notifyBackupFailed } = require('../services/notificationHelper');
const { Prisma } = require('@prisma/client');
const { prisma } = require('../lib/prisma');

// Derive coverage from Prisma's generated schema, not a stale manual allowlist.
// Tenant tables need a direct company/companyId scalar for safe scoping. The
// Company root row is archived separately and updated in place during restore;
// Backup metadata is excluded so restore never deletes its own backup record.
const COMPANY_MODEL = (Prisma.dmmf?.datamodel?.models || []).find((model) => model.name === 'Company');
const TENANT_MODELS = (Prisma.dmmf?.datamodel?.models || [])
  .map((model) => {
    const ownerField = model.fields.find((field) =>
      field.kind === 'scalar' && ['companyId', 'company'].includes(field.name));
    if (!ownerField || ['Backup', 'Company'].includes(model.name)) return null;
    const delegateName = model.name[0].toLowerCase() + model.name.slice(1);
    if (!prisma[delegateName]) {
      throw new Error(`Tenant model ${model.name} has no Prisma delegate; backup coverage is unsafe`);
    }
    return { name: model.name, delegateName, ownerField: ownerField.name, fields: model.fields };
  })
  .filter(Boolean)
  .sort((a, b) => a.name.localeCompare(b.name));

const TENANT_MODEL_BY_NAME = new Map(TENANT_MODELS.map((model) => [model.name, model]));
const getBackupableCollections = () => TENANT_MODELS.map((model) => model.name);

const getRestoreOrder = () => {
  const dependencies = new Map(TENANT_MODELS.map((model) => [model.name, new Set()]));
  for (const model of TENANT_MODELS) {
    for (const relation of model.fields.filter((field) => field.kind === 'object' && field.relationFromFields?.length)) {
      const requiredRelation = relation.relationFromFields.some((fieldName) =>
        model.fields.find((field) => field.name === fieldName)?.isRequired);
      if (requiredRelation && TENANT_MODEL_BY_NAME.has(relation.type) && relation.type !== model.name) {
        dependencies.get(model.name).add(relation.type);
      }
    }
  }
  const ordered = [];
  const remaining = new Map([...dependencies].map(([name, deps]) => [name, new Set(deps)]));
  while (remaining.size) {
    const ready = [...remaining].filter(([, deps]) => deps.size === 0).map(([name]) => name).sort();
    if (!ready.length) throw new Error(`Tenant backup restore has a Prisma relation cycle: ${[...remaining.keys()].join(', ')}`);
    for (const name of ready) {
      ordered.push(TENANT_MODEL_BY_NAME.get(name));
      remaining.delete(name);
      for (const deps of remaining.values()) deps.delete(name);
    }
  }
  return ordered;
};

// Fail at startup if schema relations cannot be restored in a safe order.
const TENANT_RESTORE_ORDER = getRestoreOrder();

const getTenantRelations = (model) => model.fields
  .filter((field) => field.kind === 'object' && field.relationFromFields?.length && TENANT_MODEL_BY_NAME.has(field.type))
  .map((relation) => ({
    target: relation.type,
    fields: relation.relationFromFields,
    nullable: relation.relationFromFields.every((fieldName) =>
      !model.fields.find((field) => field.name === fieldName)?.isRequired),
  }));

const getPrimaryWhere = (model, record, companyId) => {
  const keys = model.primaryKey?.fields?.length
    ? model.primaryKey.fields
    : model.fields.filter((field) => field.isId).map((field) => field.name);
  if (!keys.length || keys.some((key) => record[key] === undefined || record[key] === null)) {
    throw new Error(`Cannot safely restore ${model.name}: primary key is missing from an archived row`);
  }
  return { [model.ownerField]: companyId, ...Object.fromEntries(keys.map((key) => [key, record[key]])) };
};

const BACKUP_PAGE_SIZE = 500;
const readTenantModel = async (model, companyId) => {
  const delegate = prisma[model.delegateName];
  const uniqueFields = model.fields.filter((field) => field.isId || field.isUnique).map((field) => field.name);
  // Prisma's findMany orderBy argument is always an array. Models with
  // compound unique keys need multiple entries, while single-key models still
  // use the same valid shape.
  const orderBy = (uniqueFields.length ? uniqueFields : [model.ownerField])
    .map((field) => ({ [field]: 'asc' }));
  const where = { [model.ownerField]: companyId };
  const records = [];
  for (let skip = 0; ; skip += BACKUP_PAGE_SIZE) {
    const page = await delegate.findMany({ where, orderBy, skip, take: BACKUP_PAGE_SIZE });
    records.push(...page);
    if (page.length < BACKUP_PAGE_SIZE) break;
  }
  return records;
};

const readCompanySnapshot = async (companyId) => {
  if (!COMPANY_MODEL || !prisma.company) throw new Error('Company model is unavailable for backup');
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) throw new Error('Company record was not found for backup');
  return serializePrismaValue(company);
};

const serializePrismaValue = (value) => {
  if (typeof value === 'bigint') return { __backupScalar: 'bigint', value: value.toString() };
  if (Buffer.isBuffer(value)) return { __backupScalar: 'bytes', value: value.toString('base64') };
  if (Array.isArray(value)) return value.map(serializePrismaValue);
  if (value && typeof value === 'object' && !(value instanceof Date) && typeof value.toJSON !== 'function') {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, serializePrismaValue(nested)]));
  }
  return value;
};

const restoreScalarTypes = (model, record) => {
  const output = { ...record };
  for (const field of model.fields) {
    if (!Object.prototype.hasOwnProperty.call(output, field.name)) continue;
    const value = output[field.name];
    if (value && value.__backupScalar === 'bigint' && field.type === 'BigInt') output[field.name] = BigInt(value.value);
    else if (value && value.__backupScalar === 'bytes' && field.type === 'Bytes') output[field.name] = Buffer.from(value.value, 'base64');
    else if (value != null && field.type === 'DateTime' && typeof value === 'string') output[field.name] = new Date(value);
  }
  return output;
};

/**
 * Source database version, recorded in the archive so a restore can tell what
 * produced it. Failure here must not fail the backup — it is metadata.
 */
const getSourceEngineVersion = async () => {
  try {
    const { prisma } = require('../lib/prisma');
    const rows = await prisma.$queryRawUnsafe('SHOW server_version');
    const version = rows && rows[0] && rows[0].server_version;
    return version ? `postgresql ${version}` : 'postgresql';
  } catch (error) {
    return 'postgresql (version unavailable)';
  }
};

// Get backup directory
const getBackupDir = () => {
  const backupDir = path.join(process.cwd(), 'backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }
  return backupDir;
};

// Generate checksum for data integrity
const generateChecksum = (data) => {
  return crypto.createHash('sha256').update(data).digest('hex');
};

// @desc    Get all backups for a company
// @route   GET /api/backups
// @access  Private
exports.getBackups = async (req, res) => {
  try {
    const companyId = req.company._id || req.company;

    // Opt-in pagination: callers that send page/limit get a page and totals;
    // callers that send neither keep the previous all-rows behaviour, so the
    // existing backups screen is unaffected.
    const { paginated, page, limit, skip } = parseOptionalPagination(req.query, { defaultLimit: 50 });
    const filter = { company: companyId };

    let query = Backup.find(filter)
      .populate('createdBy', 'name email')
      .populate('verification.verifiedBy', 'name email')
      .populate('restore.restoredBy', 'name email')
      .sort({ createdAt: -1 });
    if (paginated) query = query.skip(skip).limit(limit);

    const backups = await query;
    const total = paginated ? await Backup.countDocuments(filter) : backups.length;

    res.json({
      success: true,
      count: backups.length,
      data: backups,
      pagination: paginationMeta(page, limit || backups.length || 1, total)
    });
  } catch (error) {
    console.error('Error getting backups:', error);
    res.status(500).json({
      success: false,
      message: 'Server error retrieving backups',
      error: error.message
    });
  }
};

// @desc    Get single backup
// @route   GET /api/backups/:id
// @access  Private
exports.getBackup = async (req, res) => {
  try {
    const companyId = req.company._id || req.company;

    const backup = await Backup.findOne({
      _id: req.params.id,
      company: companyId
    })
      .populate('createdBy', 'name email')
      .populate('verification.verifiedBy', 'name email')
      .populate('restore.restoredBy', 'name email');

    if (!backup) {
      return res.status(404).json({
        success: false,
        message: 'Backup not found'
      });
    }

    res.json({
      success: true,
      data: backup
    });
  } catch (error) {
    console.error('Error getting backup:', error);
    res.status(500).json({
      success: false,
      message: 'Server error retrieving backup',
      error: error.message
    });
  }
};

// @desc    Create new backup
// @route   POST /api/backups
// @access  Private (Admin)
exports.createBackup = async (req, res) => {
  try {
    const companyId = req.company._id || req.company;
    const {
      name,
      type = 'manual',
      storageLocation = 'local',
    } = req.body;

    if (req.body.pointInTime) {
      return res.status(400).json({
        success: false,
        message: 'Application backups are full snapshots. Historical point-in-time recovery must be performed through the database provider.',
        code: 'BACKUP_PITR_NOT_SUPPORTED',
      });
    }

    const configuredSettings = await Backup.findOne({ company: companyId, type: 'scheduled' }).sort({ createdAt: -1 });

    // Create backup record
    const backup = await Backup.create({
      company: companyId,
      name: name || `Backup_${new Date().toISOString().replace(/[:.]/g, '-')}`,
      type,
      status: 'pending',
      storageLocation,
      cloudConfig: configuredSettings?.cloudConfig || {},
      createdBy: req.user?._id,
      collections: []
    });

    // Start backup process in background
    performBackup(backup._id, companyId).catch(err => {
      console.error('Backup failed:', err);
    });

    res.status(201).json({
      success: true,
      message: 'Backup initiated successfully',
      data: backup
    });
  } catch (error) {
    console.error('Error creating backup:', error);
    res.status(500).json({
      success: false,
      message: 'Server error creating backup',
      error: error.message
    });
  }
};

// Perform the actual backup
const performBackup = async (backupId, companyId) => {
  const backup = await Backup.findById(backupId);
  if (!backup) return;

  try {
    backup.status = 'in_progress';
    await backup.save();

    const backupData = {
      companyId,
      company: await readCompanySnapshot(companyId),
      timestamp: new Date().toISOString(),
      snapshotType: 'full-tenant-snapshot',
      collections: []
    };

    const backupDir = getBackupDir();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `backup_${companyId}_${timestamp}.json.gz`;
    const filePath = path.join(backupDir, fileName);

    // Backup each collection
    for (const model of TENANT_MODELS) {
      try {
        const documents = await readTenantModel(model, companyId);
        backupData.collections.push({
          name: model.name,
          documentCount: documents.length,
          data: documents.map(serializePrismaValue),
        });
      } catch (err) {
        console.warn(`Could not backup tenant model ${model.name}:`, err.message);
        backupData.collections.push({
          name: model.name,
          documentCount: 0,
          data: [],
          error: err.message,
        });
      }
    }


    // Compress and save backup
    const jsonData = JSON.stringify(backupData);
    const compressedData = zlib.gzipSync(Buffer.from(jsonData));

    fs.writeFileSync(filePath, compressedData);

    const checksum = generateChecksum(compressedData);

    // A backup that could not read every collection is NOT 'completed'.
    // Marking it so would let a partial archive be restored later as though it
    // were whole — the failure would only surface as missing data.
    const failedCollections = backupData.collections.filter((c) => c.error);
    backup.status = failedCollections.length ? 'completed_with_errors' : 'completed';
    if (failedCollections.length) {
      console.warn(
        `[backup] ${failedCollections.length}/${backupData.collections.length} collections failed: ` +
        failedCollections.map((c) => c.name).join(', '),
      );
    }
    backup.filePath = filePath;
    backup.fileSize = compressedData.length;
    // Field name is legacy. The data now comes from PostgreSQL, so recording a
    // Mongoose version would misidentify the source of the archive.
    backup.mongoVersion = await getSourceEngineVersion();
    backup.verification.checksum = checksum;
    // 'valid' here means the archive file matches its checksum — it does not
    // mean the archive contains every collection. See status above.
    backup.verification.integrityStatus = 'valid';

    // Update collections info
    backup.collections = backupData.collections.map(c => ({
      name: c.name,
      documentCount: c.documentCount
    }));

    await backup.save();

    // If cloud backup is enabled, upload to cloud
    if (backup.storageLocation !== 'local') {
      const uploadResult = await uploadToCloud(backup);
      backup.verification = {
        ...(backup.verification || {}),
        cloudUploadStatus: uploadResult.success ? 'uploaded' : 'failed',
        cloudUploadError: uploadResult.success ? null : uploadResult.error,
        cloudUploadedAt: uploadResult.success ? new Date().toISOString() : null,
      };
      // Keep a valid local snapshot restorable, but make the failed off-site
      // copy explicit in the same record returned to operators.
      backup.cloudUrl = uploadResult.success ? uploadResult.url : null;
      await backup.save();
    }

    // Verify every complete archive automatically once its local file and any
    // requested remote copy attempt have finished. Incomplete archives retain
    // their completed_with_errors status and are never labeled verified.
    if (backup.status === 'completed') {
      await performVerification(backupId, backup.createdBy || null);
    }

    console.log(
      failedCollections.length
        ? `Backup ${backupId} completed WITH ERRORS — ${failedCollections.length} collection(s) missing`
        : `Backup ${backupId} completed successfully`,
    );
  } catch (error) {
    console.error('Backup failed:', error);
    backup.status = 'failed';
    backup.errorMessage = error.message;
    await backup.save();

    // Send notification for failed backup
    await notifyBackupFailed(companyId, backup, error.message);
  }
};

// Upload backup to cloud storage
const uploadToCloud = async (backup) => {
  // A remote location is only recorded after the provider confirms the upload.
  try {
    if (backup.storageLocation === 's3') {
      const bucket = backup.cloudConfig?.bucket || process.env.AWS_S3_BUCKET;
      const region = backup.cloudConfig?.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
      const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
      const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
      if (!bucket || !region || !accessKeyId || !secretAccessKey) {
        throw new Error('S3 backup requires bucket, region, AWS_ACCESS_KEY_ID, and AWS_SECRET_ACCESS_KEY configuration.');
      }
      const endpoint = new URL(process.env.AWS_S3_ENDPOINT || `https://s3.${region}.amazonaws.com`);
      const objectKey = `${process.env.AWS_S3_PREFIX ? `${process.env.AWS_S3_PREFIX.replace(/^\/+|\/+$/g, '')}/` : ''}${path.basename(backup.filePath)}`;
      const encodedPath = `/${encodeURIComponent(bucket)}/${objectKey.split('/').map(encodeURIComponent).join('/')}`;
      const body = fs.readFileSync(backup.filePath);
      const payloadHash = crypto.createHash('sha256').update(body).digest('hex');
      const now = new Date();
      const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
      const dateStamp = amzDate.slice(0, 8);
      const host = endpoint.host;
      const headers = {
        host,
        'content-type': 'application/gzip',
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
      };
      if (process.env.AWS_SESSION_TOKEN) headers['x-amz-security-token'] = process.env.AWS_SESSION_TOKEN;
      const signedHeaders = Object.keys(headers).sort().join(';');
      const canonicalHeaders = Object.keys(headers).sort().map((key) => `${key}:${String(headers[key]).trim()}\n`).join('');
      const canonicalRequest = ['PUT', encodedPath, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
      const scope = `${dateStamp}/${region}/s3/aws4_request`;
      const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
      const hmac = (key, value) => crypto.createHmac('sha256', key).update(value).digest();
      const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), 's3'), 'aws4_request');
      headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex')}`;
      await new Promise((resolve, reject) => {
        const transport = endpoint.protocol === 'http:' ? require('http') : require('https');
        const request = transport.request({ protocol: endpoint.protocol, hostname: endpoint.hostname, port: endpoint.port || undefined, method: 'PUT', path: encodedPath, headers: { ...headers, 'content-length': body.length } }, (response) => {
          let responseBody = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => { responseBody += chunk; });
          response.on('end', () => response.statusCode >= 200 && response.statusCode < 300
            ? resolve()
            : reject(new Error(`S3 upload failed with HTTP ${response.statusCode}: ${responseBody.slice(0, 500)}`)));
        });
        request.on('error', reject);
        request.end(body);
      });
      return { success: true, url: `s3://${bucket}/${objectKey}` };
    } else if (backup.storageLocation === 'google-drive' || backup.storageLocation === 'cloud') {
      // Handle both 'google-drive' and 'cloud' (default to Google Drive) storage types
      try {
        let serviceAccount = null;

        // Try multiple sources for credentials
        const possiblePaths = [
          path.join(process.cwd(), 'config', 'google-credentials.json'),
          path.join(process.env.USERPROFILE || process.env.HOME || '', 'Downloads', 'stockmanager-backup-92c9f04a5d8d.json'),
          path.join(process.cwd(), '..', 'Downloads', 'stockmanager-backup-92c9f04a5d8d.json')
        ];

        for (const credPath of possiblePaths) {
          if (fs.existsSync(credPath)) {
            serviceAccount = JSON.parse(fs.readFileSync(credPath, 'utf8'));
            console.log('Found Google credentials at:', credPath);
            break;
          }
        }

        // Also check GOOGLE_SERVICE_ACCOUNT_FILE env var (path to credentials file)
        if (!serviceAccount && process.env.GOOGLE_SERVICE_ACCOUNT_FILE) {
          const credPath = path.resolve(process.cwd(), process.env.GOOGLE_SERVICE_ACCOUNT_FILE);
          if (fs.existsSync(credPath)) {
            serviceAccount = JSON.parse(fs.readFileSync(credPath, 'utf8'));
            console.log('Found Google credentials from GOOGLE_SERVICE_ACCOUNT_FILE:', credPath);
          }
        }

        if (!serviceAccount && process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
          serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
        }

        if (!serviceAccount) {
          throw new Error('Google Service Account credentials not found. Please ensure google-credentials.json exists in config folder or GOOGLE_SERVICE_ACCOUNT_KEY is set.');
        }

        const auth = new google.auth.GoogleAuth({
          credentials: serviceAccount,
          scopes: ['https://www.googleapis.com/auth/drive.file']
        });

        const drive = google.drive({ version: 'v3', auth });

        const fileMetadata = {
          name: path.basename(backup.filePath),
          owners: process.env.GOOGLE_DRIVE_OWNER_EMAIL ? [process.env.GOOGLE_DRIVE_OWNER_EMAIL] : undefined,
        };

        // Optionally upload into a specific folder
        if (process.env.GOOGLE_DRIVE_FOLDER_ID) {
          fileMetadata.parents = [process.env.GOOGLE_DRIVE_FOLDER_ID];
        }

        const media = {
          mimeType: 'application/gzip',
          body: fs.createReadStream(backup.filePath)
        };

        console.log('Starting Google Drive upload for:', backup.filePath);

        const response = await drive.files.create({
          resource: fileMetadata,
          media,
          fields: 'id, webViewLink',
          supportsAllDrives: true,
          includeItemsFromAllDrives: true
        });

        const fileId = response.data.id;
        if (!fileId) throw new Error('Google Drive did not return an uploaded file ID.');
        const webViewLink = response.data.webViewLink || (fileId ? `https://drive.google.com/file/d/${fileId}/view` : null);

        backup.cloudUrl = webViewLink;

        console.log('Google Drive upload successful! File ID:', fileId);
      } catch (err) {
        console.error('Google Drive upload failed:', err.message || err);
        // Set failed status - this indicates the backup itself succeeded but cloud upload failed
        backup.cloudUrl = null;
        // Log additional error details for debugging
        if (err.response) {
          console.error('Google API Error Response:', err.response.data);
        }
        return { success: false, error: err.message || 'Google Drive upload failed' };
      }
    } else if (backup.storageLocation === 'dropbox') {
      try {
        const axios = require('axios');
        const dropboxToken = process.env.DROPBOX_ACCESS_TOKEN;

        if (!dropboxToken) {
          throw new Error('Dropbox access token not configured');
        }

        // Read the backup file
        const fileContent = fs.readFileSync(backup.filePath);
        const fileName = path.basename(backup.filePath);

        console.log('Starting Dropbox upload for:', fileName);

        // Upload to Dropbox using their API
        const response = await axios.post(
          'https://content.dropboxapi.com/2/files/upload',
          fileContent,
          {
            headers: {
              'Authorization': `Bearer ${dropboxToken}`,
              'Dropbox-API-Arg': JSON.stringify({
                path: `/${fileName}`,
                mode: 'add',
                autorename: true,
                mute: false
              }),
              'Content-Type': 'application/octet-stream'
            }
          }
        );

        // Get the shared link for the file
        try {
          const shareResponse = await axios.post(
            'https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings',
            {
              path: response.data.path_lower,
              settings: {
                requested_visibility: 'public'
              }
            },
            {
              headers: {
                'Authorization': `Bearer ${dropboxToken}`,
                'Content-Type': 'application/json'
              }
            }
          );
          backup.cloudUrl = shareResponse.data.url;
        } catch (shareErr) {
          // If shared link already exists, get existing links or use direct link
          if (shareErr.response?.data?.error?.['.tag'] === 'shared_link_already_exists') {
            try {
              const listResponse = await axios.post(
                'https://api.dropboxapi.com/2/sharing/list_shared_links',
                { path: response.data.path_lower },
                {
                  headers: {
                    'Authorization': `Bearer ${dropboxToken}`,
                    'Content-Type': 'application/json'
                  }
                }
              );
              if (listResponse.data.links.length > 0) {
                backup.cloudUrl = listResponse.data.links[0].url;
              } else {
                backup.cloudUrl = `https://www.dropbox.com/home${response.data.path_display}`;
              }
            } catch (listErr) {
              backup.cloudUrl = `https://www.dropbox.com/home${response.data.path_display}`;
            }
          } else {
            backup.cloudUrl = `https://www.dropbox.com/home${response.data.path_display}`;
          }
        }

        console.log('Dropbox upload successful! Path:', response.data.path_display);
      } catch (err) {
        console.error('Dropbox upload failed:', err.message || err);
        if (err.response) {
          console.error('Dropbox Error Response:', err.response.data);
        }
        backup.cloudUrl = null;
        return { success: false, error: err.message || 'Dropbox upload failed' };
      }
    } else {
      throw new Error(`Unsupported remote backup storage provider: ${backup.storageLocation}`);
    }

    await backup.save();
    return { success: true, url: backup.cloudUrl };
  } catch (error) {
    console.error('Cloud upload failed:', error);
    return { success: false, error: error.message || 'Remote backup upload failed' };
  }
};

// @desc    Restore from backup
// @route   POST /api/backups/:id/restore
// @access  Private (Admin)
exports.restoreBackup = async (req, res) => {
  try {
    const companyId = req.company._id || req.company;

    const backup = await Backup.findOne({
      _id: req.params.id,
      company: companyId
    });

    if (!backup) {
      return res.status(404).json({
        success: false,
        message: 'Backup not found'
      });
    }

    if (backup.status !== 'completed' && backup.status !== 'verified') {
      return res.status(400).json({
        success: false,
        message: 'Cannot restore from incomplete or failed backup'
      });
    }

    // Start restore process in background
    performRestore(backup._id, companyId, req.user?._id).catch(err => {
      console.error('Restore failed:', err);
    });

    res.json({
      success: true,
      message: 'Restore process initiated successfully',
      data: backup
    });
  } catch (error) {
    console.error('Error restoring backup:', error);
    res.status(500).json({
      success: false,
      message: 'Server error restoring backup',
      error: error.message
    });
  }
};

// Perform the actual restore
const performRestore = async (backupId, companyId, userId) => {
  const backup = await Backup.findById(backupId);
  if (!backup) return;

  try {
    // Refuse a knowingly-partial archive. Restoring one deletes the company's
    // current rows for every collection it does contain, so restoring from an
    // archive that is already missing collections destroys data that the backup
    // cannot put back.
    if (backup.status === 'completed_with_errors') {
      throw new Error(
        'Refusing to restore: this backup completed with errors and is missing at least one '
        + 'collection. Restoring would delete current data that the archive cannot replace.',
      );
    }

    backup.status = 'restoring';
    backup.restore.restoredAt = new Date();
    backup.restore.restoredBy = userId;
    await backup.save();

    const backupDir = getBackupDir();
    const filePath = backup.filePath;

    if (!fs.existsSync(filePath)) {
      throw new Error('Backup file not found');
    }

    // Read and decompress backup
    const compressedData = fs.readFileSync(filePath);
    const decompressedData = zlib.gunzipSync(compressedData);
    const backupData = JSON.parse(decompressedData.toString());

    // THE authoritative completeness check: the archive's own manifest.
    //
    // The status-based refusal above is only an early-out — `status` is mutable
    // and markAsVerified() used to overwrite 'completed_with_errors' with
    // 'verified', laundering a partial archive past that gate. The manifest is a
    // property of the file itself and cannot be edited by changing a record.
    const archiveErrors = (backupData.collections || []).filter((c) => c.error);
    if (archiveErrors.length) {
      throw new Error(
        `Refusing to restore: archive is missing ${archiveErrors.length} collection(s) `
        + `(${archiveErrors.map((c) => c.name).join(', ')}). Restoring would delete current `
        + 'data that this archive cannot replace.',
      );
    }

    const expectedNames = new Set(getBackupableCollections());
    const archivedNames = (backupData.collections || []).map((collection) => collection.name);
    const duplicateNames = archivedNames.filter((name, index) => archivedNames.indexOf(name) !== index);
    const missingNames = [...expectedNames].filter((name) => !archivedNames.includes(name));
    const unexpectedNames = archivedNames.filter((name) => !expectedNames.has(name));
    if (duplicateNames.length || missingNames.length || unexpectedNames.length) {
      throw new Error(
        `Refusing incomplete or incompatible backup: ${missingNames.length} tenant model(s) missing, `
        + `${duplicateNames.length} duplicate model entr${duplicateNames.length === 1 ? 'y' : 'ies'}, `
        + `${unexpectedNames.length} unknown model(s). Create a new complete backup before restoring.`,
      );
    }
    if (!backupData.company || backupData.company.id !== companyId || backupData.companyId !== companyId) {
      throw new Error('Refusing backup: company ownership metadata is missing or does not match this tenant');
    }
    const restoreOrder = TENANT_RESTORE_ORDER;
    const archivedByName = new Map(backupData.collections.map((collection) => [collection.name, collection]));

    // Verify checksum
    const currentChecksum = generateChecksum(compressedData);
    if (currentChecksum !== backup.verification.checksum) {
      throw new Error('Backup file integrity check failed');
    }

    // ALL-OR-NOTHING RESTORE.
    //
    // Every tenant model is deleted and reinserted inside ONE PostgreSQL
    // transaction. Previously each collection was handled independently with
    // its own try/catch, so a failure partway through left the company with
    // some collections restored, some emptied by the delete, and some
    // untouched — an unrecoverable mixture, because the delete had already run.
    //
    // Errors are deliberately NOT caught per collection: the first failure must
    // abort the transaction so Postgres rolls the whole thing back.
    const restoredCounts = [];
    await runInTransaction(async (tx) => {
      const companySnapshot = restoreScalarTypes(COMPANY_MODEL, backupData.company);
      delete companySnapshot.id;
      await tx.company.update({ where: { id: companyId }, data: companySnapshot });

      // Nullable tenant-to-tenant references are cleared first so optional
      // cycles (for example an asset pointing at its disposal event) cannot
      // prevent a safe child-first delete.
      for (const model of restoreOrder) {
        const nullableFields = getTenantRelations(model)
          .filter((relation) => relation.nullable)
          .flatMap((relation) => relation.fields);
        if (nullableFields.length) {
          const data = Object.fromEntries([...new Set(nullableFields)].map((field) => [field, null]));
          await tx[model.delegateName].updateMany({ where: { [model.ownerField]: companyId }, data });
        }
      }

      for (const model of [...restoreOrder].reverse()) {
        await tx[model.delegateName].deleteMany({ where: { [model.ownerField]: companyId } });
      }

      const deferredRelationUpdates = [];
      for (const model of restoreOrder) {
        const collection = archivedByName.get(model.name);
        if (!Array.isArray(collection.data) || collection.data.length !== collection.documentCount) {
          throw new Error(`Backup row count is invalid for ${model.name}`);
        }
        const nullableRelations = getTenantRelations(model).filter((relation) => relation.nullable);
        const rows = collection.data.map((archivedRecord) => {
          const record = restoreScalarTypes(model, archivedRecord);
          record[model.ownerField] = companyId;
          for (const relation of nullableRelations) {
            const deferred = {};
            for (const field of relation.fields) {
              if (record[field] !== undefined && record[field] !== null) {
                deferred[field] = record[field];
                record[field] = null;
              }
            }
            if (Object.keys(deferred).length) deferredRelationUpdates.push({ model, record, data: deferred });
          }
          return record;
        });

        for (let offset = 0; offset < rows.length; offset += BACKUP_PAGE_SIZE) {
          await tx[model.delegateName].createMany({ data: rows.slice(offset, offset + BACKUP_PAGE_SIZE) });
        }
        restoredCounts.push(`${model.name}: ${rows.length}`);
      }

      for (const update of deferredRelationUpdates) {
        const result = await tx[update.model.delegateName].updateMany({
          where: getPrimaryWhere(update.model, update.record, companyId),
          data: update.data,
        });
        if (result.count !== 1) throw new Error(`Could not restore a deferred relation for ${update.model.name}`);
      }
    }, {
      // A full-company restore writes far more than an ordinary request. Without
      // a raised timeout Prisma aborts mid-restore — which now rolls back
      // safely, but fails work that would otherwise have succeeded.
      timeout: Number(process.env.RESTORE_TRANSACTION_TIMEOUT_MS) || 120000,
      maxWait: Number(process.env.RESTORE_TRANSACTION_MAX_WAIT_MS) || 10000,
    });

    console.log(`[restore] Restored ${restoredCounts.length} collections: ${restoredCounts.join(', ')}`);

    // Reaching here means the transaction committed, so every collection was
    // restored. There is no longer a "partially restored" outcome to report:
    // any failure above throws, the transaction rolls back, and the outer catch
    // records the backup as failed with the database untouched.
    backup.status = 'verified';
    await backup.save();

    console.log(`Restore from backup ${backupId} completed successfully`);
  } catch (error) {
    console.error('Restore failed:', error);
    backup.status = 'failed';
    backup.errorMessage = error.message;
    await backup.save();
  }
};

// @desc    Verify backup integrity
// @route   POST /api/backups/:id/verify
// @access  Private (Admin)
exports.verifyBackup = async (req, res) => {
  try {
    const companyId = req.company._id || req.company;

    const backup = await Backup.findOne({
      _id: req.params.id,
      company: companyId
    });

    if (!backup) {
      return res.status(404).json({
        success: false,
        message: 'Backup not found'
      });
    }

    if (backup.status !== 'completed') {
      return res.status(400).json({
        success: false,
        message: 'Can only verify completed backups'
      });
    }

    // Verify backup in background
    performVerification(backup._id, req.user?._id).catch(err => {
      console.error('Verification failed:', err);
    });

    res.json({
      success: true,
      message: 'Backup verification initiated'
    });
  } catch (error) {
    console.error('Error verifying backup:', error);
    res.status(500).json({
      success: false,
      message: 'Server error verifying backup',
      error: error.message
    });
  }
};

// Perform backup verification
const performVerification = async (backupId, userId) => {
  const backup = await Backup.findById(backupId);
  if (!backup) return;

  try {
    const backupDir = getBackupDir();
    const filePath = backup.filePath;

    if (!fs.existsSync(filePath)) {
      backup.verification.integrityStatus = 'missing';
      backup.verification.errorMessage = 'Backup file not found';
      await backup.save();
      return;
    }

    // Read and verify checksum
    const fileData = fs.readFileSync(filePath);
    const currentChecksum = generateChecksum(fileData);

    backup.verification.verified = currentChecksum === backup.verification.checksum;
    backup.verification.verifiedAt = new Date();
    backup.verification.verifiedBy = userId;

    if (backup.verification.verified) {
      backup.verification.integrityStatus = 'valid';
      backup.status = 'verified';
    } else {
      backup.verification.integrityStatus = 'corrupted';
      backup.verification.errorMessage = 'Checksum mismatch - backup may be corrupted';
    }

    await backup.save();
    console.log(`Backup ${backupId} verification completed: ${backup.verification.verified}`);
  } catch (error) {
    console.error('Verification failed:', error);
    backup.verification.integrityStatus = 'corrupted';
    backup.verification.errorMessage = error.message;
    await backup.save();
  }
};

// @desc    Delete backup
// @route   DELETE /api/backups/:id
// @access  Private (Admin)
exports.deleteBackup = async (req, res) => {
  try {
    const companyId = req.company._id || req.company;

    const backup = await Backup.findOne({
      _id: req.params.id,
      company: companyId
    });

    if (!backup) {
      return res.status(404).json({
        success: false,
        message: 'Backup not found'
      });
    }

    // Delete local file if exists
    if (backup.filePath && fs.existsSync(backup.filePath)) {
      fs.unlinkSync(backup.filePath);
    }

    await backup.deleteOne();

    res.json({
      success: true,
      message: 'Backup deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting backup:', error);
    res.status(500).json({
      success: false,
      message: 'Server error deleting backup',
      error: error.message
    });
  }
};

// @desc    Get available full backup snapshots
// @route   GET /api/backups/snapshots
// @access  Private
exports.getSnapshots = async (req, res) => {
  try {
    const companyId = req.company._id || req.company;

    const candidateBackups = await Backup.find({
      company: companyId,
      status: { $in: ['completed', 'verified', 'completed_with_errors'] }
    })
      .select('name createdAt fileSize collections status filePath')
      .sort({ createdAt: -1 })
      .limit(100);

    // Keep null filtering out of the legacy query shim: Mongo's `$ne: null`
    // cannot be represented by this Prisma compatibility layer.
    const backups = candidateBackups.filter((backup) => Boolean(backup.filePath));

    const snapshots = backups.map(b => ({
      id: b._id,
      name: b.name,
      timestamp: b.createdAt,
      fileSize: b.fileSize,
      totalDocuments: (b.collections || []).reduce((sum, c) => sum + (c.documentCount || 0), 0),
      status: b.status,
      restorable: ['completed', 'verified'].includes(b.status),
    }));

    res.json({
      success: true,
      data: snapshots
    });
  } catch (error) {
    console.error('Error getting backup snapshots:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// Backward-compatible alias for older clients. This returns ordinary backup
// snapshots and has never provided database point-in-time recovery.
exports.getPointsInTime = exports.getSnapshots;

// @desc    Get backup settings
// @route   GET /api/backups/settings
// @access  Private (Admin)
exports.getBackupSettings = async (req, res) => {
  try {
    const companyId = req.company._id || req.company;

    // Get the backup settings document (type: 'scheduled')
    let settings = await Backup.findOne({
      company: companyId,
      type: 'scheduled'
    }).sort({ createdAt: -1 });

    // Return default settings if none exist
    if (!settings) {
      return res.json({
        success: true,
        data: {
          enabled: false,
          frequency: 'daily',
          retention: 30,
          storageLocation: 'local',
          autoVerify: true,
          lastRun: null,
          nextRun: null,
        }
      });
    }

    res.json({
      success: true,
      data: {
        enabled: settings.schedule?.enabled || false,
        frequency: settings.schedule?.frequency || 'daily',
        retention: settings.retention?.keepForDays || 30,
        storageLocation: settings.storageLocation || 'local',
        autoVerify: true,
        lastRun: settings.schedule?.lastRun || null,
        nextRun: settings.schedule?.nextRun || null,
        cloudConfig: settings.cloudConfig
      }
    });
  } catch (error) {
    console.error('Error getting backup settings:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// @desc    Update backup settings
// @route   PUT /api/backups/settings
// @access  Private (Admin)
exports.updateBackupSettings = async (req, res) => {
  try {
    const companyId = req.company._id || req.company;
    const { enabled, cloudConfig } = req.body;
    const validFrequencies = new Set(['hourly', 'daily', 'weekly', 'monthly']);
    const validStorageLocations = new Set(['local', 'cloud', 's3', 'google-drive', 'dropbox']);
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ success: false, message: 'enabled must be a boolean.' });
    }

    // Create or update backup settings
    let backupSettings = await Backup.findOne({
      company: companyId,
      type: 'scheduled'
    });

    if (!backupSettings) {
      backupSettings = new Backup({
        company: companyId,
        name: 'Scheduled Backup Settings',
        type: 'scheduled',
        status: 'pending'
      });
    }

    const frequency = req.body.frequency || backupSettings.schedule?.frequency || 'daily';
    const storageLocation = req.body.storageLocation || backupSettings.storageLocation || 'local';
    const retention = req.body.retention ?? backupSettings.retention?.keepForDays ?? 30;
    if (!validFrequencies.has(frequency)) {
      return res.status(400).json({ success: false, message: 'frequency must be hourly, daily, weekly, or monthly.' });
    }
    if (!validStorageLocations.has(storageLocation)) {
      return res.status(400).json({ success: false, message: 'Unsupported backup storage location.' });
    }
    if (!Number.isInteger(Number(retention)) || Number(retention) < 1 || Number(retention) > 365) {
      return res.status(400).json({ success: false, message: 'retention must be between 1 and 365 days.' });
    }

    const now = new Date();
    const intervalMs = {
      hourly: 60 * 60 * 1000,
      daily: 24 * 60 * 60 * 1000,
      weekly: 7 * 24 * 60 * 60 * 1000,
      monthly: 30 * 24 * 60 * 60 * 1000,
    }[frequency];
    const schedule = {
      ...(backupSettings.schedule || {}),
      enabled,
      frequency,
      autoVerify: true,
      nextRun: enabled ? new Date(now.getTime() + intervalMs).toISOString() : null,
      cronExpression: ({ hourly: 'hourly', daily: 'daily', weekly: 'weekly', monthly: 'monthly' })[frequency],
    };
    if (!enabled) schedule.nextRun = null;
    backupSettings.schedule = schedule;
    backupSettings.retention = {
      ...(backupSettings.retention || {}),
      keepForDays: Number(retention),
      autoDelete: true,
    };
    backupSettings.storageLocation = storageLocation;

    if (cloudConfig) {
      backupSettings.cloudConfig = {
        provider: cloudConfig.provider || 'local',
        bucket: cloudConfig.bucket,
        region: cloudConfig.region
      };
    }

    await backupSettings.save();

    res.json({
      success: true,
      message: 'Backup settings updated successfully',
      data: {
        enabled: schedule.enabled,
        frequency: schedule.frequency,
        retention: backupSettings.retention.keepForDays,
        storageLocation: backupSettings.storageLocation,
        autoVerify: true,
        lastRun: schedule.lastRun || null,
        nextRun: schedule.nextRun,
        cloudConfig: backupSettings.cloudConfig,
      },
    });
  } catch (error) {
    console.error('Error updating backup settings:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// @desc    Download backup file
// @route   GET /api/backups/:id/download
// @access  Private (Admin)
exports.downloadBackup = async (req, res) => {
  try {
    const companyId = req.company._id || req.company;

    const backup = await Backup.findOne({
      _id: req.params.id,
      company: companyId
    });

    if (!backup) {
      return res.status(404).json({
        success: false,
        message: 'Backup not found'
      });
    }

    if (!backup.filePath || !fs.existsSync(backup.filePath)) {
      return res.status(404).json({
        success: false,
        message: 'Backup file not found'
      });
    }

    res.download(backup.filePath, path.basename(backup.filePath));
  } catch (error) {
    console.error('Error downloading backup:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// @desc    Get backup statistics
// @route   GET /api/backups/stats
// @access  Private
exports.getBackupStats = async (req, res) => {
  try {
    const companyId = req.company._id || req.company;

    const stats = await Backup.aggregate([
      { $match: { company: new mongoose.Types.ObjectId(companyId) } },
      {
        $group: {
          _id: null,
          totalBackups: { $sum: 1 },
          completedBackups: {
            $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] }
          },
          verifiedBackups: {
            $sum: { $cond: [{ $eq: ['$status', 'verified'] }, 1, 0] }
          },
          failedBackups: {
            $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] }
          },
          totalSize: { $sum: '$fileSize' },
          lastBackup: { $max: '$createdAt' }
        }
      }
    ]);

    const result = stats[0] || {
      totalBackups: 0,
      completedBackups: 0,
      verifiedBackups: 0,
      failedBackups: 0,
      totalSize: 0,
      lastBackup: null
    };

    res.json({
      success: true,
      data: {
        ...result,
        formattedTotalSize: result.totalSize === 0 ? '0 B' :
          formatBytes(result.totalSize)
      }
    });
  } catch (error) {
    console.error('Error getting backup stats:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Export for scheduled jobs
module.exports.performBackup = performBackup;
module.exports.performRestore = performRestore;
module.exports.performVerification = performVerification;
