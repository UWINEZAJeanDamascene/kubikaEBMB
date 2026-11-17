const { spawnSync } = require('child_process');

function discoverWindowsPrinters() {
  if (process.platform !== 'win32') return [];
  const script = `
    $spooler = Get-Service -Name Spooler -ErrorAction SilentlyContinue
    Get-Printer | ForEach-Object {
      $p = $_
      $cim = Get-CimInstance Win32_Printer -Filter ("Name='" + ($p.Name -replace "'", "''") + "'") -ErrorAction SilentlyContinue
      $jobs = @(Get-PrintJob -PrinterName $p.Name -ErrorAction SilentlyContinue)
      $stuck = $jobs | Where-Object { $_.JobStatus -match 'Paused|Error|Offline|PaperOut|DoorOpen' -or ($_.SubmittedTime -and $_.SubmittedTime -lt (Get-Date).AddMinutes(-5) -and $_.JobStatus -notmatch 'Printing') } | Select-Object -First 1
      $state = if (-not $spooler -or $spooler.Status -ne 'Running') { 'spooler-stopped' }
        elseif ($p.PrinterStatus -eq 7 -or $p.WorkOffline -or $cim.WorkOffline -or $cim.DetectedErrorState -in @(7, 8)) { 'offline' }
        elseif ($cim.DetectedErrorState -eq 4) { 'paper-out' }
        elseif ($cim.DetectedErrorState -eq 6) { 'cover-open' }
        elseif ($jobs | Where-Object { $_.JobStatus -match 'Paused' } | Select-Object -First 1) { 'paused' }
        elseif ($stuck) { 'spooler-stuck' }
        elseif ($cim.DetectedErrorState -in @(9, 10, 11, 12) -or $p.PrinterStatus -eq 6) { 'error' }
        else { 'ready' }
      [PSCustomObject]@{ name=$p.Name; address=$p.Name; driver=$p.DriverName; port=$p.PortName; default=$p.Default; status=$state; statusMessage=$(if ($state -eq 'spooler-stopped') { 'Windows Print Spooler is stopped.' } elseif ($state -eq 'offline') { 'Printer is offline.' } elseif ($state -eq 'paper-out') { 'Printer reports paper out.' } elseif ($state -eq 'cover-open') { 'Printer reports its cover is open.' } elseif ($state -eq 'paused') { 'Printer queue is paused.' } elseif ($state -eq 'spooler-stuck') { 'A printer job appears paused or stuck in the Windows spooler.' } elseif ($state -eq 'error') { 'Printer reports an error.' } else { $null }) } |
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
    status: printer.status || 'unknown',
    lastError: printer.statusMessage || null,
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
      paperSize: profile.paperSize,
      copies: profile.copies,
      tray: profile.tray,
      duplex: profile.duplex,
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
