/** Explicit opt-in only: two subscription turns through the real product/MCP. */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

if (process.env.AUTODEV_RUN_ROUTING_SMOKE !== 'two-subscription-turns') throw new Error('Explicit two-turn opt-in required.');
const productRoot = process.cwd();
const validationRoot = path.join(productRoot, '.local-tests', '2026-09-06-validation');
mkdirSync(validationRoot, { recursive: true });
const root = mkdtempSync(path.join(validationRoot, 'routing-live-'));
const repo = path.join(root, 'repo'); const runtime = path.join(root, 'runtime');
mkdirSync(repo); mkdirSync(runtime);
writeFileSync(path.join(repo, 'AGENTS.md'), 'Work only in this isolated fixture. Do not read credentials, .env, home files, other projects or network. No installation, commit, push, deployment or persistent settings. Do not modify files. Run node --test and state its real exit code.\n');
writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
writeFileSync(path.join(repo, 'fixture.test.js'), "import test from 'node:test'; import assert from 'node:assert/strict'; test('isolated arithmetic check',()=>assert.equal(20+22,42));\n");
execFileSync('git', ['-c', 'core.hooksPath=.disabled', 'init', '-q'], { cwd: repo, windowsHide: true });
const guard = createServer(); await new Promise<void>(resolve => guard.listen(0, '127.0.0.1', resolve));
const port = (guard.address() as { port: number }).port; await new Promise<void>(resolve => guard.close(() => resolve()));
const clientToken = randomBytes(36).toString('base64url'); const adminToken = randomBytes(36).toString('base64url');
writeFileSync(path.join(runtime, 'client-token'), clientToken, { mode: 0o600 });
writeFileSync(path.join(runtime, 'admin-token'), adminToken, { mode: 0o600 });
writeFileSync(path.join(runtime, 'config.json'), JSON.stringify({ schemaVersion: 1, host: '127.0.0.1', port, model: 'gpt-6-astra', reasoningEffort: 'xhigh', projects: [{ id: 'routing-fixture', name: 'Isolated routing verification', path: repo }] }));
if (process.platform === 'win32') {
  const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  const script = `. ${quote(path.join(productRoot, 'scripts/local-common.ps1'))}; Protect-AutoDevRuntime ${quote(runtime)}`;
  execFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'pipe' });
}
const instance = randomUUID();
const child = spawn(process.execPath, [path.join(productRoot, 'dist/src/index.js'), `--autodev-instance=${instance}`], { cwd: productRoot, env: { ...process.env, AUTODEV_CONFIG: path.join(runtime, 'config.json') }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let closed = false; const exited = new Promise<void>(resolve => child.once('close', () => { closed = true; resolve(); }));
// Child diagnostics are intentionally private. Reports contain structured evidence only.
child.stdout.resume(); child.stderr.resume();
writeFileSync(path.join(root, 'owned-core.json'), JSON.stringify({ pid: child.pid, instance, entry: path.join(productRoot, 'dist/src/index.js'), startedUtc: new Date().toISOString() }));
const origin = `http://127.0.0.1:${port}`;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const client = new Client({ name: 'AutoDev-isolated-routing-verification', version: '1' });
let connected = false; let currentJob: { job: string; turn: string } | null = null;
async function tool(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name} failed; inspect isolated state without resubmission.`);
  return result.structuredContent ?? JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
}
async function terminal(job: string): Promise<any> {
  const deadline = Date.now() + 6 * 60_000;
  while (Date.now() < deadline) {
    const status = await tool('autodev_status', { job_id: job });
    if (['completed', 'failed', 'interrupted'].includes(status.execution_status)) return status;
    if (status.execution_status !== 'running' && status.execution_status !== 'starting') throw new Error(`Isolated job needs attention: ${status.execution_status}; no replay.`);
    await pause(3000);
  }
  throw new Error('Isolated turn deadline exceeded; reconcile before any follow-up.');
}
async function artifact(manifest: string): Promise<string> {
  let cursor: string | undefined; let text = '';
  do { const page = await tool('autodev_artifact', { manifest_id: manifest, artifact: 'execution.json', ...(cursor ? { cursor } : {}) }); text += page.content; cursor = page.nextCursor ?? undefined; } while (cursor);
  return text;
}
const report: Record<string, unknown> = { startedUtc: new Date().toISOString(), workspace: root, serviceInstance: instance, inferenceTurnsAllowed: 2, review: 'Codex verification only; no ChatGPT review written' };
try {
  const readyDeadline = Date.now() + 90_000;
  let ready = false;
  while (Date.now() < readyDeadline && !closed) {
    try { const response = await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(3000) }); if (response.ok) { ready = true; break; } } catch { /* bounded startup */ }
    await pause(1500);
  }
  assert.ok(ready, 'Isolated real product must become ready.');
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${clientToken}` } } })); connected = true;
  report.projects = await tool('autodev_projects');
  const first = await tool('autodev_submit', { request_key: 'routing-live-fast-v1', project_id: 'routing-fixture', requirements: 'Run node --test for this isolated fixture. Do not modify files. Report the actual test count and exit code, followed by ROUTING_FAST_OK.', acceptance: ['Report the actual node --test exit code; do not modify files.'], routing: { complexity: 'simple', risk: 'low', preference: 'speed' } });
  assert.ok(first.job_id && first.turn_id && first.thread_id); currentJob = { job: first.job_id, turn: first.turn_id };
  const status1 = await terminal(first.job_id); currentJob = null; assert.equal(status1.execution_status, 'completed');
  const manifest1 = await tool('autodev_evidence', { job_id: first.job_id });
  const evidence1 = await artifact(manifest1.id); const execution1 = JSON.parse(evidence1);
  report.first = { response: first, status: status1, manifest: manifest1.id, routing: execution1.routing };
  writeFileSync(path.join(root, 'verification.json'), JSON.stringify(report, null, 2));
  const second = await tool('autodev_continue', { request_key: 'routing-live-deep-v1', job_id: first.job_id, requirements: 'Review this mock authorization guard: function allowed(expected, supplied) { if (!expected) return true; return expected === supplied; }. Explain its fail-open behavior and a minimal safe correction. This is a short isolated design review; do not read real auth or modify any files. Run node --test and report its real exit code. Finish with ROUTING_DEEP_OK.', acceptance: ['Identify the missing expected credential fail-open case and state a fail-closed correction.', 'Report the actual node --test exit code; no file changes.'], routing: { complexity: 'complex', risk: 'high', phase: 'review', preference: 'quality' } });
  assert.equal(second.thread_id, first.thread_id); assert.notEqual(second.turn_id, first.turn_id); currentJob = { job: second.job_id, turn: second.turn_id };
  const status2 = await terminal(first.job_id); currentJob = null; assert.equal(status2.execution_status, 'completed');
  const manifest2 = await tool('autodev_evidence', { job_id: first.job_id }); const evidence2 = JSON.parse(await artifact(manifest2.id));
  assert.equal(await artifact(manifest1.id), evidence1);
  assert.notEqual(execution1.routing.decision.selected_model, evidence2.routing.decision.selected_model);
  for (const entry of [execution1, evidence2]) {
    assert.equal(entry.routing.thread_confirmation.model, entry.routing.decision.selected_model);
    assert.equal(entry.routing.thread_confirmation.effort, entry.routing.decision.selected_effort);
    assert.equal(entry.routing.turn_confirmation.model, null);
  }
  report.second = { response: second, status: status2, manifest: manifest2.id, routing: evidence2.routing };
  report.firstArtifactUnchanged = true; report.firstArtifactSha256 = createHash('sha256').update(evidence1).digest('hex');
  report.completedUtc = new Date().toISOString(); report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.failure = error instanceof Error ? error.message : 'Unknown failure';
  throw error;
} finally {
  if (currentJob && connected) {
    try { await tool('autodev_cancel', { request_key: 'routing-live-cancel-v1', job_id: currentJob.job, turn_id: currentJob.turn }); await terminal(currentJob.job); } catch { /* Preserve unresolved identity; no replay or process kill. */ }
  }
  if (connected) await client.close();
  const shutdown = await fetch(`${origin}/admin/shutdown`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` }, signal: AbortSignal.timeout(10000) }).catch(() => null);
  if (shutdown?.ok) await Promise.race([exited, pause(20000)]);
  report.isolatedCoreExitConfirmed = closed;
  writeFileSync(path.join(root, 'verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ result: report.result, reportPath: path.join(root, 'verification.json'), isolatedCoreExitConfirmed: closed, firstArtifactUnchanged: report.firstArtifactUnchanged }));
  if (!closed) throw new Error('Isolated core did not confirm shutdown; owned record preserved for reconciliation.');
}
