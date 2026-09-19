[CmdletBinding()]
param(
  [ValidateSet('start','status','stop','restart')][string]$Action = 'status',
  [switch]$Automatic,
  [string]$StartedUtc
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'local-common.ps1')

function Get-AutoDevDailyMutexName([string]$Root) {
  $Hasher = [Security.Cryptography.SHA256]::Create()
  try { $Digest = [BitConverter]::ToString($Hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($Root.ToLowerInvariant()))).Replace('-', '') }
  finally { $Hasher.Dispose() }
  return 'Global\AutoDev-Daily-' + $Digest
}

function Get-AutoDevDailyCore([string]$Root) {
  $Runtime = Join-Path $Root '.runtime'
  $Config = Read-AutoDevConfig (Join-Path $Runtime 'config.json')
  $Record = Read-AutoDevProcessRecord (Join-Path $Runtime 'server-process.json')
  $Info = if ($Record) { Get-AutoDevRecordedProcess $Record } else { $null }
  if (-not $Info) {
    if (-not (Test-AutoDevPortFree ([int]$Config.port))) { throw 'AutoDev daily: configured port has an unverified listener; no process was changed.' }
    return [pscustomobject]@{ Running = $false; Status = $null }
  }
  if (-not (Test-AutoDevOwnedProcess $Record $Info $Root)) { throw 'AutoDev daily: process ownership mismatch; no process was changed.' }
  $Status = Invoke-AutoDevAdmin $Config $Runtime '/admin/status'
  Assert-AutoDevServerIdentity $Status $Record
  return [pscustomobject]@{ Running = $true; Status = $Status }
}

function Assert-AutoDevDailyIdle($Core) {
  if (-not $Core.Running) { return }
  $Status = $Core.Status
  if ($null -eq $Status.tasks -or $null -eq $Status.PSObject.Properties['active_job_id']) {
    throw 'AutoDev daily: authenticated task state is incomplete; stopping was refused.'
  }
  if ($Status.active_job_id -or @($Status.tasks | Where-Object { -not (Test-AutoDevTerminalOrUndispatchedTask $_) }).Count -gt 0) {
    throw 'AutoDev daily: active or recovery-required execution must be reconciled before stop/restart.'
  }
  # Historical review journal uncertainty does not imply active execution.
}

function Invoke-AutoDevDailyControl([string]$Root, [string]$Kind, [string]$Operation) {
  $Script = Join-Path $Root ('scripts\' + $(if ($Kind -eq 'core') { 'autodev.ps1' } else { 'fixed-tunnel.ps1' }))
  $global:LASTEXITCODE = 0
  if ($Kind -eq 'core') { $Output = & $Script -Command $Operation }
  else { $Output = & $Script -Action $Operation }
  if ($global:LASTEXITCODE -ne 0) { throw "AutoDev daily: $Kind $Operation failed (exit $global:LASTEXITCODE); state was preserved." }
  return $Output
}

function Invoke-AutoDevDailyAction([string]$Root, [string]$Operation, [bool]$IsAutomatic = $false, [string]$AutomaticStartedUtc = '') {
  if ($IsAutomatic -and $Operation -ne 'start') { throw 'AutoDev daily: automatic mode only supports start.' }
  $Runtime = Join-Path $Root '.runtime'
  $Marker = Join-Path $Runtime 'manual-stop.json'
  $Mutex = New-Object Threading.Mutex($false, (Get-AutoDevDailyMutexName $Root))
  $OwnsMutex = $false
  try {
    try { $OwnsMutex = $Mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $OwnsMutex = $true }
    if (-not $OwnsMutex) { throw 'AutoDev daily: another lifecycle action is in progress; no competing action was started.' }
    if ($IsAutomatic) {
      $Began = [DateTimeOffset]::ParseExact($AutomaticStartedUtc, 'o', [Globalization.CultureInfo]::InvariantCulture).UtcDateTime
      if ($Began -gt [DateTime]::UtcNow.AddSeconds(2)) { throw 'AutoDev daily: automatic start timestamp is invalid.' }
      if (Test-Path -LiteralPath $Marker) {
        if ((Get-Item -LiteralPath $Marker -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'AutoDev daily: stop marker must not be a link.' }
        $Stopped = Get-Content -LiteralPath $Marker -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($Stopped.schemaVersion -ne 1 -or $Stopped.root -ne $Root) { throw 'AutoDev daily: invalid stop marker; automatic start was refused.' }
        # PS 7 may deserialize JSON ISO dates as DateTime. Converting that
        # object to a locale string would discard subsecond precision.
        $StoppedAt = if ($Stopped.stoppedUtc -is [DateTime]) { $Stopped.stoppedUtc.ToUniversalTime() }
          elseif ($Stopped.stoppedUtc -is [DateTimeOffset]) { $Stopped.stoppedUtc.UtcDateTime }
          else { [DateTimeOffset]::ParseExact([string]$Stopped.stoppedUtc, 'o', [Globalization.CultureInfo]::InvariantCulture).UtcDateTime }
        if ($StoppedAt -ge $Began) {
          Write-Output 'AutoDev automatic start skipped: manual stop occurred during the login delay.'
          return
        }
      }
    }
    if ($Operation -eq 'status') {
      $Core = Get-AutoDevDailyCore $Root
      $FixedText = Invoke-AutoDevDailyControl $Root 'fixed' 'status'
      try { $Fixed = ($FixedText -join "`n") | ConvertFrom-Json -ErrorAction Stop }
      catch { throw 'AutoDev daily: fixed connection status could not be verified.' }
      $Result = [ordered]@{
        core_process_running = $Core.Running
        core_ready = ($Core.Running -and $Core.Status.ready -eq $true)
        active_job_id = $(if ($Core.Running) { $Core.Status.active_job_id } else { $null })
        task_count = $(if ($Core.Running) { @($Core.Status.tasks).Count } else { $null })
        fixed_process_running = ($Fixed.process_running -eq $true)
        native_process_running = ($Fixed.native_process_running -eq $true)
        native_ready = ($Fixed.native_ready -eq $true)
        route_lease_valid = ($Fixed.route_lease_valid -eq $true)
        external_metadata_ready = ($Fixed.external_metadata_ready -eq $true)
        startup_confirmed = ($Fixed.startup_confirmed -eq $true)
        startup_probe = $Fixed.startup_probe
        blocked = $Fixed.blocked
        ready_for_chatgpt_probe = ($Core.Running -and $Core.Status.ready -eq $true -and $Fixed.ready_for_chatgpt_probe -eq $true)
        chatgpt_e2e = 'not_verified'
      }
      $Result | ConvertTo-Json -Depth 5
      return
    }
    if ($Operation -in @('stop','restart')) {
      $Core = Get-AutoDevDailyCore $Root
      Assert-AutoDevDailyIdle $Core
      Protect-AutoDevRuntime $Runtime
      Write-AutoDevAtomicText $Marker (@{ schemaVersion = 1; root = $Root; stoppedUtc = [DateTimeOffset]::UtcNow.ToString('o') } | ConvertTo-Json -Compress)
      # Close the public entry first. Core shutdown rechecks active execution
      # atomically server-side, including requests racing this preflight.
      $null = Invoke-AutoDevDailyControl $Root 'fixed' 'stop'
      $null = Invoke-AutoDevDailyControl $Root 'core' 'stop'
      $After = Get-AutoDevDailyCore $Root
      if ($After.Running) { throw 'AutoDev daily: core exit was not confirmed.' }
      if ($Operation -eq 'stop') { Write-Output 'AutoDev core and fixed connection are stopped. Automatic recovery is paused until Codex is reopened.'; return }
    }
    if (-not $IsAutomatic -and (Test-Path -LiteralPath $Marker)) {
      if ((Get-Item -LiteralPath $Marker -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'AutoDev daily: stop marker must not be a link.' }
      Remove-Item -LiteralPath $Marker -Force
    }
    # Invoke in the same PowerShell thread: start-daily takes this same mutex
    # reentrantly, and preserves its existing installation/readiness checks.
    $global:LASTEXITCODE = 0
    & (Join-Path $Root 'scripts\start-daily.ps1')
    if ($global:LASTEXITCODE -ne 0) {
      $Failure = New-Object InvalidOperationException("AutoDev daily: startup failed (exit $global:LASTEXITCODE).")
      $Failure.Data['ExitCode'] = [int]$global:LASTEXITCODE
      throw $Failure
    }
  } finally {
    if ($OwnsMutex) { $Mutex.ReleaseMutex() }
    $Mutex.Dispose()
  }
}

if ($MyInvocation.InvocationName -ne '.') {
  try {
    [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
    $DailyRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
    Invoke-AutoDevDailyAction $DailyRoot $Action ([bool]$Automatic) $StartedUtc
    exit 0
  } catch {
    $Message = $_.Exception.Message
    if ($Message -notlike 'AutoDev daily:*') { $Message = 'AutoDev daily: lifecycle prerequisites or authenticated identity could not be verified. Inspect doctor/status; no success was inferred.' }
    [Console]::Error.WriteLine($Message)
    if ($_.Exception.Data.Contains('ExitCode')) { exit ([int]$_.Exception.Data['ExitCode']) }
    exit 1
  }
}
