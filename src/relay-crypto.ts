import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const RELAY_PATH = '/_autodev/relay';
export const RELAY_WIRE_LIMIT = 4 * 1024 * 1024;
export const RELAY_PLAINTEXT_LIMIT = 3 * 1024 * 1024;
export const RELAY_BODY_LIMIT = 2 * 1024 * 1024;
export type RelayEnvelope = { v: 1; id: string; iv: string; data: string };
export type RelayRequest = { method: string; path: string; headers: [string, string][]; body: string; issuedAt: number };
export type RelayResponse = { status: number; headers: [string, string][]; body: string };
export class RelayError extends Error { constructor() { super('Relay request rejected.'); this.name = 'RelayError'; } }

const requestHeaders = new Set(['authorization', 'accept', 'content-type', 'mcp-protocol-version', 'mcp-session-id']);
const responseHeaders = new Set(['content-type', 'cache-control', 'referrer-policy', 'content-security-policy', 'location', 'www-authenticate', 'x-autodev-instance']);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, names: string) => Object.keys(value).sort().join(',') === names.split(',').sort().join(',');
const validTime = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const aad = (issuer: string, direction: 'request' | 'response', id: string) => Buffer.from(`AutoDev relay v1\n${direction}\n${issuer}\n${id}`, 'utf8');
const decoder = new TextDecoder('utf-8', { fatal: true });

export function decodeRelayBase64(value: unknown, maximum: number, exactBytes?: number): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum * 4 / 3) || !/^[A-Za-z0-9_-]*$/.test(value)) throw new RelayError();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length > maximum || (exactBytes !== undefined && bytes.length !== exactBytes) || bytes.toString('base64url') !== value) throw new RelayError();
  return bytes;
}

function headers(value: unknown, allowed: Set<string>): [string, string][] {
  if (!Array.isArray(value) || value.length > allowed.size) throw new RelayError();
  const seen = new Set<string>();
  let size = 0;
  return value.map(pair => {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string' || !allowed.has(pair[0].toLowerCase()) || seen.has(pair[0].toLowerCase()) || /[\x00-\x1f\x7f]/.test(pair[1])) throw new RelayError();
    size += pair[0].length + pair[1].length;
    if (size > 32 * 1024) throw new RelayError();
    seen.add(pair[0].toLowerCase());
    return [pair[0].toLowerCase(), pair[1]];
  });
}

function validTarget(method: unknown, target: unknown, issuer: string): boolean {
  if (typeof method !== 'string' || typeof target !== 'string' || target.length > 16 * 1024 || !target.startsWith('/') || target.startsWith('//') || /[\\#\x00-\x20\x7f]/.test(target)) return false;
  try {
    const url = new URL(target, issuer);
    if (url.origin !== issuer || url.pathname + url.search !== target) return false;
    if (method === 'GET' && ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server', '/oauth/authorize', '/oauth/result'].includes(url.pathname)) return true;
    if (method === 'POST' && ['/oauth/register', '/oauth/token'].includes(url.pathname)) return true;
    return ['GET', 'POST', 'DELETE'].includes(method) && url.pathname === '/mcp' && !url.search;
  } catch { return false; }
}

function request(value: unknown, issuer: string, now: number): RelayRequest {
  if (!object(value) || !exact(value, 'method,path,headers,body,issuedAt') || !validTarget(value.method, value.path, issuer) || !validTime(value.issuedAt) || Math.abs(value.issuedAt - now) > 60_000) throw new RelayError();
  const body = decodeRelayBase64(value.body, RELAY_BODY_LIMIT);
  if (value.method === 'GET' && body.length !== 0) throw new RelayError();
  return { method: value.method as string, path: value.path as string, headers: headers(value.headers, requestHeaders), body: body.toString('base64url'), issuedAt: value.issuedAt };
}

function response(value: unknown): RelayResponse {
  if (!object(value) || !exact(value, 'status,headers,body') || typeof value.status !== 'number' || !Number.isInteger(value.status) || value.status < 200 || value.status > 599) throw new RelayError();
  const body = decodeRelayBase64(value.body, RELAY_BODY_LIMIT);
  if ([204, 304].includes(value.status) && body.length !== 0) throw new RelayError();
  return { status: value.status, headers: headers(value.headers, responseHeaders), body: body.toString('base64url') };
}

/** One random in-memory key per runner lifetime; no key or envelope is logged. */
export class RelayChannel {
  private readonly key: Buffer;
  private readonly issuer: string;
  private readonly clock: () => number;
  private lastNow = 0;
  private closed = false;
  private readonly seen = new Map<string, { expires: number; responded: boolean; requestIv: string }>();
  constructor(options: { issuer: string; key: Buffer; now?: () => number }) {
    const url = new URL(options.issuer);
    if (url.protocol !== 'https:' || url.origin !== options.issuer || url.username || url.password || !Buffer.isBuffer(options.key) || options.key.length !== 32) throw new RelayError();
    this.key = Buffer.from(options.key);
    this.issuer = options.issuer;
    this.clock = options.now ?? Date.now;
  }

  open(value: unknown): { id: string; request: RelayRequest } {
    try {
      if (this.closed || !object(value) || !exact(value, 'v,id,iv,data') || value.v !== 1 || Buffer.byteLength(JSON.stringify(value)) > RELAY_WIRE_LIMIT) throw 0;
      const id = decodeRelayBase64(value.id, 16, 16).toString('base64url');
      const iv = decodeRelayBase64(value.iv, 12, 12);
      const data = decodeRelayBase64(value.data, RELAY_PLAINTEXT_LIMIT + 16);
      if (data.length < 16) throw 0;
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAAD(aad(this.issuer, 'request', id));
      decipher.setAuthTag(data.subarray(-16));
      const plaintext = Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]);
      try {
        if (plaintext.length > RELAY_PLAINTEXT_LIMIT) throw 0;
        const current = this.clock();
        if (!validTime(current)) throw 0;
        const now = this.lastNow = Math.max(this.lastNow, current);
        const opened = request(JSON.parse(decoder.decode(plaintext)), this.issuer, now);
        for (const [key, value] of this.seen) if (value.expires <= now) this.seen.delete(key);
        if (this.seen.has(id) || this.seen.size >= 4096) throw 0;
        this.seen.set(id, { expires: now + 120_000, responded: false, requestIv: iv.toString('base64url') });
        return { id, request: opened };
      } finally { plaintext.fill(0); }
    } catch { throw new RelayError(); }
  }

  sealResponse(id: string, value: RelayResponse): RelayEnvelope {
    try {
      const entry = this.seen.get(id);
      if (this.closed || !entry || entry.responded) throw 0;
      const plaintext = Buffer.from(JSON.stringify(response(value)));
      try {
        if (plaintext.length > RELAY_PLAINTEXT_LIMIT) throw 0;
        let iv: Buffer;
        do { iv = randomBytes(12); } while (iv.toString('base64url') === entry.requestIv);
        const cipher = createCipheriv('aes-256-gcm', this.key, iv);
        cipher.setAAD(aad(this.issuer, 'response', id));
        const data = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
        const envelope: RelayEnvelope = { v: 1, id, iv: iv.toString('base64url'), data: data.toString('base64url') };
        if (Buffer.byteLength(JSON.stringify(envelope)) > RELAY_WIRE_LIMIT) throw 0;
        entry.responded = true;
        return envelope;
      } finally { plaintext.fill(0); }
    } catch { throw new RelayError(); }
  }

  close(): void { this.closed = true; this.key.fill(0); this.seen.clear(); }
}
