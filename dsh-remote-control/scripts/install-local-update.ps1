$ErrorActionPreference = 'Stop'
$src = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$dst = 'D:\deepseek harness\plugins\dsh-remote-control'
if ((Resolve-Path -LiteralPath $dst).Path -ne $dst) { throw 'Unexpected installed directory' }
$old = Get-Content -LiteralPath (Join-Path $dst 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$backup = Join-Path (Join-Path (Split-Path -Parent $src) 'plugin-backups') ('installed-' + $old.version + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backup -Force | Out-Null
$folders = @('lib','agent','src','scripts')
$files = @('package.json','README.md','CHANGELOG.md','cordis.patch.yml','LICENSE','tsconfig.json','tsdown.config.ts')
foreach ($item in ($folders + $files)) {
  $from = Join-Path $dst $item
  if (Test-Path -LiteralPath $from) { Copy-Item -LiteralPath $from -Destination $backup -Recurse -Force }
}
Write-Output "Backup: $backup"
foreach ($item in ($folders + $files)) {
  Copy-Item -LiteralPath (Join-Path $src $item) -Destination $dst -Recurse -Force
}
foreach ($item in @('lib\index.js','lib\agent-http.js','lib\catalog.js','lib\execution.js','lib\client.js','lib\registry.js','agent\dsh-remote-agent.mjs','package.json')) {
  $a = (Get-FileHash -LiteralPath (Join-Path $src $item)).Hash
  $b = (Get-FileHash -LiteralPath (Join-Path $dst $item)).Hash
  if ($a -ne $b) { throw "Installed hash mismatch: $item" }
}
node (Join-Path $src 'scripts\verify-installed.mjs') $dst
if ($LASTEXITCODE -ne 0) { throw 'Installed module validation failed; backup retained' }
& 'D:\nodejs\npm.cmd' pack --ignore-scripts --pack-destination $src
if ($LASTEXITCODE -ne 0) { throw 'Packaging failed' }
Write-Output 'Update complete; runtime dependency links and user registry were not replaced.'
