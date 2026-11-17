const crypto = require('crypto');
const { drawerCommand, payloadHash } = require('./escpos');
const { renderReceiptEscPos, renderThermalDocument } = require('../../kubika-receipt-renderer/index.cjs');
const { printTcp9100, printWindowsSpoolerRaw, printPdfWindows } = require('./transports');

function retryDelay(attemptCount) {
  return [2000, 5000, 10000, 30000][Math.min(Math.max(attemptCount - 1, 0), 3)];
}

async function transmitJob(job, printer, ledger, { afterBytesSent, backendUrl, printPdf = printPdfWindows } = {}) {
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
    companyId: job.companyId,
    registerId: job.registerId,
    jobType,
    localOnly: job.localOnly,
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
      if (printer?.transport !== 'windows-spooler') {
        throw Object.assign(new Error('A4 PDF printing requires a selected Windows spooler printer.'), {
          code: 'PRINT_A4_PRINTER_UNAVAILABLE',
        });
      }
      const signedUrl = payload.signedUrl || payload.downloadUrl || payload.url;
      let pdf;
      if (signedUrl) {
        if (!backendUrl) throw new Error('The configured backend origin is unavailable for signed PDF retrieval.');
        const target = new URL(String(signedUrl), backendUrl);
        const backendOrigin = new URL(backendUrl).origin;
        if (target.origin !== backendOrigin
          || !target.pathname.startsWith('/api/pos/print-agent/documents/')
          || !target.searchParams.has('expires')
          || !target.searchParams.has('signature')) {
          throw Object.assign(new Error('The A4 document URL is not a valid signed Kubika print URL.'), {
            code: 'PRINT_DOCUMENT_URL_INVALID',
          });
        }
        const response = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(30000) });
        if (!response.ok || response.status >= 300) {
          throw Object.assign(new Error(`Signed invoice download failed with HTTP ${response.status}.`), {
            code: response.status === 403 || response.status === 410 ? 'PRINT_DOCUMENT_URL_EXPIRED' : 'PRINT_DOCUMENT_DOWNLOAD_FAILED',
          });
        }
        const contentType = String(response.headers.get('content-type') || '').toLowerCase();
        const contentLength = Number(response.headers.get('content-length') || 0);
        if (!contentType.startsWith('application/pdf') || (contentLength && contentLength > 20 * 1024 * 1024)) {
          throw Object.assign(new Error('The signed document response is not a supported PDF.'), {
            code: 'PRINT_DOCUMENT_INVALID',
          });
        }
        pdf = Buffer.from(await response.arrayBuffer());
      } else {
        const base64 = payload.pdfBase64 || payload.pdfData || payload.base64 || null;
        if (!base64) throw new Error('PDF payload is missing a signed document URL.');
        pdf = Buffer.from(base64, 'base64');
      }
      if (!pdf.length || pdf.length > 20 * 1024 * 1024) throw new Error('The invoice PDF is empty or exceeds 20 MB.');
      const printOptions = {};
      const tray = Object.prototype.hasOwnProperty.call(payload, 'tray') ? payload.tray : printer?.tray;
      const duplex = Object.prototype.hasOwnProperty.call(payload, 'duplex') ? payload.duplex : printer?.duplex;
      if (tray !== undefined) printOptions.tray = tray;
      if (duplex !== undefined) printOptions.duplex = duplex;
      await printPdf(printer.address || printer.name, pdf, Number(payload.copies || printer.copies || 1), printOptions);
    } else {
      const columns = Number(['gift-card-slip', 'z-report'].includes(jobType)
        ? payload.columns ?? printer?.columns ?? (payload.paperWidthMm === 58 ? 32 : 42)
        : printer?.columns ?? payload.columns ?? (payload.paperWidthMm === 58 ? 32 : 42));
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
      companyId: job.companyId,
      registerId: job.registerId,
      jobType,
      localOnly: job.localOnly,
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
      companyId: job.companyId,
      registerId: job.registerId,
      jobType,
      localOnly: job.localOnly,
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
