param(
  [Parameter(Mandatory = $true)][string]$ArtifactPath,
  [string]$ManifestPath
)
$ErrorActionPreference = 'Stop'
if (-not $ManifestPath) { $ManifestPath = Join-Path $PSScriptRoot '..\release\manifest.json' }
$manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
$artifact = Resolve-Path -LiteralPath $ArtifactPath
$name = Split-Path -Leaf $artifact.Path
$expected = if ($name -eq $manifest.setup) { $manifest.setupSha256 }
  elseif ($name -eq $manifest.package) { $manifest.packageSha256 }
  else { throw "Artifact '$name' is not listed in the release manifest." }
if (-not $expected -or $expected -notmatch '^[a-fA-F0-9]{64}$') { throw "The release manifest has no valid SHA-256 for '$name'." }
$actual = (Get-FileHash -LiteralPath $artifact.Path -Algorithm SHA256).Hash
if ($actual -ine $expected) { throw "SHA-256 verification failed for '$name'." }
[PSCustomObject]@{ artifact = $name; sha256 = $actual.ToLowerInvariant(); verified = $true } | ConvertTo-Json -Compress
