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

function mergePrinterProfiles(discovered, existing) {
  const identity = (printer) => `${printer.transport}:${printer.address || printer.name}`;
  const saved = Array.isArray(existing) ? existing : [];
  const profiles = new Map(saved.map((printer) => [identity(printer), printer]));
  const merged = discovered.map((printer) => {
    const profile = profiles.get(identity(printer));
    if (!profile) return { ...printer, isDefault: false };
    return {
      ...printer,
      paperWidthMm: profile.paperWidthMm,
      columns: profile.columns,
      codePage: profile.codePage,
      role: profile.role,
      capabilities: profile.capabilities,
      drawerEnabled: profile.drawerEnabled,
      drawerPin: profile.drawerPin,
      pulseOnMs: profile.pulseOnMs,
      pulseOffMs: profile.pulseOffMs,
      isDefault: Boolean(profile.isDefault),
    };
  });
  if (!merged.some((printer) => printer.isDefault) && merged.length) {
    const fallback = discovered.find((printer) => printer.isDefault) || merged[0];
    const fallbackIdentity = identity(fallback);
    const selected = merged.find((printer) => identity(printer) === fallbackIdentity);
    if (selected) selected.isDefault = true;
  }
  return merged;
}

module.exports = { discoverWindowsPrinters, mergePrinterProfiles };
