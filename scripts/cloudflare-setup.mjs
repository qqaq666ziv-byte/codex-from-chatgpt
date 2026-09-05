import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { product, wrangler } from './cloudflare-cli.mjs';
import { acquireRuntimeLock } from '../dist/src/runtime-lock.js';
import { processIdentity } from '../dist/src/secure-process.js';
import { configuredFixedTunnel, fixedOriginSchema, saveRouteSecret } from '../dist/src/fixed-tunnel.js';
import { noChargeSafeguards } from '../dist/src/cost-policy.js';

const runtime = path.join(product, '.runtime');
const recordPath = path.join(runtime, 'cloudflare-deployment.json');
const configPath = path.join(runtime, 'cloudflare-worker.json');
const fence = path.join(runtime, 'fixed-deploy-incomplete.json');
class SetupError extends Error {}
let phase = 'local preflight';
function atomic(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  renameSync(temporary, file);
}
async function accepted(args, description, options) {
  const result = await wrangler(args, options);
  if (result.code !== 0 || result.timedOut || result.outputTruncated) {
    const code = (result.stdout + result.stderr).match(/\[code:\s*(\d+)\]/)?.[1];
    throw new SetupError(`${description} failed${code ? ` (Cloudflare code ${code})` : ''}. Deployment remains stopped; no paid fallback was requested.`);
  }
  return result.stdout;
}
async function configure(input) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(product, 'dist/src/fixed-tunnel-runner.js'), 'configure'],
      { cwd: product, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    child.once('error', () => reject(new Error('Local fixed configuration could not start.')));
    child.once('close', code => code === 0 ? resolve() : reject(new Error('Local fixed configuration was rejected.')));
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(input));
  });
}

async function main() {
  if (process.argv[2] !== '--confirmed-workers-free') throw new Error('COST_UNVERIFIED: first verify the selected account is Workers Free, with all six no-charge safeguards.');
  const deployLease = path.join(runtime, 'cloudflare-deploy-lease'); mkdirSync(deployLease, { recursive: true });
  const release = await acquireRuntimeLock(deployLease);
  try {
    const fixedLease = path.join(runtime, 'fixed-gateway-lease'); mkdirSync(fixedLease, { recursive: true });
    const stopRelease = await acquireRuntimeLock(fixedLease);
    try {
      const processFile = path.join(runtime, 'fixed-gateway-process.json');
      if (existsSync(processFile)) {
        const record = JSON.parse(readFileSync(processFile, 'utf8'));
        if (processIdentity(record.pid) || processIdentity(record.childPid)) throw new Error('Stop the fixed connection before deployment. Uncertain ownership is preserved.');
      }
      atomic(fence, { schemaVersion: 1, status: 'incomplete' });
    } finally { stopRelease(); }

    phase = 'Cloudflare account selection';
    const info = JSON.parse(await accepted(['whoami', '--json'], 'Cloudflare authentication'));
    if (!Array.isArray(info.accounts) || info.accounts.length !== 1 || !/^[a-f0-9]{32}$/.test(info.accounts[0].id)) {
      throw new Error('Select one unambiguous authorized Cloudflare account before deployment.');
    }
    const accountId = info.accounts[0].id;
    let record = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, 'utf8')) : undefined;
    if (record && (record.schemaVersion !== 1 || record.accountId !== accountId || !/^autodev-fixed-[a-f0-9]{8}$/.test(record.name))) throw new Error('Saved Cloudflare deployment identity does not match the selected account.');
    if (!record) {
      const name = `autodev-fixed-${randomBytes(4).toString('hex')}`;
      record = { schemaVersion: 1, accountId, name, namespaceTitle: `${name}-routes` };
      atomic(recordPath, record);
    }
    const workerConfig = () => ({
      name: record.name, account_id: accountId, main: path.join(product, 'edge/worker.mjs'),
      compatibility_date: '2026-09-05', workers_dev: true, preview_urls: false,
      send_metrics: false, observability: { enabled: false },
      kv_namespaces: record.namespaceId ? [{ binding: 'ROUTES', id: record.namespaceId }] : [],
    });
    atomic(configPath, workerConfig());
    if (!record.namespaceId) {
      const namespaces = JSON.parse(await accepted(['kv', 'namespace', 'list', '--config', configPath], 'KV namespace lookup'));
      const existing = namespaces.filter(item => item.title === record.namespaceTitle);
      if (existing.length > 1) throw new Error('Ambiguous deployment namespace. No namespace was changed.');
      if (existing.length === 1) record.namespaceId = existing[0].id;
      else {
        const output = await accepted(['kv', 'namespace', 'create', record.namespaceTitle, '--config', configPath, '--update-config', 'false'], 'Free KV namespace creation');
        record.namespaceId = output.match(/"id"\s*:\s*"([a-f0-9]{32})"/)?.[1];
      }
      if (!/^[a-f0-9]{32}$/.test(record.namespaceId)) throw new Error('KV namespace identity was not confirmed. Retry the same saved deployment.');
      atomic(recordPath, record); atomic(configPath, workerConfig());
    }
    phase = 'Worker deployment';
    await accepted(['deploy', '--config', configPath, '--dry-run', '--autoconfig', 'false'], 'Worker compilation');
    const deployed = await accepted(['deploy', '--config', configPath, '--autoconfig', 'false'], 'Free Worker deployment');
    const origin = fixedOriginSchema.parse(deployed.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/)?.[0]);
    if (record.origin && record.origin !== origin) throw new Error('Fixed origin changed unexpectedly. The existing local identity was preserved.');
    record.origin = origin; atomic(recordPath, record);
    const evidence = { evidenceUrl: 'https://developers.cloudflare.com/workers/platform/pricing/',
      basis: 'free-tier', accountPlanConfirmed: true, safeguards: noChargeSafeguards() };
    configuredFixedTunnel(origin, evidence);
    phase = 'local fixed configuration';
    await configure({ origin, evidence });
    let secret = randomBytes(32).toString('base64url');
    try {
      phase = 'local DPAPI route secret';
      await saveRouteSecret(runtime, secret);
      phase = 'Worker route secret provisioning';
      await accepted(['secret', 'put', 'ROUTE_SECRET', '--config', configPath], 'Worker route secret provisioning', { input: secret });
    } finally { secret = ''; }
    phase = 'public Worker health';
    let healthy = false;
    const healthDeadline = Date.now() + 90_000;
    while (Date.now() < healthDeadline) {
      try {
        const health = await fetch(`${origin}/_autodev/health`, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
        const status = await health.json();
        healthy = health.status === 200 && status.ok === true && typeof status.routeReady === 'boolean';
        if (healthy) break;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (!healthy) throw new SetupError('Deployed Worker health was not confirmed within 90 seconds; retry this saved deployment after checking free quota.');
    unlinkSync(fence);
    console.log('Free fixed Worker and KV deployed. Route secret is provisioned to Worker and local DPAPI; account credentials remain in private CLI storage.');
    console.log('No tunnel was started. Run fixed-tunnel.ps1 setup, then start and verify the existing App separately.');
  } finally { release(); }
}
main().catch(error => { console.error(error instanceof SetupError ? error.message : `Cloudflare setup stopped during ${phase}. The fixed connection remains stopped; original state was preserved.`); process.exitCode = 1; });
