import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { OAuthGate, OAuthError } from './oauth.js';
import { authorized } from './local-config.js';
import { gatewayAssertion } from './gateway-identity.js';
import { EncryptedOAuthStateStore } from './oauth-state.js';
import { RelayChannel, RELAY_PATH, RELAY_BODY_LIMIT, RELAY_WIRE_LIMIT, decodeRelayBase64 } from './relay-crypto.js';

type Options = { issuer: string; publicPort: number; controlPort: number; upstream: string; clientToken: string; adminToken: string; instance?: string; onShutdown?: () => void; oauthStateFile?: string; managementCommand?: 'connect-chatgpt.ps1' | 'fixed-tunnel.ps1'; relayKey?: Buffer };
type PublicRequest = { method: string; path: string; headers: Headers; read: () => Promise<string>; signal: AbortSignal };
type PublicResponse = { status: number; headers: [string, string][]; body: Buffer };
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

async function body(req: IncomingMessage, maximum = RELAY_BODY_LIMIT, signal?: AbortSignal): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  const abort = () => req.destroy(new Error('Request ended.'));
  signal?.throwIfAborted();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      const bytes = Buffer.from(chunk); size += bytes.length;
      if (size > maximum) { req.resume(); throw new Error('Request too large.'); }
      chunks.push(bytes);
    }
    signal?.throwIfAborted();
    return Buffer.concat(chunks).toString('utf8');
  } finally { signal?.removeEventListener('abort', abort); }
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
function result(status: number, text: string | Buffer, headers: [string, string][]): PublicResponse { return { status, headers, body: typeof text === 'string' ? Buffer.from(text, 'utf8') : text }; }
function jsonResult(status: number, value: unknown, headers: [string, string][] = []): PublicResponse {
  return result(status, JSON.stringify(value), [['content-type', 'application/json'], ['cache-control', 'no-store'], ...headers]);
}
async function responseBody(response: Response): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const value = await reader.read();
        if (value.done) break;
        size += value.value.length;
        if (size > RELAY_BODY_LIMIT) { await reader.cancel(); throw new Error('Response too large.'); }
        chunks.push(Buffer.from(value.value));
      }
    } finally { reader.releaseLock(); }
  }
  return Buffer.concat(chunks);
}

/** OAuth public handling is shared; encrypted relay mode never exposes its plaintext routes. */
export async function createGateway(options: Options) {
  const issuer = new URL(options.issuer);
  if (issuer.protocol !== 'https:' || issuer.origin !== options.issuer || issuer.username || issuer.password) throw new Error('Use an exact HTTPS origin.');
  const upstream = new URL(options.upstream);
  if (upstream.protocol !== 'http:' || upstream.hostname !== '127.0.0.1' || upstream.pathname !== '/mcp') throw new Error('Upstream must be the local AutoDev MCP endpoint.');
  const relay = options.relayKey === undefined ? undefined : new RelayChannel({ issuer: options.issuer, key: options.relayKey });
  const gate = new OAuthGate({ issuer: options.issuer, ...(options.oauthStateFile ? { stateStore: new EncryptedOAuthStateStore({ filePath: options.oauthStateFile, issuer: options.issuer }) } : {}) });
  const managementCommand = options.managementCommand === 'fixed-tunnel.ps1' ? 'fixed-tunnel.ps1' : 'connect-chatgpt.ps1';
  let activeRequests = 0;
  let activeRelays = 0;

  async function publicRequest(req: PublicRequest): Promise<PublicResponse> {
    try {
      req.signal.throwIfAborted();
      const url = new URL(req.path, issuer);
      const instance: [string, string][] = relay && options.instance ? [['x-autodev-instance', options.instance]] : [];
      if (req.method === 'GET' && (url.pathname === '/.well-known/oauth-protected-resource' || url.pathname === '/.well-known/oauth-protected-resource/mcp')) return jsonResult(200, gate.resourceMetadata(), instance);
      if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') return jsonResult(200, gate.metadata(), instance);
      if (req.method === 'POST' && url.pathname === '/oauth/register') return jsonResult(201, gate.register(JSON.parse(await req.read())));
      if (req.method === 'POST' && url.pathname === '/oauth/token') return jsonResult(200, gate.token(new URLSearchParams(await req.read())));
      if (req.method === 'GET' && url.pathname === '/oauth/authorize') {
        const pending = gate.begin(url.searchParams);
        return result(200, `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="refresh" content="3;url=/oauth/result?request_id=${encodeURIComponent(pending.request_id)}"><title>AutoDev 連線核准</title><style>body{font:18px system-ui;max-width:640px;margin:12vh auto;padding:24px;line-height:1.7;background:#f5f5f3;color:#202624}code{word-break:break-all}</style><h1>確認連接 AutoDev</h1><p>請在執行 AutoDev 的電腦核對下列代碼，並使用本機連線管理指令批准。這會允許此連線交辦、查看證據及記錄審查；Codex 提權仍需另外核准。</p><p>應用程式：${escape(pending.client_name)}</p><p>核對碼：<strong>${escape(pending.verification_code)}</strong></p><p>請求：<code>${escape(pending.request_id)}</code></p><p>此頁會自動等待核准。不需要 OpenAI API Key，也不收取 API 模型費用。</p></html>`, [['content-type', 'text/html; charset=utf-8'], ['cache-control', 'no-store'], ['referrer-policy', 'no-referrer'], ['content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'"]]);
      }
      if (req.method === 'GET' && url.pathname === '/oauth/result') {
        const id = url.searchParams.get('request_id') ?? '';
        const decision = gate.finish(id);
        if (decision.status === 'pending') {
          const pending = gate.pendingRequests().find(value => value.request_id === id);
          return result(200, `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="refresh" content="3"><title>等待 AutoDev 核准</title><h1>等待本機核准</h1><p>應用程式：${escape(pending?.client_name ?? '')}</p><p>核對碼：<strong>${escape(pending?.verification_code ?? '')}</strong></p><p>請求：<code>${escape(id)}</code></p><p>請在本機使用 ${managementCommand} 核對並執行 approve。此頁會自動接續。</p></html>`, [['content-type', 'text/html; charset=utf-8'], ['cache-control', 'no-store'], ['referrer-policy', 'no-referrer'], ['content-security-policy', "default-src 'none'; frame-ancestors 'none'"]]);
        }
        return result(302, '', [['location', decision.redirect_url], ['cache-control', 'no-store'], ['referrer-policy', 'no-referrer']]);
      }
      if (url.pathname !== '/mcp' || url.search) return jsonResult(404, { error: 'not_found' });
      if (req.method === 'GET') return jsonResult(405, { error: 'SSE is unavailable; use JSON POST.' });
      if (req.method !== 'POST') return jsonResult(405, { error: 'method_not_allowed' });
      const header = req.headers.get('authorization');
      const authentication: [string, string][] = [['www-authenticate', `Bearer resource_metadata="${options.issuer}/.well-known/oauth-protected-resource/mcp"`]];
      if (!header?.startsWith('Bearer ')) return jsonResult(401, { error: 'invalid_token' }, authentication);
      let grant;
      try { grant = gate.verify(header.slice(7)); } catch { return jsonResult(401, { error: 'invalid_token' }, authentication); }
      if (req.headers.get('mcp-session-id')) return jsonResult(404, { error: 'stateless_mcp_reconnect_without_session_id' });
      if (activeRequests >= 64) return jsonResult(429, { error: 'concurrent_request_capacity' });
      activeRequests++;
      try {
        const content = await req.read();
        const headers: Record<string, string> = { Authorization: `Bearer ${options.clientToken}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json',
          ...gatewayAssertion(options.adminToken, { issuer: options.issuer, grantId: grant.grant_id, expiresAt: grant.expires_at, body: content }) };
        const protocol = req.headers.get('mcp-protocol-version');
        if (protocol !== null) headers['mcp-protocol-version'] = protocol;
        const response = await fetch(upstream, { method: 'POST', headers, body: content, signal: AbortSignal.any([req.signal, AbortSignal.timeout(60_000)]), redirect: 'error' });
        if (response.headers.get('mcp-session-id') || (response.headers.get('content-type') ?? '').includes('text/event-stream')) {
          await response.body?.cancel(); throw new Error('The trusted gateway requires stateless JSON MCP responses.');
        }
        const contentBody = relay ? await responseBody(response) : Buffer.from(await response.text(), 'utf8');
        return result(response.status, contentBody, [['content-type', response.headers.get('content-type') ?? 'application/json'], ['cache-control', 'no-store']]);
      } finally { activeRequests--; }
    } catch (error) { return jsonResult(error instanceof OAuthError ? error.status : 400, { error: error instanceof OAuthError ? error.code : 'request_rejected' }); }
  }

  const publicServer = createServer(async (req, res) => {
    const controller = new AbortController();
    const timer = setTimeout(() => { if (!res.writableEnded && !res.destroyed) json(res, 400, { error: 'request_rejected' }); controller.abort(); }, 65_000);
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', disconnected);
    let heldRelay = false;
    try {
      if (req.headers.host !== issuer.host && req.headers.host !== `127.0.0.1:${options.publicPort}`) {
        json(res, relay ? 400 : 403, { error: relay ? 'request_rejected' : 'invalid_host' }); return;
      }
      if (relay) {
        if (req.method !== 'POST' || req.url !== RELAY_PATH || activeRelays >= 64) { json(res, 400, { error: 'request_rejected' }); return; }
        activeRelays++; heldRelay = true;
        const opened = relay.open(JSON.parse(await body(req, RELAY_WIRE_LIMIT, controller.signal)));
        const decoded = decodeRelayBase64(opened.request.body, RELAY_BODY_LIMIT);
        const response = await publicRequest({ method: opened.request.method, path: opened.request.path, headers: new Headers(opened.request.headers),
          read: async () => { controller.signal.throwIfAborted(); return decoded.toString('utf8'); }, signal: controller.signal });
        controller.signal.throwIfAborted();
        const encrypted = relay.sealResponse(opened.id, { status: response.status, headers: response.headers, body: response.body.toString('base64url') });
        if (!res.writableEnded && !res.destroyed) json(res, 200, encrypted);
        return;
      }
      const headers = new Headers();
      for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
      const response = await publicRequest({ method: req.method ?? '', path: req.url ?? '/', headers, read: () => body(req, RELAY_BODY_LIMIT, controller.signal), signal: controller.signal });
      if (!res.writableEnded && !res.destroyed) { res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(response.body); }
    } catch { if (!res.writableEnded && !res.destroyed) json(res, 400, { error: 'request_rejected' }); }
    finally { clearTimeout(timer); res.removeListener('close', disconnected); if (heldRelay) activeRelays--; }
  });

  const controlServer = createServer(async (req, res) => {
    try {
      if (req.headers.host !== `127.0.0.1:${options.controlPort}` || req.headers.origin) { json(res, 403, { error: 'invalid_origin' }); return; }
      if (!authorized(req.headers.authorization, options.adminToken)) { json(res, 401, { error: 'authentication_required' }); return; }
      if (req.url === '/status' && req.method === 'GET') { json(res, 200, { process_id: process.pid, instance_id: options.instance ?? 'test', issuer: options.issuer, pending: gate.pendingRequests() }); return; }
      if (req.url === '/approve' && req.method === 'POST') {
        const value = JSON.parse(await body(req)) as Record<string, unknown>;
        if (typeof value.request_id !== 'string' || typeof value.verification_code !== 'string' || typeof value.approve !== 'boolean') throw new Error('Invalid approval.');
        json(res, 200, gate.localApproval(value.request_id, value.approve, value.verification_code)); return;
      }
      if (req.url === '/shutdown' && req.method === 'POST') { json(res, 200, { stopping: true }); setImmediate(() => options.onShutdown?.()); return; }
      json(res, 404, { error: 'not_found' });
    } catch { json(res, 400, { error: 'request_rejected' }); }
  });
  publicServer.requestTimeout = 65_000; controlServer.requestTimeout = 10_000;
  const close = async () => { for (const server of [publicServer, controlServer]) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } relay?.close(); };
  try {
    for (const [server, port] of [[controlServer, options.controlPort], [publicServer, options.publicPort]] as const) await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  } catch (error) { await close(); throw error; }
  return { close };
}
