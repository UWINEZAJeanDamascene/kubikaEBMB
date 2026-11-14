const crypto = require('crypto');
const { renderThermal, drawerCommand, payloadHash } = require('./escpos');
const { printTcp9100, printWindowsSpoolerRaw, printPdfWindows } = require('./transports');

function retryDelay(attemptCount) {
  return [2000, 5000, 10000, 30000][Math.min(Math.max(attemptCount - 1, 0), 3)];
}

async function transmitJob(job, printer, ledger, { afterBytesSent } = {}) {
  const existing = ledger.get(job.id);
  const copyRequired = Boolean(job.copy_required || job.copyRequired);
  if (existing) {
    const alreadyCompleted = ['transmitted', 'confirmed'].includes(existing.status);
    if (!copyRequired || !alreadyCompleted) {
      throw Object.assign(new Error('This print job already has an outcome and cannot be sent again automatically.'), {
        status: 409,
        code: existing.status === 'uncertain' || existing.status === 'transmitting'
          ? 'PRINT_JOB_OUTCOME_UNCERTAIN'
          : 'PRINT_DUPLICATE_REFUSED',
      });
    }
  }
  const payload = job.payloadJson || job.payload_json || {};
  const hash = payloadHash(payload);

  ledger.save({
    jobId: job.id,
    status: 'transmitting',
    printerId: printer?.id || null,
    payloadHash: hash,
    attemptCount: (existing?.attempt_count || 0) + 1,
    error: null,
  });

  try {
    if (job.jobType === 'drawer-open' || job.job_type === 'drawer-open') {
      const pin = Number(printer?.drawerPin || printer?.drawer_pin || 2);
      const onMs = Number(printer?.pulseOnMs || printer?.pulse_on_ms || 25);
      const offMs = Number(printer?.pulseOffMs || printer?.pulse_off_ms || 500);
      const bytes = drawerCommand(pin, onMs, offMs);
      await sendBytes(printer, bytes);
    } else if (job.jobType === 'invoice-pdf' || job.jobType === 'report-pdf') {
      const base64 = payload.pdfBase64 || payload.pdfData || payload.base64 || null;
      if (!base64) throw new Error('PDF payload is missing pdfBase64.');
      await printPdfWindows(printer?.address || printer?.name, Buffer.from(base64, 'base64'), Number(payload.copies || 1));
    } else {
      const bytes = renderThermal(payload, {
        columns: Number(printer?.columns || payload.columns || (payload.paperWidthMm === 58 ? 32 : 42)),
        copy: copyRequired,
      });
      await sendBytes(printer, bytes);
    }

    if (afterBytesSent) await afterBytesSent();
    ledger.save({
      jobId: job.id,
      status: 'transmitted',
      printerId: printer?.id || null,
      payloadHash: hash,
      printedAt: new Date().toISOString(),
      attemptCount: (existing?.attempt_count || 0) + 1,
    });
    ledger.markPrinted(job.id);
    return { transmitted: true, copyRequired };
  } catch (error) {
    ledger.save({
      jobId: job.id,
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
