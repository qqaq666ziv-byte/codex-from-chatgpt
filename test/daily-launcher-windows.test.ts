import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { buildSync } from 'esbuild';
import { configuredFixedTunnel, fixedRelease } from '../src/fixed-tunnel.js';
import { noChargeSafeguards } from '../src/cost-policy.js';

const execute = promisify(execFile);
const product = path.resolve('.');
const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const privateText = 'SYNTHETIC_PRIVATE_CHILD_OUTPUT_MUST_NOT_APPEAR';
const binaryBytes = Buffer.from('synthetic non-executable cloudflared fixture');

async function run(shell: string, command: string) {
  try {
    const result = await execute(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
      { cwd: product, windowsHide: true, timeout: 45_000, maxBuffer: 1_000_000 });
    return { code: 0, output: result.stdout + result.stderr };
  } catch (error) {
    const result = error as { code?: number; stdout?: string; stderr?: string };
    return { code: result.code ?? -1, output: (result.stdout ?? '') + (result.stderr ?? '') };
  }
}

function fixture() {
  const testRoot = path.join(product, '.local-tests'); mkdirSync(testRoot, { recursive: true });
  const root = mkdtempSync(path.join(testRoot, 'daily 中文 space &-'));
  const scripts = path.join(root, 'scripts'), runtime = path.join(root, '.runtime'), dist = path.join(root, 'dist', 'src');
  for (const directory of [scripts, runtime, dist, path.join(root, '.tools')]) mkdirSync(directory, { recursive: true });
  copyFileSync(path.join(product, 'Start-AutoDev.cmd'), path.join(root, 'Start-AutoDev.cmd'));
  copyFileSync(path.join(product, 'scripts', 'start-daily.ps1'), path.join(scripts, 'start-daily.ps1'));
  for (const name of ['local-common.ps1', 'backup-common.ps1']) writeFileSync(path.join(scripts, name), '# synthetic unused prerequisite');
  writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  for (const name of ['fixed-tunnel', 'local-config']) {
    const output = buildSync({ entryPoints: [path.join(product, 'src', `${name}.ts`)], bundle: true, packages: 'external', platform: 'node', format: 'esm', write: false }).outputFiles[0]!.text;
    // Keep production validation logic; substitute only the release's expected
    // hash so no actual binary is installed, started, or copied into fixtures.
    writeFileSync(path.join(dist, `${name}.js`), output.replaceAll(fixedRelease.executableSha256, createHash('sha256').update(binaryBytes).digest('hex')));
  }
  for (const name of ['index.js', 'fixed-tunnel-runner.js']) writeFileSync(path.join(dist, name), '// synthetic unused server entry');
  const binary = path.join(root, '.tools', 'cloudflared-2026.8.2.exe'); writeFileSync(binary, binaryBytes);
  for (const name of ['admin-token', 'client-token', 'fixed-tunnel-key.dpapi']) writeFileSync(path.join(runtime, name), 'synthetic-unused-credential-never-decrypted');
  writeFileSync(path.join(runtime, 'config.json'), JSON.stringify({ schemaVersion: 1, host: '127.0.0.1', port: 8790, model: 'synthetic', reasoningEffort: 'xhigh', projects: [] }));
  const validConfig = configuredFixedTunnel('https://synthetic.synthetic.workers.dev', {
    evidenceUrl: 'https://developers.cloudflare.com/workers/platform/pricing/', basis: 'free-tier', accountPlanConfirmed: true, safeguards: noChargeSafeguards(),
  });
  const config = path.join(runtime, 'fixed-tunnel.json'); writeFileSync(config, JSON.stringify(validConfig));
  const events = path.join(runtime, 'synthetic-events.jsonl'), scenario = path.join(runtime, 'synthetic-scenario.json');
  const common = `
$r = Join-Path (Split-Path -Parent $PSScriptRoot) '.runtime'
$state = Get-Content -LiteralPath (Join-Path $r 'synthetic-scenario.json') -Raw | ConvertFrom-Json
`;
  writeFileSync(path.join(scripts, 'autodev.ps1'), `\ufeffparam([string]$Command)\n${common}
Add-Content -LiteralPath (Join-Path $r 'synthetic-events.jsonl') -Value ('core:' + $Command)
Write-Output '${privateText}'
if ($state.delay) { Start-Sleep -Milliseconds $state.delay }
exit ([int]$state.coreExit)
`);
  writeFileSync(path.join(scripts, 'fixed-tunnel.ps1'), `\ufeffparam([string]$Action)\n${common}
Add-Content -LiteralPath (Join-Path $r 'synthetic-events.jsonl') -Value ('fixed:' + $Action)
if ($Action -eq 'start') { Write-Output '${privateText}'; exit ([int]$state.fixedExit) }
if ($Action -ne 'status') { exit 91 }
if ($state.malformed) { Write-Output '${privateText}'; exit 0 }
if ($state.statusExit) { Write-Output '${privateText}'; exit ([int]$state.statusExit) }
@{ready_for_chatgpt_probe=($state.ready -eq $true); chatgpt_e2e='not_verified'} | ConvertTo-Json -Compress
`);
  const setScenario = (changes: Record<string, unknown> = {}) => {
    writeFileSync(scenario, JSON.stringify({ coreExit: 0, fixedExit: 0, ready: true, ...changes }));
    if (existsSync(events)) unlinkSync(events);
  };
  setScenario();
  const entries = () => existsSync(events) ? readFileSync(events, 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/) : [];
  const launch = (shell: string) => run(shell, `& ${quote(path.join(scripts, 'start-daily.ps1'))}; exit $LASTEXITCODE`);
  const batch = (shell: string) => run(shell, `& ${quote(path.join(root, 'Start-AutoDev.cmd'))} --no-pause; exit $LASTEXITCODE`);
  return { root, runtime, scripts, config, binary, validConfig, setScenario, entries, launch, batch };
}

for (const shell of ['powershell.exe', 'pwsh.exe']) {
  test(`${shell}: daily launcher prerequisites, exit codes, readiness and serialized startup`, { skip: process.platform !== 'win32', timeout: 180_000 }, async context => {
    if ((await run(shell, '$PSVersionTable.PSVersion.ToString()')).code !== 0) { context.skip(`${shell} unavailable`); return; }
    const f = fixture();
    const assertPrivate = (output: string) => {
      assert.equal(output.includes(privateText), false, output);
      assert.equal(output.includes('https://synthetic.synthetic.workers.dev'), false, output);
    };
    for (const marker of ['build-incomplete.json', 'fixed-deploy-incomplete.json', 'fixed-oauth.dpapi.pending']) {
      const file = path.join(f.runtime, marker); writeFileSync(file, '{}');
      const result = await f.launch(shell); assert.equal(result.code, 2, result.output); assert.deepEqual(f.entries(), []); assertPrivate(result.output);
      assert.equal(existsSync(file), true); unlinkSync(file);
    }
    const credential = path.join(f.runtime, 'fixed-tunnel-key.dpapi'); unlinkSync(credential);
    const missing = await f.launch(shell); assert.equal(missing.code, 2, missing.output); assert.deepEqual(f.entries(), []);
    writeFileSync(credential, 'synthetic-unused-credential-never-decrypted');
    writeFileSync(f.config, JSON.stringify({ ...f.validConfig, cost: { status: 'unverified' } }));
    const unverified = await f.launch(shell); assert.equal(unverified.code, 2, unverified.output); assert.deepEqual(f.entries(), []);
    const confirmed = f.validConfig.cost;
    assert.equal(confirmed.status, 'confirmed-no-charge');
    writeFileSync(f.config, JSON.stringify({ ...f.validConfig, cost: { ...confirmed, basis: 'free-credits', expiresAt: '2020-01-01T00:00:00.000Z' } }));
    const expired = await f.launch(shell); assert.equal(expired.code, 2, expired.output); assert.deepEqual(f.entries(), []);
    writeFileSync(f.config, JSON.stringify(f.validConfig));
    writeFileSync(f.binary, 'tampered-synthetic-binary');
    const tampered = await f.launch(shell); assert.equal(tampered.code, 2, tampered.output); assert.deepEqual(f.entries(), []);
    writeFileSync(f.binary, binaryBytes);

    const success = await f.launch(shell); assert.equal(success.code, 0, success.output);
    assert.deepEqual(f.entries(), ['core:start', 'fixed:start', 'fixed:status']); assertPrivate(success.output);
    assert.match(success.output, /FIXED-ENTRY-VALIDATION/);
    assert.equal(readFileSync(f.config, 'utf8'), JSON.stringify(f.validConfig));
    f.setScenario({ coreExit: 37 });
    const coreFailure = await f.launch(shell); assert.equal(coreFailure.code, 37, coreFailure.output); assertPrivate(coreFailure.output);
    assert.deepEqual(f.entries(), ['core:start']);
    f.setScenario({ fixedExit: 41 });
    const fixedFailure = await f.launch(shell); assert.equal(fixedFailure.code, 41, fixedFailure.output); assertPrivate(fixedFailure.output);
    assert.deepEqual(f.entries(), ['core:start', 'fixed:start']);
    for (const change of [{ ready: false }, { malformed: true }, { statusExit: 43 }]) {
      f.setScenario(change); const result = await f.launch(shell); assert.equal(result.code, 'statusExit' in change ? 43 : 1, result.output); assertPrivate(result.output);
      assert.deepEqual(f.entries(), ['core:start', 'fixed:start', 'fixed:status']);
    }

    f.setScenario({ delay: 5000 });
    const first = f.launch(shell);
    const deadline = Date.now() + 20_000;
    while (f.entries().length === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(f.entries(), ['core:start']);
    const overlapping = await f.launch(shell); assert.equal(overlapping.code, 1, overlapping.output);
    const completed = await first; assert.equal(completed.code, 0, completed.output);
    assert.deepEqual(f.entries(), ['core:start', 'fixed:start', 'fixed:status']);

    f.setScenario();
    const batch = await f.batch(shell); assert.equal(batch.code, 0, batch.output); assertPrivate(batch.output);
    assert.deepEqual(f.entries(), ['core:start', 'fixed:start', 'fixed:status']);
    f.setScenario({ fixedExit: 41 });
    const failedBatch = await f.batch(shell); assert.equal(failedBatch.code, 41, failedBatch.output); assertPrivate(failedBatch.output);
    assert.deepEqual(f.entries(), ['core:start', 'fixed:start']);
  });
}
