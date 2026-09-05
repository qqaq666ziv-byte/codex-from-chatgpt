import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { transformSync } from 'esbuild';
import { acquireRuntimeLock } from '../src/runtime-lock.js';
import { saveRouteSecret } from '../src/fixed-tunnel.js';
import { noChargeSafeguards } from '../src/cost-policy.js';

const execute = promisify(execFile);
const product = path.resolve('.');
const quote = (value: string) => "'" + value.replace(/'/g, "''") + "'";
async function run(shell: string, command: string) {
  try { const result = await execute(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { windowsHide: true, timeout: 30000, maxBuffer: 1_000_000 }); return { code: 0, output: result.stdout + result.stderr }; }
  catch (error) { const value = error as { code?: number; stdout?: string; stderr?: string }; return { code: value.code ?? -1, output: (value.stdout ?? '') + (value.stderr ?? '') }; }
}
for (const shell of ['powershell.exe', 'pwsh.exe']) {
  test(`${shell}: fixed launcher fails closed on cost, deployment fences and concurrent configuration`, { skip: process.platform !== 'win32', timeout: 180000 }, async context => {
    if ((await run(shell, '$PSVersionTable.PSVersion.ToString()')).code !== 0) { context.skip(`${shell} unavailable`); return; }
    const testRoot = path.join(product, '.local-tests'); mkdirSync(testRoot, { recursive: true });
    const directory = mkdtempSync(path.join(testRoot, 'fixed candidate 中文-'));
    const dist = path.join(directory, 'dist', 'src'), runtime = path.join(directory, '.runtime'), scripts = path.join(directory, 'scripts');
    mkdirSync(dist, { recursive: true });
    mkdirSync(scripts);
    for (const name of ['fixed-tunnel.ps1', 'local-common.ps1']) copyFileSync(path.join(product, 'scripts', name), path.join(scripts, name));
    writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
    for (const name of readdirSync(path.join(product, 'src')).filter(name => name.endsWith('.ts'))) {
      const source = readFileSync(path.join(product, 'src', name), 'utf8');
      writeFileSync(path.join(dist, name.replace(/\.ts$/, '.js')), transformSync(source, { loader: 'ts', target: 'es2022', format: 'esm' }).code);
    }
    const entry = path.join(dist, 'fixed-tunnel-runner.js');
    const invoke = (action: string, input?: unknown) => run(shell, `${input === undefined ? '' : quote(JSON.stringify(input)) + ' | '}& ${quote(process.execPath)} ${quote(entry)} ${quote(action)}; exit $LASTEXITCODE`);
    const launch = (...args: string[]) => run(shell, `$ErrorActionPreference='Stop'; & ${quote(path.join(scripts, 'fixed-tunnel.ps1'))} ${args.map(value => /^-[A-Za-z]+$/.test(value) ? value : quote(value)).join(' ')}; exit $LASTEXITCODE`);
    const origin = 'https://synthetic-isolated.synthetic-account.workers.dev';
    const configured = await launch('configure', '-WorkerOrigin', origin);
    assert.equal(configured.code, 0, configured.output);
    assert.match(configured.output, /unverified/);
    assert.equal(configured.output.includes(origin), false);
    const before = readFileSync(path.join(runtime, 'fixed-tunnel.json'), 'utf8');
    assert.equal(JSON.parse(before).cost.status, 'unverified');
    for (const action of ['start', 'run', 'credential']) {
      const blocked = await launch(action);
      assert.notEqual(blocked.code, 0, blocked.output);
      assert.match(blocked.output, /COST_UNVERIFIED/);
      assert.equal(existsSync(path.join(runtime, 'fixed-tunnel-key.dpapi')), false);
      assert.equal(existsSync(path.join(runtime, 'fixed-gateway-process.json')), false);
      assert.equal(existsSync(path.join(runtime, 'fixed-oauth.dpapi')), false);
    }
    const release = await acquireRuntimeLock(path.join(runtime, 'fixed-gateway-lease'));
    try {
      const raced = await invoke('configure', { origin });
      assert.notEqual(raced.code, 0, raced.output);
      assert.equal(readFileSync(path.join(runtime, 'fixed-tunnel.json'), 'utf8'), before);
    } finally { release(); }
    const changed = await launch('configure', '-WorkerOrigin', 'https://different.synthetic-account.workers.dev');
    assert.notEqual(changed.code, 0, changed.output);
    assert.equal(readFileSync(path.join(runtime, 'fixed-tunnel.json'), 'utf8'), before);
    const status = await launch('status');
    assert.equal(status.code, 0, status.output);
    assert.equal(JSON.parse(status.output).process_running, false);
    assert.equal(status.output.includes(origin), false);
    writeFileSync(path.join(runtime, 'fixed-deploy-incomplete.json'), '{"synthetic":true}');
    const fenced = await launch('run');
    assert.notEqual(fenced.code, 0, fenced.output); assert.match(fenced.output, /DEPLOYMENT_INCOMPLETE/);
    assert.equal(existsSync(path.join(runtime, 'fixed-tunnel-key.dpapi')), false);
    const data = { evidenceUrl: 'https://developers.cloudflare.com/workers/platform/pricing/', basis: 'free-tier', accountPlanConfirmed: true, safeguards: noChargeSafeguards() };
    const repaired = await invoke('configure', { origin, evidence: data });
    assert.equal(repaired.code, 0, repaired.output);
    const secret = 's'.repeat(43);
    await saveRouteSecret(runtime, secret);
    const encrypted = readFileSync(path.join(runtime, 'fixed-tunnel-key.dpapi'), 'utf8');
    assert.match(encrypted, /^[a-f0-9]+$/i); assert.equal(encrypted.includes(secret), false);
    assert.equal(existsSync(path.join(runtime, 'fixed-deploy-incomplete.json')), true);
    const stillFenced = await launch('run'); assert.match(stillFenced.output, /DEPLOYMENT_INCOMPLETE/);
    const releaseKey = await acquireRuntimeLock(path.join(runtime, 'fixed-gateway-lease'));
    try { await assert.rejects(saveRouteSecret(runtime, 't'.repeat(43)), /live writer/); assert.equal(readFileSync(path.join(runtime, 'fixed-tunnel-key.dpapi'), 'utf8'), encrypted); }
    finally { releaseKey(); }
  });
}
