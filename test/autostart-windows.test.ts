import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const product = path.resolve('.');
const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
async function run(shell: string, script: string) {
  try {
    const result = await execute(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;" + script + ';exit 0', 'utf16le').toString('base64')], { cwd: product, windowsHide: true, timeout: 45_000, maxBuffer: 1_000_000 });
    return { code: 0, output: result.stdout + result.stderr };
  } catch (error) {
    const result = error as { code?: number; stdout?: string; stderr?: string };
    return { code: result.code ?? -1, output: (result.stdout ?? '') + (result.stderr ?? '') };
  }
}

function fixture() {
  const testRoot = path.join(product, '.local-tests'); mkdirSync(testRoot, { recursive: true });
  const root = mkdtempSync(path.join(testRoot, 'autostart 中文 space &-'));
  const scripts = path.join(root, 'scripts'), runtime = path.join(root, '.runtime'), startup = path.join(root, 'synthetic Startup');
  for (const directory of [scripts, runtime, startup]) mkdirSync(directory);
  for (const name of ['local-common.ps1', 'manage-daily.ps1', 'autostart.ps1', 'availability.ps1']) copyFileSync(path.join(product, 'scripts', name), path.join(scripts, name));
  const stateFile = path.join(runtime, 'synthetic-state.json');
  const eventsFile = path.join(runtime, 'events.txt');
  const codex = path.join(root, 'codex.cmd'); writeFileSync(codex, '@echo off\r\nexit /b 0\r\n');
  const commonFile = path.join(scripts, 'local-common.ps1');
  writeFileSync(commonFile, '\ufeff' + readFileSync(commonFile, 'utf8').replace(/^\uFEFF/, '') + `
function Get-FixtureState { Get-Content -LiteralPath ${quote(stateFile)} -Raw -Encoding UTF8 | ConvertFrom-Json }
function Save-FixtureState($Value) { [IO.File]::WriteAllText(${quote(stateFile)}, ($Value | ConvertTo-Json -Depth 8), [Text.Encoding]::UTF8) }
function Add-FixtureEvent([string]$Value) { Add-Content -LiteralPath ${quote(eventsFile)} -Value $Value }
function Read-AutoDevConfig([string]$Path) { return @{port=57931} }
function Protect-AutoDevRuntime([string]$Path) { }
function Read-AutoDevProcessRecord([string]$Path) { $s=Get-FixtureState; if ($s.running) { return @{pid=91919;instanceId='synthetic'} }; return $null }
function Get-AutoDevProcessInfo([int]$ProcessId) { return @{ProcessId=91919} }
function Get-AutoDevRecordedProcess($Record) { return Get-AutoDevProcessInfo $Record.pid }
function Test-AutoDevOwnedProcess($Record,$Info,[string]$Root) { return -not (Get-FixtureState).wrongOwner }
function Test-AutoDevPortFree([int]$Port) { return -not (Get-FixtureState).portConflict }
function Invoke-AutoDevAdmin($Config,[string]$Runtime,[string]$Path) {
  $s=Get-FixtureState
  if ($s.authMissing) { throw 'Synthetic private auth text must never appear' }
  $task = if ($s.task) { $s.task } else { [pscustomobject]@{execution_status=$s.execution} }
  return [pscustomobject]@{ready=$true;process_id=91919;instance_id='synthetic';active_job_id=$s.active;tasks=@($task);requests=@(@{outcome='uncertain';operation='review'})}
}
function Assert-AutoDevServerIdentity($Status,$Record) { if ((Get-FixtureState).wrongInstance) { throw 'Synthetic private identity text must never appear' } }
function Resolve-AutoDevNode { if ($env:AUTODEV_NODE_EXECUTABLE) { return $env:AUTODEV_NODE_EXECUTABLE }; return ${quote(process.execPath)} }
function Resolve-AutoDevCodex { if ($env:AUTODEV_CODEX_EXECUTABLE) { return $env:AUTODEV_CODEX_EXECUTABLE }; return ${quote(codex)} }
`);
  writeFileSync(path.join(scripts, 'autodev.ps1'), `\ufeffparam([string]$Command)
. (Join-Path $PSScriptRoot 'local-common.ps1')
Add-FixtureEvent ('core:'+$Command)
$s=Get-FixtureState
if ($Command -eq 'stop') { if ($s.coreStopFails) { exit 42 };$s.running=$false;Save-FixtureState $s }
exit 0
`);
  writeFileSync(path.join(scripts, 'fixed-tunnel.ps1'), `\ufeffparam([string]$Action)
. (Join-Path $PSScriptRoot 'local-common.ps1')
Add-FixtureEvent ('fixed:'+$Action)
$s=Get-FixtureState
if ($Action -eq 'stop') { if ($s.fixedStopFails) { exit 43 };$s.fixed=$false;Save-FixtureState $s }
if ($Action -eq 'status') { @{process_running=$s.fixed;native_process_running=$s.fixed;native_ready=$s.fixed;route_lease_valid=$s.fixed;external_metadata_ready=$s.fixed;ready_for_chatgpt_probe=$s.fixed;private='Synthetic private status must not appear'} | ConvertTo-Json -Compress }
exit 0
`);
  writeFileSync(path.join(scripts, 'start-daily.ps1'), `\ufeff
. (Join-Path $PSScriptRoot 'local-common.ps1')
$root=Split-Path -Parent $PSScriptRoot
$m=New-Object Threading.Mutex($false,(Get-AutoDevDailyMutexName $root))
if (-not $m.WaitOne(0)) { exit 92 }
try {
Add-FixtureEvent 'daily:start'
$s=Get-FixtureState
if ($s.delay) { Start-Sleep -Milliseconds $s.delay }
if ($s.startFails) { exit 41 }
$s.running=$true;$s.fixed=$true;Save-FixtureState $s
@{node=$env:AUTODEV_NODE_EXECUTABLE;codex=$env:AUTODEV_CODEX_EXECUTABLE;path=$env:PATH} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root '.runtime\\environment.json') -Encoding UTF8
} finally { $m.ReleaseMutex();$m.Dispose() }
exit 0
`);
  const set = (changes: Record<string, unknown> = {}) => writeFileSync(stateFile, JSON.stringify({ running: true, fixed: true, execution: 'completed', active: null, ...changes }));
  set();
  const events = () => existsSync(eventsFile) ? readFileSync(eventsFile, 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/).filter(Boolean) : [];
  const clear = () => writeFileSync(eventsFile, '');
  const manage = (shell: string, action: string) => run(shell, `& ${quote(path.join(scripts, 'manage-daily.ps1'))} -Action ${action};exit $LASTEXITCODE`);
  const prelude = `. ${quote(path.join(scripts, 'autostart.ps1'))};$ctx=New-AutoDevAutostartContext ${quote(root)};$ctx.StartupFile=Join-Path ${quote(startup)} ($ctx.Name+'.vbs');`;
  const scheduler = `
$script:task=$null;$script:registerCalls=0
function Get-ScheduledTask { param($TaskPath); if ($script:task) { return $script:task } }
function New-ScheduledTaskAction { param($Execute,$Argument,$WorkingDirectory); return @{Execute=$Execute;Arguments=$Argument;WorkingDirectory=$WorkingDirectory} }
function New-ScheduledTaskTrigger { param([switch]$AtLogOn,$User); if (-not $AtLogOn) { throw 'Not a logon trigger' };return @{UserId=$User} }
function New-ScheduledTaskPrincipal { param($UserId,$LogonType,$RunLevel);return @{UserId=$UserId;LogonType=$LogonType;RunLevel=$RunLevel} }
function New-ScheduledTaskSettingsSet { param($MultipleInstances,[switch]$AllowStartIfOnBatteries,[switch]$DontStopIfGoingOnBatteries,$ExecutionTimeLimit,$RestartCount,$RestartInterval);if ($MultipleInstances -ne 'IgnoreNew' -or $ExecutionTimeLimit.TotalMinutes -ne 0 -or $RestartCount -ne 3 -or $RestartInterval.TotalMinutes -ne 1) { throw 'Unsafe settings' };return @{Enabled=$true;MultipleInstances=$MultipleInstances;RestartCount=$RestartCount} }
function New-ScheduledTask { param($Action,$Trigger,$Principal,$Settings,$Description);return [pscustomobject]@{TaskName=$ctx.Name;Actions=@($Action);Triggers=@($Trigger);Principal=$Principal;Settings=$Settings;Description=$Description} }
function Register-ScheduledTask { param($TaskName,$TaskPath,$InputObject,[switch]$Force);$script:registerCalls++;if ((Get-FixtureState).accessDenied) { throw (New-Object UnauthorizedAccessException('Synthetic registration access denied')) };if ((Get-FixtureState).registrationFailure) { throw 'Synthetic unexpected registration failure' };$script:task=$InputObject }
function Disable-ScheduledTask { param($TaskName,$TaskPath);$script:task.Settings.Enabled=$false }
function Unregister-ScheduledTask { param($TaskName,$TaskPath,[switch]$Confirm);$script:task=$null }
function Get-ScheduledTaskInfo { param($TaskName,$TaskPath);return @{LastTaskResult=0} }
`;
  return { root, runtime, scripts, startup, codex, set, events, clear, manage, prelude, scheduler };
}

for (const shell of ['powershell.exe', 'pwsh.exe']) {
  test(`${shell}: a removed versioned Codex executable resolves only an installed durable-PATH replacement`, { skip: process.platform !== 'win32' }, async context => {
    if ((await run(shell, '$PSVersionTable.PSVersion.ToString()')).code !== 0) { context.skip(`${shell} unavailable`); return; }
    const f = fixture();
    const result = await run(shell, f.prelude + `
$cfg=[pscustomobject]@{nodeExecutable=${quote(process.execPath)};codexExecutable=(Join-Path $ctx.Root 'removed-version\\codex.exe')}
$env:PATH='TRANSIENT_PATH_MUST_NOT_BE_USED'
function Resolve-AutoDevApplication($Pinned,$Names) { if ($Pinned -or $env:PATH -match 'TRANSIENT_PATH' -or ($Names -join ',') -ne 'codex.exe,codex.cmd') { throw 'Unsafe executable discovery' }; return ${quote(f.codex)} }
Initialize-AutoDevAutostartEnvironment $cfg
if ($env:AUTODEV_CODEX_EXECUTABLE -ne ${quote(f.codex)}) { throw 'Removed executable prevented startup after app update' }
$cfg.codexExecutable='relative.cmd'
try { Initialize-AutoDevAutostartEnvironment $cfg;throw 'Invalid path accepted' } catch { if ($_.Exception.Message -notlike '*saved executable path is invalid*') { throw } }
Write-Output 'UPDATED_EXECUTABLE_OK'
`);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /UPDATED_EXECUTABLE_OK/);
  });

  test(`${shell}: real monitor survives a failed child launcher and exits after disable`, { skip: process.platform !== 'win32', timeout: 60_000 }, async context => {
    if ((await run(shell, '$PSVersionTable.PSVersion.ToString()')).code !== 0) { context.skip(`${shell} unavailable`); return; }
    const f = fixture();
    f.set({ running: false, fixed: false, startFails: true });
    const result = await run(shell, f.prelude + f.scheduler + `
$null=Enable-AutoDevAutostart $ctx
. ${quote(path.join(f.scripts, 'availability.ps1'))}
$ctx.DelaySeconds=0
function Get-AutoDevDesktopSession { return $null }
function Start-Sleep { param($Seconds); if ($Seconds -eq 5) { $cfg=Read-AutoDevAutostartConfig $ctx;$cfg.enabled=$false;Save-AutoDevAutostartConfig $ctx $cfg } }
Invoke-AutoDevAvailabilityWatch $ctx
$state=Get-Content -LiteralPath (Join-Path $ctx.Root '.runtime\\availability.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($state.status -ne 'retry_wait' -or $state.failures -ne 1 -or $state.retrySeconds -ne 30) { throw 'Failed child terminated the monitor or lost retry state' }
Write-Output 'MONITOR_CHILD_FAILURE_OK'
`);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /MONITOR_CHILD_FAILURE_OK/);
    assert.equal(f.events().filter(event => event === 'daily:start').length, 1);
  });

  test(`${shell}: daily lifecycle protects active/uncertain executions, identity, ordering and concurrent start`, { skip: process.platform !== 'win32', timeout: 120_000 }, async context => {
    if ((await run(shell, '$PSVersionTable.PSVersion.ToString()')).code !== 0) { context.skip(`${shell} unavailable`); return; }
    const f = fixture();
    for (const execution of ['running','starting','awaiting_approval','interrupting','recovery_required','dispatch_uncertain','unknown-future-status']) {
      f.set({ execution }); const result = await f.manage(shell, 'stop'); assert.equal(result.code, 1, result.output); assert.deepEqual(f.events(), []);
    }
    for (const scenario of [{ active: 'synthetic-active' }, { wrongOwner: true }, { wrongInstance: true }, { authMissing: true }, { running: false, portConflict: true }]) {
      f.set(scenario); const result = await f.manage(shell, 'restart'); assert.equal(result.code, 1, result.output); assert.deepEqual(f.events(), []); assert.doesNotMatch(result.output, /Synthetic private/);
    }
    const blocked = { execution_status: 'blocked', status: 'blocked', routing_status: 'blocked', dispatch_status: 'not_dispatched', thread_id: null, turn_id: null,
      routing_attempt: { operation: 'submit', round: 1, decision: { status: 'blocked', selected_model: null, selected_effort: null } } };
    for (const task of [
      { ...blocked, dispatch_status: undefined }, { ...blocked, dispatch_status: 'unknown' },
      { ...blocked, thread_id: 'already-dispatched' }, { ...blocked, turn_id: 'existing-turn' },
      { ...blocked, thread_id: undefined }, { ...blocked, turn_id: undefined },
      { ...blocked, status: undefined }, { ...blocked, routing_status: 'selected' },
      { ...blocked, routing_attempt: undefined },
      { ...blocked, routing_attempt: { ...blocked.routing_attempt, operation: 'continue' } },
      { ...blocked, routing_attempt: { ...blocked.routing_attempt, round: 2 } },
      { ...blocked, routing_attempt: { ...blocked.routing_attempt, decision: { status: 'blocked' } } },
      { ...blocked, routing_attempt: { ...blocked.routing_attempt, decision: { ...blocked.routing_attempt.decision, selected_model: 'synthetic-model' } } },
    ]) {
      f.set({ task }); const malformed = await f.manage(shell, 'stop'); assert.equal(malformed.code, 1, malformed.output); assert.deepEqual(f.events(), []);
    }
    f.set({ task: blocked }); const safeBlockedStop = await f.manage(shell, 'stop'); assert.equal(safeBlockedStop.code, 0, safeBlockedStop.output); assert.deepEqual(f.events(), ['fixed:stop','core:stop']);
    f.clear(); f.set({ task: { execution_status: 'completed', routing_status: 'blocked', thread_id: 'prior-thread', turn_id: 'prior-turn' } });
    const blockedFollowupStop = await f.manage(shell, 'stop'); assert.equal(blockedFollowupStop.code, 0, blockedFollowupStop.output); assert.deepEqual(f.events(), ['fixed:stop','core:stop']);
    f.clear();
    f.set(); const status = await f.manage(shell, 'status'); assert.equal(status.code, 0, status.output); assert.equal(JSON.parse(status.output).ready_for_chatgpt_probe, true); assert.doesNotMatch(status.output, /Synthetic private/);
    f.clear(); const stopped = await f.manage(shell, 'stop'); assert.equal(stopped.code, 0, stopped.output); assert.deepEqual(f.events(), ['fixed:stop','core:stop']); assert.ok(existsSync(path.join(f.runtime, 'manual-stop.json')));
    f.clear(); const restarted = await f.manage(shell, 'restart'); assert.equal(restarted.code, 0, restarted.output); assert.deepEqual(f.events(), ['fixed:stop','core:stop','daily:start']); assert.equal(existsSync(path.join(f.runtime, 'manual-stop.json')), false);
    f.clear(); f.set({ fixedStopFails: true }); const failed = await f.manage(shell, 'restart'); assert.equal(failed.code, 1, failed.output); assert.deepEqual(f.events(), ['fixed:stop']);
    f.clear(); f.set({ startFails: true }); const failedStart = await f.manage(shell, 'start'); assert.equal(failedStart.code, 41, failedStart.output);
    f.clear(); f.set({ delay: 2500 }); const first = f.manage(shell, 'start');
    const deadline = Date.now() + 20_000; while (f.events()[0] !== 'daily:start' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 80));
    const second = await f.manage(shell, 'stop'); assert.equal(second.code, 1, second.output); assert.equal((await first).code, 0); assert.deepEqual(f.events(), ['daily:start']);
  });

  test(`${shell}: login registration, access-denied fallback, reversible controls and delayed manual stop`, { skip: process.platform !== 'win32', timeout: 120_000 }, async context => {
    if ((await run(shell, '$PSVersionTable.PSVersion.ToString()')).code !== 0) { context.skip(`${shell} unavailable`); return; }
    const f = fixture();
    const scheduled = await run(shell, f.prelude + f.scheduler + `
$a=Enable-AutoDevAutostart $ctx;if (-not $a.enabled -or $a.mechanism -ne 'scheduled-task') { throw 'Enable failed' }
$cfg=Read-AutoDevAutostartConfig $ctx;if ($cfg.nodeExecutable -ne ${quote(process.execPath)} -or $cfg.codexExecutable -ne ${quote(f.codex)}) { throw 'Executable pin missing' }
$b=Disable-AutoDevAutostart $ctx;if ($b.enabled -or -not $b.registered) { throw 'Disable failed' }
$c=Enable-AutoDevAutostart $ctx;if (-not $c.enabled) { throw 'Resume failed' }
$script:task.Actions[0].Arguments='unowned';try { $null=Disable-AutoDevAutostart $ctx;throw 'Unsafe change accepted' } catch { if ($_.Exception.Message -notlike '*ownership or action mismatch*') { throw } }
$script:task.Actions[0].Arguments=$ctx.Arguments
$d=Disable-AutoDevAutostart $ctx $true;if ($d.configured -or $script:task) { throw 'Remove failed' }
Write-Output 'SCHEDULED_OK'
`);
    assert.equal(scheduled.code, 0, scheduled.output); assert.match(scheduled.output, /SCHEDULED_OK/);
    f.set({ registrationFailure: true });
    const failure = await run(shell, f.prelude + f.scheduler + `try { $null=Enable-AutoDevAutostart $ctx;throw 'Unexpected success' } catch { if ($_.Exception.Message -notlike '*unexpected registration failure*') { throw } };if (Test-Path -LiteralPath $ctx.StartupFile) { throw 'Unexpected fallback' }`);
    assert.equal(failure.code, 0, failure.output);
    f.set({ accessDenied: true });
    const fallback = await run(shell, f.prelude + f.scheduler + `
$a=Enable-AutoDevAutostart $ctx;if (-not $a.enabled -or $a.mechanism -ne 'startup-folder') { throw 'Fallback failed' }
$text=[IO.File]::ReadAllText($ctx.StartupFile);if ($text -notlike '*launcher.Run*' -or $text -notlike '*False*') { throw 'Incorrect launcher' }
$b=Disable-AutoDevAutostart $ctx;if ($b.enabled -or (Test-Path -LiteralPath $ctx.StartupFile)) { throw 'Fallback disable failed' }
$c=Enable-AutoDevAutostart $ctx;if (-not $c.enabled) { throw 'Fallback resume failed' }
function Start-Sleep { param($Seconds);if ($Seconds -ne 30) { throw 'Wrong login delay' };. ${quote(path.join(f.scripts, 'manage-daily.ps1'))};Invoke-AutoDevDailyAction $ctx.Root 'stop' }
Invoke-AutoDevAutostartRun $ctx
Write-Output 'FALLBACK_OK'
`);
    assert.equal(fallback.code, 0, fallback.output); assert.match(fallback.output, /manual stop occurred/); assert.deepEqual(f.events(), ['fixed:stop','core:stop']);
    f.clear();
    const delayedDisable = await run(shell, f.prelude + f.scheduler + `
function Start-Sleep { param($Seconds);$null=Disable-AutoDevAutostart $ctx }
Invoke-AutoDevAutostartRun $ctx
`);
    assert.equal(delayedDisable.code, 0, delayedDisable.output); assert.match(delayedDisable.output, /disabled during/); assert.deepEqual(f.events(), []);
    f.set();
    const actualRun = await run(shell, f.prelude + f.scheduler + `
$null=Enable-AutoDevAutostart $ctx
function Start-Sleep { param($Seconds);if ($Seconds -ne 30) { throw 'Wrong delay' } }
$env:PATH='SYNTHETIC_TRANSIENT_PATH_NOT_INHERITED'
Invoke-AutoDevAutostartRun $ctx
$null=Disable-AutoDevAutostart $ctx $true
`);
    assert.equal(actualRun.code, 0, actualRun.output); assert.deepEqual(f.events(), ['daily:start']);
    const environment = JSON.parse(readFileSync(path.join(f.runtime, 'environment.json'), 'utf8').replace(/^\uFEFF/, ''));
    assert.equal(environment.node, process.execPath); assert.equal(environment.codex, f.codex); assert.doesNotMatch(environment.path, /SYNTHETIC_TRANSIENT/);
    const unowned = await run(shell, f.prelude + f.scheduler + `[IO.File]::WriteAllText($ctx.StartupFile,'unowned');try { $null=Enable-AutoDevAutostart $ctx;throw 'Unsafe overwrite' } catch { if ($_.Exception.Message -notlike '*Startup file ownership mismatch*') { throw } };if ([IO.File]::ReadAllText($ctx.StartupFile) -ne 'unowned') { throw 'File changed' }`);
    assert.equal(unowned.code, 0, unowned.output);
  });
}
