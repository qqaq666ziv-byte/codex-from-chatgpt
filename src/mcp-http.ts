import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from './mcp.js';
import type { AutoDev } from './product.js';
import { GatewayIdentityVerifier } from './gateway-identity.js';

type LocalSession = { transport: StreamableHTTPServerTransport; tag: string; lastUsed: number; active: number };
type Principal = { lastUsed: number; active: number };
type Options = { product: AutoDev; hosts: string[]; adminToken: string; now?: () => number; principalIdleMs?: number; localIdleMs?: number };
function json(res: ServerResponse, status: number, error: string) {
  if (!res.headersSent) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ error })); }
}
async function rawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) { const value = Buffer.from(chunk); bytes += value.length; if (bytes > 2 * 1024 * 1024) throw new Error('Request too large.'); chunks.push(value); }
  return Buffer.concat(chunks).toString('utf8');
}

/** Authentication/Host checks run in index.ts before this HTTP lifecycle adapter. */
export function createMcpHttpHandler(options: Options) {
  const now = options.now ?? Date.now;
  const verifier = new GatewayIdentityVerifier(options.adminToken, now);
  const sessions = new Map<string, LocalSession>();
  const initializing = new Set<LocalSession>();
  const gatewayTransports = new Set<StreamableHTTPServerTransport>();
  const principals = new Map<string, Principal>();
  const principalIdleMs = options.principalIdleMs ?? 30 * 60_000;
  const localIdleMs = options.localIdleMs ?? 5 * 60_000;
  let closing = false;
  function holdLocalSession(session: LocalSession, res: ServerResponse) {
    session.active++; session.lastUsed = now(); let released = false;
    const release = () => { if (released) return; released = true; session.active--; session.lastUsed = now(); };
    res.once('close', release);
    return release;
  }
  async function sweep() {
    const time = now();
    for (const [principal, value] of principals) if (!value.active && value.lastUsed + principalIdleMs <= time) { principals.delete(principal); options.product.forgetSession(principal); }
    for (const session of sessions.values()) if (!session.active && session.lastUsed + localIdleMs <= time) await session.transport.close();
  }
  const timer = setInterval(() => { void sweep().catch(() => {}); }, 60_000);
  timer.unref();
  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (closing) { json(res, 503, 'MCP service is closing.'); return; }
    await sweep();
    const raw = req.method === 'POST' ? await rawBody(req) : '';
    let principal: string | undefined;
    try { principal = verifier.verify(req.headers, req.method, req.url, raw); }
    catch { json(res, 401, 'Gateway identity rejected.'); return; }
    if (principal) {
      if (req.headers['mcp-session-id']) { json(res, 404, 'Gateway uses stateless MCP; reconnect without a session ID.'); return; }
      let owner = principals.get(principal);
      if (!owner) {
        if (principals.size >= 128) { json(res, 429, 'Review connection capacity reached; wait for idle connections to expire.'); return; }
        owner = { lastUsed: now(), active: 0 }; principals.set(principal, owner);
      }
      if (gatewayTransports.size >= 64) { json(res, 429, 'Concurrent request capacity reached.'); return; }
      owner.active++; owner.lastUsed = now();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, enableDnsRebindingProtection: true, allowedHosts: options.hosts });
      const mcp = createMcpServer(options.product, principal);
      gatewayTransports.add(transport);
      let closed = false;
      const cleanup = async () => {
        if (closed) return; closed = true;
        gatewayTransports.delete(transport); owner!.active--; owner!.lastUsed = now();
        await mcp.close().catch(() => {});
      };
      res.once('close', () => { void cleanup(); });
      try { await mcp.connect(transport); await transport.handleRequest(req, res, JSON.parse(raw)); }
      finally { await cleanup(); }
      return;
    }
    const id = typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : undefined;
    let session = id ? sessions.get(id) : undefined;
    if (req.method === 'POST') {
      const parsed: unknown = JSON.parse(raw);
      let created = false;
      if (!session && !id && isInitializeRequest(parsed)) {
        if (sessions.size + initializing.size >= 32) {
          const oldest = [...sessions.values()].filter(value => value.active === 0).sort((a, b) => a.lastUsed - b.lastUsed)[0];
          if (oldest) await oldest.transport.close();
          if (sessions.size + initializing.size >= 32) { json(res, 429, 'Concurrent local session capacity reached.'); return; }
        }
        const tag = `local:${randomUUID()}`;
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true, enableDnsRebindingProtection: true, allowedHosts: options.hosts,
          onsessioninitialized: newId => { initializing.delete(entry); sessions.set(newId, entry); } });
        const entry: LocalSession = { transport, tag, lastUsed: now(), active: 0 };
        initializing.add(entry);
        transport.onclose = () => { initializing.delete(entry); if (transport.sessionId) sessions.delete(transport.sessionId); options.product.forgetSession(tag); };
        try { await createMcpServer(options.product, tag).connect(transport); }
        catch (error) { initializing.delete(entry); await transport.close().catch(() => {}); throw error; }
        session = entry;
        created = true;
      }
      if (!session) { json(res, 404, 'Unknown MCP session; reconnect and use autodev_status to recover.'); return; }
      const release = holdLocalSession(session, res);
      try { await session.transport.handleRequest(req, res, parsed); }
      finally {
        release();
        if (created && !session.transport.sessionId) await session.transport.close();
      }
      return;
    }
    if ((req.method === 'GET' || req.method === 'DELETE') && session) {
      const release = holdLocalSession(session, res);
      try { await session.transport.handleRequest(req, res); }
      finally { release(); }
      return;
    }
    json(res, 405, 'Unsupported method or missing session.');
  }
  async function close() {
    closing = true; clearInterval(timer);
    for (const transport of gatewayTransports) await transport.close().catch(() => {});
    for (const session of [...sessions.values(), ...initializing]) await session.transport.close().catch(() => {});
    for (const principal of principals.keys()) options.product.forgetSession(principal);
    principals.clear();
  }
  return { handle, close, sweep };
}
