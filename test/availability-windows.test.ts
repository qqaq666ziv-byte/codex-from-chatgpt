import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
for (const shell of ['powershell.exe', 'pwsh.exe']) {
  test(`${shell}: Codex availability recovers startup/transport failure with backoff and preserves manual stop`, { skip: process.platform !== 'win32' }, async context => {
    try { await execute(shell, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']); }
    catch { context.skip(`${shell} unavailable`); return; }
    mkdirSync('.local-tests', { recursive: true });
    const root = mkdtempSync(path.resolve('.local-tests/availability 中文-'));
    const script = `
$ErrorActionPreference='Stop'
. ${quote(path.resolve('scripts/availability.ps1'))}
$ctx=[pscustomobject]@{Root=${quote(root)}}
$script:ready=$false;$script:starts=0;$script:stopped=$false;$script:desktop=$null
function Get-AutoDevDesktopSession { return $script:desktop }
function Test-AutoDevAvailabilityStopped($Context,$TriggerUtc) { return $script:stopped }
function Test-AutoDevAvailabilityReady($Context) { return $script:ready }
function Start-AutoDevAvailabilityAttempt($Context,$TriggerUtc) { $script:starts++;return $script:ready }
function Save-AutoDevAvailabilityState($Context,$State) { }
$t=[DateTimeOffset]::Parse('2026-09-12T00:00:00Z')
$s=New-AutoDevAvailabilityState $t
Invoke-AutoDevAvailabilityTick $ctx $s $t
if ($script:starts -ne 1 -or $s.failures -ne 1 -or $s.status -ne 'retry_wait') { throw 'Initial failure was not recoverable' }
Invoke-AutoDevAvailabilityTick $ctx $s ($t.AddSeconds(10))
if ($script:starts -ne 1) { throw 'Retry storm' }
$script:ready=$true
Invoke-AutoDevAvailabilityTick $ctx $s ($t.AddSeconds(31))
if ($s.status -ne 'ready' -or $s.failures -ne 0) { throw 'Failed login was never recovered' }
$script:desktop=[pscustomobject]@{key='codex-A';startedUtc=$t.AddSeconds(40).ToString('o')}
$script:ready=$false
Invoke-AutoDevAvailabilityTick $ctx $s ($t.AddSeconds(40))
if ($script:starts -ne 2) { throw 'Opening Codex did not trigger recovery' }
$script:stopped=$true
Invoke-AutoDevAvailabilityTick $ctx $s ($t.AddSeconds(80))
if ($s.status -ne 'manually_stopped' -or $script:starts -ne 2) { throw 'Manual stop was ignored' }
$script:stopped=$false;$script:ready=$true
$script:desktop=[pscustomobject]@{key='codex-B';startedUtc=$t.AddSeconds(90).ToString('o')}
Invoke-AutoDevAvailabilityTick $ctx $s ($t.AddSeconds(90))
if ($s.status -ne 'ready' -or $s.triggerUtc -ne $script:desktop.startedUtc) { throw 'Reopening Codex did not rearm' }
$script:ready=$false
Invoke-AutoDevAvailabilityTick $ctx $s ($t.AddSeconds(151))
if ($script:starts -ne 3) { throw 'Transport death was not recovered' }
for ($i=0;$i -lt 12;$i++) { Invoke-AutoDevAvailabilityTick $ctx $s ($t.AddSeconds(1000+600*$i)) }
if ($s.retrySeconds -ne 300) { throw 'Backoff was not capped' }
function Test-AutoDevAvailabilityReady($Context) { throw 'PRIVATE_CREDENTIAL_MUST_NOT_APPEAR' }
Invoke-AutoDevAvailabilityTick $ctx $s ($t.AddDays(1))
if ($s.status -ne 'retry_wait') { throw 'Probe error killed recovery' }
Write-Output 'AVAILABILITY_OK'
`;
    const result = await execute(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 45_000 }).catch((error: { stderr?: string }) => { throw new Error(error.stderr); });
    assert.match(result.stdout, /AVAILABILITY_OK/);
    assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_CREDENTIAL/);
  });
}
