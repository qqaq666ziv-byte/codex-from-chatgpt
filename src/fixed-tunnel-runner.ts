import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway } from './gateway.js';
import { loadLocalConfig, readLocalToken } from './local-config.js';
import { acquireRuntimeLock } from './runtime-lock.js';
import { processIdentity, type OwnedProcess } from './secure-process.js';
import { startWindowsJob, type WindowsJob } from './windows-job.js';
import { assertFixedActivation, assertRouteCredential, boundedJson, configuredFixedTunnel, fixedAgentConfig, fixedArguments, fixedEnvironment, fixedExternalMetadata, fixedPorts, fixedRelease, loadFixedConfig, publishRoute, quickTunnelOrigin, routeLeaseClock, verifyFixedBinary, type FixedConfig } from './fixed-tunnel.js';

const entry = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(entry), '../..');
const runtime = path.join(root, '.runtime');
const configFile = path.join(runtime, 'fixed-tunnel.json');
const recordFile = path.join(runtime, 'fixed-gateway-process.json');
const binary = path.join(root, '.tools', 'cloudflared-2026.8.2.exe');
const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
type ManagedRecord = OwnedProcess & { schemaVersion: 1; publicPort: 8798; controlPort: 8799; nativeAdminPort: 8800; childPid: number; childCreated: string; shutdownConfirmed: boolean; startupConfirmed?: boolean; routeExpiresAt?: string; failure?: 'native_exit' | 'shutdown_unconfirmed' | 'route_lease_expired' };
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function atomic(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); renameSync(temporary, file);
}
function record(): ManagedRecord | undefined {
  if (!existsSync(recordFile)) return;
  if (lstatSync(recordFile).isSymbolicLink()) throw new Error('Managed fixed gateway record must not be a link.');
  const value = JSON.parse(readFileSync(recordFile, 'utf8')) as ManagedRecord;
  if (value.schemaVersion !== 1 || value.publicPort !== fixedPorts.publicPort || value.controlPort !== fixedPorts.controlPort || value.nativeAdminPort !== fixedPorts.nativeAdminPort ||
    typeof value.created !== 'string' || typeof value.childCreated !== 'string' || !Number.isSafeInteger(value.childPid) || value.childPid <= 0) throw new Error('Invalid managed fixed gateway record.');
  return value;
}
function owned(previous: ManagedRecord) {
  const current = processIdentity(previous.pid);
  if (!current) return null;
  if (!/^[a-f0-9-]{36}$/.test(previous.instance) || path.resolve(previous.entry) !== entry || previous.executable.toLowerCase() !== process.execPath.toLowerCase() ||
    current.executable.toLowerCase() !== previous.executable.toLowerCase() || current.created !== previous.created ||
    !current.command.includes(entry) || !current.command.includes(`--autodev-fixed-instance=${previous.instance}`)) throw new Error('PROCESS_IDENTITY_MISMATCH: no fixed gateway process was changed.');
  return current;
}
function nativeOwned(previous: ManagedRecord) {
  const current = processIdentity(previous.childPid);
  if (!current || current.created !== previous.childCreated) return false;
  if (current.executable.toLowerCase() !== binary.toLowerCase()) throw new Error('Native fixed gateway identity mismatch. No process was changed.');
  return true;
}
function assertStopped() {
  const previous = record();
  if (previous && (owned(previous) || nativeOwned(previous))) throw new Error('Stop the owned fixed gateway before changing its installation, configuration or credential.');
}
async function lease() {
  const directory = path.join(runtime, 'fixed-gateway-lease'); mkdirSync(directory, { recursive: true });
  return acquireRuntimeLock(directory);
}
function verifyBinary(file = binary) {
  if (lstatSync(file).isSymbolicLink()) throw new Error('Pinned native executable must not be a link.');
  verifyFixedBinary(readFileSync(file));
}
async function setup() {
  assertStopped();
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Pinned cloudflared installation requires Windows x64.');
  if (existsSync(binary)) { verifyBinary(); return; }
  const tools = path.join(root, '.tools'); mkdirSync(tools, { recursive: true });
  if (lstatSync(tools).isSymbolicLink()) throw new Error('Tools directory must be physical.');
  const response = await fetch(fixedRelease.url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error('Official cloudflared download failed.');
  const bytes = Buffer.from(await response.arrayBuffer()); verifyFixedBinary(bytes);
  const stage = `${binary}.install-${randomUUID()}`; writeFileSync(stage, bytes, { flag: 'wx' }); renameSync(stage, binary);
}
function decryptKey() {
  const file = path.join(runtime, 'fixed-tunnel-key.dpapi');
  if (lstatSync(file).isSymbolicLink()) throw new Error('Credential must not be a link.');
  const script = "$ErrorActionPreference='Stop';$s=[IO.File]::ReadAllText($env:AUTODEV_KEY_FILE)|ConvertTo-SecureString;$p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s);try{[Console]::Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p))}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p);$s.Dispose()}";
  return execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...fixedEnvironment(process.env), AUTODEV_KEY_FILE: file }, encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim();
}
async function gatewayStatus(previous: ManagedRecord) {
  const response = await fetch(`http://127.0.0.1:${previous.controlPort}/status`, { headers: { Authorization: `Bearer ${readLocalToken(runtime, 'admin')}` }, signal: AbortSignal.timeout(5000), redirect: 'error' });
  const value = await boundedJson(response) as { process_id?: number; instance_id?: string; issuer?: string; pending?: unknown[] } | null;
  if (value?.process_id !== previous.pid || value.instance_id !== previous.instance) throw new Error('Fixed gateway HTTP identity mismatch.');
  return value;
}
async function status(previous: ManagedRecord, config: FixedConfig) {
  const control = await gatewayStatus(previous);
  if (control.issuer !== config.origin) throw new Error('Fixed gateway issuer mismatch.');
  let nativeReady = false, external = false, coreReady = false, workerReady = false;
  const nativeRunning = nativeOwned(previous);
  const core = loadLocalConfig(path.join(runtime, 'config.json'));
  try { const response = await fetch(`http://127.0.0.1:${core.port}/readyz`, { signal: AbortSignal.timeout(2000) }); coreReady = response.ok; await response.body?.cancel(); } catch { /* fixed state only */ }
  if (nativeRunning) {
    try {
      const response = await fetch(`http://127.0.0.1:${fixedPorts.nativeAdminPort}/ready`, { signal: AbortSignal.timeout(3000), redirect: 'error' }); nativeReady = response.ok; await response.body?.cancel();
    } catch { /* Raw native diagnostics are never returned. */ }
  }
  const leaseValid = Boolean(previous.routeExpiresAt && Date.parse(previous.routeExpiresAt) > Date.now());
  if (nativeReady && leaseValid) {
    assertFixedActivation(config);
    try {
      const response = await fetch(`${config.origin}/_autodev/health`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
      const health = await boundedJson(response) as { ok?: unknown; routeReady?: unknown } | null; workerReady = health?.ok === true && health.routeReady === true;
      external = await externalProbe(config, previous.instance);
    } catch { /* Worker health alone cannot establish this run's relay route. */ }
  }
  return { process_running: true, native_process_running: nativeRunning, native_ready: nativeReady, core_ready: coreReady, worker_route_ready: workerReady, route_lease_valid: leaseValid, external_metadata_ready: external,
    blocked: previous.failure ?? (!leaseValid ? 'route_lease_expired' : null), pending_approval_count: Array.isArray(control.pending) ? control.pending.length : 0,
    ready_for_chatgpt_probe: nativeRunning && nativeReady && leaseValid && coreReady && external && !previous.failure,
    chatgpt_e2e: 'not_verified', cost_status: config.cost.status, paid_fallback: false };
}
async function externalProbe(config: FixedConfig, instance: string) {
  const response = await fetch(`${config.origin}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(8000), redirect: 'error', headers: { Accept: 'application/json', 'User-Agent': 'AutoDev-FixedProbe/1.0' } });
  const sameInstance = response.headers.get('x-autodev-instance') === instance;
  return fixedExternalMetadata(await boundedJson(response), config.origin) && sameInstance;
}
async function run() {
  const release = await lease();
  try {
    if (existsSync(path.join(runtime, 'fixed-deploy-incomplete.json'))) throw new Error('DEPLOYMENT_INCOMPLETE: repair the Worker deployment before starting the fixed gateway. No credential was read.');
    const config = loadFixedConfig(runtime); assertFixedActivation(config); assertStopped(); verifyBinary();
    const core = loadLocalConfig(path.join(runtime, 'config.json'));
    if (Object.values(fixedPorts).includes(core.port as 8798)) throw new Error('Fixed gateway ports conflict with the core.');
    const coreHealth = await fetch(`http://127.0.0.1:${core.port}/readyz`, { signal: AbortSignal.timeout(5000) });
    if (!coreHealth.ok) throw new Error('Start and diagnose the AutoDev core before the fixed gateway.'); await coreHealth.body?.cancel();
    const instance = process.argv.find(arg => arg.startsWith('--autodev-fixed-instance='))?.split('=')[1];
    if (!instance || !/^[a-f0-9-]{36}$/.test(instance)) throw new Error('Start through the owned fixed gateway launcher.');
    let gateway: Awaited<ReturnType<typeof createGateway>> | undefined;
    let job: WindowsJob | undefined, launching: Promise<WindowsJob> | undefined, managed: ManagedRecord | undefined;
    let closing = false, closePromise: Promise<void> | undefined, finishStartup!: () => void;
    let clock: ReturnType<typeof routeLeaseClock> | undefined, costTimer: ReturnType<typeof setTimeout> | undefined, credential = '';
    const relayKey = randomBytes(32);
    const startupFinished = new Promise<void>(resolve => { finishStartup = resolve; });
    function close() { return closePromise ??= (async () => {
      closing = true; clock?.stop(); if (costTimer) clearTimeout(costTimer);
      // An expiry stops an already-created native job immediately, while the
      // listener cleanup still waits for pending startup operations to settle.
      const early = job?.close().then(() => true, () => false);
      await startupFinished;
      try {
        if (early) { if (!await early) throw new Error('Owned native shutdown was not confirmed.'); }
        else { const current = job ?? (launching ? await launching : undefined); if (current) await current.close(); }
        if (managed) atomic(recordFile, { ...managed, shutdownConfirmed: true });
      } catch {
        if (managed) { try { atomic(recordFile, { ...managed, failure: 'shutdown_unconfirmed', shutdownConfirmed: false }); } catch { /* preserve original evidence */ } }
        console.error('Owned fixed gateway shutdown was not confirmed. Runtime evidence preserved.'); process.exitCode = 1;
      } finally { try { await gateway?.close(); } finally { relayKey.fill(0); credential = ''; release(); } }
    })(); }
    process.once('SIGINT', () => void close()); process.once('SIGTERM', () => void close()); process.once('exit', release);
    try {
      const reservations: ReturnType<typeof createServer>[] = [];
      try {
        for (const port of Object.values(fixedPorts)) {
          const server = createServer();
          await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
          reservations.push(server); if (closing) throw new Error('Fixed gateway startup was cancelled.');
        }
      } finally { for (const server of reservations) await new Promise<void>(resolve => server.close(() => resolve())); }
      if (closing) throw new Error('Fixed gateway startup was cancelled.');
      gateway = await createGateway({ issuer: config.origin, publicPort: fixedPorts.publicPort, controlPort: fixedPorts.controlPort,
        upstream: `http://127.0.0.1:${core.port}/mcp`, clientToken: readLocalToken(runtime, 'client'), adminToken: readLocalToken(runtime, 'admin'),
        instance, relayKey, oauthStateFile: path.join(runtime, 'fixed-oauth.dpapi'), managementCommand: 'fixed-tunnel.ps1', onShutdown: () => { void close(); } });
      if (closing) throw new Error('Fixed gateway startup was cancelled.');
      const agentFile = path.join(runtime, 'fixed-cloudflared.yml'); writeFileSync(agentFile, fixedAgentConfig(), { mode: 0o600 });
      credential = decryptKey(); assertRouteCredential(credential); assertFixedActivation(config);
      if (config.cost.status === 'confirmed-no-charge' && config.cost.expiresAt) {
        const remaining = Math.max(0, Date.parse(config.cost.expiresAt) - Date.now());
        if (remaining <= 2147483647) costTimer = setTimeout(() => { process.exitCode = 1; void close(); }, remaining);
      }
      if (closing) throw new Error('Fixed gateway startup was cancelled.');
      launching = startWindowsJob(binary, fixedArguments(config, runtime), { cwd: root, env: fixedEnvironment(process.env) }); job = await launching;
      const died = () => { if (!closing) { if (managed) { managed.failure = 'native_exit'; try { atomic(recordFile, managed); } catch { /* preserve prior evidence */ } } process.exitCode = 1; console.error('Owned internal tunnel exited. No paid fallback was attempted.'); void close(); } };
      job.process.once('error', died); job.process.once('exit', died);
      if (closing || job.process.exitCode !== null || job.process.signalCode !== null) throw new Error('Owned internal tunnel exited during startup.');
      const own = processIdentity(process.pid), native = processIdentity(job.childPid);
      if (!own || !native || native.executable.toLowerCase() !== binary.toLowerCase()) throw new Error('Cannot verify owned fixed gateway process identity.');
      managed = { schemaVersion: 1, pid: process.pid, executable: process.execPath, created: own.created, entry, instance, ...fixedPorts,
        childPid: job.childPid, childCreated: native.created, shutdownConfirmed: false };
      atomic(recordFile, managed);
      let quickOrigin: string | undefined;
      const nativeDeadline = Date.now() + 90000;
      while (!closing && Date.now() < nativeDeadline && !quickOrigin) {
        try {
          const ready = await fetch(`http://127.0.0.1:${fixedPorts.nativeAdminPort}/ready`, { signal: AbortSignal.timeout(2000) });
          const healthy = ready.ok; await ready.body?.cancel();
          if (healthy) quickOrigin = quickTunnelOrigin(await boundedJson(await fetch(`http://127.0.0.1:${fixedPorts.nativeAdminPort}/quicktunnel`, { signal: AbortSignal.timeout(2000) }), false));
        } catch { /* Only the explicit local metrics port is probed. */ }
        if (!quickOrigin) await pause(500);
      }
      if (closing || !quickOrigin) throw new Error('The owned internal tunnel did not become ready.');
      const routeOrigin = quickOrigin;
      const renew = async () => {
        if (closing) return;
        const expiresAt = await publishRoute(config, routeOrigin, credential, relayKey);
        if (closing) return;
        managed!.routeExpiresAt = new Date(expiresAt).toISOString(); atomic(recordFile, managed); clock!.arm(expiresAt);
      };
      clock = routeLeaseClock(() => { if (managed) { managed.failure = 'route_lease_expired'; try { atomic(recordFile, managed); } catch { /* preserve evidence */ } } process.exitCode = 1; void close(); }, renew);
      await renew();
      const workerDeadline = Date.now() + 90000; let propagated = false;
      while (!closing && Date.now() < workerDeadline && !propagated) {
        try { propagated = await externalProbe(config, instance); } catch { /* KV propagation is eventual. */ }
        if (!propagated) await pause(1500);
      }
      if (closing || !propagated) throw new Error('The Worker did not confirm this run through the encrypted relay. No ChatGPT success was inferred.');
      managed.startupConfirmed = true; atomic(recordFile, managed);
      console.log('Fixed gateway and this run of the encrypted relay are ready. Ordinary ChatGPT acceptance remains to be verified.');
    } catch (error) { finishStartup(); await close(); throw error; }
    finally { finishStartup(); }
  } catch (error) { release(); throw error; }
}
async function stdin() { let value = ''; for await (const chunk of process.stdin) { value += String(chunk); if (value.length > 16384) throw new Error('Local input is too large.'); } return value.trim(); }
async function main() {
  const action = process.argv[2] ?? 'help';
  if (action === 'help') { console.log('Fixed Cloudflare connection: setup | configure | credential (local prompt) | start | run | status | doctor | stop | restart | approve | deny | connection-info. Current free service, quota or credit evidence and six no-charge safeguards are required.'); return; }
  if (action === 'setup') { const release = await lease(); try { await setup(); console.log('Verified pinned cloudflared executable hash. No account or tunnel was contacted.'); } finally { release(); } return; }
  if (action === 'configure') {
    const release = await lease();
    try { assertStopped(); const input = JSON.parse(await stdin()) as { origin?: string; evidence?: unknown }; const config = configuredFixedTunnel(input.origin ?? '', input.evidence);
      if (existsSync(configFile) && loadFixedConfig(runtime).origin !== config.origin) throw new Error('Existing fixed origin and OAuth identity preserved. Use an explicit migration to change the assigned domain.');
      atomic(configFile, config); console.log(`Fixed gateway configuration saved. Cost status: ${config.cost.status}. No provider request was made.`);
    } finally { release(); } return;
  }
  if (action === 'credential-check' || action === 'credential-store') {
    const release = await lease();
    try { assertStopped(); assertFixedActivation(loadFixedConfig(runtime));
      if (action === 'credential-store') { const value = await stdin(); if (!/^[a-fA-F0-9]{100,16384}$/.test(value)) throw new Error('Invalid Windows DPAPI credential envelope.');
        const temporary = path.join(runtime, `fixed-tunnel-key.${randomUUID()}.tmp`); writeFileSync(temporary, value, { flag: 'wx', mode: 0o600 }); renameSync(temporary, path.join(runtime, 'fixed-tunnel-key.dpapi')); }
    } finally { release(); } return;
  }
  if (action === 'doctor') {
    let verified = false, executable = false;
    try { verifyBinary(); verified = true; executable = execFileSync(binary, ['--version'], { env: fixedEnvironment(process.env), windowsHide: true, encoding: 'utf8', timeout: 10000 }).trim().startsWith(`cloudflared version ${fixedRelease.version} `); } catch { /* safe fixed state only */ }
    const config = existsSync(configFile) ? loadFixedConfig(runtime) : undefined;
    console.log(JSON.stringify({ binary_version: fixedRelease.version, binary_verified: verified, offline_execution: executable ? 'verified' : 'blocked_or_unavailable', configured: Boolean(config), cost_status: config?.cost.status ?? 'unverified', credential_present: existsSync(path.join(runtime, 'fixed-tunnel-key.dpapi')), chatgpt_e2e: 'not_verified', paid_fallback: false }, null, 2)); return;
  }
  if (action === 'connection-info') { const config = loadFixedConfig(runtime); console.log(JSON.stringify({ mcp_url: `${config.origin}/mcp`, oauth_metadata_url: `${config.origin}/.well-known/oauth-authorization-server`, authentication: 'OAuth', status: 'manual_setup_information_not_e2e_proof' }, null, 2)); return; }
  if (action === 'run') { await run(); return; }
  if (!['status', 'stop', 'approve', 'deny'].includes(action)) throw new Error('Unknown fixed gateway action.');
  const previous = record();
  if (!previous || !owned(previous)) {
    const native = previous ? nativeOwned(previous) : false;
    if (native) throw new Error('Supervisor is absent but its native child is still present. Do not start another tunnel.');
    if (action !== 'status' && action !== 'stop') throw new Error('No running fixed gateway can accept approval.');
    console.log(JSON.stringify({ process_running: false, configured: existsSync(configFile), shutdown_confirmed: previous?.shutdownConfirmed ?? null, chatgpt_e2e: 'not_verified' })); return;
  }
  const config = loadFixedConfig(runtime);
  if (action === 'status') { console.log(JSON.stringify(await status(previous, config), null, 2)); return; }
  await gatewayStatus(previous);
  const request = action === 'stop' ? {} : { request_id: process.argv[3], verification_code: process.argv[4], approve: action === 'approve' };
  const response = await fetch(`http://127.0.0.1:${previous.controlPort}/${action === 'stop' ? 'shutdown' : 'approve'}`, { method: 'POST', headers: { Authorization: `Bearer ${readLocalToken(runtime, 'admin')}`, 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!response.ok) throw new Error('Fixed gateway rejected the local action.'); await response.body?.cancel();
  if (action !== 'stop') { console.log(action === 'approve' ? 'Matching local OAuth request approved.' : 'Matching local OAuth request denied.'); return; }
  for (let index = 0; index < 50; index++) {
    if (!owned(previous)) {
      const final = record();
      if (nativeOwned(previous) || final?.instance !== previous.instance || !final.shutdownConfirmed) throw new Error('Supervisor exited but complete owned job shutdown was not confirmed. Evidence preserved.');
      console.log('Owned fixed gateway stopped. Persistent OAuth grants and the core were preserved.'); return;
    }
    await pause(250);
  }
  throw new Error('Fixed gateway shutdown requested but process exit was not confirmed.');
}
void main().catch(error => {
  const message = error instanceof Error && !('stdout' in error) && !('issues' in error) ? error.message : '';
  console.error(message.startsWith('COST_UNVERIFIED:') || /^[A-Za-z][A-Za-z0-9 .,;:'()/_-]+$/.test(message) ? message : 'Fixed gateway operation failed. Check the local prerequisites; no credential or raw native diagnostic was printed.'); process.exitCode = 1;
});
