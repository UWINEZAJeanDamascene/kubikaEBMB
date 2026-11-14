$ErrorActionPreference = 'Stop'

$installDir = if ($args[0]) { $args[0] } else { "$env:ProgramFiles\Kubika\PrintAgent" }
$serviceExe = Join-Path $installDir 'service.exe'

if (Test-Path $serviceExe) {
  & $serviceExe stop 2>$null
  & $serviceExe uninstall 2>$null
}

Write-Host 'Kubika Print Agent service stopped and uninstalled.'
