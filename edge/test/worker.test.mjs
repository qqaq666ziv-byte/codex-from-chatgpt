import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes, webcrypto } from 'node:crypto';
import { createWorker, LIMITS } from '../worker.mjs';

const NOW = Date.parse('2026-09-05T00:00:00.000Z');
const ISSUER = 'https://autodev.example.workers.dev';
const SECRET = randomBytes(32).toString('base64url');
const KEY = randomBytes(32);
const ORIGIN = 'https://owned-quick-test.trycloudflare.com';
const ROUTE = { origin: ORIGIN, expiresAt: new Date(NOW + LIMITS.maxLease).toISOString(), relayKey: KEY.toString('base64url') };
const EMPTY = Buffer.from('{}').toString('base64url');
const responsePlain = (body = '{}', status = 200, headers = [['content-type', 'application/json']]) =>
  ({ status, headers, body: Buffer.from(body).toString('base64url') });
function open(wire, direction = 'request', issuer = ISSUER, key = KEY) {
  const data = Buffer.from(wire.data, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(wire.iv, 'base64url'));
  decipher.setAAD(Buffer.from(`AutoDev relay v1\n${direction}\n${issuer}\n${wire.id}`));
  decipher.setAuthTag(data.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]).toString('utf8'));
}
function seal(id, plain, options = {}) {
  const iv = options.iv ?? randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', options.key ?? KEY, iv);
  cipher.setAAD(Buffer.from(`AutoDev relay v1\n${options.direction ?? 'response'}\n${options.issuer ?? ISSUER}\n${id}`));
  const text = typeof plain === 'string' ? plain : JSON.stringify(plain);
  return { v: 1, id, iv: iv.toString('base64url'), data: Buffer.concat([cipher.update(text), cipher.final(), cipher.getAuthTag()]).toString('base64url') };
}
function fixture({ route = ROUTE, reply = responsePlain(), fetchError, kvError, now = () => NOW, timeout = 1000 } = {}) {
  const calls = [];
  const puts = [];
  const gets = [];
  let stored = route === null ? null : JSON.stringify(route);
  const env = { ROUTE_SECRET: SECRET, ROUTES: {
    async get(...args) { gets.push(args); if (kvError) throw kvError; return stored; },
    async put(...args) { puts.push(args); if (kvError) throw kvError; stored = args[1]; },
  } };
  const worker = createWorker({ now, crypto: webcrypto, timeout, fetch: async (url, init) => {
    if (fetchError) throw fetchError;
    const wire = JSON.parse(init.body);
    const plain = open(wire);
    calls.push({ url, init, wire, plain });
    if (typeof reply === 'function') return reply({ url, init, wire, plain });
    return Response.json(seal(wire.id, reply));
  } });
  return { env, calls, puts, gets, worker,
    run(path = '/mcp', init = {}) { return worker.fetch(new Request(ISSUER + path, init.method || init.body ? init : { ...init, method: 'POST', body: '{}' }), env); },
    update(value = ROUTE, headers = {}) { return worker.fetch(new Request(ISSUER + '/_autodev/route', { method: 'PUT',
      headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(value) }), env); },
  };
}
async function safe503(response) {
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'temporarily_unavailable' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
}

test('registers one encrypted route with awaited KV TTL and no secret in response', async () => {
  const f = fixture({ route: null });
  const result = await f.update();
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { ok: true, expiresAt: ROUTE.expiresAt });
  assert.deepEqual(f.puts, [['active-route', JSON.stringify(ROUTE), { expirationTtl: 3600 }]]);
  assert.equal(f.calls.length, 0);
});
test('requires secret only on registration and rejects malformed or missing credentials', async () => {
  for (const authorization of ['', 'Bearer invalid', `Basic ${SECRET}`, `Bearer ${SECRET}extra`]) {
    const f = fixture();
    assert.equal((await f.update(ROUTE, { authorization })).status, 401);
    assert.equal(f.puts.length, 0);
  }
  const f = fixture();
  f.env.ROUTE_SECRET = undefined;
  await safe503(await f.update());
});
test('accepts only canonical exact single-level HTTPS Quick origins', async () => {
  for (const origin of ['http://owned.trycloudflare.com', 'https://owned.trycloudflare.com/', 'https://u:p@owned.trycloudflare.com',
    'https://owned.trycloudflare.com:443', 'https://sub.owned.trycloudflare.com', 'https://owned.trycloudflare.com?x=1',
    'https://owned.trycloudflare.com#x', 'https://owned.trycloudflare.com/a', 'https://owned.trycloudflare.com.evil.test',
    'https://127.0.0.1', 'https://OWNED.trycloudflare.com', 'https://-owned.trycloudflare.com']) {
    const f = fixture();
    assert.equal((await f.update({ ...ROUTE, origin })).status, 400, origin);
    assert.equal(f.puts.length, 0);
  }
});
test('validates lease bounds, exact ISO, relay key canonical length, and strict record keys', async () => {
  for (const patch of [{ expiresAt: new Date(NOW + LIMITS.minLease - 1).toISOString() },
    { expiresAt: new Date(NOW + LIMITS.maxLease + 1).toISOString() }, { expiresAt: '2026-09-05T01:00:00Z' },
    { expiresAt: NOW + LIMITS.maxLease }, { relayKey: KEY.toString('base64') }, { relayKey: 'a'.repeat(43) },
    { relayKey: KEY.subarray(1).toString('base64url') }, { extra: true }]) {
    const f = fixture();
    assert.equal((await f.update({ ...ROUTE, ...patch })).status, 400, JSON.stringify(patch));
    assert.equal(f.puts.length, 0);
  }
  assert.equal((await fixture().update({ ...ROUTE, expiresAt: new Date(NOW + LIMITS.minLease).toISOString() })).status, 200);
});
test('health is safe and reports valid lease only, never destination or key', async () => {
  for (const [route, ready] of [[ROUTE, true], [null, false], [{ ...ROUTE, expiresAt: new Date(NOW).toISOString() }, false],
    [{ ...ROUTE, relayKey: 'invalid' }, false]]) {
    const f = fixture({ route });
    const result = await f.run('/_autodev/health', { method: 'GET' });
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { ok: true, routeReady: ready });
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.gets, [['active-route', { type: 'text', cacheTtl: 30 }]]);
  }
});
test('KV quota/read/write errors return safe503 without fallback or exception details', async () => {
  const f = fixture({ kvError: new Error(`Quota exceeded ${ORIGIN} ${SECRET}`) });
  await safe503(await f.update());
  await safe503(await f.run('/_autodev/health', { method: 'GET' }));
  await safe503(await f.run());
  assert.equal(f.calls.length, 0);
});
test('missing, stale, malformed, and too-future route never dispatch', async () => {
  for (const route of [null, { ...ROUTE, expiresAt: new Date(NOW).toISOString() },
    { ...ROUTE, expiresAt: new Date(NOW + LIMITS.maxLease + 1).toISOString() }, { ...ROUTE, origin: 'https://evil.test' }]) {
    const f = fixture({ route }); await safe503(await f.run()); assert.equal(f.calls.length, 0);
  }
  const f = fixture(); f.env.ROUTES.get = async () => '{bad'; await safe503(await f.run());
});
test('allows only required method/path pairs and never exposes local control', async () => {
  for (const path of ['/status', '/approve', '/shutdown', '/admin', '/_autodev/relay', '/', '/mcp/extra', '/oauth/authorize/']) {
    const f = fixture(); assert.equal((await f.run(path)).status, 404, path); assert.equal(f.gets.length, 0);
  }
  for (const [path, method] of [['/mcp', 'GET'], ['/mcp', 'DELETE'], ['/oauth/token', 'GET'], ['/oauth/authorize', 'POST']]) {
    const f = fixture(); assert.equal((await f.run(path, { method })).status, 405); assert.equal(f.calls.length, 0);
  }
  for (const path of ['/mcp?origin=https://evil.test', '/.well-known/oauth-protected-resource?url=x', '/oauth/token?x=y']) {
    assert.equal((await fixture().run(path)).status, path.includes('.well-known') ? 405 : 400);
  }
});
test('required public routes encrypt their exact method/path/query and never expose their payload upstream', async () => {
  for (const [path, method] of [['/.well-known/oauth-protected-resource', 'GET'], ['/.well-known/oauth-protected-resource/mcp', 'GET'],
    ['/.well-known/oauth-authorization-server', 'GET'], ['/oauth/register', 'POST'], ['/oauth/token', 'POST'],
    ['/oauth/authorize?state=test%2Bvalue&client_id=a', 'GET'], ['/oauth/result?request_id=abc', 'GET'], ['/mcp', 'POST']]) {
    const f = fixture();
    assert.equal((await f.run(path, { method, ...(method === 'POST' ? { body: 'private-payload' } : {}) })).status, 200);
    const call = f.calls[0];
    assert.equal(call.url, ORIGIN + '/_autodev/relay');
    assert.equal(call.init.method, 'POST'); assert.equal(call.init.redirect, 'manual');
    assert.deepEqual(call.init.headers, { 'content-type': 'application/json', accept: 'application/json', 'accept-encoding': 'identity' });
    assert.equal(call.plain.method, method); assert.equal(call.plain.path, path); assert.equal(call.plain.issuedAt, NOW);
    assert.equal(Buffer.from(call.plain.body, 'base64url').toString(), method === 'POST' ? 'private-payload' : '');
    assert.ok(!call.init.body.includes('private-payload')); assert.ok(!call.init.body.includes(SECRET)); assert.ok(!call.init.body.includes(ROUTE.relayKey));
  }
});
test('strips spoofed credentials, cookies and routing headers; preserves only required OAuth/MCP headers inside ciphertext', async () => {
  const f = fixture();
  const result = await f.run('/mcp', { method: 'POST', body: '{}', headers: { authorization: 'Bearer oauth-token',
    cookie: 'secretcookie', host: 'evil.test', 'x-forwarded-host': 'evil.test', 'x-autodev-assertion': 'forged',
    'cf-access-client-secret': 'fake', 'proxy-authorization': 'fake', 'x-api-key': 'fake',
    'mcp-protocol-version': '2025-03-26', 'mcp-session-id': 'stale', accept: 'application/json', 'content-type': 'application/json' } });
  assert.equal(result.status, 200);
  assert.deepEqual(f.calls[0].plain.headers, [['accept', 'application/json'], ['content-type', 'application/json'],
    ['authorization', 'Bearer oauth-token'], ['mcp-protocol-version', '2025-03-26'], ['mcp-session-id', 'stale']]);
  assert.ok(!f.calls[0].init.body.includes('oauth-token'));
  const metadata = fixture();
  await metadata.run('/.well-known/oauth-protected-resource', { method: 'GET', headers: { authorization: `Bearer ${SECRET}` } });
  assert.deepEqual(metadata.calls[0].plain.headers, []);
});
test('rejects oversized or compressed request before any upstream operation', async () => {
  for (const init of [{ headers: { 'content-length': String(LIMITS.body + 1) }, body: 'x' },
    { headers: { 'content-encoding': 'gzip' }, body: 'x' }, { headers: { upgrade: 'websocket' }, body: 'x' },
    { body: 'x'.repeat(LIMITS.body + 1) }]) {
    const f = fixture(); const result = await f.run('/mcp', { method: 'POST', ...init });
    assert.ok([400, 413].includes(result.status)); assert.equal(f.calls.length, 0); assert.equal(f.gets.length, 0);
  }
  assert.equal((await fixture().update({ ...ROUTE, extra: 'x'.repeat(LIMITS.route) })).status, 413);
});
test('maximum 2MiB payload fits 3MiB plaintext and 4MiB wire', async () => {
  const f = fixture({ timeout: 5000 });
  assert.equal((await f.run('/mcp', { method: 'POST', body: 'x'.repeat(LIMITS.body) })).status, 200);
  assert.equal(Buffer.from(f.calls[0].plain.body, 'base64url').length, LIMITS.body);
  assert.ok(f.calls[0].init.body.length > 3 * 1024 * 1024);
  assert.ok(f.calls[0].init.body.length <= LIMITS.wire);
});
test('does not follow outer redirects, accept plaintext OAuth responses, compressed wire, or HTTP error pages', async () => {
  for (const reply of [() => new Response(null, { status: 302, headers: { location: 'https://evil.test' } }),
    () => new Response('private failure ' + SECRET, { status: 500 }), () => Response.json({ access_token: 'plaintext' }),
    ({ wire }) => new Response(JSON.stringify(seal(wire.id, responsePlain())), { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } })]) {
    const f = fixture({ reply }); await safe503(await f.run()); assert.equal(f.calls.length, 1);
  }
});
test('authenticates response key, direction, issuer, id, iv, schema and tag', async () => {
  for (const change of [({ wire }) => seal(wire.id, responsePlain(), { key: randomBytes(32) }),
    ({ wire }) => seal(wire.id, responsePlain(), { direction: 'request' }),
    ({ wire }) => seal(wire.id, responsePlain(), { issuer: 'https://evil.test' }),
    () => seal(randomBytes(16).toString('base64url'), responsePlain()),
    ({ wire }) => seal(wire.id, responsePlain(), { iv: Buffer.from(wire.iv, 'base64url') }),
    ({ wire }) => ({ ...seal(wire.id, responsePlain()), v: 2 }),
    ({ wire }) => ({ ...seal(wire.id, responsePlain()), extra: true }),
    ({ wire }) => ({ ...seal(wire.id, responsePlain()), data: 'invalid' }),
    ({ wire }) => ({ ...seal(wire.id, responsePlain()), iv: 'invalid' })]) {
    const f = fixture({ reply: args => Response.json(change(args)) }); await safe503(await f.run());
  }
});
test('rejects oversized wire, plaintext, decoded response body and invalid inner headers', async () => {
  for (const reply of [() => new Response('x', { headers: { 'content-type': 'application/json', 'content-length': String(LIMITS.wire + 1) } }),
    () => new Response('x'.repeat(LIMITS.wire + 1), { headers: { 'content-type': 'application/json' } }),
    ({ wire }) => Response.json(seal(wire.id, ' '.repeat(LIMITS.plain + 1))),
    ({ wire }) => Response.json(seal(wire.id, responsePlain('x'.repeat(LIMITS.body + 1)))),
    ({ wire }) => Response.json(seal(wire.id, responsePlain('{}', 200, [['content-type', 'application/json'], ['Content-Type', 'text/html']]))),
    ({ wire }) => Response.json(seal(wire.id, responsePlain('{}', 200, [['content-type', 'application/json'], ['x-bad', 'bad\r\nInjected: true']]))),
    ({ wire }) => Response.json(seal(wire.id, { status: 200, headers: [['content-type', 'application/json']], body: EMPTY + '=' }))]) {
    await safe503(await fixture({ reply, timeout: 5000 }).run());
  }
});
test('only passes local OAuth JSON/HTML headers, strips cookies, raw server identity and arbitrary redirects', async () => {
  const f = fixture({ reply: responsePlain('{"error":"invalid_token"}', 401, [['content-type', 'application/json'],
    ['www-authenticate', `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource"`],
    ['set-cookie', 'private=x'], ['server', 'upstream'], ['x-autodev-assertion', 'private'], ['cache-control', 'public,max-age=3600']]) });
  const result = await f.run(); assert.equal(result.status, 401);
  assert.ok(result.headers.get('www-authenticate').includes(ISSUER));
  for (const name of ['set-cookie', 'server', 'x-autodev-assertion']) assert.equal(result.headers.get(name), null);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(await result.text(), '{"error":"invalid_token"}');
  const html = fixture({ reply: responsePlain('<meta http-equiv="refresh" content="3;url=/oauth/result?request_id=a">', 200, [['content-type', 'text/html']]) });
  const htmlResult = await html.run('/oauth/authorize?state=s', { method: 'GET' });
  assert.equal(htmlResult.status, 200); assert.match(htmlResult.headers.get('content-security-policy'), /default-src 'none'/);
});
test('permits only authenticated exact ChatGPT OAuth result redirects', async () => {
  for (const path of ['/connector_platform_oauth_redirect', '/connector/oauth/valid_client-ID']) {
    for (const approved of [true, false]) {
      const url = new URL('https://chatgpt.com' + path);
      url.searchParams.set('state', 'user-state'); url.searchParams.set('iss', ISSUER);
      url.searchParams.set(approved ? 'code' : 'error', approved ? randomBytes(32).toString('base64url') : 'access_denied');
      const f = fixture({ reply: responsePlain('', 302, [['location', url.href]]) });
      const result = await f.run('/oauth/result?request_id=a', { method: 'GET' });
      assert.equal(result.status, 302); assert.equal(result.headers.get('location'), url.href); assert.equal(await result.text(), '');
    }
  }
});
test('rejects other redirects, mixed issuers, ambiguous parameters and wrong public path', async () => {
  const valid = new URL('https://chatgpt.com/connector_platform_oauth_redirect');
  valid.searchParams.set('state', 's'); valid.searchParams.set('iss', ISSUER); valid.searchParams.set('code', 'a'.repeat(43));
  for (const location of ['https://evil.test', '/oauth/result?request_id=x', valid.href.replace('chatgpt.com', 'chatgpt.com.evil.test'),
    valid.href + '&state=duplicate', valid.href + '&next=https://evil.test', valid.href.replace('state=s', 'state='),
    valid.href.replace(encodeURIComponent(ISSUER), encodeURIComponent('https://evil.test')), valid.href + '#x']) {
    await safe503(await fixture({ reply: responsePlain('', 302, [['location', location]]) }).run('/oauth/result?request_id=a', { method: 'GET' }));
  }
  await safe503(await fixture({ reply: responsePlain('', 302, [['location', valid.href]]) }).run());
  await safe503(await fixture({ reply: responsePlain('', 307, [['location', valid.href]]) }).run('/oauth/result?request_id=a', { method: 'GET' }));
});
test('passes discovery instance proof only for metadata with valid UUID', async () => {
  const instance = '12345678-1234-1234-1234-123456789abc';
  const reply = responsePlain('{}', 200, [['content-type', 'application/json'], ['X-AutoDev-Instance', instance]]);
  const metadata = await fixture({ reply }).run('/.well-known/oauth-protected-resource', { method: 'GET' });
  assert.equal(metadata.headers.get('x-autodev-instance'), instance);
  assert.equal((await fixture({ reply }).run()).headers.get('x-autodev-instance'), null);
  await safe503(await fixture({ reply: responsePlain('{}', 200, [['content-type', 'application/json'], ['x-autodev-instance', 'private-value']]) }).run('/.well-known/oauth-protected-resource', { method: 'GET' }));
});
test('handles JSON MCP notifications with empty 204 responses and local capacity failure', async () => {
  const response = await fixture({ reply: responsePlain('', 204, []) }).run();
  assert.equal(response.status, 204); assert.equal(await response.text(), '');
  await safe503(await fixture({ reply: responsePlain('unexpected', 204, []) }).run());
  await safe503(await fixture({ reply: responsePlain('{}', 429) }).run());
  await safe503(await fixture({ reply: responsePlain('{}', 503) }).run());
});
test('lease expires during dispatch and response is discarded', async () => {
  let current = NOW;
  const f = fixture({ now: () => current, reply: ({ wire }) => { current += LIMITS.maxLease + 1; return Response.json(seal(wire.id, responsePlain())); } });
  await safe503(await f.run());
});
test('fetch errors and deadline never disclose internal details or fall back', async () => {
  await safe503(await fixture({ fetchError: new Error('private ' + SECRET) }).run());
  const f = fixture({ timeout: 10, reply: () => new Promise(() => {}) });
  await safe503(await f.run());
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].init.signal.aborted, true);
});
test('hanging response and request streams are cancelled at deadline', async () => {
  let responseCancelled = false;
  const f = fixture({ timeout: 10, reply: () => new Response(new ReadableStream({ cancel() { responseCancelled = true; } }), { headers: { 'content-type': 'application/json' } }) });
  await safe503(await f.run()); assert.equal(responseCancelled, true);
  let requestCancelled = false;
  const request = new Request(ISSUER + '/mcp', { method: 'POST', body: new ReadableStream({ cancel() { requestCancelled = true; } }), duplex: 'half' });
  const g = fixture({ timeout: 10 });
  await safe503(await g.worker.fetch(request, g.env)); assert.equal(requestCancelled, true); assert.equal(g.calls.length, 0);
});
test('rechecks a lease after a delayed KV read, before dispatch or positive health', async () => {
  for (const path of ['/mcp', '/_autodev/health']) {
    let current = NOW;
    const f = fixture({ now: () => current });
    f.env.ROUTES.get = async () => { current += LIMITS.maxLease + 1; return JSON.stringify(ROUTE); };
    const result = await f.run(path, path.endsWith('health') ? { method: 'GET' } : {});
    if (path.endsWith('health')) assert.deepEqual(await result.json(), { ok: true, routeReady: false });
    else await safe503(result);
    assert.equal(f.calls.length, 0);
  }
});
test('maximum authenticated response body is accepted without exposing envelope headers', async () => {
  const result = await fixture({ reply: responsePlain('x'.repeat(LIMITS.body)), timeout: 5000 }).run();
  assert.equal(result.status, 200); assert.equal((await result.arrayBuffer()).byteLength, LIMITS.body);
});
test('registration request deadline is safe503, not malformed input success', async () => {
  let cancelled = false;
  const f = fixture({ timeout: 10 });
  const request = new Request(ISSUER + '/_autodev/route', { method: 'PUT', headers: {
    authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' }, duplex: 'half',
    body: new ReadableStream({ cancel() { cancelled = true; } }) });
  await safe503(await f.worker.fetch(request, f.env)); assert.equal(cancelled, true); assert.equal(f.puts.length, 0);
});
test('503 stage diagnostics are fixed labels without raw error, URL, body or credential data', async () => {
  const privateError = new Error(`private ${ORIGIN} ${SECRET} ${ROUTE.relayKey}`);
  for (const [options, expected] of [
    [{ kvError: privateError }, 'route_lookup'], [{ route: null }, 'route_lookup'],
    [{ fetchError: privateError }, 'relay_fetch'],
    [{ reply: () => new Response('private body', { status: 530 }) }, 'relay_http_530'],
    [{ reply: () => new Response(null, { status: 302, headers: { location: ORIGIN } }) }, 'relay_http_302'],
    [{ reply: () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }) }, 'relay_encoding'],
    [{ reply: () => new Response('private body', { headers: { 'content-type': 'text/html' } }) }, 'relay_content_type'],
    [{ reply: () => Response.json({ private: SECRET }) }, 'response_crypto'],
    [{ reply: ({ wire }) => Response.json(seal(wire.id, responsePlain(), { key: randomBytes(32) })) }, 'response_crypto'],
    [{ reply: responsePlain('{}', 503) }, 'public_response'],
  ]) {
    const response = await fixture(options).run();
    assert.equal(response.headers.get('x-autodev-failure'), expected);
    await safe503(response);
    const visible = JSON.stringify([...response.headers]);
    for (const secret of [ORIGIN, SECRET, ROUTE.relayKey, privateError.message]) assert.ok(!visible.includes(secret));
  }
  const f = fixture();
  const worker = createWorker({ now: () => NOW, crypto: { subtle: { importKey: async () => { throw privateError; } } },
    fetch: async () => { throw new Error('should not fetch'); } });
  const cryptoResponse = await worker.fetch(new Request(ISSUER + '/mcp', { method: 'POST', body: '{}' }), f.env);
  assert.equal(cryptoResponse.headers.get('x-autodev-failure'), 'request_crypto'); await safe503(cryptoResponse);
  const writeResponse = await fixture({ kvError: privateError }).update();
  assert.equal(writeResponse.headers.get('x-autodev-failure'), 'route_write'); await safe503(writeResponse);
});
test('diagnostic trace belongs to each concurrent request and cannot be spoofed by upstream', async () => {
  const f = fixture({ reply: async ({ wire, plain }) => {
    if (plain.path === '/oauth/register') {
      await new Promise(resolve => setTimeout(resolve, 15));
      return Response.json(seal(wire.id, responsePlain('{}', 503)));
    }
    return new Response('{}', { status: 502, headers: { 'x-autodev-failure': SECRET } });
  } });
  const [publicFailure, httpFailure] = await Promise.all([f.run('/oauth/register', { method: 'POST', body: '{}' }), f.run()]);
  assert.equal(publicFailure.headers.get('x-autodev-failure'), 'public_response');
  assert.equal(httpFailure.headers.get('x-autodev-failure'), 'relay_http_502');
  const success = await fixture({ reply: responsePlain('{}', 200, [['content-type', 'application/json'], ['x-autodev-failure', SECRET]]) }).run();
  assert.equal(success.status, 200); assert.equal(success.headers.get('x-autodev-failure'), null);
  assert.equal((await fixture().run('/admin')).headers.get('x-autodev-failure'), null);
});
test('default fetch retains its global runtime receiver while injected fetch remains supported', async () => {
  const original = globalThis.fetch;
  let defaultCalls = 0;
  try {
    globalThis.fetch = async function (url, init) {
      // Cloudflare WebIDL requires the global receiver; a detached deps.fetch fails.
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      assert.equal(url, ORIGIN + '/_autodev/relay');
      const wire = JSON.parse(init.body);
      assert.equal(open(wire).path, '/mcp');
      defaultCalls++;
      return Response.json(seal(wire.id, responsePlain('{"receiver":"global"}')));
    };
    const f = fixture();
    const worker = createWorker({ now: () => NOW, crypto: webcrypto });
    const result = await worker.fetch(new Request(ISSUER + '/mcp', { method: 'POST', body: '{}' }), f.env);
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { receiver: 'global' });
    assert.equal(defaultCalls, 1);
    assert.equal(f.calls.length, 0);
    const injectedResult = await f.run();
    assert.equal(injectedResult.status, 200);
    assert.equal(f.calls.length, 1);
    assert.equal(defaultCalls, 1);
  } finally { globalThis.fetch = original; }
});
