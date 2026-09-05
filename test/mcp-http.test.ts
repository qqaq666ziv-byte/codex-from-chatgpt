import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createGateway } from '../src/gateway.js';
import { gatewayAssertion, ASSERTION_HEADER, SIGNATURE_HEADER } from '../src/gateway-identity.js';
import { createMcpHttpHandler } from '../src/mcp-http.js';
import { authorized, type LocalConfig } from '../src/local-config.js';
import type { AppServerClient, AppServerMessage, JsonRpcId } from '../src/codex-app-server.js';
import { JobManager } from '../src/jobs.js';
import { StateStore } from '../src/store.js';
import { AutoDev } from '../src/product.js';

const adminToken = 'synthetic-mcp-http-administrator-credential';
const clientToken = 'synthetic-mcp-http-executor-client-credential';
const issuer = 'https://autodev.example';
const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'HTTP fixture', version: '1' } } };

class FakeExecutor implements AppServerClient {
  private readonly listeners = new Set<(message: AppServerMessage) => void>();
  addMessageListener(listener: (message: AppServerMessage) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  addExitListener(_listener: (error: Error) => void) { return () => {}; }
  async start() {}
  async request<T>(method: string): Promise<T> {
    if (method === 'thread/start') return { thread: { id: 'fixture-thread' }, model: 'fixture-model', reasoningEffort: 'medium', approvalPolicy: 'on-request', sandbox: 'workspace-write' } as T;
    if (method === 'turn/start') return { turn: { id: 'fixture-turn', status: 'inProgress', items: [] } } as T;
    return {} as T;
  }
  respond(_id: JsonRpcId, _result: unknown) {}
  respondError(_id: JsonRpcId, _code: number, _message: string) {}
  complete(workspace: string) {
    for (const listener of this.listeners) listener({ method: 'turn/completed', params: { threadId: 'fixture-thread', turnId: 'fixture-turn', turn: { id: 'fixture-turn', status: 'completed', items: [
      { type: 'commandExecution', id: 'fixture-test', command: 'npm test', cwd: workspace, status: 'completed', exitCode: 0, aggregatedOutput: 'Synthetic executor fixture: all requested test assertions passed.\n' },
      { type: 'agentMessage', id: 'fixture-final', phase: 'final_answer', text: 'Synthetic executor fixture completed; review must still read complete evidence.' },
    ] } } });
  }
}

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address !== 'string'); return address.port;
}
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }

async function fixture(t: TestContext) {
  const tests = path.resolve('.local-tests'); mkdirSync(tests, { recursive: true });
  const directory = mkdtempSync(path.join(tests, 'mcp-http-')); const workspace = path.join(directory, 'repository'); const runtimeDir = path.join(directory, 'runtime');
  mkdirSync(workspace); mkdirSync(runtimeDir);
  execFileSync('git', ['-c', 'core.hooksPath=.no-test-hooks', 'init', '--quiet'], { cwd: workspace, windowsHide: true });
  writeFileSync(path.join(workspace, 'source.ts'), 'export const value = 1;\n');
  const config: LocalConfig = { schemaVersion: 1, host: '127.0.0.1', port: 8799, model: 'fixture-model', reasoningEffort: 'medium', runtimeDir, configPath: path.join(runtimeDir, 'config.json'), projects: [{ id: 'fixture', name: 'HTTP synthetic fixture', path: realpathSync(workspace) }] };
  const fake = new FakeExecutor();
  const jobs = new JobManager(fake, { store: new StateStore(path.join(runtimeDir, 'jobs.json')), model: config.model, reasoningEffort: config.reasoningEffort, workspaceValidator: async value => { assert.equal(realpathSync(value), config.projects[0]!.path); return realpathSync(value); } });
  const product = new AutoDev(config, jobs);
  const started = await product.submit({ request_key: 'fixture-submit', project_id: 'fixture', requirements: 'Change value to 2 and retain test evidence.', acceptance: ['value is 2', 'passing test evidence exists'] });
  writeFileSync(path.join(workspace, 'source.ts'), 'export const value = 2;\n'); fake.complete(workspace);
  const manifest = product.seal(started.job_id!);
  let http: ReturnType<typeof createMcpHttpHandler> | undefined;
  const core = createServer(async (req, res) => {
    if (!authorized(req.headers.authorization, clientToken)) { res.writeHead(401); res.end(); return; }
    try { if (!http) throw new Error('not ready'); await http.handle(req, res); }
    catch { if (!res.headersSent) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'fixture request rejected' })); } }
  });
  const corePort = await listen(core); let clockOffset = 0;
  http = createMcpHttpHandler({ product, adminToken, hosts: [`127.0.0.1:${corePort}`], now: () => Date.now() + clockOffset });
  const publicReservation = createServer(); const controlReservation = createServer();
  const publicPort = await listen(publicReservation); const controlPort = await listen(controlReservation);
  await Promise.all([close(publicReservation), close(controlReservation)]);
  const gateway = await createGateway({ issuer, publicPort, controlPort, upstream: `http://127.0.0.1:${corePort}/mcp`, clientToken, adminToken });
  t.after(async () => {
    await gateway.close(); await http!.close(); await close(core);
    const resolved = path.resolve(directory); assert.ok(resolved.startsWith(tests + path.sep)); rmSync(resolved, { recursive: true, force: true });
  });
  return { product, manifest, jobId: started.job_id!, publicUrl: `http://127.0.0.1:${publicPort}`, controlUrl: `http://127.0.0.1:${controlPort}`, coreUrl: `http://127.0.0.1:${corePort}/mcp`,
    expire: async (ms: number) => { clockOffset = ms; try { await http!.sweep(); } finally { clockOffset = 0; } } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function grant(f: Fixture, existingClient?: string) {
  let clientId = existingClient;
  if (!clientId) {
    const registration = await fetch(`${f.publicUrl}/oauth/register`, { method: 'POST', body: JSON.stringify({ client_name: 'SDK lifecycle fixture', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' }) });
    assert.equal(registration.status, 201); clientId = (await registration.json() as { client_id: string }).client_id;
  }
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: redirectUri, resource: `${issuer}/mcp`, scope: 'autodev', state: randomBytes(16).toString('hex'), code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
  const authorize = await fetch(`${f.publicUrl}/oauth/authorize?${query}`); assert.equal(authorize.status, 200);
  const id = /<code>([^<]+)<\/code>/.exec(await authorize.text())?.[1]; assert.ok(id);
  const status = await fetch(`${f.controlUrl}/status`, { headers: { Authorization: `Bearer ${adminToken}` } });
  const pending = (await status.json() as { pending: Array<{ request_id: string; verification_code: string }> }).pending.find(item => item.request_id === id); assert.ok(pending);
  const approval = await fetch(`${f.controlUrl}/approve`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ ...pending, approve: true }) }); assert.equal(approval.status, 200);
  const redirect = await fetch(`${f.publicUrl}/oauth/result?request_id=${id}`, { redirect: 'manual' }); assert.equal(redirect.status, 302);
  const code = new URL(redirect.headers.get('location')!).searchParams.get('code')!;
  const response = await fetch(`${f.publicUrl}/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, redirect_uri: redirectUri, resource: `${issuer}/mcp`, code, code_verifier: verifier }) });
  assert.equal(response.status, 200); return { clientId, token: (await response.json() as { access_token: string }).access_token };
}

async function call(url: string, token: string, name: string, args: Record<string, unknown>) {
  const client = new Client({ name: 'New client for every tool call', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  try { await client.connect(transport); const result = await client.callTool({ name, arguments: args }); return { result, sessionId: transport.sessionId }; }
  finally { await client.close(); }
}
function resultObject(value: Awaited<ReturnType<typeof call>>) {
  assert.notEqual(value.result.isError, true, JSON.stringify(value.result));
  return value.result.structuredContent as Record<string, unknown>;
}
function review(f: Fixture, request_key: string) { return { request_key, job_id: f.jobId, manifest_id: f.manifest.id, verdict: 'pass', summary: 'Synthetic HTTP fixture reviewed complete requirements, source diff, identity and passing test evidence.' }; }

test('more than 40 fresh SDK clients can read all evidence and review through one OAuth grant without sharing proof across grants or local clients', async t => {
  const f = await fixture(t); const first = await grant(f); const second = await grant(f, first.clientId); const publicMcp = `${f.publicUrl}/mcp`;
  for (let index = 0; index < 45; index++) {
    const response = await call(publicMcp, first.token, 'autodev_projects', {});
    assert.equal(response.sessionId, undefined); assert.ok(resultObject(response).projects);
  }
  const request = review(f, 'same-key-after-incomplete-read');
  const rejected = await call(publicMcp, first.token, 'autodev_review', request);
  assert.equal(rejected.result.isError, true); assert.match(JSON.stringify(rejected.result), /EVIDENCE_NOT_READ/);
  assert.equal(f.product.journal.list().some(record => record.key === request.request_key), false);
  const manifest = resultObject(await call(publicMcp, first.token, 'autodev_evidence', { job_id: f.jobId })); assert.equal(manifest.id, f.manifest.id);
  let checkedForeignCursor = false;
  for (const artifact of f.manifest.artifacts) {
    let cursor: string | undefined; let bytes = 0;
    do {
      const page = resultObject(await call(publicMcp, first.token, 'autodev_artifact', { manifest_id: f.manifest.id, artifact: artifact.name, limit: 128, ...(cursor ? { cursor } : {}) }));
      bytes += Buffer.byteLength(page.content as string); cursor = (page.nextCursor as string | null) ?? undefined;
      if (cursor && !checkedForeignCursor) {
        checkedForeignCursor = true;
        const foreign = await call(publicMcp, second.token, 'autodev_artifact', { manifest_id: f.manifest.id, artifact: artifact.name, cursor, limit: 128 });
        assert.equal(foreign.result.isError, true); assert.match(JSON.stringify(foreign.result), /sequentially/);
      }
    } while (cursor);
    assert.equal(bytes, artifact.byteLength);
  }
  assert.equal((await call(publicMcp, second.token, 'autodev_review', review(f, 'other-grant-cannot-review'))).result.isError, true);
  const local = await call(f.coreUrl, clientToken, 'autodev_review', review(f, 'direct-client-cannot-review'));
  assert.ok(local.sessionId); assert.equal(local.result.isError, true);
  const accepted = resultObject(await call(publicMcp, first.token, 'autodev_review', request));
  assert.equal(accepted.review_status, 'pass'); assert.equal(f.product.status(f.jobId).review_status, 'pass');
  await f.expire(31 * 60_000);
  const expired = await call(publicMcp, first.token, 'autodev_review', review(f, 'expired-proof'));
  assert.equal(expired.result.isError, true); assert.match(JSON.stringify(expired.result), /EVIDENCE_NOT_READ/);
});

test('gateway assertions are bound to exact request bodies, cannot be minted with the client token, and reject replay', async t => {
  const f = await fixture(t); const content = JSON.stringify(initialize);
  const input = { issuer, grantId: randomBytes(32).toString('base64url'), expiresAt: new Date(Date.now() + 600_000).toISOString(), body: content };
  const headers = { Authorization: `Bearer ${clientToken}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
  const forged = await fetch(f.coreUrl, { method: 'POST', headers: { ...headers, ...gatewayAssertion(clientToken, input) }, body: content }); assert.equal(forged.status, 401);
  const proof = gatewayAssertion(adminToken, input);
  const tampered = await fetch(f.coreUrl, { method: 'POST', headers: { ...headers, ...proof }, body: JSON.stringify({ ...initialize, id: 2 }) }); assert.equal(tampered.status, 401);
  const success = await fetch(f.coreUrl, { method: 'POST', headers: { ...headers, ...proof }, body: content }); assert.equal(success.status, 200); assert.equal(success.headers.get('mcp-session-id'), null);
  const replay = await fetch(f.coreUrl, { method: 'POST', headers: { ...headers, ...proof }, body: content }); assert.equal(replay.status, 401);
  const partial = await fetch(f.coreUrl, { method: 'POST', headers: { ...headers, [ASSERTION_HEADER]: proof[ASSERTION_HEADER]! }, body: content }); assert.equal(partial.status, 401);
  assert.equal(JSON.stringify(proof).includes(adminToken), false); assert.ok(proof[SIGNATURE_HEADER]);
});

test('rejected local initialize requests do not consume capacity and idle local sessions are reclaimed', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 40; index++) {
    const response = await fetch(f.coreUrl, { method: 'POST', headers: { Authorization: `Bearer ${clientToken}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(initialize) });
    assert.equal(response.status, 406);
  }
  for (let index = 0; index < 40; index++) assert.ok(resultObject(await call(f.coreUrl, clientToken, 'autodev_projects', {})).projects);
  // This idle transport has no long-running GET stream. Active streams must
  // retain their lease; a merely initialized idle transport must expire.
  const local = await fetch(f.coreUrl, { method: 'POST', headers: { Authorization: `Bearer ${clientToken}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }, body: JSON.stringify(initialize) });
  assert.equal(local.status, 200); await local.text(); const sessionId = local.headers.get('mcp-session-id'); assert.ok(sessionId);
  await f.expire(6 * 60_000);
  const stale = await fetch(f.coreUrl, { method: 'POST', headers: { Authorization: `Bearer ${clientToken}`, 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-03-26', Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) });
  assert.equal(stale.status, 404);
});
