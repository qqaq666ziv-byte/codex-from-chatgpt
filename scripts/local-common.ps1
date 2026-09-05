# Windows PowerShell 5.1 / PowerShell 7 helpers. Import has no side effects.
function ConvertTo-AutoDevNativeArgument([AllowEmptyString()][string]$Value) {
  return '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}

function Assert-AutoDevExit([string]$Operation, [int]$Code) {
  if ($Code -ne 0) { throw "$Operation failed (exit $Code)." }
}

function Protect-AutoDevRuntime([string]$Path) {
  if ($PSVersionTable.PSEdition -eq 'Desktop') {
    Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
  }
  if (Test-Path -LiteralPath $Path) {
    $Item = Get-Item -LiteralPath $Path -Force
    if (-not $Item.PSIsContainer -or ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Runtime must be a physical directory, not a link.' }
  } else { New-Item -ItemType Directory -Path $Path -ErrorAction Stop | Out-Null }
  $Sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $Acl = Get-Acl -LiteralPath $Path
  $Before = $Acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
  $Acl.SetAccessRuleProtection($true, $false)
  foreach ($Entry in @($Acl.Access)) { [void]$Acl.RemoveAccessRuleSpecific($Entry) }
  $Acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($Sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')))
  if ($Before -ne $Acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)) { Set-Acl -LiteralPath $Path -AclObject $Acl -ErrorAction Stop }
  foreach ($File in Get-ChildItem -LiteralPath $Path -File -Force) {
    if ($File.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Runtime files must not be links.' }
    $FileAcl = Get-Acl -LiteralPath $File.FullName
    $Before = $FileAcl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
    $FileAcl.SetAccessRuleProtection($true, $false)
    foreach ($Entry in @($FileAcl.Access)) { [void]$FileAcl.RemoveAccessRuleSpecific($Entry) }
    $FileAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($Sid, 'FullControl', 'Allow')))
    if ($Before -ne $FileAcl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)) { Set-Acl -LiteralPath $File.FullName -AclObject $FileAcl -ErrorAction Stop }
  }
}

function Write-AutoDevAtomicText([string]$Path, [string]$Text) {
  $Temp = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
  [IO.File]::WriteAllText($Temp, $Text, (New-Object Text.UTF8Encoding($false)))
  if (Test-Path -LiteralPath $Path) {
    # PowerShell 5.1/7 may bind $null as an empty backup path for this overload.
    # A unique sibling backup preserves atomic replacement and rollback evidence.
    $Backup = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.bak'
    [IO.File]::Replace($Temp, $Path, $Backup)
  }
  else { [IO.File]::Move($Temp, $Path) }
}

function New-AutoDevToken {
  $Bytes = New-Object byte[] 32
  $Generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $Generator.GetBytes($Bytes) } finally { $Generator.Dispose() }
  return [Convert]::ToBase64String($Bytes)
}

function Read-AutoDevConfig([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw 'Run setup before this command.' }
  if ((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Runtime configuration must not be a link.' }
  try { $Config = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json }
  catch { throw 'Local runtime configuration is unreadable or malformed; its contents were not printed.' }
  if ($Config.schemaVersion -ne 1 -or $Config.host -ne '127.0.0.1' -or
      [string]$Config.port -notmatch '^[0-9]+$' -or $Config.port -lt 1024 -or $Config.port -gt 65535 -or
      [string]::IsNullOrWhiteSpace($Config.model) -or [string]::IsNullOrWhiteSpace($Config.reasoningEffort)) { throw 'Invalid local runtime configuration.' }
  return $Config
}

function Test-AutoDevPortFree([int]$Port) {
  $Listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $Port)
  try { $Listener.Server.ExclusiveAddressUse = $true; $Listener.Start(); return $true }
  catch { return $false }
  finally { $Listener.Stop() }
}

function Get-AutoDevProcessInfo([int]$ProcessId) {
  if ($PSVersionTable.PSEdition -eq 'Desktop') {
    Import-Module (Join-Path $PSHOME 'Modules\CimCmdlets\CimCmdlets.psd1') -ErrorAction Stop
  }
  return Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
}

function Test-AutoDevOwnedProcess($Record, $Info, [string]$Root) {
  if (-not $Info -or $Record.schemaVersion -ne 1 -or [string]$Record.pid -notmatch '^[1-9][0-9]*$' -or
      $Record.pid -ne $Info.ProcessId -or $Record.root -ne $Root -or
      [string]$Record.instanceId -notmatch '^[0-9a-f]{32}$' -or
      $Record.entrypoint -ne (Join-Path $Root 'dist\src\index.js') -or
      $Record.executable -ne $Info.ExecutablePath) { return $false }
  $Entry = ConvertTo-AutoDevNativeArgument $Record.entrypoint
  $Marker = ConvertTo-AutoDevNativeArgument ("--autodev-instance=" + $Record.instanceId)
  if ([string]$Info.CommandLine -notmatch [regex]::Escape($Entry) -or [string]$Info.CommandLine -notmatch [regex]::Escape($Marker)) { return $false }
  try {
    $Recorded = if ($Record.created_utc -is [DateTime]) { $Record.created_utc.ToUniversalTime() } else { [DateTime]::Parse($Record.created_utc).ToUniversalTime() }
    return [Math]::Abs(($Recorded - ([DateTime]$Info.CreationDate).ToUniversalTime()).TotalMilliseconds) -lt 1
  } catch { return $false }
}

function Read-AutoDevProcessRecord([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  if ((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Process record must not be a link.' }
  try { $Record = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json }
  catch { throw 'Process record is unreadable or malformed; manual inspection required.' }
  if ([string]$Record.pid -notmatch '^[1-9][0-9]*$') { throw 'Invalid process record; manual inspection required.' }
  return $Record
}

function Assert-AutoDevServerIdentity($Status, $Record) {
  if ($null -eq $Status -or $Status.process_id -ne $Record.pid -or $Status.instance_id -ne $Record.instanceId) {
    throw 'AutoDev server identity mismatch; the listener did not prove the managed PID and instance.'
  }
}

function Invoke-AutoDevAdmin($Config, [string]$Runtime, [string]$Path, [string]$Method = 'Get', $Body = $null) {
  if ($Path -notin @('/admin/status', '/admin/shutdown', '/admin/approval', '/admin/answer')) { throw 'Unknown admin endpoint.' }
  $TokenPath = Join-Path $Runtime 'admin-token'
  if (-not (Test-Path -LiteralPath $TokenPath -PathType Leaf)) { throw 'Local admin credential is missing; run setup.' }
  $Token = [IO.File]::ReadAllText($TokenPath).Trim()
  $Arguments = @{ Uri = "http://127.0.0.1:$($Config.port)$Path"; Method = $Method; Headers = @{ Authorization = "Bearer $Token" }; TimeoutSec = 10; UseBasicParsing = $true; ErrorAction = 'Stop' }
  if ($null -ne $Body) { $Arguments.ContentType = 'application/json; charset=utf-8'; $Arguments.Body = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 30 -Compress)) }
  try { return Invoke-RestMethod @Arguments }
  catch { throw "AutoDev admin request failed ($Method $Path). No approval was inferred; check status before retrying." }
  finally { $Token = $null; $Arguments = $null }
}

function Stop-AutoDevOwnedTree($Record, [string]$Root) {
  $Info = Get-AutoDevProcessInfo ([int]$Record.pid)
  if (-not $Info) { return }
  if (-not (Test-AutoDevOwnedProcess $Record $Info $Root)) { throw 'Refusing to stop a process whose ownership cannot be verified.' }
  & taskkill.exe /pid $Record.pid /t /f | Out-Null
  Assert-AutoDevExit 'Stopping owned AutoDev process tree' $LASTEXITCODE
  $Deadline = [DateTime]::UtcNow.AddSeconds(5)
  do {
    if (-not (Get-AutoDevProcessInfo ([int]$Record.pid))) { return }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $Deadline)
  throw 'The owned AutoDev process did not exit; its process record has been preserved.'
}
