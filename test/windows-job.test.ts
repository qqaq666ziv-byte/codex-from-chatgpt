import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { startWindowsJob, type WindowsJob } from '../src/windows-job.js';
import { processIdentity, type ProcessIdentity } from '../src/secure-process.js';

const windows = process.platform === 'win32';
const testRoot = path.resolve('.local-tests');
function fixture() {
  mkdirSync(testRoot, { recursive: true });
  const directory = mkdtempSync(path.join(testRoot, 'windows-job-'));
  const program = path.join(directory, 'synthetic child 中文.mjs');
  const marker = path.join(directory, 'started.json');
  writeFileSync(program, `import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], JSON.stringify({pid:process.pid,args:process.argv.slice(3),sent:process.env.AUTODEV_SYNTHETIC_CHILD,parent:process.env.AUTODEV_JOB_PARENT_ONLY ?? null}));
setInterval(() => {}, 1000);
`);
  return { directory, program, marker };
}
function environment(directory: string): NodeJS.ProcessEnv {
  return { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: directory, TMP: directory, AUTODEV_SYNTHETIC_CHILD: 'synthetic-child-only' };
}
async function until<T>(read: () => T, message: string, milliseconds = 10000): Promise<NonNullable<T>> {
  const deadline = Date.now() + milliseconds;
  do { const value = read(); if (value) return value as NonNullable<T>; await pause(50); } while (Date.now() < deadline);
  throw new Error(message);
}
function exit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('exit', ended); reject(new Error('Owned test process did not exit.')); }, 10000);
    function ended(code: number | null) { clearTimeout(timer); resolve(code); }
    child.once('exit', ended);
  });
}
async function gone(pid: number, identity: ProcessIdentity) {
  await until(() => { const current = processIdentity(pid); return !current || current.created !== identity.created; }, 'The original synthetic job child is still running.');
}
function clean(t: TestContext, job: WindowsJob) {
  t.after(async () => {
    try { await job.close(); } catch {
      // The test intentionally terminates exact helper handles in two cases.
      if (job.process.exitCode === null && job.process.signalCode === null) { job.process.kill('SIGKILL'); await exit(job.process); }
    }
  });
}

test('Windows job starts only its explicit child environment and closes the entire owned child', { skip: !windows, timeout: 40000 }, async t => {
  const f = fixture();
  const old = process.env.AUTODEV_JOB_PARENT_ONLY; process.env.AUTODEV_JOB_PARENT_ONLY = 'synthetic-must-not-inherit';
  let job: WindowsJob;
  try { job = await startWindowsJob(process.execPath, [f.program, f.marker, 'a "quoted" value', '尾端\\', ''], { cwd: f.directory, env: environment(f.directory) }); }
  finally { if (old === undefined) delete process.env.AUTODEV_JOB_PARENT_ONLY; else process.env.AUTODEV_JOB_PARENT_ONLY = old; }
  clean(t, job);
  const data = await until(() => existsSync(f.marker) && JSON.parse(readFileSync(f.marker, 'utf8')), 'Synthetic child never started.');
  assert.equal(data.pid, job.childPid); assert.deepEqual(data.args, ['a "quoted" value', '尾端\\', '']);
  assert.equal(data.sent, 'synthetic-child-only'); assert.equal(data.parent, null);
  const identity = processIdentity(job.childPid); assert.ok(identity);
  assert.equal(identity.executable.toLowerCase(), process.execPath.toLowerCase());
  await job.close(); await gone(job.childPid, identity);
  assert.equal(job.process.exitCode, 0);
  await job.close(); // Repeated close uses the same verified completion.
});

test('abrupt job-owner helper death kills the assigned native child', { skip: !windows, timeout: 40000 }, async t => {
  const f = fixture();
  const job = await startWindowsJob(process.execPath, [f.program, f.marker], { cwd: f.directory, env: environment(f.directory) }); clean(t, job);
  await until(() => existsSync(f.marker), 'Synthetic child never started.');
  const identity = processIdentity(job.childPid); assert.ok(identity);
  assert.equal(job.process.kill('SIGKILL'), true); // Exact helper spawned by this test.
  await exit(job.process); await gone(job.childPid, identity);
  await assert.rejects(job.close(), /unexpectedly/);
});

test('normal close waits until both the native child and its descendant are gone', { skip: !windows, timeout: 40000 }, async t => {
  const f = fixture(); const parentProgram = path.join(f.directory, 'synthetic-parent.mjs');
  const descendantMarker = path.join(f.directory, 'descendant.json');
  writeFileSync(parentProgram, `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath,[process.argv[2],process.argv[3]],{stdio:'ignore'});
writeFileSync(process.argv[4],JSON.stringify({pid:process.pid,descendantPid:child.pid}));
setInterval(()=>{},1000);
`);
  const job = await startWindowsJob(process.execPath, [parentProgram, f.program, descendantMarker, f.marker], { cwd: f.directory, env: environment(f.directory) }); clean(t, job);
  const data = await until(() => existsSync(descendantMarker) && existsSync(f.marker) && JSON.parse(readFileSync(f.marker, 'utf8')), 'Synthetic descendant never started.');
  assert.equal(data.pid, job.childPid);
  const childIdentity = processIdentity(job.childPid); const descendantIdentity = processIdentity(data.descendantPid);
  assert.ok(childIdentity); assert.ok(descendantIdentity);
  await job.close(); await gone(job.childPid, childIdentity); await gone(data.descendantPid, descendantIdentity);
  assert.equal(job.process.exitCode, 0);
});

test('abrupt supervisor death closes its pipe and kills the job child', { skip: !windows, timeout: 45000 }, async t => {
  const f = fixture(); const supervisorProgram = path.join(f.directory, 'supervisor.mjs');
  writeFileSync(supervisorProgram, `import { startWindowsJob } from ${JSON.stringify(pathToFileURL(path.resolve('src/windows-job.ts')).href)};
const job = await startWindowsJob(process.execPath, [process.argv[2], process.argv[3]], {cwd:process.argv[4],env:{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,TEMP:process.argv[4],TMP:process.argv[4]}});
process.send({childPid:job.childPid,helperPid:job.process.pid});
process.on('message',async message => {if(message==='close'){await job.close();process.disconnect();}});
`);
  const supervisor = spawn(process.execPath, ['--import', 'tsx', supervisorProgram, f.program, f.marker, f.directory], { cwd: path.resolve('.'), env: environment(f.directory), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(async () => { if (supervisor.exitCode === null && supervisor.signalCode === null) { supervisor.kill('SIGKILL'); await exit(supervisor); } });
  const result = await new Promise<{ childPid: number; helperPid: number }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Synthetic supervisor did not become ready.')), 20000);
    supervisor.once('message', message => { clearTimeout(timer); resolve(message as { childPid: number; helperPid: number }); });
    supervisor.once('error', () => { clearTimeout(timer); reject(new Error('Synthetic supervisor could not start.')); });
    supervisor.once('exit', () => { clearTimeout(timer); reject(new Error('Synthetic supervisor exited before readiness.')); });
  });
  await until(() => existsSync(f.marker), 'Synthetic child never started.');
  const childIdentity = processIdentity(result.childPid); const helperIdentity = processIdentity(result.helperPid);
  assert.ok(childIdentity); assert.ok(helperIdentity);
  assert.equal(supervisor.kill('SIGKILL'), true);
  await exit(supervisor); await gone(result.helperPid, helperIdentity); await gone(result.childPid, childIdentity);
});

test('native child exit is observable through helper exit, and failed launches never report success', { skip: !windows, timeout: 45000 }, async t => {
  const f = fixture();
  const job = await startWindowsJob(process.execPath, ['-e', 'setTimeout(()=>process.exit(3),1200)'], { cwd: f.directory, env: environment(f.directory) }); clean(t, job);
  assert.equal(await exit(job.process), 72);
  await assert.rejects(job.close(), /unexpectedly/);
  await assert.rejects(startWindowsJob(path.join(f.directory, 'does-not-exist.exe'), [], { cwd: f.directory, env: environment(f.directory) }), /failed before starting/);
  await assert.rejects(startWindowsJob(process.execPath, [], { cwd: f.directory, env: { PATH: 'a', Path: 'b' } }), /environment/);
});
