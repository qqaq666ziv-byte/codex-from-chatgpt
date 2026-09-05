[CmdletBinding()]
param(
  [Parameter(Position = 0, Mandatory = $true)]
  [ValidateSet('setup', 'update', 'start', 'stop', 'restart', 'status', 'doctor', 'add-project', 'approve', 'answer')]
  [string]$Command,
  [ValidateRange(1024, 65535)][int]$Port = 8790,
  [string]$ProjectId,
  [string]$ProjectName,
  [string]$ProjectPath,
  [string]$JobId,
  [string]$TurnId,
  [string]$RequestId,
  [ValidateSet('string', 'number')][string]$RequestIdType = 'string',
  [ValidateSet('accept', 'decline', 'cancel')][string]$Decision,
  [string]$AnswersFile
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'local-common.ps1')
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$Runtime = Join-Path $Root '.runtime'
$ConfigPath = Join-Path $Runtime 'config.json'
$RecordPath = Join-Path $Runtime 'server-process.json'

function Assert-AutoDevStoppedForBuild {
  $Record = Read-AutoDevProcessRecord $RecordPath
  if ($Record -and (Get-AutoDevProcessInfo ([int]$Record.pid))) {
    throw 'Setup/update requires AutoDev to be stopped. Check status, finish or cancel active work, then run stop. No dependencies or built files were changed.'
  }
  if (Test-Path -LiteralPath $ConfigPath -PathType Leaf) {
    $Config = Read-AutoDevConfig $ConfigPath
    if (-not (Test-AutoDevPortFree ([int]$Config.port))) { throw 'The configured port is occupied. Setup/update will not change files while a listener may be running.' }
  }
}

function Build-AutoDev([bool]$Verify) {
  Assert-AutoDevStoppedForBuild
  Push-Location $Root
  try {
    & npm.cmd ci --ignore-scripts --no-audit --no-fund
    Assert-AutoDevExit 'Installing locked project dependencies' $LASTEXITCODE
    if ($Verify) {
      & npm.cmd run typecheck
      Assert-AutoDevExit 'Checking AutoDev types' $LASTEXITCODE
      & npm.cmd test
      Assert-AutoDevExit 'Testing AutoDev' $LASTEXITCODE
    }
    & npm.cmd run build
    Assert-AutoDevExit 'Building AutoDev' $LASTEXITCODE
  } finally { Pop-Location }
}

function Start-AutoDev {
  $Config = Read-AutoDevConfig $ConfigPath
  Protect-AutoDevRuntime $Runtime
  $Existing = Read-AutoDevProcessRecord $RecordPath
  if ($Existing) {
    $Info = Get-AutoDevProcessInfo ([int]$Existing.pid)
    if ($Info) {
      if (-not (Test-AutoDevOwnedProcess $Existing $Info $Root)) { throw 'Existing process record does not match the process; no process was changed.' }
      $Status = Invoke-AutoDevAdmin $Config $Runtime '/admin/status'
      Assert-AutoDevServerIdentity $Status $Existing
      if ($Status.ready -ne $true) { throw 'The managed AutoDev process exists but its executor is not ready. Inspect doctor/status; no process was restarted.' }
      Write-Output 'AutoDev is already running.'
      return $Status
    }
  }
  if (-not (Test-AutoDevPortFree ([int]$Config.port))) { throw "Port $($Config.port) is occupied. No listener was stopped. Stop the owner or choose a free port in the local configuration." }
  $Entry = Join-Path $Root 'dist\src\index.js'
  if (-not (Test-Path -LiteralPath $Entry -PathType Leaf)) { throw 'Built server is missing; run setup.' }
  $Node = (Get-Command node.exe -ErrorAction Stop).Source
  $Instance = [Guid]::NewGuid().ToString('N')
  $Arguments = (@($Entry, "--autodev-instance=$Instance") | ForEach-Object { ConvertTo-AutoDevNativeArgument $_ }) -join ' '
  $PreviousConfig = $env:AUTODEV_CONFIG
  $Process = $null
  $Record = $null
  try {
    $env:AUTODEV_CONFIG = $ConfigPath
    $Process = Start-Process -FilePath $Node -ArgumentList $Arguments -WorkingDirectory $Root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $Runtime "server-$Instance.stdout.log") -RedirectStandardError (Join-Path $Runtime "server-$Instance.stderr.log")
    $Process.Refresh()
    if ($Process.HasExited) { throw "AutoDev exited during startup (exit $($Process.ExitCode))." }
    $Record = [pscustomobject]@{ schemaVersion = 1; pid = $Process.Id; created_utc = $Process.StartTime.ToUniversalTime().ToString('o'); root = $Root; entrypoint = $Entry; executable = $Node; instanceId = $Instance }
    Write-AutoDevAtomicText $RecordPath ($Record | ConvertTo-Json -Depth 10)
    $Deadline = [DateTime]::UtcNow.AddSeconds(45)
    do {
      $Process.Refresh()
      if ($Process.HasExited) { throw "AutoDev exited before readiness (exit $($Process.ExitCode))." }
      $Status = $null
      try {
        $Ready = Invoke-RestMethod -Uri "http://127.0.0.1:$($Config.port)/readyz" -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
        $Status = Invoke-AutoDevAdmin $Config $Runtime '/admin/status'
      } catch { Start-Sleep -Milliseconds 200; continue }
      if ($null -ne $Status) {
        Assert-AutoDevServerIdentity $Status $Record
        Write-Output "AutoDev ready at http://127.0.0.1:$($Config.port)/mcp (PID $($Record.pid))."
        return
      }
    } while ([DateTime]::UtcNow -lt $Deadline)
    throw 'AutoDev did not become ready within 45 seconds; see private runtime diagnostics.'
  } catch {
    $Failure = $_
    if ($Record) {
      Stop-AutoDevOwnedTree $Record $Root
      if (Test-Path -LiteralPath $RecordPath) { Remove-Item -LiteralPath $RecordPath -Force }
    }
    throw $Failure
  } finally { $env:AUTODEV_CONFIG = $PreviousConfig }
}

function Stop-AutoDev {
  $Record = Read-AutoDevProcessRecord $RecordPath
  if (-not $Record) { Write-Output 'No managed AutoDev process record exists.'; return }
  $Info = Get-AutoDevProcessInfo ([int]$Record.pid)
  if (-not $Info) { Remove-Item -LiteralPath $RecordPath -Force; Write-Output 'AutoDev is stopped; stale process record removed.'; return }
  if (-not (Test-AutoDevOwnedProcess $Record $Info $Root)) { throw 'Refusing to stop: PID, creation time, executable or workspace command did not match.' }
  $Config = Read-AutoDevConfig $ConfigPath
  try { $null = Invoke-AutoDevAdmin $Config $Runtime '/admin/shutdown' 'Post' @{} } catch { Write-Output 'Graceful shutdown was unavailable; stopping the verified owned process tree.' }
  $Deadline = [DateTime]::UtcNow.AddSeconds(8)
  do {
    if (-not (Get-AutoDevProcessInfo ([int]$Record.pid))) { break }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $Deadline)
  Stop-AutoDevOwnedTree $Record $Root
  Remove-Item -LiteralPath $RecordPath -Force
  Write-Output 'AutoDev stopped.'
}

try {
  switch ($Command) {
    'setup' {
      Assert-AutoDevStoppedForBuild
      $Node = (Get-Command node.exe -ErrorAction Stop).Source
      $Version = & $Node --version
      Assert-AutoDevExit 'Node version check' $LASTEXITCODE
      if ([int]($Version.TrimStart('v').Split('.')[0]) -lt 20) { throw 'Node.js 20 or later is required.' }
      $null = Get-Command codex -ErrorAction Stop
      $null = Get-Command npm.cmd -ErrorAction Stop
      Protect-AutoDevRuntime $Runtime
      if (-not (Test-Path -LiteralPath $ConfigPath)) {
        $ChosenPort = $Port
        while (-not (Test-AutoDevPortFree $ChosenPort)) {
          if ($PSBoundParameters.ContainsKey('Port') -or $ChosenPort -ge [Math]::Min($Port + 100, 65535)) { throw 'No requested loopback port is available; no service was changed.' }
          $ChosenPort++
        }
        $Config = [ordered]@{ schemaVersion = 1; host = '127.0.0.1'; port = $ChosenPort; model = 'gpt-6-astra'; reasoningEffort = 'xhigh'; projects = @() }
        Write-AutoDevAtomicText $ConfigPath ($Config | ConvertTo-Json -Depth 10)
      } else { $null = Read-AutoDevConfig $ConfigPath }
      foreach ($Name in @('client-token', 'admin-token')) {
        $TokenPath = Join-Path $Runtime $Name
        if (-not (Test-Path -LiteralPath $TokenPath)) { Write-AutoDevAtomicText $TokenPath (New-AutoDevToken) }
      }
      Build-AutoDev $false
      Write-Output 'AutoDev setup completed. Tokens remain private. Register a project with add-project, then start.'
    }
    'update' {
      $null = Read-AutoDevConfig $ConfigPath
      Build-AutoDev $true
      Write-Output 'The selected local source version is built and verified. Runtime state, project configuration and tokens were preserved. Run start when ready.'
    }
    'start' { Start-AutoDev }
    'stop' { Stop-AutoDev }
    'restart' { Stop-AutoDev; Start-AutoDev }
    'status' {
      $Config = Read-AutoDevConfig $ConfigPath
      $Record = Read-AutoDevProcessRecord $RecordPath
      if (-not $Record) { Write-Output 'AutoDev is stopped (no process record).'; break }
      $Info = Get-AutoDevProcessInfo ([int]$Record.pid)
      if (-not $Info) { Write-Output 'AutoDev is stopped (stale process record).'; break }
      if (-not (Test-AutoDevOwnedProcess $Record $Info $Root)) { throw 'Process identity mismatch; no process was changed.' }
      $Status = Invoke-AutoDevAdmin $Config $Runtime '/admin/status'
      Assert-AutoDevServerIdentity $Status $Record
      $Status | ConvertTo-Json -Depth 30
    }
    'doctor' {
      & node.exe --version
      Assert-AutoDevExit 'Node version check' $LASTEXITCODE
      & codex --version
      Assert-AutoDevExit 'Codex version check' $LASTEXITCODE
      & codex login status
      Assert-AutoDevExit 'Official Codex login check' $LASTEXITCODE
      $Config = Read-AutoDevConfig $ConfigPath
      Write-Output "Requested model: $($Config.model); effort: $($Config.reasoningEffort). Effective availability is checked by App Server startup."
      Write-Output "Configured project count: $(@($Config.projects).Count). Port: $($Config.port)."
      $Record = Read-AutoDevProcessRecord $RecordPath
      if ($Record) {
        $Info = Get-AutoDevProcessInfo ([int]$Record.pid)
        if ($Info -and -not (Test-AutoDevOwnedProcess $Record $Info $Root)) { throw 'Recorded process identity mismatch.' }
        if ($Info) {
          $Status = Invoke-AutoDevAdmin $Config $Runtime '/admin/status'
          Assert-AutoDevServerIdentity $Status $Record
          $Status | ConvertTo-Json -Depth 30
        }
        else { Write-Output 'Managed server is stopped; stale record will be replaced by start.' }
      } elseif (-not (Test-AutoDevPortFree ([int]$Config.port))) { throw 'Configured port has an unmanaged listener; start will refuse to replace it.' }
      else { Write-Output 'Managed server is stopped; its loopback port is free.' }
    }
    'add-project' {
      if ($ProjectId -notmatch '^[a-z][a-z0-9-]{0,47}$' -or [string]::IsNullOrWhiteSpace($ProjectPath)) { throw 'Provide -ProjectId (lowercase letters, digits, hyphens) and an explicit -ProjectPath.' }
      if (-not [IO.Path]::IsPathRooted($ProjectPath) -or $ProjectPath.StartsWith('\\')) { throw 'ProjectPath must be an absolute local directory, not a UNC path.' }
      $Node = (Get-Command node.exe -ErrorAction Stop).Source
      # Keep native stdout ASCII: the Windows console may decode UTF-8 as CP950.
      $CanonicalBase64 = & $Node -e 'const fs=require(''node:fs'');const p=fs.realpathSync.native(process.argv[1]);if(!fs.statSync(p).isDirectory())process.exit(2);process.stdout.write(Buffer.from(p,''utf8'').toString(''base64''))' $ProjectPath
      Assert-AutoDevExit 'Resolving project directory' $LASTEXITCODE
      $Canonical = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$CanonicalBase64))
      if ($Canonical.StartsWith('\\') -or $Canonical -eq [IO.Path]::GetPathRoot($Canonical) -or $Canonical -eq $Runtime -or $Canonical.StartsWith($Runtime + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'A network path, drive root or AutoDev private runtime cannot be registered as a project.' }
      $Config = Read-AutoDevConfig $ConfigPath
      if (@($Config.projects | Where-Object { $_.id -eq $ProjectId -or $_.path -eq $Canonical }).Count -gt 0) { throw 'Project ID or canonical path is already registered; configuration was preserved.' }
      if ([string]::IsNullOrWhiteSpace($ProjectName)) { $ProjectName = $ProjectId }
      $Config.projects = @($Config.projects) + @([pscustomobject]@{ id = $ProjectId; name = $ProjectName; path = [string]$Canonical })
      Write-AutoDevAtomicText $ConfigPath ($Config | ConvertTo-Json -Depth 20)
      Write-Output "Registered project '$ProjectId'. Restart AutoDev to load the updated allowlist."
    }
    { $_ -in @('approve', 'answer') } {
      if ([string]::IsNullOrWhiteSpace($JobId) -or [string]::IsNullOrWhiteSpace($TurnId) -or [string]::IsNullOrWhiteSpace($RequestId)) { throw 'Provide the exact -JobId, -TurnId and -RequestId from the pending request.' }
      $Config = Read-AutoDevConfig $ConfigPath
      $Body = @{ job_id = $JobId; turn_id = $TurnId; request_id = $RequestId; request_key = [Guid]::NewGuid().ToString() }
      if ($RequestIdType -eq 'number') {
        if ($RequestId -notmatch '^(0|[1-9][0-9]{0,15})$' -or [decimal]$RequestId -gt 9007199254740991) { throw 'A numeric RequestId must be a nonnegative JavaScript safe integer.' }
        $Body.request_id = [Int64]$RequestId
      }
      if ($Command -eq 'approve') {
        if ([string]::IsNullOrWhiteSpace($Decision)) { throw 'Provide an explicit -Decision accept, decline or cancel.' }
        $Body.decision = $Decision
        Invoke-AutoDevAdmin $Config $Runtime '/admin/approval' 'Post' $Body | ConvertTo-Json -Depth 30
      } else {
        if ([string]::IsNullOrWhiteSpace($AnswersFile) -or -not (Test-Path -LiteralPath $AnswersFile -PathType Leaf)) { throw 'Provide -AnswersFile pointing to your explicit product answers JSON.' }
        $Body.answers = Get-Content -LiteralPath $AnswersFile -Raw -Encoding UTF8 | ConvertFrom-Json
        Invoke-AutoDevAdmin $Config $Runtime '/admin/answer' 'Post' $Body | ConvertTo-Json -Depth 30
      }
    }
  }
} catch { Write-Error $_.Exception.Message -ErrorAction Continue; exit 1 }
