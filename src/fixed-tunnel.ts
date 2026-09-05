import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { assertCurrentCostEvidence, costBasisSchema, safeguardsSchema } from './cost-policy.js';
import { acquireRuntimeLock } from './runtime-lock.js';
import { processIdentity } from './secure-process.js';

export const fixedRelease = {
  version: '2026.8.2',
  url: 'https://github.com/cloudflare/cloudflared/releases/download/2026.8.2/cloudflared-windows-amd64.exe',
  executableSha256: 'c29eee2b121f5436a642eed69fd9767da7e7b8c510fa50aaa130337f931357b5',
} as const;
export const fixedPorts = { publicPort: 8798, controlPort: 8799, nativeAdminPort: 8800 } as const;
const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
export const fixedOriginSchema = z.string().regex(new RegExp(`^https://${label}\\.${label}\\.workers\\.dev$`));
const quickOriginSchema = z.string().regex(new RegExp(`^https://${label}\\.trycloudflare\\.com$`));
const evidenceUrlSchema = z.string().url().refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && ['developers.cloudflare.com', 'www.cloudflare.com', 'cloudflare.com'].includes(url.hostname) && !url.username && !url.password && !url.search && !url.hash;
});
export const fixedCostEvidenceSchema = z.object({
  evidenceUrl: evidenceUrlSchema, basis: costBasisSchema,
  accountPlanConfirmed: z.literal(true), safeguards: safeguardsSchema,
  expiresAt: z.string().datetime().optional(),
}).strict();
export const fixedConfigSchema = z.object({
  schemaVersion: z.literal(1), origin: fixedOriginSchema, provider: z.literal('cloudflare-workers-quick'),
  cost: z.discriminatedUnion('status', [
    z.object({ status: z.literal('unverified') }).strict(),
    fixedCostEvidenceSchema.extend({ status: z.literal('confirmed-no-charge'), confirmedAt: z.string().datetime() }).strict(),
  ]),
}).strict();
export type FixedConfig = z.infer<typeof fixedConfigSchema>;
export function configuredFixedTunnel(origin: string, evidence?: unknown): FixedConfig {
  const config = fixedConfigSchema.parse({ schemaVersion: 1, origin, provider: 'cloudflare-workers-quick',
    cost: evidence === undefined ? { status: 'unverified' } : { ...fixedCostEvidenceSchema.parse(evidence), status: 'confirmed-no-charge', confirmedAt: new Date().toISOString() } });
  if (evidence !== undefined) assertFixedActivation(config);
  return config;
}
export function assertFixedActivation(config: FixedConfig, now = Date.now()) {
  const parsed = fixedConfigSchema.parse(config);
  if (parsed.cost.status !== 'confirmed-no-charge') throw new Error('COST_UNVERIFIED: confirm current account evidence and all six no-charge safeguards before credential use.');
  assertCurrentCostEvidence(parsed.cost.basis, parsed.cost.safeguards, parsed.cost.expiresAt, now);
}
export function loadFixedConfig(runtime: string): FixedConfig {
  return fixedConfigSchema.parse(JSON.parse(readFileSync(path.join(runtime, 'fixed-tunnel.json'), 'utf8').replace(/^\uFEFF/, '')));
}
/** No cloud credentials, global profile paths, proxy passwords or model keys. */
export function fixedEnvironment(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC']) if (parent[name]) env[name] = parent[name];
  return env;
}
export function assertRouteCredential(value: string) {
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(value)) throw new Error('Route control requires 43 to 128 base64url characters matching the Worker secret.');
}
/** Deployment can provision the same secret to Worker and local DPAPI via pipes. */
export async function saveRouteSecret(runtime: string, secret: string): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Local route credentials require Windows current-user DPAPI.');
  assertRouteCredential(secret);
  const directory = path.join(runtime, 'fixed-gateway-lease'); mkdirSync(directory, { recursive: true });
  const release = await acquireRuntimeLock(directory);
  try {
    assertFixedActivation(loadFixedConfig(runtime));
    const recordFile = path.join(runtime, 'fixed-gateway-process.json');
    if (existsSync(recordFile)) {
      const record = JSON.parse(readFileSync(recordFile, 'utf8')) as { pid: number; created: string; childPid: number; childCreated: string };
      for (const [pid, created] of [[record.pid, record.created], [record.childPid, record.childCreated]] as const) if (processIdentity(pid)?.created === created) throw new Error('Stop the owned fixed gateway before changing its route secret.');
    }
    const shell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const protect = "$ErrorActionPreference='Stop';Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1');$p=$env:AUTODEV_RUNTIME;$item=Get-Item -LiteralPath $p -Force;if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'ACL_ERROR'};$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=Get-Acl -LiteralPath $p;$before=$acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access);$acl.SetAccessRuleProtection($true,$false);foreach($rule in @($acl.Access)){[void]$acl.RemoveAccessRuleSpecific($rule)};$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit, ObjectInherit','None','Allow')));if($before -ne $acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)){Set-Acl -LiteralPath $p -AclObject $acl};foreach($file in Get-ChildItem -LiteralPath $p -File -Force){if($file.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'ACL_ERROR'};$a=Get-Acl -LiteralPath $file.FullName;$before=$a.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access);$a.SetAccessRuleProtection($true,$false);foreach($rule in @($a.Access)){[void]$a.RemoveAccessRuleSpecific($rule)};$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')));if($before -ne $a.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)){Set-Acl -LiteralPath $file.FullName -AclObject $a}}";
    try { execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', protect], { env: { ...fixedEnvironment(process.env), AUTODEV_RUNTIME: runtime }, windowsHide: true, stdio: 'pipe', timeout: 15000 }); }
    catch { throw new Error('Windows runtime ACL protection failed. No route credential was written.'); }
    let encrypted: string;
    try {
      encrypted = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop';$s=ConvertTo-SecureString ([Console]::In.ReadToEnd()) -AsPlainText -Force;try{[Console]::Out.Write((ConvertFrom-SecureString $s))}finally{$s.Dispose()}"], { input: secret, encoding: 'utf8', env: fixedEnvironment(process.env), windowsHide: true, timeout: 15000 }).trim();
    } catch { throw new Error('Windows route secret encryption failed. No plaintext credential was written.'); }
    if (!/^[a-fA-F0-9]{100,16384}$/.test(encrypted)) throw new Error('Invalid Windows DPAPI credential envelope.');
    assertFixedActivation(loadFixedConfig(runtime));
    const file = path.join(runtime, 'fixed-tunnel-key.dpapi');
    if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error('Route credential must not be a link.');
    const temporary = `${file}.${randomUUID()}.tmp`; writeFileSync(temporary, encrypted, { flag: 'wx', mode: 0o600 }); renameSync(temporary, file);
  } finally { release(); }
}
export function fixedAgentConfig() { return 'no-autoupdate: true\n'; }
export function fixedArguments(config: FixedConfig, runtime: string) {
  assertFixedActivation(config);
  return ['tunnel', '--config', path.join(runtime, 'fixed-cloudflared.yml'), '--url', `http://127.0.0.1:${fixedPorts.publicPort}`,
    '--no-autoupdate', '--protocol', 'http2', '--http-host-header', `127.0.0.1:${fixedPorts.publicPort}`, '--metrics', `127.0.0.1:${fixedPorts.nativeAdminPort}`, '--loglevel', 'error'];
}
export function verifyFixedBinary(bytes: Buffer) {
  if (createHash('sha256').update(bytes).digest('hex') !== fixedRelease.executableSha256) throw new Error('Pinned cloudflared executable checksum mismatch. Existing files preserved.');
}
export function quickTunnelOrigin(value: unknown): string | undefined {
  const hostname = (value as { hostname?: unknown } | null)?.hostname;
  if (typeof hostname !== 'string') return;
  const origin = hostname.startsWith('https://') ? hostname : `https://${hostname}`;
  return quickOriginSchema.safeParse(origin).success ? origin : undefined;
}
export function fixedExternalMetadata(value: unknown, origin: string): boolean {
  const metadata = value as { issuer?: unknown; authorization_endpoint?: unknown; token_endpoint?: unknown } | null;
  return metadata?.issuer === origin && metadata.authorization_endpoint === `${origin}/oauth/authorize` && metadata.token_endpoint === `${origin}/oauth/token`;
}
export function routeExpiry(config: FixedConfig, now = Date.now()) {
  assertFixedActivation(config, now);
  const costExpiry = config.cost.status === 'confirmed-no-charge' && config.cost.expiresAt ? Date.parse(config.cost.expiresAt) : Infinity;
  return Math.min(now + 60 * 60 * 1000, costExpiry);
}
/** Both public metadata and native quicktunnel JSON are bounded; no raw logs. */
export async function boundedJson(response: Response, requireJson = true): Promise<unknown> {
  if (!response.ok || (requireJson && !(response.headers.get('content-type') ?? '').includes('application/json'))) { await response.body?.cancel(); return null; }
  if (!response.body) return null;
  const reader = response.body.getReader(); const chunks: Buffer[] = []; let size = 0;
  try { while (true) { const value = await reader.read(); if (value.done) break; size += value.value.length; if (size > 131072) throw new Error('Probe response too large.'); chunks.push(Buffer.from(value.value)); } }
  finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
/** Runtime-only secrets: neither bearer nor relay key enters argv or native env. */
export async function publishRoute(config: FixedConfig, origin: string, credential: string, relayKey: Buffer, transport: typeof fetch = fetch, now = Date.now()) {
  assertFixedActivation(config, now); quickOriginSchema.parse(origin); assertRouteCredential(credential);
  if (relayKey.length !== 32) throw new Error('The per-run relay key must contain 32 random bytes.');
  const expiresAt = new Date(routeExpiry(config, now)).toISOString();
  const response = await transport(`${config.origin}/_autodev/route`, { method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ origin, expiresAt, relayKey: relayKey.toString('base64url') }) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(response.status === 429 || response.status === 402 ? 'FREE_QUOTA_BLOCKED: route update refused. No paid fallback is allowed.' : 'Worker route update was not accepted.'); }
  const value = await boundedJson(response) as { ok?: unknown; expiresAt?: unknown } | null;
  if (value?.ok !== true || value.expiresAt !== expiresAt) throw new Error('Worker route lease acknowledgement did not match.');
  return Date.parse(expiresAt);
}

/** Renewing and expiration are independent; a stuck renew cannot extend a lease. */
export function routeLeaseClock(onExpired: () => void, onRenew: () => Promise<void>, now = Date.now, timers = { setTimeout, clearTimeout }) {
  let expiryTimer: ReturnType<typeof setTimeout> | undefined, renewTimer: ReturnType<typeof setTimeout> | undefined, stopped = false;
  function stop() { stopped = true; if (expiryTimer) timers.clearTimeout(expiryTimer); if (renewTimer) timers.clearTimeout(renewTimer); }
  return {
    arm(expiresAt: number) {
      if (stopped) return;
      if (expiryTimer) timers.clearTimeout(expiryTimer); if (renewTimer) timers.clearTimeout(renewTimer);
      const remaining = expiresAt - now();
      if (remaining <= 0) { stop(); onExpired(); return; }
      expiryTimer = timers.setTimeout(() => { stop(); onExpired(); }, remaining);
      renewTimer = timers.setTimeout(() => { if (!stopped) void onRenew().catch(() => { if (!stopped) { stop(); onExpired(); } }); }, Math.min(20 * 60 * 1000, remaining));
    }, stop,
  };
}
