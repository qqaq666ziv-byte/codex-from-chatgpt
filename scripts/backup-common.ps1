# Offline runtime snapshots. Import has no side effects; callers hold both writer leases.
function Get-AutoDevFileDigest([string]$File) {
  $Stream = [IO.File]::OpenRead($File)
  $Hasher = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($Hasher.ComputeHash($Stream))).Replace('-', '').ToLowerInvariant() }
  finally { $Hasher.Dispose(); $Stream.Dispose() }
}

function Assert-AutoDevPhysicalTree([string]$Directory) {
  $RootItem = Get-Item -LiteralPath $Directory -Force -ErrorAction Stop
  if (-not $RootItem.PSIsContainer -or ($RootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Backup directories must be physical local directories.' }
  foreach ($Item in Get-ChildItem -LiteralPath $Directory -Force) {
    if ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Backup refuses linked files or directories.' }
    if ($Item.PSIsContainer) { Assert-AutoDevPhysicalTree $Item.FullName }
  }
}

function Protect-AutoDevPrivateTree([string]$Directory) {
  Assert-AutoDevPhysicalTree $Directory
  Protect-AutoDevRuntime $Directory
  foreach ($Item in Get-ChildItem -LiteralPath $Directory -Directory -Force) { Protect-AutoDevPrivateTree $Item.FullName }
}

function Enter-AutoDevOfflineLease([string]$Directory) {
  $Canonical = & node.exe -e 'process.stdout.write(Buffer.from(require(''node:fs'').realpathSync.native(process.argv[1]).toLowerCase(),''utf8'').toString(''base64''))' $Directory
  Assert-AutoDevExit 'Resolving runtime writer lease' $LASTEXITCODE
  $Hasher = [Security.Cryptography.SHA256]::Create()
  try { $Digest = ([BitConverter]::ToString($Hasher.ComputeHash([Convert]::FromBase64String([string]$Canonical)))).Replace('-', '').ToLowerInvariant() }
  finally { $Hasher.Dispose() }
  $Mutex = New-Object Threading.Mutex($false, ('Global\AutoDev-' + $Digest))
  try {
    $Owned = $false
    try { $Owned = $Mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $Owned = $true }
    if (-not $Owned) { throw 'Runtime has a live writer; stop the core and every managed connection before maintenance.' }
    return $Mutex
  } catch { $Mutex.Dispose(); throw }
}

function Assert-AutoDevOfflineState([string]$Directory) {
  Assert-AutoDevPhysicalTree $Directory
  # The script reads private state only to validate its schema and idle status.
  # No state values, credentials, prompts or parser diagnostics reach stdout.
  $Script = @'
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const root = process.argv[1];
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const hash = v => crypto.createHash('sha256').update(v).digest('hex');
const canonical = v => Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']' : object(v) ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}' : JSON.stringify(v);
const read = name => { const file = path.join(root,name); return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')) : undefined; };
try {
  const config = read('config.json');
  if (!object(config) || config.schemaVersion !== 1 || config.host !== '127.0.0.1' || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 || !Array.isArray(config.projects)) throw 1;
  const jobs = read('jobs.json');
  if (jobs !== undefined) {
    if (!object(jobs) || jobs.version !== 1 || !Array.isArray(jobs.jobs) || jobs.jobs.some(j => !object(j) || typeof j.job_id !== 'string' || typeof j.status !== 'string')) throw 1;
    if (jobs.jobs.some(j => !['completed','interrupted','failed'].includes(j.status))) { process.stdout.write('ACTIVE'); process.exit(3); }
  }
  const product = read('product-state.json');
  if (product !== undefined && (!object(product) || !object(product.state) || product.state.version !== 1 || !Array.isArray(product.state.records) || product.checksum !== hash(JSON.stringify(product.state)))) throw 1;
  const requests = read('requests.json');
  if (requests !== undefined) {
    if (!object(requests) || requests.schemaVersion !== 1 || !Array.isArray(requests.records) || requests.checksum !== hash(canonical({schemaVersion:1,records:requests.records}))) throw 1;
    if (requests.records.some(r => !object(r) || !['pending','succeeded','failed','uncertain'].includes(r.status))) throw 1;
    if (requests.records.some(r => r.status === 'pending')) { process.stdout.write('ACTIVE'); process.exit(3); }
  }
  const secure = read('secure-tunnel.json');
  if (secure !== undefined && (!object(secure) || secure.schemaVersion !== 1)) throw 1;
  const build = read('build-incomplete.json');
  if (build !== undefined && (!object(build) || build.schemaVersion !== 1 || build.status !== 'incomplete')) throw 1;
  process.stdout.write('OK');
} catch { process.stdout.write('INVALID'); process.exit(2); }
'@
  $Result = & node.exe -e $Script $Directory
  if ($LASTEXITCODE -eq 3) { throw 'Runtime has active or recovery-required work; reconcile it before backup, update or restore.' }
  if ($LASTEXITCODE -ne 0 -or $Result -ne 'OK') { throw 'Runtime state is corrupt or uses an unsupported schema; no state was replaced.' }
}

function Test-AutoDevBackupExcluded([string]$Relative) {
  $Parts = $Relative -split '[\\/]'
  if (@($Parts | Where-Object { $_ -in @('gateway-lease', 'secure-tunnel-lease', 'logs') }).Count -gt 0) { return $true }
  $Name = $Parts[-1]
  return $Name -in @('server-process.json', 'gateway.json', 'secure-tunnel-process.json', 'secure-tunnel-client.yml', 'os-writer.lock') -or $Name -match '(?i)(\.log|\.tmp|\.bak|\.lock)$' -or $Name -like 'quick-tunnel-*.yml'
}

function Get-AutoDevBackupFiles([string]$Directory) {
  $Prefix = [IO.Path]::GetFullPath($Directory).TrimEnd('\') + '\'
  return @(Get-ChildItem -LiteralPath $Directory -File -Recurse -Force | ForEach-Object {
    $Relative = $_.FullName.Substring($Prefix.Length).Replace('\', '/')
    if (-not (Test-AutoDevBackupExcluded $Relative)) {
      [pscustomobject]@{ path = $Relative; bytes = $_.Length; sha256 = Get-AutoDevFileDigest $_.FullName }
    }
  } | Sort-Object -Property path)
}

function Resolve-AutoDevBackup([string]$Root, [string]$BackupId) {
  if ($BackupId -notmatch '^[0-9]{8}T[0-9]{9}Z-[a-f0-9]{12}$') { throw 'Provide an exact backup ID printed by backup/update; paths are not accepted.' }
  $Base = Join-Path $Root '.backups'
  $Directory = Join-Path $Base $BackupId
  if (-not (Test-Path -LiteralPath $Directory -PathType Container)) { throw 'The selected local backup does not exist.' }
  Assert-AutoDevPhysicalTree $Directory
  $BaseItem = Get-Item -LiteralPath $Base -Force
  if ($BaseItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Backup root must not be a link.' }
  return $Directory
}

function Test-AutoDevBackup([string]$Root, [string]$BackupId) {
  $Directory = Resolve-AutoDevBackup $Root $BackupId
  try { $Manifest = [IO.File]::ReadAllText((Join-Path $Directory 'manifest.json')) | ConvertFrom-Json }
  catch { throw 'Backup manifest is missing or invalid.' }
  if ($Manifest.schemaVersion -ne 1 -or $Manifest.id -ne $BackupId -or $Manifest.files -isnot [Array] -or $Manifest.files.Count -lt 1) { throw 'Unsupported backup manifest.' }
  $RuntimeCopy = Join-Path $Directory 'runtime'
  Assert-AutoDevPhysicalTree $RuntimeCopy
  $Seen = @{}
  foreach ($File in $Manifest.files) {
    if ([string]$File.path -notmatch '^[^\\:]+$' -or ([string]$File.path).StartsWith('/') -or @(([string]$File.path -split '/') | Where-Object { $_ -in @('', '.', '..') -or $_.EndsWith('.') -or $_.EndsWith(' ') }).Count -gt 0 -or $Seen.ContainsKey([string]$File.path) -or (Test-AutoDevBackupExcluded ([string]$File.path))) { throw 'Invalid or duplicate backup member path.' }
    $Seen[[string]$File.path] = $true
    if ([string]$File.sha256 -notmatch '^[a-f0-9]{64}$' -or [string]$File.bytes -notmatch '^[0-9]+$') { throw 'Invalid backup member checksum.' }
    $Target = Join-Path $RuntimeCopy ([string]$File.path)
    if (-not (Test-Path -LiteralPath $Target -PathType Leaf) -or (Get-Item -LiteralPath $Target -Force).Length -ne $File.bytes -or (Get-AutoDevFileDigest $Target) -ne $File.sha256) { throw 'Backup checksum mismatch; no runtime files were changed.' }
  }
  $Actual = @(Get-ChildItem -LiteralPath $RuntimeCopy -File -Recurse -Force)
  if ($Actual.Count -ne $Manifest.files.Count) { throw 'Backup contains unlisted files.' }
  Assert-AutoDevOfflineState $RuntimeCopy
  return $Directory
}

function New-AutoDevBackup([string]$Root, [string]$Runtime) {
  Assert-AutoDevOfflineState $Runtime
  $Base = Join-Path $Root '.backups'
  Protect-AutoDevRuntime $Base
  $BackupId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,12)
  $Directory = Join-Path $Base $BackupId
  Protect-AutoDevRuntime $Directory
  $RuntimeCopy = Join-Path $Directory 'runtime'
  Protect-AutoDevRuntime $RuntimeCopy
  $Files = @(Get-AutoDevBackupFiles $Runtime)
  foreach ($File in $Files) {
    $Target = Join-Path $RuntimeCopy $File.path
    $Parent = Split-Path -Parent $Target
    if (-not (Test-Path -LiteralPath $Parent)) { New-Item -ItemType Directory -Path $Parent -Force | Out-Null }
    Copy-Item -LiteralPath (Join-Path $Runtime $File.path) -Destination $Target -ErrorAction Stop
  }
  Protect-AutoDevPrivateTree $RuntimeCopy
  $After = @(Get-AutoDevBackupFiles $Runtime)
  if (($Files | ConvertTo-Json -Depth 5 -Compress) -ne ($After | ConvertTo-Json -Depth 5 -Compress)) { throw 'Runtime changed during backup; this snapshot has no accepted manifest.' }
  $Package = [IO.File]::ReadAllText((Join-Path $Root 'package.json')) | ConvertFrom-Json
  $Manifest = [ordered]@{ schemaVersion = 1; id = $BackupId; createdUtc = [DateTime]::UtcNow.ToString('o'); productVersion = [string]$Package.version; files = @($Files) }
  Write-AutoDevAtomicText (Join-Path $Directory 'manifest.json') ($Manifest | ConvertTo-Json -Depth 10)
  Protect-AutoDevRuntime $Directory
  $null = Test-AutoDevBackup $Root $BackupId
  return $BackupId
}

function Restore-AutoDevBackup([string]$Root, [string]$Runtime, [string]$BackupId) {
  $Directory = Test-AutoDevBackup $Root $BackupId
  Assert-AutoDevOfflineState $Runtime
  $PreservedId = New-AutoDevBackup $Root $Runtime
  $PreservedDirectory = Resolve-AutoDevBackup $Root $PreservedId
  Write-Output "Verified backup of current runtime before restore: $PreservedId"
  $Staged = Join-Path $Root ('.runtime-restore-' + [Guid]::NewGuid().ToString('N'))
  Protect-AutoDevRuntime $Staged
  foreach ($Item in Get-ChildItem -LiteralPath (Join-Path $Directory 'runtime') -Force) { Copy-Item -LiteralPath $Item.FullName -Destination $Staged -Recurse -ErrorAction Stop }
  Protect-AutoDevPrivateTree $Staged
  Assert-AutoDevOfflineState $Staged
  $SourceFiles = @(Get-AutoDevBackupFiles (Join-Path $Directory 'runtime'))
  if (($SourceFiles | ConvertTo-Json -Depth 5 -Compress) -ne (@(Get-AutoDevBackupFiles $Staged) | ConvertTo-Json -Depth 5 -Compress)) { throw 'Staged restore did not pass checksum verification; runtime was preserved.' }
  # A runtime snapshot does not restore source or dependencies. Require a
  # successful rebuild of the selected source before dispatching saved work.
  Write-AutoDevAtomicText (Join-Path $Staged 'build-incomplete.json') ('{"schemaVersion":1,"status":"incomplete"}')
  # Both paths are fixed children of this checkout; no recursive deletion is used.
  $Previous = Join-Path $PreservedDirectory 'previous-runtime'
  Protect-AutoDevPrivateTree $Runtime
  Move-Item -LiteralPath $Runtime -Destination $Previous -ErrorAction Stop
  try { Move-Item -LiteralPath $Staged -Destination $Runtime -ErrorAction Stop }
  catch {
    try { Move-Item -LiteralPath $Previous -Destination $Runtime -ErrorAction Stop }
    catch { throw 'Restore failed and automatic directory recovery failed. The original runtime remains under the newly printed backup ID; do not start AutoDev until recovered.' }
    throw 'Restore failed; the original runtime was recovered. AutoDev remains stopped.'
  }
  Write-Output "Restored verified runtime backup $BackupId. Preserved prior runtime: $PreservedId. AutoDev remains stopped; complete update for the selected source before start."
}
