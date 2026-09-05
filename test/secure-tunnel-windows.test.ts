import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { transformSync } from 'esbuild';
import { acquireRuntimeLock } from '../src/runtime-lock.js';

const execute = promisify(execFile);
const product = path.resolve('.');
async function run(shell: string, args: string[]) {
  try { const result = await execute(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { windowsHide: true, timeout: 30000, maxBuffer: 1_000_000 }); return { code: 0, output: result.stdout + result.stderr }; }
  catch (error) { const e = error as { code?: number; stdout?: string; stderr?: string }; return { code: e.code ?? -1, output: (e.stdout ?? '') + (e.stderr ?? '') }; }
}
for (const shell of ['powershell.exe', 'pwsh.exe']) {
  test(`${shell}: real secure launcher configures locally and rejects activation before any credential or process`, { skip: process.platform !== 'win32' }, async context => {
    if ((await run(shell, ['-Command', '$PSVersionTable.PSVersion.ToString()'])).code !== 0) { context.skip(`${shell} unavailable`); return; }
    const testRoot = path.join(product, '.local-tests'); mkdirSync(testRoot, { recursive: true });
    const directory = mkdtempSync(path.join(testRoot, 'secure cli 中文 space-'));
    const scripts = path.join(directory, 'scripts'), dist = path.join(directory, 'dist', 'src'), runtime = path.join(directory, '.runtime');
    mkdirSync(scripts); mkdirSync(dist, { recursive: true });
    writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
    for (const name of ['secure-tunnel.ps1', 'local-common.ps1']) copyFileSync(path.join(product, 'scripts', name), path.join(scripts, name));
    for (const name of ['secure-tunnel-runner', 'secure-tunnel', 'secure-process', 'local-config', 'runtime-lock', 'windows-job']) {
      const text = readFileSync(path.join(product, 'src', name + '.ts'), 'utf8');
      writeFileSync(path.join(dist, name + '.js'), transformSync(text, { loader: 'ts', target: 'es2022', format: 'esm' }).code);
    }
    const launcher = path.join(scripts, 'secure-tunnel.ps1');
    const invoke = (...args: string[]) => run(shell, ['-File', launcher, ...args]);
    const id = 'tunnel_' + 'b'.repeat(32);
    const configured = await invoke('configure', '-TunnelId', id);
    assert.equal(configured.code, 0, configured.output);
    assert.equal(configured.output.includes(id), false);
    const original = readFileSync(path.join(runtime, 'secure-tunnel.json'), 'utf8');
    assert.equal(JSON.parse(original).cost.status, 'unverified');
    const release = await acquireRuntimeLock(path.join(runtime, 'secure-tunnel-lease'));
    try {
      const raced = await invoke('configure', '-TunnelId', id, '-ZeroCostEvidenceUrl', 'https://developers.openai.com/api/docs/guides/secure-mcp-tunnels', '-ConfirmZeroAddedCost');
      assert.notEqual(raced.code, 0, raced.output);
      assert.equal(readFileSync(path.join(runtime, 'secure-tunnel.json'), 'utf8'), original);
      const racedCredential = await invoke('credential');
      assert.notEqual(racedCredential.code, 0, racedCredential.output);
      assert.equal(existsSync(path.join(runtime, 'secure-tunnel-key.dpapi')), false);
    } finally { release(); }
    const changed = await invoke('configure', '-TunnelId', 'tunnel_' + 'c'.repeat(32));
    assert.notEqual(changed.code, 0);
    assert.equal(readFileSync(path.join(runtime, 'secure-tunnel.json'), 'utf8'), original);
    for (const action of ['start', 'run', 'credential']) {
      const blocked = await invoke(action);
      assert.notEqual(blocked.code, 0, blocked.output);
      assert.match(blocked.output, /COST_UNVERIFIED/);
      assert.equal(existsSync(path.join(runtime, 'secure-tunnel-key.dpapi')), false);
      assert.equal(existsSync(path.join(runtime, 'secure-tunnel-process.json')), false);
    }
    const stopped = await invoke('status');
    assert.equal(stopped.code, 0, stopped.output);
    assert.equal(JSON.parse(stopped.output).process_running, false);
  });
}
