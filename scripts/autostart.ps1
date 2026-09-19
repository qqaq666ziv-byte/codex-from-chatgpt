[CmdletBinding()]
param([ValidateSet('enable','disable','remove','status','run','retry')][string]$Action = 'status', [string]$TriggerUtc)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'local-common.ps1')

function New-AutoDevAutostartContext([string]$Root) {
  $Sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $Hasher = [Security.Cryptography.SHA256]::Create()
  try { $Digest = [BitConverter]::ToString($Hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($Sid + '|' + $Root.ToLowerInvariant()))).Replace('-', '').Substring(0, 20) }
  finally { $Hasher.Dispose() }
  $Name = 'AutoDev-Login-' + $Digest
  $Shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $Arguments = (@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',(Join-Path $Root 'scripts\autostart.ps1'),'-Action','run') | ForEach-Object { ConvertTo-AutoDevNativeArgument $_ }) -join ' '
  return [pscustomobject]@{
    Root = $Root; Sid = $Sid; Name = $Name; Shell = $Shell; Arguments = $Arguments
    Description = 'AutoDev current-user login launcher ' + $Digest
    File = Join-Path $Root '.runtime\autostart.json'
    StartupFile = Join-Path ([Environment]::GetFolderPath('Startup')) ($Name + '.vbs')
    DelaySeconds = 30
  }
}

function Get-AutoDevStartupText($Context) {
  $Command = (ConvertTo-AutoDevNativeArgument $Context.Shell) + ' ' + $Context.Arguments
  return "' " + $Context.Description + "`r`nSet launcher = CreateObject(""WScript.Shell"")`r`nlauncher.Run """ + $Command.Replace('"', '""') + """, 0, False`r`n"
}

function Assert-AutoDevStartupOwnership($Context) {
  if (-not (Test-Path -LiteralPath $Context.StartupFile)) { return }
  $Item = Get-Item -LiteralPath $Context.StartupFile -Force
  if ($Item.PSIsContainer -or ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
      [IO.File]::ReadAllText($Context.StartupFile) -cne (Get-AutoDevStartupText $Context)) {
    throw 'AutoDev autostart: Startup file ownership mismatch; existing file was preserved.'
  }
}

function Get-AutoDevScheduledRegistration($Context) {
  # Query failures must not be treated as a missing task that may be overwritten.
  $Task = @(Get-ScheduledTask -TaskPath '\' -ErrorAction Stop | Where-Object { $_.TaskName -eq $Context.Name })
  if ($Task.Count -eq 0) { return $null }
  if ($Task.Count -ne 1) { throw 'AutoDev autostart: ambiguous task identity.' }
  $Entry = $Task[0]
  $Owner = [string]$Entry.Principal.UserId
  if ($Owner -ne $Context.Sid) {
    try { $Owner = (New-Object Security.Principal.NTAccount($Owner)).Translate([Security.Principal.SecurityIdentifier]).Value }
    catch { throw 'AutoDev autostart: task owner could not be verified.' }
  }
  $Actions = @($Entry.Actions)
  if ($Owner -ne $Context.Sid -or $Entry.Description -cne $Context.Description -or
      $Actions.Count -ne 1 -or $Actions[0].Execute -ine $Context.Shell -or
      $Actions[0].Arguments -cne $Context.Arguments -or $Actions[0].WorkingDirectory -ine $Context.Root -or
      [string]$Entry.Principal.RunLevel -notin @('Limited','0') -or [string]$Entry.Principal.LogonType -notin @('Interactive','3')) {
    throw 'AutoDev autostart: task ownership or action mismatch; existing task was preserved.'
  }
  return $Entry
}

function Test-AutoDevAutostartAccessDenied($Failure) {
  $Exception = $Failure.Exception
  while ($null -ne $Exception) {
    if ($Exception -is [UnauthorizedAccessException] -or ($Exception.HResult -band 65535) -eq 5) { return $true }
    $Exception = $Exception.InnerException
  }
  return [string]$Failure.FullyQualifiedErrorId -match 'AccessDenied|UnauthorizedAccess|0x80070005'
}

function Read-AutoDevAutostartConfig($Context) {
  if (-not (Test-Path -LiteralPath $Context.File)) { return $null }
  $Item = Get-Item -LiteralPath $Context.File -Force
  if ($Item.PSIsContainer -or ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'AutoDev autostart: configuration must be a physical file.' }
  try { $Config = Get-Content -LiteralPath $Context.File -Raw -Encoding UTF8 | ConvertFrom-Json }
  catch { throw 'AutoDev autostart: unreadable configuration; its contents were not printed.' }
  if ($Config.schemaVersion -ne 1 -or $Config.root -ne $Context.Root -or $Config.userSid -ne $Context.Sid -or
      $Config.taskName -ne $Context.Name -or $Config.mechanism -notin @('scheduled-task','startup-folder') -or
      -not ($Config.enabled -is [bool]) -or $Config.delaySeconds -ne 30) {
    throw 'AutoDev autostart: configuration identity mismatch.'
  }
  return $Config
}

function Save-AutoDevAutostartConfig($Context, $Config) {
  Write-AutoDevAtomicText $Context.File ($Config | ConvertTo-Json -Depth 5)
}

function Enable-AutoDevAutostart($Context) {
  $null = Read-AutoDevConfig (Join-Path $Context.Root '.runtime\config.json')
  Protect-AutoDevRuntime (Join-Path $Context.Root '.runtime')
  $Previous = Read-AutoDevAutostartConfig $Context
  Assert-AutoDevStartupOwnership $Context
  $Node = Resolve-AutoDevNode
  $Codex = Resolve-AutoDevCodex
  $Config = [pscustomobject]@{ schemaVersion = 1; root = $Context.Root; userSid = $Context.Sid; taskName = $Context.Name; mechanism = 'scheduled-task'; enabled = $false; delaySeconds = 30; nodeExecutable = $Node; codexExecutable = $Codex; updatedUtc = [DateTimeOffset]::UtcNow.ToString('o') }
  if ($Previous -and $Previous.mechanism -eq 'startup-folder') {
    $Config.mechanism = 'startup-folder'
  } else {
    $Existing = $null
    $Registered = $null
    $RegistrationWritten = $false
    try {
      $Existing = Get-AutoDevScheduledRegistration $Context
      $TaskAction = New-ScheduledTaskAction -Execute $Context.Shell -Argument $Context.Arguments -WorkingDirectory $Context.Root
      $Trigger = New-ScheduledTaskTrigger -AtLogOn -User $Context.Sid
      $Principal = New-ScheduledTaskPrincipal -UserId $Context.Sid -LogonType Interactive -RunLevel Limited
      $Settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
      $Definition = New-ScheduledTask -Action $TaskAction -Trigger $Trigger -Principal $Principal -Settings $Settings -Description $Context.Description
      # Persist disabled first so a partially completed registration fails closed.
      Save-AutoDevAutostartConfig $Context $Config
      $null = Register-ScheduledTask -TaskName $Context.Name -TaskPath '\' -InputObject $Definition -Force -ErrorAction Stop
      $RegistrationWritten = $true
      $Registered = Get-AutoDevScheduledRegistration $Context
      if (-not $Registered -or $Registered.Settings.Enabled -eq $false) { throw 'AutoDev autostart: task registration was not confirmed.' }
    } catch {
      if (-not (Test-AutoDevAutostartAccessDenied $_)) { throw }
      # Same-user Startup is the explicitly authorized reversible alternative.
      # Never retain a known task and add a second launcher beside it.
      if ($Existing -or $RegistrationWritten) { throw 'AutoDev autostart: a task may already be registered; fallback was refused.' }
      $Config.mechanism = 'startup-folder'
    }
  }
  if ($Config.mechanism -eq 'startup-folder') {
    Assert-AutoDevStartupOwnership $Context
    $StartupDirectory = Split-Path -Parent $Context.StartupFile
    if (-not (Test-Path -LiteralPath $StartupDirectory -PathType Container)) { throw 'AutoDev autostart: current-user Startup directory is unavailable.' }
    if ((Get-Item -LiteralPath $StartupDirectory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'AutoDev autostart: Startup directory must not be a link.' }
    Save-AutoDevAutostartConfig $Context $Config
    [IO.File]::WriteAllText($Context.StartupFile, (Get-AutoDevStartupText $Context), [Text.Encoding]::Unicode)
    Assert-AutoDevStartupOwnership $Context
  } elseif (Test-Path -LiteralPath $Context.StartupFile) {
    Remove-Item -LiteralPath $Context.StartupFile -Force
  }
  $Config.enabled = $true
  Save-AutoDevAutostartConfig $Context $Config
  return Get-AutoDevAutostartStatus $Context
}

function Get-AutoDevAutostartStatus($Context) {
  $Config = Read-AutoDevAutostartConfig $Context
  if (-not $Config) { return [pscustomobject]@{ configured = $false; enabled = $false; mechanism = $null; logon_delay_seconds = 30 } }
  $Registered = $false; $SchedulerEnabled = $false; $LastResult = $null
  if ($Config.mechanism -eq 'scheduled-task') {
    $Task = Get-AutoDevScheduledRegistration $Context
    $Registered = $null -ne $Task
    if ($Task) {
      $SchedulerEnabled = $Task.Settings.Enabled -ne $false
      $Info = Get-ScheduledTaskInfo -TaskName $Context.Name -TaskPath '\' -ErrorAction Stop
      $LastResult = $Info.LastTaskResult
    }
  } else {
    Assert-AutoDevStartupOwnership $Context
    $Registered = Test-Path -LiteralPath $Context.StartupFile -PathType Leaf
    $SchedulerEnabled = $Registered
  }
  . (Join-Path $PSScriptRoot 'availability.ps1')
  $Monitor = Get-AutoDevAvailabilityStatus $Context
  return [pscustomobject]@{ configured = $true; enabled = ($Config.enabled -and $Registered -and $SchedulerEnabled); mechanism = $Config.mechanism; registered = $Registered; task_name = $Context.Name; logon_delay_seconds = 30; last_task_result = $LastResult; availability = $Monitor; restarts_after_manual_stop = $false; resumes_on_next_codex_open = $true; reboot_or_relogin_verified = $false }
}

function Disable-AutoDevAutostart($Context, [bool]$Remove = $false) {
  $Config = Read-AutoDevAutostartConfig $Context
  if (-not $Config) { return Get-AutoDevAutostartStatus $Context }
  Assert-AutoDevStartupOwnership $Context
  $Task = if ($Config.mechanism -eq 'scheduled-task') { Get-AutoDevScheduledRegistration $Context } else { $null }
  # The delayed run rereads this flag under the lifecycle mutex before starting.
  $Config.enabled = $false
  Save-AutoDevAutostartConfig $Context $Config
  if ($Task) {
    if ($Remove) { Unregister-ScheduledTask -TaskName $Context.Name -TaskPath '\' -Confirm:$false -ErrorAction Stop }
    else { $null = Disable-ScheduledTask -TaskName $Context.Name -TaskPath '\' -ErrorAction Stop }
    $After = Get-AutoDevScheduledRegistration $Context
    if (($Remove -and $After) -or (-not $Remove -and $After -and $After.Settings.Enabled -ne $false)) { throw 'AutoDev autostart: removal/disable was not confirmed.' }
  }
  if (Test-Path -LiteralPath $Context.StartupFile) { Remove-Item -LiteralPath $Context.StartupFile -Force }
  if ($Remove) { Remove-Item -LiteralPath $Context.File -Force }
  return Get-AutoDevAutostartStatus $Context
}

function Initialize-AutoDevAutostartEnvironment($Config) {
  $env:PATH = @([Environment]::GetEnvironmentVariable('Path','Machine'), [Environment]::GetEnvironmentVariable('Path','User')) -join ';'
  foreach ($Entry in @(
    @{ Saved = $Config.nodeExecutable; Extensions = @('.exe'); Names = @('node.exe'); Variable = 'AUTODEV_NODE_EXECUTABLE' },
    @{ Saved = $Config.codexExecutable; Extensions = @('.exe','.cmd'); Names = @('codex.exe','codex.cmd'); Variable = 'AUTODEV_CODEX_EXECUTABLE' }
  )) {
    $Executable = [string]$Entry.Saved
    if (-not [IO.Path]::IsPathRooted($Executable) -or [IO.Path]::GetExtension($Executable) -notin $Entry.Extensions) { throw 'AutoDev autostart: saved executable path is invalid.' }
    if (Test-Path -LiteralPath $Executable) {
      $Item = Get-Item -LiteralPath $Executable -Force -ErrorAction Stop
      if ($Item.PSIsContainer -or ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'AutoDev autostart: saved executable must be a physical file.' }
    } else {
      # Codex desktop updates replace versioned binary directories. Resolve an
      # already-installed executable from durable PATH, never install a tool.
      $Executable = Resolve-AutoDevApplication '' $Entry.Names
    }
    [Environment]::SetEnvironmentVariable($Entry.Variable, $Executable, 'Process')
  }
  $null = Resolve-AutoDevNode
  $null = Resolve-AutoDevCodex
}

function Invoke-AutoDevAutostartRun($Context, [string]$OriginalTriggerUtc = '') {
  $Started = if ($OriginalTriggerUtc) { $OriginalTriggerUtc } else { [DateTimeOffset]::UtcNow.ToString('o') }
  $Config = Read-AutoDevAutostartConfig $Context
  if (-not $Config -or -not $Config.enabled) { Write-Output 'AutoDev login startup is disabled.'; return }
  Start-Sleep -Seconds $Context.DelaySeconds
  . (Join-Path $Context.Root 'scripts\manage-daily.ps1')
  $Mutex = New-Object Threading.Mutex($false, (Get-AutoDevDailyMutexName $Context.Root))
  $Owns = $false
  try {
    try { $Owns = $Mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $Owns = $true }
    if (-not $Owns) { Write-Output 'AutoDev login startup skipped: another lifecycle action is active.'; return }
    $Config = Read-AutoDevAutostartConfig $Context
    if (-not $Config -or -not $Config.enabled) { Write-Output 'AutoDev login startup was disabled during its delay.'; return }
    Initialize-AutoDevAutostartEnvironment $Config
    Invoke-AutoDevDailyAction $Context.Root 'start' $true $Started
  } finally { if ($Owns) { $Mutex.ReleaseMutex() }; $Mutex.Dispose() }
}

function Invoke-AutoDevAutostartAction($Context, [string]$Operation) {
  if ($Operation -eq 'run') {
    . (Join-Path $Context.Root 'scripts\availability.ps1')
    Invoke-AutoDevAvailabilityWatch $Context
    return
  }
  if ($Operation -eq 'retry') { $Context.DelaySeconds = 0; Invoke-AutoDevAutostartRun $Context $TriggerUtc; return }
  . (Join-Path $Context.Root 'scripts\manage-daily.ps1')
  $Mutex = New-Object Threading.Mutex($false, (Get-AutoDevDailyMutexName $Context.Root))
  $Owns = $false
  try {
    try { $Owns = $Mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $Owns = $true }
    if (-not $Owns) { throw 'AutoDev autostart: another lifecycle action is in progress.' }
    switch ($Operation) {
      'enable' { Enable-AutoDevAutostart $Context | ConvertTo-Json }
      'disable' { Disable-AutoDevAutostart $Context | ConvertTo-Json }
      'remove' { Disable-AutoDevAutostart $Context $true | ConvertTo-Json }
      'status' { Get-AutoDevAutostartStatus $Context | ConvertTo-Json }
    }
  } finally { if ($Owns) { $Mutex.ReleaseMutex() }; $Mutex.Dispose() }
}

if ($MyInvocation.InvocationName -ne '.') {
  try {
    [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
    $LoginRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
    $Context = New-AutoDevAutostartContext $LoginRoot
    Invoke-AutoDevAutostartAction $Context $Action
    exit 0
  } catch {
    $Message = $_.Exception.Message
    if ($Message -notlike 'AutoDev autostart:*' -and $Message -notlike 'AutoDev daily:*') { $Message = 'AutoDev autostart: configuration, permission or launch verification failed. No successful change was inferred.' }
    [Console]::Error.WriteLine($Message)
    exit 1
  }
}
