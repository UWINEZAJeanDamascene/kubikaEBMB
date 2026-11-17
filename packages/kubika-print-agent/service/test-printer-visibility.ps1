param([switch]$SystemProbe, [string]$OutputPath)
$ErrorActionPreference = 'Stop'

if ($SystemProbe) {
  $printers = @(Get-Printer -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
  [PSCustomObject]@{ identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name; printers = $printers } |
    ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
  exit 0
}

$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this script from an elevated PowerShell window.'
}
$service = Get-CimInstance Win32_Service -Filter "Name='KubikaPrintAgent'"
if (-not $service) { throw 'Kubika Print Agent service is not installed.' }
$expected = @(Get-Printer -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name | Sort-Object -Unique)
$output = Join-Path $env:TEMP ("kubika-printer-visibility-{0}.json" -f [guid]::NewGuid())
$taskName = "KubikaPrintVisibility-$([guid]::NewGuid())"
try {
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$PSCommandPath`" -SystemProbe -OutputPath `"$output`""
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(10)
  $principalSystem = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principalSystem -Force | Out-Null
  Start-ScheduledTask -TaskName $taskName
  $deadline = (Get-Date).AddSeconds(45)
  while (-not (Test-Path -LiteralPath $output) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  if (-not (Test-Path -LiteralPath $output)) { throw 'The LocalSystem printer probe did not finish within 45 seconds.' }
  $system = Get-Content -LiteralPath $output -Raw | ConvertFrom-Json
  $systemPrinters = @($system.printers | Sort-Object -Unique)
  $missing = @($expected | Where-Object { $_ -notin $systemPrinters })
  [PSCustomObject]@{ serviceAccount = $service.StartName; systemProbeIdentity = $system.identity; windowsPrinters = $expected; localSystemPrinters = $systemPrinters; missingFromLocalSystem = $missing; passed = ($missing.Count -eq 0) } | ConvertTo-Json -Depth 4
  if ($missing.Count -gt 0) { exit 2 }
} finally {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $output -Force -ErrorAction SilentlyContinue
}
