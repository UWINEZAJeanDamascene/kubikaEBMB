const path = require('path');

const appData = process.env.ProgramData || process.env.LOCALAPPDATA || process.cwd();
const dataDir = process.env.KUBIKA_PRINT_AGENT_DATA_DIR || path.join(appData, 'Kubika', 'PrintAgent');
// Keep source development local while allowing a production install to use the hosted API.
const defaultBackendUrl = process.env.NODE_ENV === 'production'
  ? 'https://kubikapos.up.railway.app'
  : 'http://127.0.0.1:3000';

module.exports = {
  dataDir,
  localPort: Number(process.env.KUBIKA_PRINT_AGENT_PORT || 19100),
  backendUrl: String(process.env.KUBIKA_BACKEND_URL || defaultBackendUrl).replace(/\/+$/, ''),
  pollIntervalMs: Number(process.env.KUBIKA_PRINT_POLL_MS || 10000),
  leaseTimeoutMs: 30000,
};
