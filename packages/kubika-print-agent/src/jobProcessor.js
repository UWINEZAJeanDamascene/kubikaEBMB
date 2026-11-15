const crypto = require('crypto');
const { drawerCommand, payloadHash } = require('./escpos');
const { renderReceiptEscPos, renderThermalDocument } = require('../../kubika-receipt-renderer/index.cjs');
const { printTcp9100, printWindowsSpoolerRaw, printPdfWindows } = require('./transports');

function retryDelay(attemptCount) {
  return [2000, 5000, 10000, 30000][Math.min(Math.max(attemptCount - 1, 0), 3)];
}

async function transmitJob(job, printer, ledger, { afterBytesSent } = {}) {
  const jobType = job.jobType || job.job_type;
  const payload = job.payloadJson || job.payload_json || {};
  const receipt = payload.receiptDocument || payload.receipt || (payload.version === 1 ? payload : null);
  if (['receipt', 'refund-receipt'].includes(jobType)) {
    const key = String(job.idempotencyKey || job.idempotency_key || job.id || '');
    const match = /^([a-f\d]{24}):(0|[1-9]\d*):(receipt|refund-receipt)$/i.exec(key);
    const copyNumber = Number(receipt?.flags?.copyNumber || 0);
    const isCopy = Boolean(receipt?.flags?.isCopy);
    if (!match
      || match[3] !== jobType
      || !Number.isSafeInteger(copyNumber)
      || Number(match[2]) !== copyNumber
      || isCopy !== (copyNumber > 0)) {
      throw Object.assign(new Error('Receipt document, copy number, and print-job key do not match.'), {
        status: 400,
        code: 'PRINT_JOB_COPY_KEY_MISMATCH',
      });
    }
  }

  const ledgerJobId = String(job.idempotencyKey || job.idempotency_key || job.id);
  const existing = ledger.get(ledgerJobId);
  const copyRequired = Boolean(job.copy_required || job.copyRequired);
  if (existing) {
    throw Object.assign(new Error('This print-job identity already has an outcome and cannot be sent again.'), {
      status: 409,
      code: existing.status === 'uncertain' || existing.status === 'transmitting'
        ? 'PRINT_JOB_OUTCOME_UNCERTAIN'
        : 'PRINT_DUPLICATE_REFUSED',
    });
  }
  const hash = payloadHash(payload);

  ledger.save({
    jobId: ledgerJobId,
    status: 'transmitting',
    printerId: printer?.id || null,
    payloadHash: hash,
    attemptCount: (existing?.attempt_count || 0) + 1,
    error: null,
  });

  try {
    if (jobType === 'drawer-open') {
      const pin = Number(printer?.drawerPin || printer?.drawer_pin || 2);
      const onMs = Number(printer?.pulseOnMs || printer?.pulse_on_ms || 25);
      const offMs = Number(printer?.pulseOffMs || printer?.pulse_off_ms || 500);
      const bytes = drawerCommand(pin, onMs, offMs);
      await sendBytes(printer, bytes);
    } else if (['invoice-pdf', 'statement-pdf', 'report-pdf'].includes(jobType)) {
      const base64 = payload.pdfBase64 || payload.pdfData || payload.base64 || null;
      if (!base64) throw new Error('PDF payload is missing pdfBase64.');
      await printPdfWindows(printer?.address || printer?.name, Buffer.from(base64, 'base64'), Number(payload.copies || 1));
    } else {
      const columns = Number(printer?.columns ?? payload.columns ?? (payload.paperWidthMm === 58 ? 32 : 42));
      const renderOptions = {
          columns,
          codeTable: Number(printer?.codePage ?? printer?.code_page ?? payload.codeTable ?? 16),
          labels: payload.labels,
          qrMode: receipt?.fiscal?.qrPayload || (receipt?.fiscal?.qrData && !String(receipt.fiscal.qrData).startsWith('data:'))
            ? 'native'
            : receipt?.fiscal?.qrRaster ? 'raster' : 'none',
          cut: true,
        };
      const bytes = receipt?.version === 1
        ? renderReceiptEscPos(receipt, renderOptions)
        : renderThermalDocument({ ...payload, copyRequired }, { ...renderOptions, jobType });
      await sendBytes(printer, bytes);
    }

    if (afterBytesSent) await afterBytesSent();
    ledger.save({
      jobId: ledgerJobId,
      status: 'transmitted',
      printerId: printer?.id || null,
      payloadHash: hash,
      printedAt: new Date().toISOString(),
      attemptCount: (existing?.attempt_count || 0) + 1,
    });
    ledger.markPrinted(ledgerJobId);
    return { transmitted: true, copyRequired };
  } catch (error) {
    ledger.save({
      jobId: ledgerJobId,
      status: 'uncertain',
      printerId: printer?.id || null,
      payloadHash: hash,
      error: error.message,
      attemptCount: (existing?.attempt_count || 0) + 1,
    });
    throw error;
  }
}

function shouldSkipAutomaticRetry(job) {
  const status = String(job?.status || '').toLowerCase();
  return ['transmitted', 'confirmed', 'uncertain'].includes(status);
}

async function sendBytes(printer, bytes) {
  if (!printer) throw new Error('No printer is configured for this agent.');
  if (printer.transport === 'tcp9100') return printTcp9100(printer.address, bytes);
  if (printer.transport === 'windows-spooler') return printWindowsSpoolerRaw(printer.address || printer.name, bytes);
  throw new Error(`Unsupported printer transport: ${printer.transport || 'unknown'}`);
}

module.exports = { transmitJob, retryDelay, shouldSkipAutomaticRetry };
