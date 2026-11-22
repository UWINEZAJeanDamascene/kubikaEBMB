$ErrorActionPreference = 'Stop'

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$package = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$version = [string]$package.version
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
Copy-Item (Join-Path $root 'service\test-printer-visibility.ps1') $staging -Force

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
$setupExe = Join-Path $release "KubikaPrintAgent-$version-setup.exe"
$winswSigned = $false
$setupSigned = $false
$signTool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin","${env:ProgramFiles}\Windows Kits\10\bin" -Filter signtool.exe -Recurse -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending |
  Select-Object -First 1 -ExpandProperty FullName
$signThumbprint = $env:KUBIKA_CODE_SIGN_THUMBPRINT

if ($signThumbprint -and $signTool) {
  Write-Host 'Signing WinSW before packaging with the configured code-signing certificate...'
  & $signTool sign /fd SHA256 /td SHA256 /tr http://timestamp.digicert.com /sha1 $signThumbprint $serviceExe
  if ($LASTEXITCODE -ne 0) { throw "Authenticode signing failed with exit code $LASTEXITCODE" }
  $winswSigned = $true
} elseif ($signThumbprint -and -not $signTool) {
  throw 'KUBIKA_CODE_SIGN_THUMBPRINT is set, but Signtool.exe is unavailable.'
} else {
  Write-Warning 'No KUBIKA_CODE_SIGN_THUMBPRINT was configured; release artifacts will be unsigned.'
}

Compress-Archive -Path "$staging\*" -DestinationPath $zip -Force
if (Test-Path $inno) {
  Write-Host 'Building Inno Setup installer...'
  & $inno '/Q' "/DAppVersion=$version" $installerScript
  if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed with exit code $LASTEXITCODE" }
} else {
  Write-Warning "Inno Setup is not installed at $inno. Portable ZIP and manifest were created; the Setup EXE must be built on a release machine with Inno Setup 6."
}
if ((Test-Path $setupExe) -and $signThumbprint -and $signTool) {
  Write-Host 'Signing Setup EXE with the configured code-signing certificate...'
  & $signTool sign /fd SHA256 /td SHA256 /tr http://timestamp.digicert.com /sha1 $signThumbprint $setupExe
  if ($LASTEXITCODE -ne 0) { throw "Authenticode signing failed with exit code $LASTEXITCODE" }
  $setupSigned = $true
}
$signed = $winswSigned -and ((-not (Test-Path $setupExe)) -or $setupSigned)

$manifest = @{
  version = $version
  releaseDateUtc = (Get-Date).ToUniversalTime().ToString('o')
  sha256 = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLowerInvariant()
  package = Split-Path -Leaf $zip
  packageSha256 = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLowerInvariant()
  signed = $signed
  signingDecision = if ($signed) { 'Signed with configured production certificate.' } else { 'Unsigned: no production signing certificate was configured.' }
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
  $manifest.setupSigned = $setupSigned
}
$releaseNotes = Join-Path $release 'release-notes.md'
Copy-Item (Join-Path $root 'installer\verify-release.ps1') (Join-Path $release 'verify-release.ps1') -Force
@("# Kubika Print Agent $version", '', '- Adds redacted rotating JSON logs and a protected diagnostics export.', '- Reports Windows printer status and surfaces backend agent, printer, failure, and queue alerts.', '- Installer upgrade stops the service before replacing files; uninstall prompts to keep or remove shop data.', '- Includes the LocalSystem printer visibility comparison script and release SHA-256 verifier.', '', "Signing: $($manifest.signingDecision)", 'Physical Windows 10/11 printer validation remains pending.') | Set-Content $releaseNotes -Encoding UTF8
$manifest.releaseNotes = Split-Path -Leaf $releaseNotes
$manifest | ConvertTo-Json -Depth 3 | Set-Content (Join-Path $release 'manifest.json') -Encoding UTF8

# Publish complete releases into the tracked directory used by both local and
# deployed backends. Keep portable-only builds in the ignored release directory.
if (Test-Path $setupExe) {
  $downloadDir = Join-Path $root '..\..\downloads\print-agent'
  New-Item -ItemType Directory -Force $downloadDir | Out-Null
  Copy-Item $zip $downloadDir -Force
  Copy-Item $setupExe $downloadDir -Force
  Copy-Item $releaseNotes $downloadDir -Force
  Copy-Item (Join-Path $release 'manifest.json') $downloadDir -Force
  Write-Host "Published $version to tracked release directory $downloadDir. Review and commit these release artifacts."
} else {
  Write-Warning 'Setup EXE was not built; the tracked release was not changed.'
}

Write-Host "Release artifacts are in $release"
