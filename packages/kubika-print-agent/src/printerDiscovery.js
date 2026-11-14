const { spawnSync } = require('child_process');

function discoverWindowsPrinters() {
  if (process.platform !== 'win32') return [];
  const script = `
    Get-CimInstance Win32_Printer | ForEach-Object {
      [PSCustomObject]@{ name=$_.Name; address=$_.Name; driver=$_.DriverName; port=$_.PortName; default=$_.Default } |
      ConvertTo-Json -Compress
    }
  `;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(String(result.stderr || 'Windows printer discovery failed.'));
  return String(result.stdout || '').split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean).map((printer) => ({
    name: printer.name,
    transport: 'windows-spooler',
    address: printer.address,
    driver: printer.driver,
    port: printer.port,
    isDefault: Boolean(printer.default),
    status: 'discovered',
  }));
}

module.exports = { discoverWindowsPrinters };
