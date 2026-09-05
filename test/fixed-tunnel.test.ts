import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { noChargeSafeguards } from '../src/cost-policy.js';
import { assertFixedActivation, assertRouteCredential, boundedJson, configuredFixedTunnel, fixedAgentConfig, fixedArguments, fixedConfigSchema, fixedEnvironment, fixedExternalMetadata, publishRoute, quickTunnelOrigin, routeExpiry, routeLeaseClock, verifyFixedBinary } from '../src/fixed-tunnel.js';

const origin = 'https://synthetic-autodev.synthetic-account.workers.dev';
const quick = 'https://synthetic-internal.trycloudflare.com';
const evidence = () => ({ evidenceUrl: 'https://developers.cloudflare.com/workers/platform/pricing/', basis: 'free-tier', accountPlanConfirmed: true, safeguards: noChargeSafeguards() });
const confirmed = () => configuredFixedTunnel(origin, evidence());

test('fixed Cloudflare candidate defaults to unverified and accepts only exact workers.dev origins', () => {
  const config = configuredFixedTunnel(origin);
  assert.equal(config.cost.status, 'unverified');
  assert.throws(() => assertFixedActivation(config), /COST_UNVERIFIED/);
  assert.throws(() => fixedArguments(config, 'C:\\synthetic'), /COST_UNVERIFIED/);
  for (const invalid of ['http://synthetic.account.workers.dev', 'https://synthetic.workers.dev', 'https://synthetic.example.com', `${origin}/`, `${origin}:443`, `${origin}/mcp`, `${origin}?token=synthetic`, `${origin}#fragment`, 'https://user:secret@synthetic.account.workers.dev', 'https://-invalid.account.workers.dev', `${origin}.evil.example`]) assert.equal(fixedConfigSchema.safeParse({ ...config, origin: invalid }).success, false);
});

test('free service, quota and credits require account evidence, six safeguards and applicable expiry', () => {
  assert.doesNotThrow(() => assertFixedActivation(confirmed()));
  for (const basis of ['free-service', 'free-tier']) assert.doesNotThrow(() => configuredFixedTunnel(origin, { ...evidence(), basis }));
  assert.throws(() => configuredFixedTunnel(origin, { ...evidence(), basis: 'free-credits' }), /expiry/);
  const expiry = new Date(Date.now() + 300000).toISOString();
  const credits = configuredFixedTunnel(origin, { ...evidence(), basis: 'free-credits', expiresAt: expiry });
  assert.equal(routeExpiry(credits), Date.parse(expiry));
  assert.throws(() => assertFixedActivation(credits, Date.parse(expiry)), /expired/);
  for (const changed of [{ accountPlanConfirmed: false }, { evidenceUrl: 'https://example.com/claims-free' }, { evidenceUrl: 'https://developers.cloudflare.com/docs?private=synthetic' }]) assert.throws(() => configuredFixedTunnel(origin, { ...evidence(), ...changed }));
  for (const name of Object.keys(noChargeSafeguards())) assert.throws(() => configuredFixedTunnel(origin, { ...evidence(), safeguards: { ...noChargeSafeguards(), [name]: name === 'quotaExhaustion' ? 'bill' : true } }));
});

test('cloudflared receives no provider, relay or model credentials and uses the explicit owned metrics port', () => {
  const env = fixedEnvironment({ SystemRoot: 'C:\\Windows', TEMP: 'C:\\synthetic', TUNNEL_TOKEN: 'synthetic-provider', CLOUDFLARE_API_TOKEN: 'synthetic-admin', OPENAI_API_KEY: 'synthetic-model', ROUTE_SECRET: 'synthetic-route', RELAY_KEY: 'synthetic-relay', HOME: 'C:\\private-profile', USERPROFILE: 'C:\\private-profile', HTTPS_PROXY: 'http://synthetic-secret-proxy' });
  assert.deepEqual(Object.keys(env).sort(), ['SystemRoot', 'TEMP']);
  assertRouteCredential('a'.repeat(43));
  for (const invalid of ['', 'short', 'a'.repeat(42), 'a'.repeat(513), 'a'.repeat(44) + '\n']) assert.throws(() => assertRouteCredential(invalid));
  const args = fixedArguments(confirmed(), 'C:\\synthetic 中文');
  assert.deepEqual(args, ['tunnel', '--config', path.join('C:\\synthetic 中文', 'fixed-cloudflared.yml'), '--url', 'http://127.0.0.1:8798', '--no-autoupdate', '--protocol', 'http2', '--http-host-header', '127.0.0.1:8798', '--metrics', '127.0.0.1:8800', '--loglevel', 'error']);
  assert.equal(args.join(' ').includes(origin), false);
  assert.equal(fixedAgentConfig(), 'no-autoupdate: true\n');
  assert.throws(() => verifyFixedBinary(Buffer.from('synthetic-invalid-binary')), /checksum mismatch/);
});

test('route credentials match the Worker format and invalid values never reach its control endpoint', async () => {
  for (const secret of ['a'.repeat(43), 'A0_-'.repeat(32)]) assert.doesNotThrow(() => assertRouteCredential(secret));
  let calls = 0;
  const transport = (async () => { calls++; return Response.json({ ok: true }); }) as typeof fetch;
  for (const secret of ['a'.repeat(129), 'a'.repeat(512), 'a'.repeat(42) + '+', 'a'.repeat(42) + '/', 'a'.repeat(43) + '=']) {
    assert.throws(() => assertRouteCredential(secret), /43 to 128 base64url/);
    await assert.rejects(publishRoute(confirmed(), quick, secret, Buffer.alloc(32, 7), transport), /43 to 128 base64url/);
  }
  assert.equal(calls, 0);
});

test('quicktunnel metadata cannot introduce arbitrary URLs and public metadata preserves the fixed issuer', async () => {
  assert.equal(quickTunnelOrigin({ hostname: 'synthetic-internal.trycloudflare.com' }), quick);
  assert.equal(quickTunnelOrigin({ hostname: quick }), quick);
  for (const hostname of ['http://synthetic.trycloudflare.com', 'synthetic.trycloudflare.com.evil.example', '127.0.0.1', 'user:secret@synthetic.trycloudflare.com', 'synthetic.trycloudflare.com/mcp']) assert.equal(quickTunnelOrigin({ hostname }), undefined);
  assert.equal(quickTunnelOrigin(null), undefined);
  const metadata = { issuer: origin, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token` };
  assert.equal(fixedExternalMetadata(metadata, origin), true);
  assert.equal(fixedExternalMetadata({ ...metadata, issuer: quick }, origin), false);
  assert.equal(fixedExternalMetadata('<html>error</html>', origin), false);
  assert.deepEqual(await boundedJson(new Response(JSON.stringify({ hostname: 'synthetic.trycloudflare.com' })), false), { hostname: 'synthetic.trycloudflare.com' });
  await assert.rejects(boundedJson(new Response('x'.repeat(131073)), false), /too large/);
});

test('route publication binds a fresh relay key, exact lease acknowledgement and no redirects or paid fallback', async () => {
  const secret = 's'.repeat(43), relayKey = Buffer.alloc(32, 7), now = Date.now();
  let calls = 0;
  const transport = (async (url: string | URL | Request, init?: RequestInit) => {
    calls++; assert.equal(url, `${origin}/_autodev/route`); assert.equal(init?.method, 'PUT'); assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${secret}`);
    const body = JSON.parse(init?.body as string); assert.equal(body.origin, quick); assert.equal(body.relayKey, relayKey.toString('base64url')); assert.equal(body.expiresAt, new Date(now + 3600000).toISOString());
    return Response.json({ ok: true, expiresAt: body.expiresAt });
  }) as typeof fetch;
  assert.equal(await publishRoute(confirmed(), quick, secret, relayKey, transport, now), now + 3600000);
  assert.equal(calls, 1);
  await assert.rejects(publishRoute(configuredFixedTunnel(origin), quick, secret, relayKey, transport), /COST_UNVERIFIED/);
  assert.equal(calls, 1);
  await assert.rejects(publishRoute(confirmed(), quick, secret, relayKey, async () => Response.json({ ok: true, expiresAt: 'stale' })), /acknowledgement/);
  await assert.rejects(publishRoute(confirmed(), quick, secret, relayKey, async () => new Response(null, { status: 429 })), /FREE_QUOTA_BLOCKED/);
  await assert.rejects(publishRoute(confirmed(), quick, secret, Buffer.alloc(31), transport), /32 random bytes/);
});

function fakeTimers() {
  let now = 0, id = 0; const pending = new Map<number, { at: number; callback: () => void }>();
  const timers = { setTimeout: ((callback: () => void, delay: number) => { const key = ++id; pending.set(key, { at: now + delay, callback }); return key; }) as unknown as typeof setTimeout, clearTimeout: ((key: number) => { pending.delete(key); }) as unknown as typeof clearTimeout };
  return { timers, now: () => now, async advance(milliseconds: number) { const target = now + milliseconds; while (true) { const item = [...pending].sort((a, b) => a[1].at - b[1].at).find(([, value]) => value.at <= target); if (!item) break; now = item[1].at; pending.delete(item[0]); item[1].callback(); await Promise.resolve(); await Promise.resolve(); } now = target; await Promise.resolve(); await Promise.resolve(); } };
}
test('a stuck renewal cannot postpone expiration and a late acknowledgement cannot revive a stopped lease', async () => {
  const fake = fakeTimers(); let expired = 0, renewals = 0, finish!: () => void;
  const lease = routeLeaseClock(() => { expired++; }, async () => { renewals++; await new Promise<void>(resolve => { finish = resolve; }); lease.arm(fake.now() + 3600000); }, fake.now, fake.timers);
  lease.arm(3600000);
  await fake.advance(1200000); assert.equal(renewals, 1); assert.equal(expired, 0);
  await fake.advance(2400000); assert.equal(expired, 1);
  finish(); await Promise.resolve(); await Promise.resolve(); await fake.advance(7200000);
  assert.equal(renewals, 1); assert.equal(expired, 1);
});
test('failed renewal expires immediately and explicit close cancels every scheduled callback', async () => {
  const fake = fakeTimers(); let expired = 0;
  const lease = routeLeaseClock(() => { expired++; }, async () => { throw new Error('synthetic outage'); }, fake.now, fake.timers);
  lease.arm(3600000); await fake.advance(1200000); assert.equal(expired, 1);
  const closed = routeLeaseClock(() => { expired++; }, async () => { throw new Error('must not run'); }, fake.now, fake.timers);
  closed.arm(fake.now() + 3600000); closed.stop(); await fake.advance(7200000); assert.equal(expired, 1);
});
