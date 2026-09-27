param([Parameter(Mandatory = $true)][string]$ArtifactRoot)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$outputRoot = [IO.Path]::GetFullPath($ArtifactRoot)
if ($outputRoot.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or $outputRoot -eq $projectRoot) {
    throw 'Validation artifacts must be outside the project checkout.'
}
foreach ($name in @('', 'logs', 'tmp', 'cargo-target', 'npm-cache', 'browsers')) {
    New-Item -ItemType Directory -Force -Path (Join-Path $outputRoot $name) | Out-Null
}
$env:RAINSYNC_ARTIFACT_DIR = $outputRoot
$env:CARGO_TARGET_DIR = Join-Path $outputRoot 'cargo-target'
$env:npm_config_cache = Join-Path $outputRoot 'npm-cache'
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $outputRoot 'browsers'
$env:TEMP = Join-Path $outputRoot 'tmp'
$env:TMP = $env:TEMP
# No DATABASE_URL is inherited by the integration fixtures; each creates and
# destroys its own randomly named PostgreSQL container with a generated secret.
Write-Output "Validation artifacts: $outputRoot"
