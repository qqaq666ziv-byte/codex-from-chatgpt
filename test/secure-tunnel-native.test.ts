import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { AppServerClient, AppServerMessage, JsonRpcId } from '../src/codex-app-server.js';
import { createGateway } from '../src/gateway.js';
import { ASSERTION_HEADER, SIGNATURE_HEADER } from '../src/gateway-identity.js';
import { JobManager } from '../src/jobs.js';
import { authorized, type LocalConfig } from '../src/local-config.js';
import { createMcpHttpHandler } from '../src/mcp-http.js';
import { AutoDev } from '../src/product.js';
import { StateStore } from '../src/store.js';

// This is the real pinned Windows transport against a synthetic LOCAL control
// plane, not an OpenAI/ChatGPT E2E or an assertion about production billing.
// Wire contract: https://github.com/openai/tunnel-client/blob/v0.0.14/docs/protocol.md
// No downloader, credentials, model executor, browser, or public server is used.
const binary = path.resolve('.tools/tunnel-client-v0.0.14/tunnel-client.exe');
const binarySha256 = 'fcc85a69ec0ad82518e4f8964f60c45e31787957782a0fc9c1b0c44e82d61b9b';
const testRoot = path.resolve('.local-tests');
const tunnelId = 'tunnel_0123456789abcdef0123456789abcdef';
const runtimeKey = 'synthetic-local-control-plane-key';
const adminToken = 'synthetic-native-gateway-admin';
const clientToken = 'synthetic-native-core-client';
const issuer = 'https://autodev-native.invalid';
const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'native transport fixture', version: '1' } } };
type ResponseEnvelope = { request_id: string; channel: string; resp_code: number; resp_type: string; resp_headers?: Record<string, string[]>; resp_json?: { id: string | number; result?: Record<string, unknown>; error?: unknown } };
type Command = { request_id: string; shard_token: string; command_type: string; channel: string; created_at: string; response_timeout: string; headers: Record<string, string[]>; jsonrpc: unknown };

class SyntheticExecutor implements AppServerClient {
  private listeners = new Set<(message: AppServerMessage) => void>();
  addMessageListener(listener: (message: AppServerMessage) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  addExitListener(_listener: (error: Error) => void) { return () => {}; }
  async start() {}
  async request<T>(method: string): Promise<T> {
    if (method === 'thread/start') return { thread: { id: 'native-fixture-thread' }, model: 'synthetic-no-model', reasoningEffort: 'medium', approvalPolicy: 'on-request', sandbox: 'workspace-write' } as T;
    if (method === 'turn/start') return { turn: { id: 'native-fixture-turn', status: 'inProgress', items: [] } } as T;
    return {} as T;
  }
  respond(_id: JsonRpcId, _result: unknown) {}
  respondError(_id: JsonRpcId, _code: number, _message: string) {}
  complete(workspace: string) {
    for (const listener of this.listeners) listener({ method: 'turn/completed', params: { threadId: 'native-fixture-thread', turnId: 'native-fixture-turn', turn: { id: 'native-fixture-turn', status: 'completed', items: [
      { type: 'commandExecution', id: 'synthetic-check', command: 'npm test', cwd: workspace, status: 'completed', exitCode: 0, aggregatedOutput: 'Synthetic executor fixture: all requested assertions passed (no shell command or model was executed).\n' },
      { type: 'agentMessage', id: 'synthetic-final', phase: 'final_answer', text: 'Synthetic local task ready for evidence review.' },
    ] } } });
  }
}

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address !== 'string'); return address.port;
}
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
async function until<T>(read: () => T | Promise<T>, label: string, timeout = 15_000): Promise<Exclude<T, false | null | undefined>> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value) return value as Exclude<T, false | null | undefined>; await delay(40); }
  throw new Error(`Timed out waiting for ${label}`);
}
function responseHeader(response: ResponseEnvelope, name: string) {
  return Object.entries(response.resp_headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

async function fixture(t: TestContext) {
  assert.equal(createHash('sha256').update(readFileSync(binary)).digest('hex'), binarySha256, 'Run only the verified official v0.0.14 Windows binary');
  mkdirSync(testRoot, { recursive: true });
  const directory = mkdtempSync(path.join(testRoot, 'secure-tunnel-native-'));
  const servers: Server[] = [];
  const children: ChildProcess[] = [];
  let gateway: Awaited<ReturnType<typeof createGateway>> | undefined;
  let handler: ReturnType<typeof createMcpHttpHandler> | undefined;
  async function stop(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    assert.ok(children.includes(child), 'Only a process handle created by this fixture may be stopped');
    const ended = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The fixture tunnel process did not stop')), 5_000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    assert.equal(child.kill(), true, 'Owned tunnel termination must actually be sent');
    await ended;
  }
  t.after(async () => {
    for (const child of children) await stop(child);
    await gateway?.close(); await handler?.close();
    for (const server of servers) await close(server);
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(testRoot + path.sep));
    rmSync(resolved, { recursive: true, force: true });
  });
  const workspace = path.join(directory, 'repository'); const runtimeDir = path.join(directory, 'runtime');
  for (const dir of [workspace, runtimeDir, path.join(directory, 'profiles')]) mkdirSync(dir);
  execFileSync('git', ['-c', 'core.hooksPath=.no-test-hooks', 'init', '--quiet'], { cwd: workspace, windowsHide: true });
  writeFileSync(path.join(workspace, 'source.ts'), 'export const value = 1;\n');
  const config: LocalConfig = { schemaVersion: 1, host: '127.0.0.1', port: 8799, model: 'synthetic-no-model', reasoningEffort: 'medium', runtimeDir, configPath: path.join(runtimeDir, 'config.json'), projects: [{ id: 'fixture', name: 'Native transport synthetic fixture', path: realpathSync(workspace) }] };
  const executor = new SyntheticExecutor();
  const jobs = new JobManager(executor, { store: new StateStore(path.join(runtimeDir, 'jobs.json')), model: config.model, reasoningEffort: config.reasoningEffort, workspaceValidator: async value => { assert.equal(realpathSync(value), config.projects[0]!.path); return realpathSync(value); } });
  const product = new AutoDev(config, jobs);
  const job = await product.submit({ request_key: 'native-fixture-submit', project_id: 'fixture', requirements: 'Change the synthetic source value to 2.', acceptance: ['value is 2'] });
  writeFileSync(path.join(workspace, 'source.ts'), 'export const value = 2;\n'); executor.complete(workspace);
  const manifest = product.seal(job.job_id!);
  const coreRequests: Array<{ headers: IncomingHttpHeaders; principal?: string }> = [];
  const core = createServer(async (req, res) => {
    if (!authorized(req.headers.authorization, clientToken)) { res.writeHead(401); res.end(); return; }
    // Leave the body exclusively to the production handler. Decoding here is
    // observation only; a successful handler response proves HMAC/body verification.
    const assertion = typeof req.headers[ASSERTION_HEADER] === 'string' ? JSON.parse(Buffer.from(req.headers[ASSERTION_HEADER], 'base64url').toString('utf8')) as { issuer: string; grant: string } : undefined;
    coreRequests.push({ headers: req.headers, principal: assertion && `gateway:${createHash('sha256').update(`${assertion.issuer}\0${assertion.grant}`).digest('hex')}` });
    try { await handler!.handle(req, res); }
    catch { if (!res.headersSent) res.writeHead(400); res.end(); }
  });
  servers.push(core); const corePort = await listen(core);
  handler = createMcpHttpHandler({ product, adminToken, hosts: [`127.0.0.1:${corePort}`] });
  const reserved = [createServer(), createServer()]; const publicPort = await listen(reserved[0]!); const controlPort = await listen(reserved[1]!);
  for (const server of reserved) await close(server);
  gateway = await createGateway({ issuer, publicPort, controlPort, upstream: `http://127.0.0.1:${corePort}/mcp`, clientToken, adminToken });
  const publicUrl = `http://127.0.0.1:${publicPort}`; const controlUrl = `http://127.0.0.1:${controlPort}`;

  const queue: Command[] = []; const responses: Array<{ payload: ResponseEnvelope; headers: IncomingHttpHeaders; raw: string }> = [];
  const controlRequests: Array<{ pathname: string; headers: IncomingHttpHeaders }> = [];
  let pollCount = 0; let failedPolls = 0; let injectedFailure: '503' | 'disconnect' | undefined;
  let responseRetry: string | undefined; const failedResponses: typeof responses = [];
  const control = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    controlRequests.push({ pathname: url.pathname, headers: req.headers });
    if (req.headers.authorization !== `Bearer ${runtimeKey}`) { res.writeHead(401); res.end(); return; }
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === `/v1/tunnels/${tunnelId}`) { res.end(JSON.stringify({ id: tunnelId, name: 'Synthetic LOCAL tunnel', description: 'No real service or model' })); return; }
    if (url.pathname === `/v1/tunnels/${tunnelId}/poll`) {
      pollCount++;
      if (injectedFailure) { const failure = injectedFailure; injectedFailure = undefined; failedPolls++; if (failure === 'disconnect') req.socket.destroy(); else { res.writeHead(503); res.end(JSON.stringify({ error: { code: 'synthetic_unavailable', message: 'Synthetic retry fixture' } })); } return; }
      await delay(queue.length ? 0 : 80);
      if (queue.length) res.end(JSON.stringify({ commands: queue.splice(0) })); else { res.writeHead(204); res.end(); }
      return;
    }
    if (url.pathname === `/v1/tunnels/${tunnelId}/response`) {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const response = { payload: JSON.parse(raw) as ResponseEnvelope, headers: req.headers, raw };
      if (responseRetry === response.payload.request_id) { responseRetry = undefined; failedResponses.push(response); res.writeHead(503); res.end('{}'); return; }
      responses.push(response); res.end(JSON.stringify({ status: 'ok' })); return;
    }
    res.writeHead(404); res.end('{}');
  });
  servers.push(control); const planeUrl = `http://127.0.0.1:${await listen(control)}`;
  // Force the child through a deny-by-default loopback proxy. Even accidental
  // OAuth discovery/proxy checks cannot connect to an external host.
  const allowed = new Set([planeUrl, publicUrl]); const deniedDestinations: string[] = [];
  const proxy = createServer((req, res) => {
    let target: URL; try { target = new URL(req.url!); } catch { res.writeHead(400); res.end(); return; }
    if (!allowed.has(target.origin) || target.username || target.password) { deniedDestinations.push(target.origin); res.writeHead(502); res.end(); return; }
    const upstream = request(target, { method: req.method, headers: { ...req.headers, host: target.host } }, result => { res.writeHead(result.statusCode!, result.headers); result.pipe(res); });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  proxy.on('connect', (req, socket) => { deniedDestinations.push(req.url ?? 'CONNECT'); socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); });
  servers.push(proxy); const proxyUrl = `http://127.0.0.1:${await listen(proxy)}`;
  let sequence = 0;
  async function send(jsonrpc: unknown, headers: Record<string, string[]> = {}, retryResponse = false) {
    const requestId = `synthetic-command-${++sequence}`; const shard = `synthetic-shard-${sequence}`;
    if (retryResponse) responseRetry = requestId;
    queue.push({ request_id: requestId, shard_token: shard, command_type: 'jsonrpc', channel: 'main', created_at: new Date().toISOString(), response_timeout: '20s', headers, jsonrpc });
    const response = await until(() => responses.find(value => value.payload.request_id === requestId), 'official client response');
    assert.equal(response.headers['x-tunnel-shard-token'], shard);
    assert.equal(response.payload.channel, 'main');
    assert.equal(response.raw.includes('shard_token'), false);
    return response;
  }
  async function start() {
    const healthFile = path.join(directory, `health-${children.length}.txt`);
    const env: NodeJS.ProcessEnv = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: directory, TMP: directory, USERPROFILE: directory, APPDATA: directory, LOCALAPPDATA: directory, XDG_CONFIG_HOME: directory, CONTROL_PLANE_API_KEY: runtimeKey };
    const child = spawn(binary, ['run', '--control-plane.base-url', planeUrl, '--control-plane.tunnel-id', tunnelId, '--control-plane.api-key', 'env:CONTROL_PLANE_API_KEY', '--control-plane.poll-timeout', '100ms', '--mcp.server-url', `${publicUrl}/mcp`, '--health.listen-addr', '127.0.0.1:0', '--health.url-file', healthFile, '--profile-dir', path.join(directory, 'profiles'), '--http-proxy', proxyUrl, '--open-web-ui=false', '--cloudflared.managed=false', '--log.level', 'warn', '--log.format', 'json'], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child); let output = ''; let spawnError: Error | undefined;
    child.stdout!.on('data', chunk => { output = (output + chunk).slice(-12_000); }); child.stderr!.on('data', chunk => { output = (output + chunk).slice(-12_000); });
    child.on('error', error => { spawnError = error; });
    const healthUrl = await until(() => {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`Official fixture client exited (${child.exitCode}): ${output}`);
      return existsSync(healthFile) && readFileSync(healthFile, 'utf8').trim();
    }, 'official client loopback health listener');
    assert.equal(new URL(healthUrl).hostname, '127.0.0.1');
    return { child, healthUrl };
  }
  async function grant(clientId?: string) {
    if (!clientId) {
      const response = await fetch(`${publicUrl}/oauth/register`, { method: 'POST', body: JSON.stringify({ client_name: 'Synthetic native transport grant', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' }) });
      assert.equal(response.status, 201); clientId = (await response.json() as { client_id: string }).client_id;
    }
    const verifier = randomBytes(32).toString('base64url');
    const query = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: redirectUri, resource: `${issuer}/mcp`, scope: 'autodev', state: randomBytes(16).toString('hex'), code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
    const authorize = await fetch(`${publicUrl}/oauth/authorize?${query}`); assert.equal(authorize.status, 200);
    const requestId = /<code>([^<]+)<\/code>/.exec(await authorize.text())?.[1]; assert.ok(requestId);
    const pendingResponse = await fetch(`${controlUrl}/status`, { headers: { Authorization: `Bearer ${adminToken}` } });
    const pending = (await pendingResponse.json() as { pending: Array<{ request_id: string; verification_code: string }> }).pending.find(item => item.request_id === requestId); assert.ok(pending);
    const approval = await fetch(`${controlUrl}/approve`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ ...pending, approve: true }) }); assert.equal(approval.status, 200);
    const redirect = await fetch(`${publicUrl}/oauth/result?request_id=${requestId}`, { redirect: 'manual' }); assert.equal(redirect.status, 302);
    const code = new URL(redirect.headers.get('location')!).searchParams.get('code')!;
    const token = await fetch(`${publicUrl}/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, redirect_uri: redirectUri, resource: `${issuer}/mcp`, code, code_verifier: verifier }) }); assert.equal(token.status, 200);
    return { clientId, token: (await token.json() as { access_token: string }).access_token };
  }
  async function call(token: string, name: string, args: Record<string, unknown>, extra: Record<string, string[]> = {}) {
    const result = (await send({ jsonrpc: '2.0', id: sequence + 100, method: 'tools/call', params: { name, arguments: args } }, { Authorization: [`Bearer ${token}`], 'Mcp-Protocol-Version': ['2025-03-26'], ...extra })).payload;
    assert.equal(result.resp_code, 200, JSON.stringify(result));
    assert.ok(result.resp_json?.result, JSON.stringify(result));
    return result.resp_json.result;
  }
  return { start, stop, send, grant, call, product, manifest, jobId: job.job_id!, coreRequests, controlRequests, failedResponses, responses, deniedDestinations,
    failPoll: (kind: '503' | 'disconnect') => { injectedFailure = kind; }, counts: () => ({ pollCount, failedPolls }) };
}

test('official tunnel-client v0.0.14 local transport, retry, restart and OAuth evidence isolation', {
  skip: process.platform !== 'win32' ? 'Pinned native fixture is Windows amd64 only; no download performed.' : !existsSync(binary) ? 'Verified optional tunnel-client v0.0.14 binary is absent; native transport was NOT tested and no download performed.' : false,
  timeout: 90_000,
}, async t => {
  const f = await fixture(t); let native = await f.start();
  const first = await f.grant(); const second = await f.grant(first.clientId);
  const auth = { Authorization: [`Bearer ${first.token}`], 'Mcp-Protocol-Version': ['2025-03-26'] };

  await t.test('real polling and plain health endpoints are distinct from proxy health', async () => {
    await until(() => f.counts().pollCount > 0, 'a real control-plane poll');
    const metrics = await until(async () => { const text = await (await fetch(native.healthUrl + '/metrics')).text(); const match = /^commands_poll_last_successful_timestamp_seconds(?:\{[^}]*\})?\s+(\S+)/m.exec(text); return match && Number(match[1]) > 0 && text; }, 'successful-poll timestamp metric');
    // The poll loop and operator readiness state initialize independently.
    // A successful-poll metric can appear before readiness converges under
    // parallel suite load; wait for actual HTTP 200, retaining every assertion.
    for (const route of ['/healthz', '/readyz']) {
      const healthy = await until(async () => {
        const response = await fetch(native.healthUrl + route, { signal: AbortSignal.timeout(2_000) });
        const body = await response.text();
        assert.ok(response.status === 200 || response.status === 503, `${route}: unexpected HTTP ${response.status}`);
        return response.status === 200 ? { status: response.status, contentType: response.headers.get('content-type'), body } : undefined;
      }, `official client ${route} to become HTTP 200`);
      assert.equal(healthy.status, 200, healthy.body);
      assert.match(healthy.contentType ?? '', /text\/plain/); assert.ok(healthy.body.trim());
    }
    assert.match(metrics, /commands_poll_last_successful_timestamp_seconds/);
    assert.ok(f.controlRequests.every(req => req.pathname.startsWith(`/v1/tunnels/${tunnelId}`)));
    assert.ok(f.controlRequests.every(req => req.headers.authorization === `Bearer ${runtimeKey}`));
    assert.ok(f.controlRequests.some(req => String(req.headers['x-tunnel-client-version']).startsWith('0.0.14')));
  });

  await t.test('unauthenticated/forged identity requests preserve the real gateway 401 and OAuth challenge', async () => {
    const badHeaders: Array<Record<string, string[]>> = [{}, { Authorization: ['Bearer invalid-synthetic-token'], 'OpenAI-User-Id': ['claimed-owner'], [ASSERTION_HEADER]: ['forged'], [SIGNATURE_HEADER]: ['forged'] }];
    for (const headers of badHeaders) {
      const response = (await f.send(initialize, headers)).payload;
      assert.equal(response.resp_code, 401);
      assert.deepEqual(responseHeader(response, 'WWW-Authenticate'), [`Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp"`]);
    }
    assert.equal(f.coreRequests.length, 0, 'A tunnel connection or identity-like header cannot bypass OAuth');
  });

  await t.test('authorized forwarding retains MCP IDs and creates only verified grant identity', async () => {
    const response = (await f.send(initialize, { ...auth, 'OpenAI-User-Id': ['claimed-owner'], [ASSERTION_HEADER]: ['forged'], [SIGNATURE_HEADER]: ['forged'] })).payload;
    assert.equal(response.resp_code, 200); assert.equal(response.resp_json?.id, 1);
    assert.equal(responseHeader(response, 'Mcp-Session-Id'), undefined, 'Gateway remains stateless');
    const core = f.coreRequests.at(-1)!; assert.ok(core.principal); assert.notEqual(core.principal, 'claimed-owner');
    assert.equal(core.headers.authorization, `Bearer ${clientToken}`); assert.notEqual(core.headers[ASSERTION_HEADER], 'forged'); assert.equal(core.headers['openai-user-id'], undefined);
    assert.ok((await f.call(first.token, 'autodev_projects', {})).structuredContent);
  });

  await t.test('real poll 503/disconnect recovery and response retry preserve exact correlation without replaying MCP', async () => {
    for (const failure of ['503', 'disconnect'] as const) {
      const before = f.counts(); f.failPoll(failure);
      await until(() => f.counts().failedPolls > before.failedPolls, `injected ${failure}`);
      assert.equal((await f.send(initialize, auth)).payload.resp_code, 200);
      assert.ok(f.counts().pollCount > before.pollCount);
    }
    const before = f.coreRequests.length;
    const response = await f.send(initialize, auth, true);
    assert.equal(f.coreRequests.length, before + 1, 'Response retry must not execute MCP twice');
    const rejected = f.failedResponses.at(-1)!;
    assert.equal(response.raw, rejected.raw); assert.equal(response.headers['x-tunnel-shard-token'], rejected.headers['x-tunnel-shard-token']);
  });

  await t.test('same tunnel ID reconnect retains own evidence while other grants cannot inherit proof', async () => {
    const review = (key: string) => ({ request_key: key, job_id: f.jobId, manifest_id: f.manifest.id, verdict: 'pass', summary: 'Read all synthetic transport fixture evidence and verify grant isolation.' });
    const denied = await f.call(first.token, 'autodev_review', review('before-reading')); assert.equal(denied.isError, true); assert.match(JSON.stringify(denied), /EVIDENCE_NOT_READ/);
    const manifest = await f.call(first.token, 'autodev_evidence', { job_id: f.jobId }); assert.equal((manifest.structuredContent as Record<string, unknown>).id, f.manifest.id);
    for (const artifact of f.manifest.artifacts) {
      let cursor: string | undefined; let bytes = 0;
      do {
        const result = await f.call(first.token, 'autodev_artifact', { manifest_id: f.manifest.id, artifact: artifact.name, limit: 512, ...(cursor ? { cursor } : {}) });
        assert.notEqual(result.isError, true, JSON.stringify(result));
        const page = result.structuredContent as { content: string; nextCursor: string | null };
        bytes += Buffer.byteLength(page.content); cursor = page.nextCursor ?? undefined;
      } while (cursor);
      assert.equal(bytes, artifact.byteLength);
    }
    const stolen = f.coreRequests.at(-1)!;
    const other = await f.call(second.token, 'autodev_review', review('foreign-grant'), {
      [ASSERTION_HEADER]: [String(stolen.headers[ASSERTION_HEADER])], [SIGNATURE_HEADER]: [String(stolen.headers[SIGNATURE_HEADER])], 'OpenAI-User-Id': [stolen.principal!],
    });
    assert.equal(other.isError, true); assert.match(JSON.stringify(other), /EVIDENCE_NOT_READ/);
    const oldPid = native.child.pid; await f.stop(native.child); native = await f.start(); assert.notEqual(native.child.pid, oldPid);
    const accepted = await f.call(first.token, 'autodev_review', review('same-grant-after-native-restart'));
    assert.notEqual(accepted.isError, true, JSON.stringify(accepted)); assert.equal((accepted.structuredContent as Record<string, unknown>).review_status, 'pass');
    assert.equal(f.product.status(f.jobId).review_status, 'pass');
    const instances = new Set(f.controlRequests.map(req => req.headers['x-tunnel-client-instance-id']).filter(Boolean)); assert.equal(instances.size, 2);
    const allowedPaths = new Set([`/v1/tunnels/${tunnelId}`, `/v1/tunnels/${tunnelId}/poll`, `/v1/tunnels/${tunnelId}/response`]);
    assert.ok(f.controlRequests.every(req => allowedPaths.has(req.pathname)), 'Only local tunnel protocol endpoints were used; no model/admin API route');
  });
});
