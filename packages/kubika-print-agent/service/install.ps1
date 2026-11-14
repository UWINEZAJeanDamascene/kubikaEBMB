$ErrorActionPreference = 'Stop'

$installDir = if ($args[0]) { $args[0] } else { "$env:ProgramFiles\Kubika\PrintAgent" }
$serviceExe = Join-Path $installDir 'service.exe'
$wrapper = Join-Path $installDir 'service.xml'

if (-not (Test-Path $serviceExe)) { throw "WinSW wrapper not found: $serviceExe" }
if (-not (Test-Path $wrapper)) { throw "WinSW service configuration not found: $wrapper" }
$existing = Get-Service -Name 'KubikaPrintAgent' -ErrorAction SilentlyContinue
if ($existing) {
  & $serviceExe stop 2>$null
  & $serviceExe start
  if ($LASTEXITCODE -ne 0) { throw "Kubika Print Agent service failed to restart with exit code $LASTEXITCODE" }
  Write-Host 'Kubika Print Agent service upgraded and started.'
} else {
  & $serviceExe install
  if ($LASTEXITCODE -ne 0) { throw "WinSW service installation failed with exit code $LASTEXITCODE" }
  & $serviceExe start
  if ($LASTEXITCODE -ne 0) { throw "Kubika Print Agent service failed to start with exit code $LASTEXITCODE" }
  Write-Host 'Kubika Print Agent service installed and started.'
}
