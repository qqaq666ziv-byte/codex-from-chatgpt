# Imported by the current-user login launcher. No credentials or task content
# enter the monitor state. Every recovery uses the existing guarded launcher.
function Get-AutoDevDesktopSession {
  $Session = [Diagnostics.Process]::GetCurrentProcess().SessionId
  $Apps = @(Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | Where-Object {
    $_.SessionId -eq $Session -and $_.Path -match '\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$'
  } | Sort-Object StartTime)
  if ($Apps.Count -eq 0) { return $null }
  $App = $Apps[0]
  $Started = $App.StartTime.ToUniversalTime().ToString('o')
  return [pscustomobject]@{ key = ([string]$App.Id + ':' + $Started); startedUtc = $Started }
}

function New-AutoDevAvailabilityState([DateTimeOffset]$Now) {
  return [pscustomobject]@{ schemaVersion = 1; status = 'starting'; desktopKey = ''; triggerUtc = $Now.ToString('o'); nextCheckUtc = $Now; failures = 0; retrySeconds = 0; checkedUtc = $null }
}

function Test-AutoDevAvailabilityStopped($Context, [string]$TriggerUtc) {
  $Marker = Join-Path $Context.Root '.runtime\manual-stop.json'
  if (-not (Test-Path -LiteralPath $Marker)) { return $false }
  $Item = Get-Item -LiteralPath $Marker -Force
  if ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Invalid stop marker.' }
  $Value = Get-Content -LiteralPath $Marker -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($Value.schemaVersion -ne 1 -or $Value.root -ne $Context.Root) { throw 'Invalid stop marker.' }
  $Stopped = if ($Value.stoppedUtc -is [DateTime]) { [DateTimeOffset]$Value.stoppedUtc } else { [DateTimeOffset]::Parse([string]$Value.stoppedUtc) }
  return $Stopped -ge [DateTimeOffset]::Parse($TriggerUtc)
}

function Save-AutoDevAvailabilityState($Context, $State) {
  $Process = [Diagnostics.Process]::GetCurrentProcess()
  $Value = [ordered]@{ schemaVersion = 1; root = $Context.Root; pid = $PID; createdUtc = $Process.StartTime.ToUniversalTime().ToString('o'); status = $State.status; checkedUtc = $State.checkedUtc; nextCheckUtc = $State.nextCheckUtc.ToString('o'); failures = $State.failures; retrySeconds = $State.retrySeconds }
  Write-AutoDevAtomicText (Join-Path $Context.Root '.runtime\availability.json') ($Value | ConvertTo-Json -Compress)
}

function Get-AutoDevAvailabilityStatus($Context) {
  $File = Join-Path $Context.Root '.runtime\availability.json'
  if (-not (Test-Path -LiteralPath $File)) { return [pscustomobject]@{ running = $false; status = 'not_started' } }
  if ((Get-Item -LiteralPath $File -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'AutoDev autostart: monitor state must be a physical file.' }
  $Value = Get-Content -LiteralPath $File -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($Value.schemaVersion -ne 1 -or $Value.root -ne $Context.Root -or $Value.status -notin @('starting','ready','recovering','retry_wait','manually_stopped')) { throw 'AutoDev autostart: invalid monitor identity.' }
  $Info = Get-AutoDevProcessInfo ([int]$Value.pid)
  $Created = if ($Value.createdUtc -is [DateTime]) { $Value.createdUtc.ToUniversalTime() } else { [DateTimeOffset]::Parse([string]$Value.createdUtc).UtcDateTime }
  $Running = $Info -and $Info.ExecutablePath -ieq $Context.Shell -and
    $Info.CommandLine.Contains((Join-Path $Context.Root 'scripts\autostart.ps1')) -and
    [Math]::Abs(($Info.CreationDate.ToUniversalTime() - $Created).TotalMilliseconds) -lt 1
  return [pscustomobject]@{ running = [bool]$Running; status = $(if ($Running) { $Value.status } else { 'monitor_stopped' }); last_check_utc = $Value.checkedUtc; next_check_utc = $Value.nextCheckUtc; consecutive_failures = $Value.failures; retry_seconds = $Value.retrySeconds }
}

function Test-AutoDevAvailabilityReady($Context) {
  $Text = Invoke-AutoDevDailyAction $Context.Root 'status'
  $Value = ($Text -join "`n") | ConvertFrom-Json
  return $Value.ready_for_chatgpt_probe -eq $true
}

function Start-AutoDevAvailabilityAttempt($Context, [string]$TriggerUtc) {
  # A separate process isolates script exit statements and startup failures
  # from the monitor. The child rechecks enable/manual-stop under the lock.
  $Values = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',(Join-Path $Context.Root 'scripts\autostart.ps1'),'-Action','retry','-TriggerUtc',$TriggerUtc)
  $Arguments = ($Values | ForEach-Object { ConvertTo-AutoDevNativeArgument $_ }) -join ' '
  $Child = Start-Process -FilePath $Context.Shell -ArgumentList $Arguments -WorkingDirectory $Context.Root -WindowStyle Hidden -PassThru
  try {
    $null = $Child.Handle
    # Do not abandon a still-running launch and create another supervisor.
    $Child.WaitForExit()
    return ($Child.ExitCode -eq 0 -and (Test-AutoDevAvailabilityReady $Context))
  } finally { $Child.Dispose() }
}

function Invoke-AutoDevAvailabilityTick($Context, $State, [DateTimeOffset]$Now) {
  $Elapsed = [Diagnostics.Stopwatch]::StartNew()
  try {
    $Desktop = Get-AutoDevDesktopSession
    if ($Desktop -and $Desktop.key -ne $State.desktopKey) {
      $State.desktopKey = $Desktop.key; $State.triggerUtc = $Desktop.startedUtc
      $State.failures = 0; $State.nextCheckUtc = $Now
    }
    if ($Now -lt $State.nextCheckUtc) { return }
    $State.checkedUtc = $Now.ToString('o')
    if (Test-AutoDevAvailabilityStopped $Context $State.triggerUtc) {
      $State.status = 'manually_stopped'; $State.nextCheckUtc = $Now.AddSeconds(5)
    } elseif (Test-AutoDevAvailabilityReady $Context) {
      $State.status = 'ready'; $State.failures = 0; $State.retrySeconds = 0
      $State.nextCheckUtc = $Now.AddSeconds(60)
    } else {
      $State.status = 'recovering'; Save-AutoDevAvailabilityState $Context $State
      if (Start-AutoDevAvailabilityAttempt $Context $State.triggerUtc) {
        $State.status = 'ready'; $State.failures = 0; $State.retrySeconds = 0
        $State.nextCheckUtc = $Now.AddMilliseconds($Elapsed.ElapsedMilliseconds).AddSeconds(60)
      } else { throw 'Startup was not confirmed.' }
    }
  } catch {
    $State.failures = [Math]::Min(20, $State.failures + 1)
    $State.retrySeconds = [int][Math]::Min(300, 30 * [Math]::Pow(2, [Math]::Min(4, $State.failures - 1)))
    $State.status = 'retry_wait'; $State.nextCheckUtc = $Now.AddMilliseconds($Elapsed.ElapsedMilliseconds).AddSeconds($State.retrySeconds)
    # Raw child output and exception messages may contain private state.
  }
  Save-AutoDevAvailabilityState $Context $State
}

function Invoke-AutoDevAvailabilityWatch($Context) {
  . (Join-Path $Context.Root 'scripts\manage-daily.ps1')
  $Mutex = New-Object Threading.Mutex($false, ((Get-AutoDevDailyMutexName $Context.Root) + '-Availability'))
  $Owns = $false
  try {
    try { $Owns = $Mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $Owns = $true }
    if (-not $Owns) { Write-Output 'AutoDev availability monitor is already running.'; return }
    $State = New-AutoDevAvailabilityState ([DateTimeOffset]::UtcNow)
    Start-Sleep -Seconds $Context.DelaySeconds
    while ($true) {
      $Config = Read-AutoDevAutostartConfig $Context
      if (-not $Config -or -not $Config.enabled) { return }
      Invoke-AutoDevAvailabilityTick $Context $State ([DateTimeOffset]::UtcNow)
      Start-Sleep -Seconds 5
    }
  } finally { if ($Owns) { $Mutex.ReleaseMutex() }; $Mutex.Dispose() }
}
