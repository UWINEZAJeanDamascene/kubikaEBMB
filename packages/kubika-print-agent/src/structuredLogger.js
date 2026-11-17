const fs = require('fs');
const path = require('path');

const SECRET = /((?:authorization|access[_ -]?token|refresh[_ -]?token|pairing[_ -]?code|password|secret|drawerAuthorizationToken)\s*[:=]\s*)(?:bearer\s+)?[^\s,;"']+/ig;
const MAX_BYTES = 1024 * 1024;
const KEEP_FILES = 5;

function redact(value) {
  if (typeof value === 'string') return value.replace(SECRET, '$1[REDACTED]').slice(0, 2000);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key, /token|password|secret|pairingCode/i.test(key) ? '[REDACTED]' : redact(item),
    ]));
  }
  return value;
}

function createLogger(dataDir, targetConsole = console) {
  const logDir = path.join(dataDir, 'logs');
  const logFile = path.join(logDir, 'agent.jsonl');
  const outputs = Object.fromEntries(['log', 'info', 'warn', 'error'].map((level) => [
    level, (targetConsole[level] || targetConsole.log).bind(targetConsole),
  ]));
  fs.mkdirSync(logDir, { recursive: true });
  function write(level, args) {
    const entry = { timestamp: new Date().toISOString(), level, message: redact(args.map((arg) => arg instanceof Error ? arg.message : arg).join(' ')) };
    try {
      if (fs.existsSync(logFile) && fs.statSync(logFile).size >= MAX_BYTES) {
        for (let i = KEEP_FILES - 1; i >= 1; i -= 1) {
          const from = `${logFile}.${i}`;
          const to = `${logFile}.${i + 1}`;
          if (fs.existsSync(from)) {
            if (i === KEEP_FILES - 1 && fs.existsSync(to)) fs.unlinkSync(to);
            fs.renameSync(from, to);
          }
        }
        fs.renameSync(logFile, `${logFile}.1`);
      }
      fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch { /* logging must not interrupt printing */ }
    outputs[level](JSON.stringify(entry));
  }
  return {
    logFile,
    log: (...args) => write('log', args),
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
  };
}

function readRedactedDiagnostics(logFile, maxBytes = 256 * 1024) {
  if (!fs.existsSync(logFile)) return { exportedAt: new Date().toISOString(), logs: [] };
  const contents = fs.readFileSync(logFile, 'utf8').slice(-maxBytes);
  const logs = contents.split(/\r?\n/).filter(Boolean).map((line) => {
    try { return redact(JSON.parse(line)); } catch { return { level: 'info', message: redact(line) }; }
  });
  return { exportedAt: new Date().toISOString(), logs };
}

module.exports = { createLogger, readRedactedDiagnostics, redact };
