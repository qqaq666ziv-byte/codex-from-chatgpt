import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { configuredTunnel, assertActivationAllowed, tunnelArguments, tunnelEnvironment, tunnelReadiness, lastSuccessfulPoll, verifyArchive } from '../src/secure-tunnel.js';
import { matchesProcess, type OwnedProcess } from '../src/secure-process.js';
import { assertCurrentCostEvidence, noChargeSafeguards } from '../src/cost-policy.js';

const tunnelId = 'tunnel_' + 'a'.repeat(32);
const runtime = path.resolve('.local-tests/synthetic tunnel 中文/.runtime');
const evidence = 'https://help.openai.com/en/articles/synthetic-cost-evidence';

test('Secure Tunnel remains disabled until explicit operator cost evidence; the key is not a model fallback', () => {
  const pending = configuredTunnel(tunnelId, 8796);
  assert.throws(() => assertActivationAllowed(pending), /COST_UNVERIFIED/);
  assert.throws(() => tunnelArguments(pending, runtime, 8792), /COST_UNVERIFIED/);
  assert.throws(() => configuredTunnel(tunnelId, 8796, evidence), /both/);
  assert.throws(() => configuredTunnel(tunnelId, 8796, undefined, true), /both/);
  assert.throws(() => configuredTunnel(tunnelId, 8796, 'https://example.com/free', true));
  assert.throws(() => configuredTunnel(tunnelId, 8796, 'https://platform.openai.com/keys?token=private', true));
  assert.throws(() => configuredTunnel(tunnelId, 65535));
  const approved = configuredTunnel(tunnelId, 8796, evidence, true);
  const args = tunnelArguments(approved, runtime, 8792);
  assert.equal(args[args.indexOf('--control-plane.tunnel-id') + 1], tunnelId);
  assert.equal(args[args.indexOf('--control-plane.api-key') + 1], 'env:CONTROL_PLANE_API_KEY');
  assert.equal(args[args.indexOf('--mcp.server-url') + 1], 'http://127.0.0.1:8792/mcp');
  assert.ok(args.includes('--log.http-raw-unsafe=false'));
  assert.equal(args.some(a => a.includes('admin-token')), false);
  assert.throws(() => tunnelArguments(approved, runtime, 8796));
});

test('isolated native environment excludes every inherited provider key and unsafe profile option', () => {
  const key = 'sk-synthetic-' + 'a'.repeat(24);
  const env = tunnelEnvironment({ PATH: 'synthetic path', SystemRoot: 'C:\\Windows', OPENAI_API_KEY: 'must-not-inherit', OPENAI_ADMIN_KEY: 'must-not-inherit', MCP_EXTRA_HEADERS: 'unsafe', LOG_HTTP_RAW_UNSAFE: 'true', TUNNEL_CLIENT_PROFILE: 'private-profile', HTTPS_PROXY: 'private-proxy' }, runtime, key);
  assert.deepEqual(Object.keys(env).sort(), ['CONTROL_PLANE_API_KEY', 'PATH', 'SystemRoot', 'TUNNEL_CLIENT_PROFILE_DIR', 'TUNNEL_CLIENT_STATE_DIR'].sort());
  assert.equal(env.CONTROL_PLANE_API_KEY, key);
  assert.equal(env.TUNNEL_CLIENT_STATE_DIR, path.join(runtime, 'secure-tunnel-state'));
  assert.throws(() => tunnelEnvironment({}, runtime, 'invalid\nsecret'));
});

test('free tiers and credits are eligible without a permanently free service, but all six safeguards are required', () => {
  const tier = configuredTunnel(tunnelId, 8796, evidence, true, 'free-tier');
  assert.doesNotThrow(() => assertActivationAllowed(tier));
  const expires = new Date(Date.now() + 3600_000).toISOString();
  const credit = configuredTunnel(tunnelId, 8796, evidence, true, 'free-credits', expires);
  assert.doesNotThrow(() => assertActivationAllowed(credit));
  assert.throws(() => configuredTunnel(tunnelId, 8796, evidence, true, 'free-credits'), /COST_UNVERIFIED/);
  assert.throws(() => configuredTunnel(tunnelId, 8796, evidence, true, 'free-credits', '2020-01-01T00:00:00.000Z'), /expired/);
  const safe = noChargeSafeguards();
  for (const field of ['newPaymentMethodRequired', 'automaticCharges', 'automaticPaidUpgrade', 'autoRecharge', 'purchases'] as const) {
    assert.throws(() => assertCurrentCostEvidence('free-tier', { ...safe, [field]: true }));
  }
  assert.throws(() => assertCurrentCostEvidence('free-tier', { ...safe, quotaExhaustion: 'bill-overage' }));
  assert.throws(() => assertCurrentCostEvidence('free-credits', safe, expires, Date.parse(expires)), /expired/);
  // Old bare approval is not sufficient evidence for the newly explicit terms.
  assert.throws(() => assertCurrentCostEvidence('free-tier', undefined));
});

test('local green probes do not claim remote polling, ChatGPT E2E or fixed-entry completion', () => {
  const green = tunnelReadiness(true, true, 'direct');
  assert.equal(green.ready_for_chatgpt_probe, false);
  assert.equal(green.successful_remote_poll, 'not_verified');
  assert.equal(green.chatgpt_e2e, 'not_verified');
  assert.equal(green.fixed_entry_ready, false);
  assert.equal(tunnelReadiness(true, false, 'direct').ready_for_chatgpt_probe, false);
  assert.equal(tunnelReadiness(true, true, 'unknown').ready_for_chatgpt_probe, false);
  assert.equal(tunnelReadiness(true, true, 'direct', true).ready_for_chatgpt_probe, true);
});

test('only a recent successful poll from this start satisfies the native connectivity probe', () => {
  const now = 2_000_000;
  const metric = (n: number) => `commands_poll_last_successful_timestamp_seconds{tunnel_id="synthetic"} ${n}\n`;
  assert.equal(lastSuccessfulPoll(metric(1999), now - 5000, now), true);
  assert.equal(lastSuccessfulPoll(metric(0), now - 5000, now), false);
  assert.equal(lastSuccessfulPoll(metric(1900), now - 5000, now), false);
  assert.equal(lastSuccessfulPoll(metric(2010), now - 5000, now), false);
  assert.equal(lastSuccessfulPoll('unrelated_metric 2000', now - 5000, now), false);
});

test('corrupted official archive never passes verification', () => {
  assert.throws(() => verifyArchive(Buffer.from('synthetic corrupted archive')), /checksum mismatch/);
});

test('supervisor identity rejects PID reuse, wrong executable, foreign workspace and wrong instance', () => {
  const entry = path.resolve('dist/src/secure-tunnel-runner.js');
  const record: OwnedProcess = { pid: 100, created: 'synthetic-created-time', executable: process.execPath, entry, instance: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };
  const current = { created: record.created, executable: process.execPath, command: `"${process.execPath}" "${entry}" run --autodev-secure-instance=${record.instance}` };
  assert.equal(matchesProcess(record, current, entry), true);
  assert.equal(matchesProcess(record, { ...current, created: 'later-process' }, entry), false);
  assert.equal(matchesProcess(record, { ...current, executable: 'different.exe' }, entry), false);
  assert.equal(matchesProcess(record, { ...current, command: 'unrelated work' }, entry), false);
  assert.equal(matchesProcess(record, current, path.resolve('another-checkout/dist/src/secure-tunnel-runner.js')), false);
  assert.equal(matchesProcess({ ...record, instance: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }, current, entry), false);
});
