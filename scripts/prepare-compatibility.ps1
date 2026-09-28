param(
    [Parameter(Mandatory = $true)][string]$ArtifactRoot,
    [string]$Baseline = '13262053eb5f949a7e9dea6f2a11d2e1cbe7ce6e'
)
$ErrorActionPreference = 'Stop'
if ($Baseline -notmatch '^[0-9a-f]{40}$') { throw 'A complete baseline commit SHA is required.' }
. (Join-Path $PSScriptRoot 'validation-env.ps1') -ArtifactRoot $ArtifactRoot
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$parent = Join-Path $env:RAINSYNC_ARTIFACT_DIR 'compatibility'
$fixtureRoot = Join-Path $parent ([guid]::NewGuid().ToString())
$source = Join-Path $fixtureRoot 'source'
$target = Join-Path $fixtureRoot 'target'
New-Item -ItemType Directory -Force -Path $fixtureRoot,$source,$target | Out-Null
$archive = Join-Path $fixtureRoot 'baseline.zip'
git -C $project archive --format=zip --output=$archive $Baseline
if ($LASTEXITCODE -ne 0) { throw 'Baseline archive failed.' }
Expand-Archive -LiteralPath $archive -DestinationPath $source
$migrationFiles = @('0020_registration_accounts.sql', '0021_user_avatars.sql', '0022_chat_idempotency.sql')
foreach ($name in $migrationFiles) {
    Copy-Item -LiteralPath (Join-Path $project "migrations/$name") -Destination (Join-Path $source "migrations/$name")
}
$manifest = [ordered]@{ baseline=$Baseline; source=$source; target=$target; migrations=$migrationFiles; preparedAt=[DateTime]::UtcNow.ToString('o') }
[IO.File]::WriteAllText((Join-Path $parent 'latest.json'),($manifest | ConvertTo-Json))
# This is a temporary build fixture, never a reset/revert of the working branch.
node (Join-Path $PSScriptRoot 'run-check.mjs') b5-compatibility-build 1200 cargo build --manifest-path (Join-Path $source 'Cargo.toml') --target-dir $target --workspace --bins --examples --locked
if ($LASTEXITCODE -ne 0) { throw 'Compatibility build failed; inspect the saved manifest and log.' }
Write-Output ($manifest | ConvertTo-Json -Compress)
