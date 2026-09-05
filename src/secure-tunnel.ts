import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const tunnelRelease = {
  version: '0.0.14',
  commit: '0f870e50a973fa820d4c409000059e181e8d242b',
  archive: 'tunnel-client-v0.0.14-windows-amd64.zip',
  sha256: '784ab8da7b5a88f0109f1fd8aaf0a1c86067430b896dddf307ef7e3cc49fa1a5',
  url: 'https://github.com/openai/tunnel-client/releases/download/v0.0.14/tunnel-client-v0.0.14-windows-amd64.zip',
} as const;

const officialEvidence = z.string().url().refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash &&
    ['developers.openai.com', 'help.openai.com', 'platform.openai.com', 'openai.com'].includes(url.hostname);
}, 'Use the exact official pricing/support reference, without credentials or query parameters.');

export const tunnelConfigSchema = z.object({
  schemaVersion: z.literal(1),
  tunnelId: z.string().regex(/^tunnel_[a-f0-9]{32}$/),
  healthPort: z.number().int().min(1024).max(65534).default(8796),
  authentication: z.literal('existing-oauth-gateway'),
  cost: z.discriminatedUnion('status', [
    z.object({ status: z.literal('unverified') }).strict(),
    z.object({ status: z.literal('operator-confirmed-zero'), evidenceUrl: officialEvidence, confirmedAt: z.string().datetime() }).strict(),
  ]),
}).strict();
export type TunnelConfig = z.infer<typeof tunnelConfigSchema>;

export function assertActivationAllowed(config: TunnelConfig) {
  if (config.cost.status !== 'operator-confirmed-zero') {
    throw new Error('COST_UNVERIFIED: official information has not established zero added cost. No credential was read and no tunnel was contacted.');
  }
}

/** An operator records externally obtained cost evidence; a URL alone is not proof. */
export function configuredTunnel(tunnelId: string, healthPort: number, evidenceUrl?: string, confirmed = false): TunnelConfig {
  if (Boolean(evidenceUrl) !== confirmed) throw new Error('Supply both explicit zero-cost confirmation and its official evidence reference, or neither.');
  return tunnelConfigSchema.parse({ schemaVersion: 1, tunnelId, healthPort, authentication: 'existing-oauth-gateway',
    cost: confirmed ? { status: 'operator-confirmed-zero', evidenceUrl, confirmedAt: new Date().toISOString() } : { status: 'unverified' } });
}

export function loadTunnelConfig(runtime: string): TunnelConfig {
  return tunnelConfigSchema.parse(JSON.parse(readFileSync(path.join(runtime, 'secure-tunnel.json'), 'utf8').replace(/^\uFEFF/, '')));
}

/** Never inherit API keys, user profiles, proxy credentials or unsafe logging flags. */
export function tunnelEnvironment(parent: NodeJS.ProcessEnv, runtime: string, runtimeKey: string): NodeJS.ProcessEnv {
  if (!/^sk-[A-Za-z0-9_-]{16,512}$/.test(runtimeKey)) throw new Error('Invalid runtime key format.');
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'COMSPEC']) if (parent[name]) env[name] = parent[name];
  env.CONTROL_PLANE_API_KEY = runtimeKey;
  env.TUNNEL_CLIENT_STATE_DIR = path.join(runtime, 'secure-tunnel-state');
  env.TUNNEL_CLIENT_PROFILE_DIR = path.join(runtime, 'secure-tunnel-profiles');
  return env;
}

export function tunnelArguments(config: TunnelConfig, runtime: string, gatewayPort: number): string[] {
  assertActivationAllowed(config);
  if (!Number.isSafeInteger(gatewayPort) || gatewayPort < 1024 || gatewayPort > 65535 || gatewayPort === config.healthPort) throw new Error('Invalid or conflicting local gateway port.');
  return ['run', '--config', path.join(runtime, 'secure-tunnel-client.yml'),
    '--control-plane.base-url', 'https://api.openai.com',
    '--control-plane.api-key', 'env:CONTROL_PLANE_API_KEY', '--control-plane.tunnel-id', config.tunnelId,
    '--mcp.server-url', `http://127.0.0.1:${gatewayPort}/mcp`,
    '--health.listen-addr', `127.0.0.1:${config.healthPort}`, '--log.level', 'error', '--log.format', 'json',
    '--log.http-raw-unsafe=false', '--allow-remote-ui=false', '--open-web-ui=false'];
}

export function verifyArchive(bytes: Buffer) {
  if (createHash('sha256').update(bytes).digest('hex') !== tunnelRelease.sha256) throw new Error('Official tunnel archive checksum mismatch; nothing was installed.');
}

/** Never turn an HTTP 200 or a green local probe into ChatGPT E2E. */
export function lastSuccessfulPoll(metrics: string, startedAt: number, now = Date.now()): boolean {
  const samples = [...metrics.matchAll(/^commands_poll_last_successful_timestamp_seconds(?:\{[^\n]*\})?\s+(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?:\s|$)/gm)];
  return samples.some(sample => { const at = Number(sample[1]) * 1000; return Number.isFinite(at) && at > 0 && at >= startedAt - 1000 && at <= now + 5000 && now - at <= 90000; });
}

export function tunnelReadiness(healthy: boolean, ready: boolean, pollState: unknown, polled = false) {
  const routeHealthy = pollState === 'healthy' || pollState === 'direct';
  return { healthy, local_ready: ready, control_plane_route_healthy: routeHealthy,
    ready_for_chatgpt_probe: healthy && ready && routeHealthy && polled, successful_remote_poll: polled ? 'recent' : 'not_verified', chatgpt_e2e: 'not_verified',
    fixed_entry_ready: false, authentication: 'existing-oauth-gateway',
    limitation: 'Browser OAuth still depends on the current public authorization URL. Full gateway restart requires relinking OAuth.' };
}
