[CmdletBinding()]
param([ValidateRange(60,120)][int]$Seconds = 65)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'local-common.ps1')
$MeasureRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$MeasureRuntime = Join-Path $MeasureRoot '.runtime'
$MeasureConfig = Read-AutoDevConfig (Join-Path $MeasureRuntime 'config.json')
$MeasureCore = Read-AutoDevProcessRecord (Join-Path $MeasureRuntime 'server-process.json')
$MeasureCoreInfo = Get-AutoDevRecordedProcess $MeasureCore
if (-not (Test-AutoDevOwnedProcess $MeasureCore $MeasureCoreInfo $MeasureRoot)) { throw 'Core ownership was not verified.' }
$MeasureFixed = Read-AutoDevProcessRecord (Join-Path $MeasureRuntime 'fixed-gateway-process.json')
$MeasureFixedInfo = Get-AutoDevProcessInfo ([int]$MeasureFixed.pid)
if (-not $MeasureFixedInfo -or $MeasureFixed.entry -ne (Join-Path $MeasureRoot 'dist\src\fixed-tunnel-runner.js') -or
    $MeasureFixedInfo.ExecutablePath -ne $MeasureFixed.executable -or
    -not $MeasureFixedInfo.CommandLine.Contains([string]$MeasureFixed.entry) -or
    -not $MeasureFixedInfo.CommandLine.Contains('--autodev-fixed-instance=' + $MeasureFixed.instance) -or
    [Math]::Abs((([DateTime]$MeasureFixed.created).ToUniversalTime() - $MeasureFixedInfo.CreationDate.ToUniversalTime()).TotalMilliseconds) -ge 1) { throw 'Fixed gateway ownership was not verified.' }
function Assert-MeasureIdle {
  $Value = Invoke-AutoDevAdmin $MeasureConfig $MeasureRuntime '/admin/status'
  Assert-AutoDevServerIdentity $Value $MeasureCore
  if ($Value.active_job_id -or $null -eq $Value.PSObject.Properties['active_job_id'] -or $null -eq $Value.tasks -or @($Value.tasks | Where-Object { -not (Test-AutoDevTerminalOrUndispatchedTask $_) }).Count) { throw 'Idle sample refused: execution is active or uncertain.' }
}
function Get-MeasureSample {
  $All = @(Get-CimInstance Win32_Process)
  $Found = @($All | Where-Object { $_.ProcessId -in @($MeasureCore.pid,$MeasureFixed.pid) })
  do {
    $Added = @($All | Where-Object { $Entry = $_; $Parent = $Found | Where-Object ProcessId -eq $Entry.ParentProcessId | Select-Object -First 1; $Parent -and $Entry.ProcessId -notin $Found.ProcessId -and $Entry.CreationDate -ge $Parent.CreationDate })
    $Found += $Added
  } while ($Added.Count)
  $Values = @($Found | ForEach-Object {
    $P = Get-Process -Id $_.ProcessId -ErrorAction Stop
    [pscustomobject]@{ pid=$P.Id; name=$P.ProcessName; created=$P.StartTime.ToUniversalTime().ToString('o'); cpuSeconds=$P.TotalProcessorTime.TotalSeconds; workingSetBytes=$P.WorkingSet64; privateBytes=$P.PrivateMemorySize64 }
  } | Sort-Object pid)
  return [pscustomobject]@{ at=[DateTimeOffset]::UtcNow.ToString('o'); processes=$Values }
}
Assert-MeasureIdle
$MeasureWatch = [Diagnostics.Stopwatch]::StartNew()
$MeasureSamples = @((Get-MeasureSample))
Write-Output 'Sampling only the verified complete AutoDev process group; no model request is made.'
while ($MeasureWatch.Elapsed.TotalSeconds -lt $Seconds) {
  Start-Sleep -Seconds ([Math]::Min(10, [Math]::Max(1, [Math]::Ceiling($Seconds - $MeasureWatch.Elapsed.TotalSeconds))))
  $MeasureSamples += Get-MeasureSample
}
$MeasureWatch.Stop()
Assert-MeasureIdle
$MeasureFirst = $MeasureSamples[0]; $MeasureLast = $MeasureSamples[-1]
$MeasureIdentity = ($MeasureFirst.processes | ForEach-Object { "$($_.pid):$($_.created)" }) -join ','
if (@($MeasureSamples | Where-Object { (($_.processes | ForEach-Object { "$($_.pid):$($_.created)" }) -join ',') -ne $MeasureIdentity }).Count) { throw 'Process membership changed during idle measurement; retry after reconciliation.' }
$MeasureElapsed = ([DateTimeOffset]::Parse($MeasureLast.at)-[DateTimeOffset]::Parse($MeasureFirst.at)).TotalSeconds
$MeasureCpu = ($MeasureLast.processes | Measure-Object cpuSeconds -Sum).Sum - ($MeasureFirst.processes | Measure-Object cpuSeconds -Sum).Sum
$MeasureWorking = @($MeasureSamples | ForEach-Object { ($_.processes | Measure-Object workingSetBytes -Sum).Sum / 1MB })
$MeasurePrivate = @($MeasureSamples | ForEach-Object { ($_.processes | Measure-Object privateBytes -Sum).Sum / 1MB })
$MeasureResult = [ordered]@{
  powerShellVersion=$PSVersionTable.PSVersion.ToString()
  measuredUtc=$MeasureLast.at; elapsedSeconds=[Math]::Round($MeasureElapsed,2); processCount=$MeasureFirst.processes.Count
  processNames=@($MeasureFirst.processes | Group-Object name | ForEach-Object { @{name=$_.Name;count=$_.Count} })
  logicalProcessors=[Environment]::ProcessorCount; cpuDeltaSeconds=[Math]::Round($MeasureCpu,4)
  cpuPercentOneCore=[Math]::Round(100*$MeasureCpu/$MeasureElapsed,3)
  cpuPercentMachine=[Math]::Round(100*$MeasureCpu/$MeasureElapsed/[Environment]::ProcessorCount,3)
  workingSetMiB=@{min=[Math]::Round(($MeasureWorking|Measure-Object -Minimum).Minimum,2);max=[Math]::Round(($MeasureWorking|Measure-Object -Maximum).Maximum,2);mean=[Math]::Round(($MeasureWorking|Measure-Object -Average).Average,2)}
  privateMiB=@{min=[Math]::Round(($MeasurePrivate|Measure-Object -Minimum).Minimum,2);max=[Math]::Round(($MeasurePrivate|Measure-Object -Maximum).Maximum,2)}
  modelRequestsByMeasurement=0; samples=$MeasureSamples
}
$MeasureDestination = Join-Path $MeasureRoot '.local-tests/2026-09-06-validation'
New-Item -ItemType Directory -Path $MeasureDestination -Force | Out-Null
$MeasureResult | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath (Join-Path $MeasureDestination ('idle-resource-sample-ps' + $PSVersionTable.PSVersion.Major + '.json')) -Encoding UTF8
$MeasureResult.Remove('samples')
$MeasureResult | ConvertTo-Json -Depth 5
