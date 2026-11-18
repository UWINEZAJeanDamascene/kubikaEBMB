const path = require('path');
const fs = require('fs');
const multer = require('multer');
const ImportTemplate = require('../models/ImportTemplate');
const ImportLog = require('../models/ImportLog');
const ImportService = require('../services/universalImportService');
const ImportQueue = require('../services/importQueueService');
const PurchaseOcrService = require('../services/purchaseOcrService');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: ImportService.MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (['.csv', '.xlsx', '.xls'].includes(ext)) return cb(null, true);
    cb(new Error('Supported formats are CSV, XLSX, and XLS.'));
  }
});

exports.uploadImportFile = upload.single('file');

const ocrUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: ImportService.MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) return cb(null, true);
    cb(new Error('OCR upload supports PNG, JPG, JPEG, and WEBP images.'));
  }
});

exports.uploadOcrFile = ocrUpload.single('file');

function companyId(req) {
  return ImportService.getCompanyId(req);
}

function userId(req) {
  return req.user?._id || req.user?.id;
}

function sendError(res, error) {
  return res.status(error.statusCode || 500).json({
    success: false,
    ...(error.code ? { code: error.code } : {}),
    message: error.message,
  });
}

exports.getEntityTypes = async (req, res) => {
  try {
    res.json({ success: true, ...(await ImportService.getImportEntityTypes(companyId(req))) });
  } catch (error) {
    sendError(res, error);
  }
};

exports.parseHeaders = async (req, res) => {
  try {
    const parsed = await ImportService.parseHeaders(
      req.file,
      req.body.entityType || req.query.entityType,
      companyId(req),
    );
    const templates = await ImportTemplate.find({ companyId: companyId(req), entityType: req.body.entityType || req.query.entityType })
      .sort({ lastUsedAt: -1, createdAt: -1 })
      .limit(5)
      .lean();
    res.json({ success: true, data: { ...parsed, savedTemplates: templates } });
  } catch (error) {
    sendError(res, error);
  }
};

exports.getTemplates = async (req, res) => {
  const templates = await ImportTemplate.find({ companyId: companyId(req), entityType: req.params.entityType })
    .sort({ lastUsedAt: -1, createdAt: -1 })
    .lean();
  res.json({ success: true, data: templates });
};

exports.createTemplate = async (req, res) => {
  try {
    const template = await ImportTemplate.create({
      companyId: companyId(req),
      entityType: req.body.entityType,
      name: req.body.name,
      columnMapping: req.body.columnMapping,
      createdBy: userId(req)
    });
    res.status(201).json({ success: true, data: template });
  } catch (error) {
    sendError(res, error);
  }
};

exports.updateTemplate = async (req, res) => {
  const template = await ImportTemplate.findOneAndUpdate(
    { _id: req.params.id, companyId: companyId(req) },
    { $set: { name: req.body.name, columnMapping: req.body.columnMapping } },
    { new: true }
  );
  if (!template) return res.status(404).json({ success: false, message: 'Import template not found.' });
  res.json({ success: true, data: template });
};

exports.deleteTemplate = async (req, res) => {
  const deleted = await ImportTemplate.findOneAndDelete({ _id: req.params.id, companyId: companyId(req) });
  if (!deleted) return res.status(404).json({ success: false, message: 'Import template not found.' });
  res.json({ success: true, data: { deleted: true } });
};

exports.validate = async (req, res) => {
  try {
    const columnMapping = typeof req.body.columnMapping === 'string'
      ? JSON.parse(req.body.columnMapping)
      : req.body.columnMapping;
    const validation = await ImportService.validateImport({
      entityType: req.body.entityType,
      mapping: columnMapping,
      rows: req.body.rows,
      file: req.file,
      companyId: companyId(req),
      expectedFiscalEntitlementVersion: req.body.fiscalEntitlementVersion,
    });
    res.json({ success: true, data: validation });
  } catch (error) {
    sendError(res, error);
  }
};

exports.process = async (req, res) => {
  try {
    const company = companyId(req);
    let rows = req.body.rows || [];
    let fiscalImportContext = null;
    if (req.body.entityType === 'products') {
      if (!Array.isArray(rows) || !rows.length || !req.body.columnMapping || typeof req.body.columnMapping !== 'object') {
        return res.status(400).json({
          success: false,
          code: 'PRODUCT_IMPORT_SOURCE_REQUIRED',
          message: 'Revalidate the product file before importing.',
        });
      }
      const sourceRows = rows.map((row) => row?.source);
      if (sourceRows.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) {
        return res.status(400).json({
          success: false,
          code: 'PRODUCT_IMPORT_SOURCE_INVALID',
          message: 'The validated product rows are incomplete. Upload and validate the file again.',
        });
      }
      const revalidated = await ImportService.validateImport({
        entityType: 'products',
        mapping: req.body.columnMapping,
        rows: sourceRows,
        companyId: company,
        expectedFiscalEntitlementVersion: req.body.fiscalEntitlementVersion,
        rowNumbers: rows.map((row) => row.rowNumber),
      });
      if (revalidated.errorRows > 0) {
        return res.status(422).json({
          success: false,
          code: 'PRODUCT_IMPORT_REVALIDATION_FAILED',
          message: 'One or more product rows failed the final validation. Review the row errors and retry.',
          data: revalidated,
        });
      }
      rows = revalidated.rows;
      fiscalImportContext = {
        fiscalEbmEnabled: revalidated.fiscalEbmEnabled,
        fiscalEntitlementVersion: revalidated.fiscalEntitlementVersion,
      };
    }

    const log = await ImportLog.create({
      companyId: company,
      entityType: req.body.entityType,
      importedBy: userId(req),
      fileName: req.body.fileName || 'uploaded-file',
      totalRows: Array.isArray(rows) ? rows.length : 0,
      templateUsed: req.body.templateId || null,
      status: 'pending'
    });

    if (req.body.templateId) {
      await ImportTemplate.updateOne({ _id: req.body.templateId, companyId: company }, {
        $inc: { useCount: 1 },
        $set: { lastUsedAt: new Date() }
      });
    }

    const job = await ImportQueue.enqueueImport({
      logId: log._id,
      entityType: req.body.entityType,
      companyId: company,
      userId: userId(req),
      rows,
      duplicateAction: req.body.duplicateAction || 'skip',
      ...(fiscalImportContext || {}),
    });
    res.status(202).json({ success: true, data: { jobId: job.jobId, logId: log._id, backend: job.backend } });
  } catch (error) {
    sendError(res, error);
  }
};

exports.progress = async (req, res) => {
  const progress = await ImportQueue.getProgress(req.params.jobId, companyId(req));
  if (!progress) return res.status(404).json({ success: false, message: 'Import job not found.' });
  res.json({ success: true, data: progress });
};

exports.history = async (req, res) => {
  const filter = { companyId: companyId(req) };
  if (req.query.entityType) filter.entityType = req.query.entityType;
  if (req.query.from || req.query.to) {
    filter.startedAt = {};
    if (req.query.from) filter.startedAt.$gte = new Date(req.query.from);
    if (req.query.to) filter.startedAt.$lte = new Date(req.query.to);
  }
  const logs = await ImportLog.find(filter).sort({ startedAt: -1 }).limit(100).lean();
  res.json({ success: true, data: logs });
};

function removeImportReport(reportUrl, logId, kind) {
  if (!reportUrl) return;
  const filename = path.basename(String(reportUrl));
  const expectedPrefix = `import-${kind}-${String(logId)}-`;
  if (!filename.startsWith(expectedPrefix) || !filename.endsWith('.csv')) return;

  const downloadsDir = path.resolve(__dirname, '..', 'downloads');
  const filePath = path.resolve(downloadsDir, filename);
  if (!filePath.startsWith(`${downloadsDir}${path.sep}`)) return;
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

exports.deleteHistory = async (req, res) => {
  try {
    const scope = { _id: req.params.id, companyId: companyId(req) };
    const log = await ImportLog.findOne(scope).lean();
    if (!log) return res.status(404).json({ success: false, message: 'Import history record not found.' });

    if (['pending', 'processing'].includes(log.status)) {
      return res.status(409).json({ success: false, message: 'An active import cannot be deleted.' });
    }
    if (!['failed', 'completed_with_errors'].includes(log.status)) {
      return res.status(400).json({ success: false, message: 'Only failed imports or imports with errors can be deleted.' });
    }

    // Remove only report files generated for this exact tenant-owned import.
    removeImportReport(log.errorReportUrl, log._id, 'errors');
    removeImportReport(log.resultsReportUrl, log._id, 'results');
    await ImportLog.findOneAndDelete(scope);

    res.json({ success: true, data: { deleted: true } });
  } catch (error) {
    sendError(res, error);
  }
};

exports.downloadErrorReport = async (req, res) => {
  const log = await ImportLog.findOne({ _id: req.params.id, companyId: companyId(req) }).lean();
  if (!log || !log.errorReportUrl) return res.status(404).json({ success: false, message: 'Error report not found.' });
  const filePath = path.join(__dirname, '..', log.errorReportUrl.replace(/^\//, ''));
  if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, message: 'Error report file not found.' });
  res.download(filePath);
};

exports.downloadResultsReport = async (req, res) => {
  const log = await ImportLog.findOne({ _id: req.params.id, companyId: companyId(req) }).lean();
  if (!log || !log.resultsReportUrl) return res.status(404).json({ success: false, message: 'Results report not found.' });
  const filePath = path.join(__dirname, '..', log.resultsReportUrl.replace(/^\//, ''));
  if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, message: 'Results report file not found.' });
  res.download(filePath);
};

exports.downloadTemplate = async (req, res) => {
  try {
    const buffer = await ImportService.generateTemplate(
      req.params.entityType,
      companyId(req),
      req.query.fiscalEntitlementVersion,
    );
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.entityType}_import_template.xlsx"`);
    res.send(Buffer.from(buffer));
  } catch (error) {
    sendError(res, error);
  }
};

exports.scanPurchaseInvoice = async (req, res) => {
  try {
    const result = await PurchaseOcrService.scanInvoice({
      companyId: companyId(req),
      file: req.file
    });
    res.json({ success: true, data: result });
  } catch (error) {
    sendError(res, error);
  }
};

exports.createPurchaseFromScannedInvoice = async (req, res) => {
  try {
    const result = await PurchaseOcrService.createDraftPurchaseFromScan({
      companyId: companyId(req),
      userId: userId(req),
      file: req.file
    });
    res.status(201).json({ success: true, data: result });
  } catch (error) {
    if (error.details) {
      return res.status(error.statusCode || 422).json({ success: false, message: error.message, data: error.details });
    }
    sendError(res, error);
  }
};
