param([Parameter(Mandatory=$true)][string]$ArtifactRoot)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'validation-env.ps1') -ArtifactRoot $ArtifactRoot
$manifestPath=Join-Path $env:RAINSYNC_ARTIFACT_DIR 'compatibility/latest.json'
$manifest=Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json -AsHashtable
$fixtureRoot=Split-Path $manifest.source
$source=Join-Path $fixtureRoot 'baseline-source'
$target=Join-Path $fixtureRoot 'baseline-target'
if (-not (Test-Path -LiteralPath (Join-Path $source 'Cargo.toml'))) {
    Expand-Archive -LiteralPath (Join-Path $fixtureRoot 'baseline.zip') -DestinationPath $source
}
$manifest.baselineSource=$source
$manifest.baselineTarget=$target
[IO.File]::WriteAllText($manifestPath,($manifest | ConvertTo-Json))
node (Join-Path $PSScriptRoot 'run-check.mjs') b5-legacy-baseline-build 1200 cargo build --manifest-path (Join-Path $source 'Cargo.toml') --target-dir $target -p rainsync-server --locked
if ($LASTEXITCODE -ne 0) { throw 'Unmodified legacy baseline build failed.' }
