import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { acquireRuntimeLock } from '../src/runtime-lock.js';

type WorkerEvent = { event: 'acquired' | 'rejected' | 'released'; pid?: number; error?: string };
const testRoot = path.resolve('.local-tests');
const moduleURL = pathToFileURL(path.resolve('src/runtime-lock.ts')).href;
const windows = process.platform === 'win32';

function fixture(t: { after(callback: () => Promise<void>): void }) {
  mkdirSync(testRoot, { recursive: true });
  const directory = mkdtempSync(path.join(testRoot, 'runtime-lock-'));
  const program = path.join(directory, 'worker.mjs');
  writeFileSync(program, `
import { acquireRuntimeLock } from ${JSON.stringify(moduleURL)};
try {
  const release = await acquireRuntimeLock(process.argv[2]);
  process.send({event:'acquired',pid:process.pid});
  process.on('message', message => {
    if (message === 'release') {
      release();
      process.send({event:'released'}, () => process.disconnect());
    }
  });
} catch (error) {
  process.exitCode = 11;
  process.send({event:'rejected',error:error.message}, () => process.disconnect());
}
`);
  const children: ChildProcess[] = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        if (child.connected) child.send('release', () => {});
        const exited = await Promise.race([exit(child).then(() => true), pause(3000).then(() => false)]);
        if (!exited) { child.kill('SIGKILL'); await exit(child); }
      }
    }
    // Retain only this test's small generated fixture for diagnosis. No parent
    // PoC/runtime path or previously denied cleanup directory is touched.
  });
  return {
    directory,
    worker(runtimePath = directory) {
      const child = spawn(process.execPath, ['--import', 'tsx', program, runtimePath], {
        cwd: path.resolve('.'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      children.push(child);
      return child;
    },
  };
}

function event(child: ChildProcess): Promise<WorkerEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Worker event timeout.')); }, 20_000);
    function cleanup() { clearTimeout(timer); child.off('message', message); child.off('error', error); child.off('exit', ended); }
    function message(value: unknown) { cleanup(); resolve(value as WorkerEvent); }
    function error(value: Error) { cleanup(); reject(value); }
    function ended(code: number | null) { cleanup(); reject(new Error(`Worker exited before its event (${code}).`)); }
    child.once('message', message); child.once('error', error); child.once('exit', ended);
  });
}

function exit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  if (child.signalCode !== null) return Promise.resolve(null);
  return new Promise(resolve => child.once('exit', code => resolve(code)));
}

async function release(child: ChildProcess): Promise<void> {
  const reply = event(child);
  child.send('release');
  assert.equal((await reply).event, 'released');
  assert.equal(await exit(child), 0);
}

test('Windows Global mutex excludes a second process and permits acquisition after release', { skip: !windows, timeout: 45_000 }, async t => {
  const f = fixture(t);
  const first = f.worker();
  assert.equal((await event(first)).event, 'acquired');
  const second = f.worker(f.directory.toUpperCase());
  const denied = await event(second);
  assert.equal(denied.event, 'rejected');
  assert.match(denied.error!, /live writer/);
  assert.equal(await exit(second), 11);
  await release(first);
  const third = f.worker();
  assert.equal((await event(third)).event, 'acquired');
  await release(third);
});

test('two racing Windows acquirers produce exactly one held lease', { skip: !windows, timeout: 45_000 }, async t => {
  const f = fixture(t);
  const workers = [f.worker(), f.worker()];
  const outcomes = await Promise.all(workers.map(event));
  assert.equal(outcomes.filter(value => value.event === 'acquired').length, 1);
  assert.equal(outcomes.filter(value => value.event === 'rejected').length, 1);
  await release(workers[outcomes.findIndex(value => value.event === 'acquired')]!);
  assert.equal(await exit(workers[outcomes.findIndex(value => value.event === 'rejected')]!), 11);
});

test('abrupt Windows parent death releases its helper mutex without stale-file takeover', { skip: !windows, timeout: 45_000 }, async t => {
  const f = fixture(t);
  const first = f.worker();
  assert.equal((await event(first)).event, 'acquired');
  first.kill('SIGKILL'); // Exact ChildProcess handle created by this test.
  await exit(first);
  const deadline = Date.now() + 15_000;
  let acquired: ChildProcess | undefined;
  do {
    const candidate = f.worker();
    const result = await event(candidate);
    if (result.event === 'acquired') { acquired = candidate; break; }
    await exit(candidate);
    await pause(100);
  } while (Date.now() < deadline);
  assert.ok(acquired, 'helper must release when its parent pipe closes');
  await release(acquired);
});

test('unexpected Windows mutex-holder death terminates the writer with exit 70', { skip: !windows, timeout: 45_000 }, async t => {
  const f = fixture(t);
  const writer = f.worker();
  assert.equal((await event(writer)).event, 'acquired');
  // Inspect only this fixture writer's child, verifying its PID, creation time
  // and exact mutex-bearing command before terminating that owned test helper.
  const script = `
$ErrorActionPreference = 'Stop'
$Owned = @(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${writer.pid}' | Where-Object { $_.Name -eq 'powershell.exe' -and $_.CommandLine.Contains('AUTODEV_MUTEX_NAME') })
if ($Owned.Count -ne 1) { throw 'Expected exactly one owned mutex helper' }
$Again = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $Owned[0].ProcessId)
if ($Again.ParentProcessId -ne ${writer.pid} -or $Again.CreationDate -ne $Owned[0].CreationDate -or $Again.CommandLine -ne $Owned[0].CommandLine) { throw 'Owned helper identity changed' }
Stop-Process -Id $Again.ProcessId -Force -ErrorAction Stop
`;
  const killer = spawn(path.join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '';
  killer.stderr!.on('data', value => { diagnostics += value; });
  assert.equal(await exit(killer), 0, diagnostics);
  assert.equal(await exit(writer), 70);
  const successor = f.worker();
  assert.equal((await event(successor)).event, 'acquired');
  await release(successor);
});

test('non-Windows lock never automatically takes over an existing stale file', { skip: windows }, async t => {
  const f = fixture(t);
  const file = path.join(f.directory, 'os-writer.lock');
  writeFileSync(file, JSON.stringify({ pid: 99999999, nonce: 'historical-owner' }));
  const before = readFileSync(file, 'utf8');
  await assert.rejects(acquireRuntimeLock(f.directory), /automatic stale takeover is disabled/);
  assert.equal(readFileSync(file, 'utf8'), before);
});
