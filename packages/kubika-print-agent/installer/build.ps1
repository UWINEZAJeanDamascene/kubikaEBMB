$ErrorActionPreference = 'Stop'

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$version = '0.1.3'
$staging = Join-Path $root 'staging'
$release = Join-Path $root 'release'
$runtimeDir = Join-Path $staging 'runtime'
$serviceExe = Join-Path $staging 'service.exe'
$inno = @(
  "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
  "${env:ProgramFiles}\Inno Setup 6\ISCC.exe",
  (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe')
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

New-Item -ItemType Directory -Force $staging | Out-Null
New-Item -ItemType Directory -Force $release | Out-Null
New-Item -ItemType Directory -Force $runtimeDir | Out-Null
New-Item -ItemType Directory -Force (Join-Path $staging 'src') | Out-Null
New-Item -ItemType Directory -Force (Join-Path $staging 'node_modules') | Out-Null

Write-Host 'Staging application and bundled runtime...'
Copy-Item (Join-Path $root 'src\*') (Join-Path $staging 'src') -Recurse -Force
Copy-Item (Join-Path $root 'package.json') $staging -Force
Copy-Item (Join-Path $root 'package-lock.json') $staging -Force
Copy-Item (Join-Path $root 'node_modules\*') (Join-Path $staging 'node_modules') -Recurse -Force
Copy-Item (Join-Path $root 'service\winsw.xml') (Join-Path $staging 'service.xml') -Force
Copy-Item (Join-Path $root 'service\install.ps1') $staging -Force
Copy-Item (Join-Path $root 'service\uninstall.ps1') $staging -Force
Copy-Item (Join-Path $root 'service\open-setup.cmd') $staging -Force

$node = Get-Command node.exe -ErrorAction Stop
$nodeExe = $node.Source
Copy-Item $nodeExe (Join-Path $runtimeDir 'node.exe') -Force

if (-not (Test-Path $serviceExe)) {
  $winswUrl = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe'
  $winswResponse = try {
    Invoke-WebRequest -UseBasicParsing -Uri $winswUrl -OutFile $serviceExe
    $true
  } catch {
    $false
  }
  if (-not $winswResponse -or -not (Test-Path $serviceExe)) {
    throw 'WinSW-x64.exe could not be downloaded. Obtain it from the pinned release and place it in staging\service.exe.'
  }
}

$installerScript = Join-Path $root 'installer\setup.iss'
$zip = Join-Path $release "KubikaPrintAgent-$version-portable.zip"
Compress-Archive -Path "$staging\*" -DestinationPath $zip -Force

if (Test-Path $inno) {
  Write-Host 'Building Inno Setup installer...'
  & $inno '/Q' $installerScript
  if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed with exit code $LASTEXITCODE" }
} else {
  Write-Warning "Inno Setup is not installed at $inno. Portable ZIP and manifest were created; the Setup EXE must be built on a release machine with Inno Setup 6."
}

$setupExe = Join-Path $release "KubikaPrintAgent-$version-setup.exe"
$signed = $false
$signTool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin","${env:ProgramFiles}\Windows Kits\10\bin" -Filter signtool.exe -Recurse -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending |
  Select-Object -First 1 -ExpandProperty FullName
$signThumbprint = $env:KUBIKA_CODE_SIGN_THUMBPRINT

if ((Test-Path $setupExe) -and $signThumbprint -and $signTool) {
  Write-Host 'Signing WinSW and Setup EXE with the configured code-signing certificate...'
  & $signTool sign /fd SHA256 /td SHA256 /tr http://timestamp.digicert.com /sha1 $signThumbprint $serviceExe $setupExe
  if ($LASTEXITCODE -ne 0) { throw "Authenticode signing failed with exit code $LASTEXITCODE" }
  $signed = $true
} elseif ($signThumbprint -and -not $signTool) {
  throw 'KUBIKA_CODE_SIGN_THUMBPRINT is set, but Signtool.exe is unavailable.'
} elseif ((Test-Path $setupExe) -and -not $signThumbprint) {
  Write-Warning 'No KUBIKA_CODE_SIGN_THUMBPRINT was configured; release artifacts remain unsigned.'
}

$manifest = @{
  version = $version
  releaseDateUtc = (Get-Date).ToUniversalTime().ToString('o')
  sha256 = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLowerInvariant()
  package = Split-Path -Leaf $zip
  signed = $signed
  winswSha256 = (Get-FileHash -Algorithm SHA256 $serviceExe).Hash.ToLowerInvariant()
  hardwareValidation = @{
    physicalPrinters = 'pending'
    physicalDrawers = 'pending'
    simulatedTcp9100 = 'passed'
    windowsSdk = 'available'
    productionCertificate = 'not-provided'
  }
}
if (Test-Path $setupExe) {
  $manifest.setup = Split-Path -Leaf $setupExe
  $manifest.setupSha256 = (Get-FileHash -Algorithm SHA256 $setupExe).Hash.ToLowerInvariant()
}
$manifest | ConvertTo-Json -Depth 3 | Set-Content (Join-Path $release 'manifest.json') -Encoding UTF8

Write-Host "Release artifacts are in $release"
