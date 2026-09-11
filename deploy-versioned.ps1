$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

function Get-SourceHash([string[]]$Paths) {
  $files = $Paths | ForEach-Object {
    $path = Join-Path $root $_
    if ((Get-Item -LiteralPath $path).PSIsContainer) { Get-ChildItem -LiteralPath $path -Recurse -File } else { Get-Item -LiteralPath $path }
  } | Sort-Object FullName
  $rows = $files | ForEach-Object {
    $relative = $_.FullName.Substring($root.Length).TrimStart('\', '/')
    "$relative $((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash)"
  }
  $bytes = [Text.Encoding]::UTF8.GetBytes(($rows -join "`n"))
  ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
}

try { $commit = (git -C $root rev-parse HEAD 2>$null).Trim() } catch { $commit = 'unknown' }
if (-not $commit) { $commit = 'unknown' }
if ($commit -eq 'unknown') { $dirty = 'unknown' } else { $dirty = if (git -C $root status --porcelain) { 'true' } else { 'false' } }
$version = if ($commit -eq 'unknown') { 'unknown' } elseif ($dirty -eq 'true') { "$commit-dirty" } else { $commit }
$sourceHash = Get-SourceHash @('src', 'wrangler.toml', 'package.json', 'package-lock.json')
$builtAt = (Get-Date).ToUniversalTime().ToString('o')

npm.cmd test
npx.cmd wrangler deploy --var "BUILD_VERSION:$version" --var "BUILD_COMMIT:$commit" --var "BUILD_DIRTY:$dirty" --var "BUILD_SOURCE_HASH:$sourceHash" --var "BUILD_AT:$builtAt"
