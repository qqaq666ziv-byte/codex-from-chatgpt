import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authorized, loadLocalConfig, readLocalToken } from './local-config.js';
import { acquireRuntimeLock } from './runtime-lock.js';
import { configuredTunnel, loadTunnelConfig, assertActivationAllowed, tunnelArguments, tunnelEnvironment, tunnelReadiness, lastSuccessfulPoll, tunnelRelease, verifyArchive } from './secure-tunnel.js';
import { processIdentity, requireOwned, type OwnedProcess } from './secure-process.js';
import { startWindowsJob, type WindowsJob } from './windows-job.js';

const entry = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(entry), '../..');
const runtime = path.join(root, '.runtime');
const recordFile = path.join(runtime, 'secure-tunnel-process.json');
const configFile = path.join(runtime, 'secure-tunnel.json');
const binary = path.join(root, '.tools', 'tunnel-client-v0.0.14', 'tunnel-client.exe');
const binaryHash = 'fcc85a69ec0ad82518e4f8964f60c45e31787957782a0fc9c1b0c44e82d61b9b';
type RecordFile = OwnedProcess & { schemaVersion: 1; controlPort: number; healthPort: number; shutdownConfirmed?: boolean };
const pause = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
function atomic(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); renameSync(temporary, file);
}
function record(): RecordFile | undefined {
  if (!existsSync(recordFile)) return;
  const value = JSON.parse(readFileSync(recordFile, 'utf8')) as RecordFile;
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.controlPort) || value.controlPort < 1024 || value.controlPort > 65535) throw new Error('Invalid managed tunnel record.');
  return value;
}
function assertStopped() {
  const previous = record();
  if (previous && requireOwned(previous, entry)) throw new Error('Stop the managed Secure Tunnel before changing its installation or configuration.');
}
async function lifecycleLease() {
  const directory = path.join(runtime, 'secure-tunnel-lease'); mkdirSync(directory, { recursive: true });
  return acquireRuntimeLock(directory);
}
function verifyBinary() {
  if (lstatSync(binary).isSymbolicLink() || createHash('sha256').update(readFileSync(binary)).digest('hex') !== binaryHash) throw new Error('Official tunnel binary checksum mismatch. Existing file preserved.');
}
async function setup() {
  assertStopped();
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Pinned installation currently supports Windows x64.');
  if (existsSync(binary)) { verifyBinary(); return; }
  const toolsDir = path.join(root, '.tools'); mkdirSync(toolsDir, { recursive: true });
  if (lstatSync(toolsDir).isSymbolicLink()) throw new Error('Tools directory must be local and physical.');
  const destination = path.dirname(binary);
  if (existsSync(destination)) throw new Error('Incomplete existing installation preserved. Inspect it before retrying.');
  const archiveFile = path.join(toolsDir, 'tunnel-client-v0.0.14.zip');
  let bytes: Buffer;
  if (existsSync(archiveFile)) bytes = readFileSync(archiveFile);
  else {
    const response = await fetch(tunnelRelease.url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error('Official tunnel download failed.');
    bytes = Buffer.from(await response.arrayBuffer()); verifyArchive(bytes);
    writeFileSync(archiveFile, bytes, { flag: 'wx' });
  }
  verifyArchive(bytes);
  const stage = `${destination}.install-${randomUUID()}`;
  // Fixed, hash-verified official archive, extracted only to a new workspace directory.
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop';Expand-Archive -LiteralPath $env:AUTODEV_ARCHIVE -DestinationPath $env:AUTODEV_STAGE"],
    { windowsHide: true, stdio: 'pipe', env: { ...process.env, AUTODEV_ARCHIVE: archiveFile, AUTODEV_STAGE: stage }, timeout: 60000 });
  const stagedBinary = path.join(stage, 'tunnel-client.exe');
  if (createHash('sha256').update(readFileSync(stagedBinary)).digest('hex') !== binaryHash) throw new Error('Extracted binary checksum mismatch. Staging retained.');
  renameSync(stage, destination); verifyBinary();
}
function decryptRuntimeKey(): string {
  const keyFile = path.join(runtime, 'secure-tunnel-key.dpapi');
  if (lstatSync(keyFile).isSymbolicLink()) throw new Error('Credential file must not be a link.');
  const script = "$ErrorActionPreference='Stop';$s=[IO.File]::ReadAllText($env:AUTODEV_KEY_FILE)|ConvertTo-SecureString;$p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s);try{[Console]::Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p))}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p);$s.Dispose()}";
  // Output is consumed only in this process; never inherited by Codex or printed.
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, env: { ...process.env, AUTODEV_KEY_FILE: keyFile }, timeout: 10000 }).trim();
}
async function gateway() {
  const value = JSON.parse(readFileSync(path.join(runtime, 'gateway.json'), 'utf8')) as OwnedProcess & { publicPort: number; controlPort: number; issuer: string };
  const expected = path.join(root, 'dist', 'src', 'gateway-runner.js');
  const p = processIdentity(value.pid);
  if (!p || !/^[a-f0-9-]{36}$/.test(value.instance) || path.resolve(value.entry) !== expected || value.created !== p.created ||
    p.executable.toLowerCase() !== process.execPath.toLowerCase() || !p.command.includes(value.entry) || !p.command.includes(`--autodev-gateway-instance=${value.instance}`) ||
    !Number.isSafeInteger(value.publicPort) || value.publicPort < 1024 || value.publicPort > 65535 ||
    !Number.isSafeInteger(value.controlPort) || value.controlPort < 1024 || value.controlPort > 65535) throw new Error('An owned, running OAuth gateway is required. Quick Tunnel recovery was not changed.');
  const response = await fetch(`http://127.0.0.1:${value.controlPort}/status`, { headers: { Authorization: `Bearer ${readLocalToken(runtime, 'admin')}` }, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('OAuth gateway did not authenticate the local probe.');
  const status = await response.json() as { process_id: number; instance_id: string; issuer: string };
  if (status.process_id !== value.pid || status.instance_id !== value.instance || status.issuer !== value.issuer) throw new Error('OAuth gateway identity mismatch.');
  return value;
}
async function probes(healthPort: number, startedAt: number) {
  let healthy = false, ready = false, route: unknown = 'unknown', polled = false;
  try {
    const origin = `http://127.0.0.1:${healthPort}`;
    const results = await Promise.all([fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(2000) }), fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(2000) }), fetch(`${origin}/api/system`, { signal: AbortSignal.timeout(2000) }), fetch(`${origin}/metrics`, { signal: AbortSignal.timeout(2000) })]);
    healthy = results[0]!.ok; ready = results[1]!.ok;
    if (results[2]!.ok) { const value = await results[2]!.json() as { proxy_health?: Array<{ route?: { kind?: string }; health_state?: string }> }; route = value.proxy_health?.find(p => p.route?.kind === 'control_plane')?.health_state; }
    if (results[3]!.ok) polled = lastSuccessfulPoll(await results[3]!.text(), startedAt);
    for (const response of results) if (!response.bodyUsed) await response.body?.cancel();
  } catch { /* fixed, non-secret diagnostics only */ }
  return tunnelReadiness(healthy, ready, route, polled);
}
async function run() {
  // Configuration, cost validation and native launch share the same lease as
  // configure/credential writes and the Windows backup/update maintenance path.
  const release = await lifecycleLease();
  try {
  const config = loadTunnelConfig(runtime); assertActivationAllowed(config); verifyBinary();
  const core = loadLocalConfig(path.join(runtime, 'config.json'));
  const health = await fetch(`http://127.0.0.1:${core.port}/readyz`, { signal: AbortSignal.timeout(5000) });
  if (!health.ok) throw new Error('AutoDev core is not ready.');
  const ingress = await gateway();
  if ([core.port, ingress.publicPort, ingress.controlPort].some(port => port === config.healthPort || port === config.healthPort + 1)) throw new Error('Secure Tunnel ports conflict with an existing service.');
  const instance = process.argv.find(arg => arg.startsWith('--autodev-secure-instance='))?.split('=')[1];
  if (!instance || !/^[a-f0-9-]{36}$/.test(instance)) throw new Error('Start through the owned Windows launcher.');
  let job: WindowsJob | undefined, launching: Promise<WindowsJob> | undefined, closing = false, closePromise: Promise<void> | undefined;
  let managedRecord: RecordFile | undefined;
  let finishStartup!: () => void;
  const startupFinished = new Promise<void>(resolve => { finishStartup = resolve; });
  const startedAt = Date.now();
  const adminToken = readLocalToken(runtime, 'admin');
  const control = createServer(async (req, res) => {
    const send = (code: number, value: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    if (req.headers.host !== `127.0.0.1:${config.healthPort + 1}` || req.headers.origin) { send(403, { error: 'origin_rejected' }); return; }
    if (!authorized(req.headers.authorization, adminToken)) { send(401, { error: 'authentication_required' }); return; }
    if (req.url === '/status' && req.method === 'GET') {
      let gatewayAlive = false, coreAlive = false;
      try { const current = await gateway(); gatewayAlive = current.instance === ingress.instance && current.pid === ingress.pid;
        coreAlive = (await fetch(`http://127.0.0.1:${core.port}/readyz`, { signal: AbortSignal.timeout(2000) })).ok; } catch { /* dependency unavailable */ }
      const probe = await probes(config.healthPort, startedAt);
      const running = !closing && Boolean(job?.childPid) && job?.process.exitCode === null && job?.process.signalCode === null;
      send(200, { process_id: process.pid, instance_id: instance, process_running: running,
        ...probe, oauth_gateway_ready: gatewayAlive, core_ready: coreAlive, ready_for_chatgpt_probe: running && probe.ready_for_chatgpt_probe && gatewayAlive && coreAlive }); return;
    }
    if (req.url === '/shutdown' && req.method === 'POST') { send(200, { stopping: true }); setImmediate(() => void close()); return; }
    send(404, { error: 'not_found' });
  });
  function close(): Promise<void> {
    return closePromise ??= (async () => {
      closing = true;
      // Do not release the lease or close the server before a pending listen /
      // native launch has settled; cancellation cannot leave a later listener.
      await startupFinished;
      try {
        // Job membership is atomic at CreateProcess. Parent death or helper
        // death closes the sole OS job handle and kills all descendants.
        const currentJob = job ?? (launching ? await launching : undefined);
        if (currentJob) await currentJob.close();
        if (managedRecord) atomic(recordFile, { ...managedRecord, shutdownConfirmed: true });
      } catch {
        console.error('Owned Windows job shutdown was not confirmed; runtime record preserved.'); process.exitCode = 1;
      } finally {
        control.closeAllConnections(); await new Promise<void>(resolve => control.close(() => resolve())); release();
      }
    })();
  }
  process.once('SIGINT', () => void close()); process.once('SIGTERM', () => void close()); process.once('exit', release);
  try {
    assertStopped();
    // Reserve both ports before spawning. Never attach health probes to someone else's listener.
    const reservation = createServer();
    try { await new Promise<void>((resolve, reject) => { reservation.once('error', reject); reservation.listen(config.healthPort, '127.0.0.1', resolve); }); }
    finally { if (reservation.listening) await new Promise<void>(resolve => reservation.close(() => resolve())); }
    if (closing) throw new Error('Secure Tunnel startup was cancelled.');
    await new Promise<void>((resolve, reject) => { control.once('error', reject); control.listen(config.healthPort + 1, '127.0.0.1', resolve); });
    if (closing) throw new Error('Secure Tunnel startup was cancelled.');
    writeFileSync(path.join(runtime, 'secure-tunnel-client.yml'), '{}\n', { mode: 0o600 });
    let key = decryptRuntimeKey();
    const env = tunnelEnvironment(process.env, runtime, key); key = '';
    try {
      if (closing) throw new Error('Secure Tunnel startup was cancelled.');
      launching = startWindowsJob(binary, tunnelArguments(config, runtime, ingress.publicPort), { cwd: root, env });
      job = await launching;
    }
    finally { delete env.CONTROL_PLANE_API_KEY; }
    job.process.once('error', () => { console.error('Owned tunnel job failed.'); process.exitCode = 1; void close(); });
    job.process.once('exit', () => { if (!closing) { console.error('Owned tunnel job exited; use status/restart.'); process.exitCode = 1; void close(); } });
    if (job.process.exitCode !== null || job.process.signalCode !== null || closing) throw new Error('Owned tunnel job exited during startup.');
    const own = processIdentity(process.pid); if (!own) throw new Error('Cannot record supervisor identity.');
    managedRecord = { schemaVersion: 1, pid: process.pid, created: own.created, executable: process.execPath, entry, instance, controlPort: config.healthPort + 1, healthPort: config.healthPort, shutdownConfirmed: false };
    atomic(recordFile, managedRecord);
    console.log('Secure Tunnel candidate supervisor started. Check status, then verify from ordinary ChatGPT.');
  } catch (error) { finishStartup(); await close(); throw error; }
  finally { finishStartup(); }
  } catch (error) { release(); throw error; }
}
async function statusOrStop(stop: boolean) {
  const previous = record();
  if (!previous || !requireOwned(previous, entry)) { console.log(JSON.stringify({ process_running: false, configured: existsSync(configFile), chatgpt_e2e: 'not_verified' })); return; }
  const headers = { Authorization: `Bearer ${readLocalToken(runtime, 'admin')}` };
  const origin = `http://127.0.0.1:${previous.controlPort}`;
  const response = await fetch(`${origin}/status`, { headers, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Managed supervisor status did not authenticate.');
  const value = await response.json() as { process_id: number; instance_id: string };
  if (value.process_id !== previous.pid || value.instance_id !== previous.instance) throw new Error('Supervisor HTTP identity mismatch.');
  if (!stop) { console.log(JSON.stringify(value, null, 2)); return; }
  if (!(await fetch(`${origin}/shutdown`, { method: 'POST', headers, signal: AbortSignal.timeout(5000) })).ok) throw new Error('Shutdown rejected.');
  for (let index = 0; index < 40; index++) {
    if (!requireOwned(previous, entry)) {
      const finalRecord = record();
      if (finalRecord?.instance !== previous.instance || finalRecord.shutdownConfirmed !== true) throw new Error('Supervisor exited but owned job shutdown was not confirmed. Runtime evidence preserved.');
      console.log('Owned Secure Tunnel stopped. Core, OAuth gateway and product state preserved.'); return;
    }
    await pause(250);
  }
  throw new Error('Shutdown requested but process exit was not confirmed.');
}
async function main() {
  const action = process.argv[2] ?? 'help';
  if (action === 'help') { console.log('Secure Tunnel candidate: setup | configure | start (Windows launcher) | run | status | doctor | stop. Zero added cost must be established before credential use. Existing OAuth is required; this candidate is not the fixed-entry release.'); return; }
  if (action === 'setup') { const release = await lifecycleLease(); try { await setup(); console.log('Verified official tunnel-client 0.0.14. No tunnel or credential was used.'); } finally { release(); } return; }
  if (action === 'configure') {
    const release = await lifecycleLease();
    try {
    assertStopped();
    const input = configuredTunnel(process.argv[3] ?? '', Number(process.argv[4] ?? '8796'), process.argv[5] || undefined, process.argv[6] === 'confirmed');
    if (existsSync(configFile) && loadTunnelConfig(runtime).tunnelId !== input.tunnelId) throw new Error('Existing Tunnel identity preserved. Changing it requires an explicit migration.');
    atomic(configFile, input); console.log(`Secure Tunnel configuration saved. Cost status: ${input.cost.status}. No remote request was made.`); return;
    } finally { release(); }
  }
  if (action === 'credential-check' || action === 'credential-store') {
    const release = await lifecycleLease();
    try {
      assertStopped(); assertActivationAllowed(loadTunnelConfig(runtime));
      if (action === 'credential-store') {
        let encrypted = '';
        for await (const chunk of process.stdin) { encrypted += String(chunk); if (encrypted.length > 16384) throw new Error('Invalid encrypted credential.'); }
        encrypted = encrypted.trim();
        if (!/^[a-fA-F0-9]{100,16384}$/.test(encrypted)) throw new Error('Invalid Windows DPAPI credential envelope.');
        const temporary = path.join(runtime, `secure-tunnel-key.${randomUUID()}.tmp`);
        writeFileSync(temporary, encrypted, { flag: 'wx', mode: 0o600 }); renameSync(temporary, path.join(runtime, 'secure-tunnel-key.dpapi'));
      }
    } finally { release(); }
    return;
  }
  if (action === 'doctor') {
    verifyBinary();
    const config = existsSync(configFile) ? loadTunnelConfig(runtime) : undefined;
    console.log(JSON.stringify({ binary_version: tunnelRelease.version, binary_verified: true, configured: Boolean(config), cost_status: config?.cost.status ?? 'unverified', credential_present: existsSync(path.join(runtime, 'secure-tunnel-key.dpapi')), authentication: 'existing-oauth-gateway', fixed_entry_ready: false, next_action: config?.cost.status === 'operator-confirmed-zero' ? 'Configure a locally protected runtime key, start the existing core/OAuth gateway, then start the tunnel candidate.' : 'Obtain official zero-added-cost evidence before creating or using a runtime key.' }, null, 2)); return;
  }
  if (action === 'run') { await run(); return; }
  if (action === 'status' || action === 'stop') { await statusOrStop(action === 'stop'); return; }
  throw new Error('Unknown Secure Tunnel action.');
}
void main().catch(error => {
  // Only our deliberately fixed diagnostics are allowed; never print native stdout/stderr or Zod input.
  const message = error instanceof Error && !('stdout' in error) && !('issues' in error) ? error.message : 'Configuration or native command failed; no credential or raw diagnostic was printed.';
  console.error(message.startsWith('COST_UNVERIFIED:') || /^[A-Za-z][A-Za-z0-9 .,;:'()/_-]+$/.test(message) ? message : 'Secure Tunnel operation failed. Use doctor and inspect the local prerequisites.'); process.exitCode = 1;
});
