import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// A Windows named mutex is an OS object: no stale file needs to be removed after
// a crash or reboot. Global provides one namespace across interactive sessions.
// Creating Global mutexes does not require the file-mapping privilege; a denied
// mutex creation is an error, never a reason to fall back to a session-local lock.
// https://learn.microsoft.com/en-us/windows/win32/termserv/kernel-object-namespaces
const HOLDER_SCRIPT = `
$ErrorActionPreference = 'Stop'
$AutoDevMutex = $null
$AutoDevOwnsMutex = $false
try {
  $AutoDevMutex = [System.Threading.Mutex]::new($false, $env:AUTODEV_MUTEX_NAME)
  try { $AutoDevOwnsMutex = $AutoDevMutex.WaitOne(0) }
  catch [System.Threading.AbandonedMutexException] { $AutoDevOwnsMutex = $true }
  if (-not $AutoDevOwnsMutex) {
    [Console]::Out.WriteLine('BUSY')
    [Console]::Out.Flush()
    exit 23
  }
  [Console]::Out.WriteLine('READY')
  [Console]::Out.Flush()
  $AutoDevReleaseLine = [Console]::In.ReadLine()
  if ($null -ne $AutoDevReleaseLine -and $AutoDevReleaseLine -ne 'RELEASE') { exit 24 }
} catch {
  [Console]::Error.WriteLine('LOCK_ERROR')
  exit 25
} finally {
  if ($AutoDevOwnsMutex) { $AutoDevMutex.ReleaseMutex() }
  if ($null -ne $AutoDevMutex) { $AutoDevMutex.Dispose() }
}
`;

/**
 * Holds a single writer lease until release. On Windows an owned hidden helper
 * owns the OS mutex. Parent death closes its stdin, so even an abrupt parent exit
 * releases the lease. Unexpected helper death while held terminates this writer
 * with exit 70; continuing without an exclusive lease would corrupt state.
 * Call release only after every writer and executor has stopped.
 *
 * Other platforms use a conservative exclusive file. They deliberately require
 * manual diagnosis after a crash; there is no unsafe automatic stale takeover.
 */
export async function acquireRuntimeLock(runtimeDir: string): Promise<() => void> {
  const canonical = realpathSync.native(runtimeDir);
  if (!statSync(canonical).isDirectory()) throw new Error('Runtime lock requires an existing directory.');
  if (process.platform !== 'win32') return acquireExclusiveFile(canonical);
  const digest = createHash('sha256').update(canonical.toLowerCase()).digest('hex');
  const mutexName = `Global\\AutoDev-${digest}`;
  const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

  return new Promise<() => void>((resolve, reject) => {
    let settled = false;
    let held = false;
    let intentional = false;
    let output = '';
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command', HOLDER_SCRIPT], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, AUTODEV_MUTEX_NAME: mutexName },
    });
    const timer = setTimeout(() => fail('Runtime mutex helper did not become ready. No writer was started.'), 15_000);

    function lostLease(): void {
      if (!held || intentional) return;
      intentional = true;
      // Do not print helper output, paths or process environment.
      process.stderr.write('[AutoDev] Runtime writer lock was lost; stopping immediately.\n');
      process.exit(70);
    }
    function fail(message: string): void {
      if (held) { lostLease(); return; }
      if (settled) return;
      settled = true;
      intentional = true;
      clearTimeout(timer);
      child.stdin.end();
      // Only this exact spawned helper is terminated on failed initialization.
      // Normal release uses stdin and never looks up or kills another process.
      if (child.exitCode === null && child.signalCode === null) child.kill();
      reject(new Error(message));
    }
    const release = (): void => {
      if (intentional) return;
      intentional = true;
      held = false;
      child.stdin.end('RELEASE\n');
    };
    child.stdout.setEncoding('ascii');
    child.stdout.on('data', (data: string) => {
      output += data;
      if (output.length > 128) { fail('Invalid runtime mutex helper response.'); return; }
      const lines = output.split(/\r?\n/);
      output = lines.pop()!;
      for (const line of lines) {
        if (line === 'READY' && !settled) {
          held = true;
          settled = true;
          clearTimeout(timer);
          resolve(release);
        } else if (line === 'BUSY' && !settled) {
          fail('AutoDev runtime already has a live writer.');
        } else {
          fail('Invalid runtime mutex helper response.');
        }
      }
    });
    child.stderr.on('data', () => { /* Diagnostics are fixed and sanitized by this module. */ });
    child.stdin.on('error', () => {
      if (held && !intentional) lostLease();
      else if (!settled) fail('Runtime mutex helper input failed.');
    });
    child.once('error', () => fail('Unable to start the Windows runtime mutex helper.'));
    child.once('exit', () => {
      clearTimeout(timer);
      if (held && !intentional) lostLease();
      else if (!settled) fail('Global runtime mutex unavailable or denied. No fallback or policy change was attempted.');
    });
  });
}

function acquireExclusiveFile(directory: string): () => void {
  const file = path.join(directory, 'os-writer.lock');
  const nonce = randomUUID();
  let descriptor: number;
  try { descriptor = openSync(file, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('Runtime writer lock already exists. On this platform, verify the prior owner manually; automatic stale takeover is disabled.');
    }
    throw error;
  }
  try { writeFileSync(descriptor, JSON.stringify({ pid: process.pid, nonce })); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // Never remove a replaced file or a symlink on behalf of an earlier owner.
    if (lstatSync(file).isSymbolicLink()) throw new Error('Runtime lock ownership changed.');
    const current = JSON.parse(readFileSync(file, 'utf8')) as { nonce?: string };
    if (current.nonce !== nonce) throw new Error('Runtime lock ownership changed.');
    unlinkSync(file);
  };
}
