import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID, webcrypto } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import test, { type TestContext } from 'node:test';
import { createGateway } from '../src/gateway.js';
import { GatewayIdentityVerifier } from '../src/gateway-identity.js';
import { RelayChannel, RelayError, RELAY_BODY_LIMIT, RELAY_PATH, RELAY_WIRE_LIMIT, type RelayEnvelope, type RelayRequest, type RelayResponse } from '../src/relay-crypto.js';
import { createWorker } from '../edge/worker.mjs';

const issuer = 'https://fixed-autodev.example';
const redirect = 'https://chatgpt.com/connector_platform_oauth_redirect';
const quickOrigin = 'https://owned-fixture.trycloudflare.com';
const adminToken = 'synthetic-relay-local-admin-credential';
const clientToken = 'synthetic-relay-upstream-credential';
const encoder = new TextEncoder();
const additionalData = (direction: string, id: string, origin = issuer) => encoder.encode(`AutoDev relay v1\n${direction}\n${origin}\n${id}`);

// Independent WebCrypto matches the deployed Worker's ciphertext-plus-tag wire format.
async function webSeal(key: Buffer, value: unknown, options: { origin?: string; direction?: string; id?: string } = {}): Promise<RelayEnvelope> {
  const id = options.id ?? randomBytes(16).toString('base64url');
  const iv = randomBytes(12);
  const cryptoKey = await webcrypto.subtle.importKey('raw', new Uint8Array(key), 'AES-GCM', false, ['encrypt']);
  const data = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(iv), additionalData: additionalData(options.direction ?? 'request', id, options.origin), tagLength: 128 }, cryptoKey, encoder.encode(JSON.stringify(value)));
  return { v: 1, id, iv: iv.toString('base64url'), data: Buffer.from(data).toString('base64url') };
}
async function webOpen(key: Buffer, value: RelayEnvelope, expectedId: string): Promise<RelayResponse> {
  assert.equal(value.id, expectedId);
  const cryptoKey = await webcrypto.subtle.importKey('raw', new Uint8Array(key), 'AES-GCM', false, ['decrypt']);
  const plain = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(Buffer.from(value.iv, 'base64url')), additionalData: additionalData('response', expectedId), tagLength: 128 }, cryptoKey, new Uint8Array(Buffer.from(value.data, 'base64url')));
  return JSON.parse(Buffer.from(plain).toString('utf8'));
}
const input = (overrides: Partial<RelayRequest> = {}): RelayRequest => ({ method: 'GET', path: '/.well-known/oauth-authorization-server', headers: [], body: '', issuedAt: Date.now(), ...overrides });
async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address !== 'string'); return address.port;
}
async function close(server: Server): Promise<void> { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }

async function fixture(t: TestContext) {
  const key = randomBytes(32);
  const instance = randomUUID();
  const received: { headers: IncomingHttpHeaders; body: string; principal: string | undefined }[] = [];
  const outerRequests: { url: string; headers: Headers; body: string }[] = [];
  let reply = Buffer.from('{"ok":true}');
  let replyStatus = 200;
  let hanging: { started: () => void; closed: () => void } | undefined;
  const verifier = new GatewayIdentityVerifier(adminToken);
  const upstream = createServer(async (req, res) => {
    let content = ''; for await (const chunk of req) content += chunk;
    received.push({ headers: req.headers, body: content, principal: verifier.verify(req.headers, req.method, req.url, content) });
    if (hanging) { res.once('close', hanging.closed); hanging.started(); return; }
    res.writeHead(replyStatus, { 'content-type': 'application/json' }); res.end(reply);
  });
  const upstreamPort = await listen(upstream);
  const publicReservation = createServer(); const controlReservation = createServer();
  const publicPort = await listen(publicReservation); const controlPort = await listen(controlReservation);
  await Promise.all([close(publicReservation), close(controlReservation)]);
  const gateway = await createGateway({ issuer, publicPort, controlPort, upstream: `http://127.0.0.1:${upstreamPort}/mcp`, clientToken, adminToken, relayKey: key, instance, managementCommand: 'fixed-tunnel.ps1' });
  t.after(async () => { await gateway.close(); await close(upstream); });
  const publicUrl = `http://127.0.0.1:${publicPort}`;
  const controlUrl = `http://127.0.0.1:${controlPort}`;
  const worker = createWorker({ crypto: webcrypto, fetch: async (url: string, init: RequestInit) => {
    assert.equal(String(url), quickOrigin + RELAY_PATH);
    outerRequests.push({ url: String(url), headers: new Headers(init.headers), body: String(init.body) });
    return fetch(publicUrl + RELAY_PATH, init);
  } });
  const env = { ROUTES: { get: async () => JSON.stringify({ origin: quickOrigin, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), relayKey: key.toString('base64url') }) } };
  const send = (method: string, target: string, body?: string, headers: Record<string, string> = {}) => worker.fetch(new Request(issuer + target, { method, headers, ...(body === undefined ? {} : { body }) }), env) as Promise<Response>;
  return { key, instance, publicUrl, controlUrl, received, outerRequests, send,
    post: (value: unknown) => fetch(publicUrl + RELAY_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }),
    reply: (value: Buffer, status = 200) => { reply = value; replyStatus = status; },
    hang: (started: () => void, closed: () => void) => { hanging = { started, closed }; },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function authorize(f: Fixture) {
  const registration = await f.send('POST', '/oauth/register', JSON.stringify({ client_name: 'Relay <script>fixture</script>', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }), { 'content-type': 'application/json' });
  assert.equal(registration.status, 201);
  const client = await registration.json() as { client_id: string };
  const verifier = randomBytes(32).toString('base64url');
  const params = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: redirect, state: 'synthetic-callback-state', resource: `${issuer}/mcp`, scope: 'autodev', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
  const authorization = await f.send('GET', `/oauth/authorize?${params}`);
  assert.equal(authorization.status, 200);
  const html = await authorization.text();
  assert.match(html, /&lt;script&gt;fixture&lt;\/script&gt;/);
  assert.match(authorization.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  const id = /<code>([^<]+)<\/code>/.exec(html)?.[1]; assert.ok(id);
  const status = await fetch(`${f.controlUrl}/status`, { headers: { authorization: `Bearer ${adminToken}` } });
  const pending = (await status.json() as { pending: { request_id: string; verification_code: string }[] }).pending.find(p => p.request_id === id); assert.ok(pending);
  const waiting = await f.send('GET', `/oauth/result?request_id=${id}`);
  assert.equal(waiting.status, 200); assert.match(await waiting.text(), /fixed-tunnel.ps1/);
  const decision = await fetch(`${f.controlUrl}/approve`, { method: 'POST', headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ request_id: id, verification_code: pending.verification_code, approve: true }) });
  assert.equal(decision.status, 200);
  const finished = await f.send('GET', `/oauth/result?request_id=${id}`);
  assert.equal(finished.status, 302);
  const location = new URL(finished.headers.get('location')!);
  assert.equal(location.origin + location.pathname, redirect);
  assert.equal(location.searchParams.get('iss'), issuer);
  const exchanged = await f.send('POST', '/oauth/token', new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: redirect, resource: `${issuer}/mcp`, code_verifier: verifier, code: location.searchParams.get('code')! }).toString(), { 'content-type': 'application/x-www-form-urlencoded' });
  assert.equal(exchanged.status, 200);
  const tokens = await exchanged.json() as { access_token: string; refresh_token: string };
  return { clientId: client.client_id, tokens };
}

test('actual Worker WebCrypto and HTTP gateway complete OAuth and preserve the stable MCP grant principal', async t => {
  const f = await fixture(t);
  for (const route of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    const response = await f.send('GET', route);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-autodev-instance'), f.instance);
  }
  const { clientId, tokens } = await authorize(f);
  const mcp = await f.send('POST', '/mcp', '{"jsonrpc":"2.0","id":1,"method":"initialize"}', { authorization: `Bearer ${tokens.access_token}`, 'mcp-protocol-version': '2025-03-26', 'content-type': 'application/json', cookie: 'synthetic-secret-cookie', 'x-admin-token': adminToken });
  assert.equal(mcp.status, 200); assert.deepEqual(await mcp.json(), { ok: true });
  assert.equal(mcp.headers.get('x-autodev-instance'), null);
  const first = f.received[0]!;
  assert.equal(first.headers.authorization, `Bearer ${clientToken}`);
  assert.equal(first.headers.cookie, undefined); assert.equal(first.headers['x-admin-token'], undefined);
  assert.equal(first.headers['mcp-protocol-version'], '2025-03-26');
  assert.ok(first.principal?.startsWith('gateway:'));
  for (const outer of f.outerRequests) {
    assert.equal(outer.headers.has('authorization'), false); assert.equal(outer.headers.has('cookie'), false);
    assert.equal(outer.body.includes(tokens.access_token), false); assert.equal(outer.body.includes(tokens.refresh_token), false);
    assert.equal(outer.body.includes(adminToken), false); assert.equal(outer.body.includes('synthetic-secret-cookie'), false);
  }
  const refreshed = await f.send('POST', '/oauth/token', new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token, resource: `${issuer}/mcp` }).toString(), { 'content-type': 'application/x-www-form-urlencoded' });
  assert.equal(refreshed.status, 200);
  const next = await refreshed.json() as { access_token: string };
  assert.equal((await f.send('POST', '/mcp', '{}', { authorization: `Bearer ${next.access_token}` })).status, 200);
  assert.equal(f.received.at(-1)!.principal, first.principal);
  assert.equal((await f.send('POST', '/oauth/token', new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token, resource: `${issuer}/mcp` }).toString())).status, 400);
  const revoked = await f.send('POST', '/mcp', '{}', { authorization: `Bearer ${next.access_token}` });
  assert.equal(revoked.status, 401); assert.match(revoked.headers.get('www-authenticate') ?? '', /oauth-protected-resource/);
});

test('encrypted mode has no plaintext OAuth/MCP routes; malformed, tampered and replayed envelopes receive generic errors', async t => {
  const f = await fixture(t);
  for (const route of ['/oauth/register', '/oauth/token', '/oauth/authorize', '/mcp', '/status', '/.well-known/oauth-authorization-server']) {
    for (const method of ['GET', 'POST']) {
      const raw = await fetch(f.publicUrl + route, { method, headers: { authorization: `Bearer ${adminToken}` }, ...(method === 'POST' ? { body: '{}' } : {}) });
      assert.equal(raw.status, 400); assert.deepEqual(await raw.json(), { error: 'request_rejected' });
    }
  }
  assert.equal((await fetch(f.publicUrl + RELAY_PATH)).status, 400);
  const valid = await webSeal(f.key, input());
  const opened = await f.post(valid); assert.equal(opened.status, 200);
  const envelope = await opened.json() as RelayEnvelope;
  assert.equal(envelope.id, valid.id); assert.notEqual(envelope.iv, valid.iv);
  assert.equal((await webOpen(f.key, envelope, valid.id)).status, 200);
  const tampered = Buffer.from(valid.data, 'base64url'); tampered[0]! ^= 1;
  for (const attack of [null, {}, { ...valid, v: 2 }, { ...valid, extra: 'unexpected' }, { ...valid, id: valid.id + '=' }, { ...valid, iv: valid.iv + '=' }, { ...valid, data: tampered.toString('base64url') }, { ...valid, id: randomBytes(16).toString('base64url') }, valid,
    await webSeal(randomBytes(32), input()), await webSeal(f.key, input(), { origin: 'https://wrong.example' }), await webSeal(f.key, input(), { direction: 'response' })]) {
    const rejected = await f.post(attack); assert.equal(rejected.status, 400); assert.deepEqual(await rejected.json(), { error: 'request_rejected' });
  }
  assert.equal(f.received.length, 0);
});

test('relay rejects forbidden targets, untrusted headers, noncanonical bodies and timestamp skew', async t => {
  const f = await fixture(t);
  for (const changed of [
    { path: '//evil.example/oauth/token' }, { path: 'https://evil.example/oauth/token' }, { path: '/oauth/register#fragment' }, { path: '/oauth/register/../token' }, { path: '/oauth/../status' }, { path: '/oauth\\token' }, { path: '/oauth/token\n' }, { path: '/status' }, { path: '/_autodev/route' }, { method: 'PUT' },
    { headers: [['cookie', 'secret']] }, { headers: [['authorization', 'Bearer one'], ['Authorization', 'Bearer two']] }, { headers: [['authorization', 'Bearer one\r\nX-Injected: yes']] }, { headers: [['host', '127.0.0.1']] },
    { body: 'AA==' }, { body: 'AA' }, { issuedAt: Date.now() - 61_000 }, { issuedAt: Date.now() + 61_000 }, { issuedAt: 'now' },
  ]) {
    const rejected = await f.post(await webSeal(f.key, { ...input(), ...changed }));
    assert.equal(rejected.status, 400); assert.deepEqual(await rejected.json(), { error: 'request_rejected' });
  }
});

test('full two MiB request/response bodies interoperate and oversized bodies or wire responses fail closed', async t => {
  const f = await fixture(t);
  const { tokens } = await authorize(f);
  const full = Buffer.alloc(RELAY_BODY_LIMIT, 97);
  f.reply(full);
  const response = await f.send('POST', '/mcp', full.toString('utf8'), { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' });
  assert.equal(response.status, 200); assert.equal((await response.arrayBuffer()).byteLength, RELAY_BODY_LIMIT);
  assert.equal(Buffer.byteLength(f.received.at(-1)!.body), RELAY_BODY_LIMIT);
  f.reply(Buffer.alloc(RELAY_BODY_LIMIT + 1, 98));
  const oversizedResponse = await f.send('POST', '/mcp', '{}', { authorization: `Bearer ${tokens.access_token}` });
  assert.equal(oversizedResponse.status, 400); assert.deepEqual(await oversizedResponse.json(), { error: 'request_rejected' });
  const oversizedRequest = await f.post(await webSeal(f.key, input({ method: 'POST', path: '/mcp', body: Buffer.alloc(RELAY_BODY_LIMIT + 1).toString('base64url') })));
  assert.equal(oversizedRequest.status, 400);
  const outer = await fetch(f.publicUrl + RELAY_PATH, { method: 'POST', body: 'x'.repeat(RELAY_WIRE_LIMIT + 1) });
  assert.equal(outer.status, 400); assert.deepEqual(await outer.json(), { error: 'request_rejected' });
  f.reply(Buffer.alloc(0), 204);
  const notification = await f.send('POST', '/mcp', '{}', { authorization: `Bearer ${tokens.access_token}` });
  assert.equal(notification.status, 204); assert.equal(await notification.text(), '');
});

test('replay capacity never evicts live IDs; expiry releases slots and closing erases use of the run key', async () => {
  const key = randomBytes(32); let now = Date.now();
  const channel = new RelayChannel({ issuer, key, now: () => now });
  let first = '';
  for (let index = 0; index < 4096; index++) {
    const sealed = await webSeal(key, input({ issuedAt: now }));
    if (index === 0) first = sealed.id;
    channel.open(sealed);
  }
  assert.throws(() => channel.sealResponse('unknown-id', { status: 200, headers: [], body: '' }), RelayError);
  const excess = await webSeal(key, input({ issuedAt: now }));
  assert.throws(() => channel.open(excess), RelayError);
  assert.throws(() => channel.open({ ...excess, id: first }), RelayError);
  now += 120_001;
  const fresh = await webSeal(key, input({ issuedAt: now }), { id: first });
  channel.open(fresh);
  const reply = channel.sealResponse(first, { status: 200, headers: [['content-type', 'application/json']], body: Buffer.from('{}').toString('base64url') });
  assert.equal((await webOpen(key, reply, first)).status, 200);
  assert.throws(() => channel.sealResponse(first, { status: 200, headers: [], body: '' }), RelayError);
  channel.close();
  assert.throws(() => channel.open(fresh), RelayError);
});

test('a disconnected encrypted caller aborts its pending upstream request', async t => {
  const f = await fixture(t);
  const { tokens } = await authorize(f);
  let onStarted!: () => void; let onClosed!: () => void;
  const started = new Promise<void>(resolve => { onStarted = resolve; });
  const closed = new Promise<void>(resolve => { onClosed = resolve; });
  f.hang(onStarted, onClosed);
  const controller = new AbortController();
  const envelope = await webSeal(f.key, input({ method: 'POST', path: '/mcp', headers: [['authorization', `Bearer ${tokens.access_token}`]], body: Buffer.from('{}').toString('base64url') }));
  const request = fetch(f.publicUrl + RELAY_PATH, { method: 'POST', body: JSON.stringify(envelope), signal: controller.signal }).catch(() => undefined);
  await started; controller.abort(); await request;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Upstream was not cancelled after disconnect')), 3000); })]); }
  finally { if (timer) clearTimeout(timer); }
});
