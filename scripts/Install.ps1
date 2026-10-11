param()
$ErrorActionPreference = 'Stop'
$kitRoot = $PSScriptRoot
$buildDir = Join-Path $kitRoot 'dist'
$targetDir = Join-Path $env:APPDATA 'Vencord\dist'
if (Get-Process -Name Discord -ErrorAction SilentlyContinue) { throw 'Fully quit Discord from the system tray, then run this script again.' }
if (-not (Test-Path -LiteralPath (Join-Path $targetDir 'patcher.js'))) { throw 'Install normal desktop Vencord from https://vencord.dev/download/ first, then run this script again.' }
$manifest = Get-Content -LiteralPath (Join-Path $kitRoot 'manifest.json') -Raw | ConvertFrom-Json
foreach ($entry in $manifest.files) {
    if ($entry.name -notmatch '^[a-zA-Z0-9._-]+$') { throw 'Invalid manifest filename.' }
    if ((Get-FileHash -LiteralPath (Join-Path $buildDir $entry.name) -Algorithm SHA256).Hash -ne $entry.sha256) { throw "Package verification failed: $($entry.name)" }
}
$backupDir = Join-Path $kitRoot ('backups\' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
Copy-Item -LiteralPath $targetDir -Destination (Join-Path $backupDir 'dist') -Recurse
foreach ($entry in $manifest.files) {
    $destination = Join-Path $targetDir $entry.name
    Copy-Item -LiteralPath (Join-Path $buildDir $entry.name) -Destination $destination -Force
    if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $entry.sha256) { throw "Installed-file verification failed: $($entry.name)" }
}
Write-Output "SharedKey installed. Existing build backed up to $backupDir. Open Discord and click the lock beside the message box."
