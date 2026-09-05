import { execFileSync } from 'node:child_process';
import path from 'node:path';

export type ProcessIdentity = { created: string; command: string; executable: string };
export type OwnedProcess = { pid: number; created: string; executable: string; entry: string; instance: string };

export function processIdentity(pid: number): ProcessIdentity | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid process ID.');
  const script = "$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$env:AUTODEV_INSPECT_PID); if($null -ne $p){$v=@{created=$p.CreationDate.ToUniversalTime().ToString('o');command=$p.CommandLine;executable=$p.ExecutablePath}|ConvertTo-Json -Compress;[Console]::Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($v)))}";
  // An inspection error is not evidence that a process has stopped.
  const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, env: { ...process.env, AUTODEV_INSPECT_PID: String(pid) }, timeout: 10000 }).trim();
  return result ? JSON.parse(Buffer.from(result, 'base64').toString('utf8')) : null;
}

export function matchesProcess(record: OwnedProcess, current: ProcessIdentity, expectedEntry: string, expectedExecutable = process.execPath): boolean {
  return Number.isSafeInteger(record.pid) && record.pid > 0 && /^[a-f0-9-]{36}$/.test(record.instance) &&
    path.resolve(record.entry) === path.resolve(expectedEntry) && record.executable.toLowerCase() === expectedExecutable.toLowerCase() &&
    current.executable.toLowerCase() === record.executable.toLowerCase() && current.created === record.created &&
    current.command.includes(record.entry) && current.command.includes(`--autodev-secure-instance=${record.instance}`);
}

export function requireOwned(record: OwnedProcess, entry: string): ProcessIdentity | null {
  const current = processIdentity(record.pid);
  if (current && !matchesProcess(record, current, entry)) throw new Error('PROCESS_IDENTITY_MISMATCH: no process was changed.');
  return current;
}
