// This Worker only relays encrypted traffic to one short-lived, locally owned route.
export const LIMITS = Object.freeze({ body: 2 * 1024 * 1024, plain: 3 * 1024 * 1024,
  wire: 4 * 1024 * 1024, route: 2048, headers: 16 * 1024, url: 8192,
  minLease: 20 * 60_000, maxLease: 60 * 60_000, timeout: 65_000 });
const ROUTE_KEY = 'active-route';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const ROUTES = new Map([
  ['/.well-known/oauth-protected-resource', ['GET']],
  ['/.well-known/oauth-protected-resource/mcp', ['GET']],
  ['/.well-known/oauth-authorization-server', ['GET']],
  ['/oauth/register', ['POST']], ['/oauth/token', ['POST']],
  ['/oauth/authorize', ['GET']], ['/oauth/result', ['GET']], ['/mcp', ['POST']],
]);
const RESPONSE_HEADERS = new Set(['content-type', 'www-authenticate', 'content-security-policy',
  'referrer-policy', 'allow']);

class Rejected extends Error {
  constructor(status = 503) { super('request_rejected'); this.status = status; }
}
function json(status, value) {
  return new Response(JSON.stringify(value), { status, headers: {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  } });
}
function unavailable(stage) {
  const response = json(503, { error: 'temporarily_unavailable' });
  // Only finite diagnostic labels and HTTP status numbers can leave this boundary.
  const safeStage = /^(?:request_validation|route_auth|route_write|route_lookup|request_crypto|relay_fetch|relay_encoding|relay_content_type|response_crypto|public_response|relay_http_[1-5][0-9]{2})$/.test(stage)
    ? stage : 'request_validation';
  response.headers.set('x-autodev-failure', safeStage);
  return response;
}
function exactKeys(value, names) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}
function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromBase64(value, max, exact) {
  if (typeof value !== 'string' || value.length > Math.ceil(max * 4 / 3) || !/^[A-Za-z0-9_-]*$/.test(value)) throw new Rejected();
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
  if (binary.length > max || (exact !== undefined && binary.length !== exact)) throw new Rejected();
  const result = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) result[i] = binary.charCodeAt(i);
  if (toBase64(result) !== value) throw new Rejected();
  return result;
}
function validateRoute(value, now, registration = false) {
  if (!exactKeys(value, ['origin', 'expiresAt', 'relayKey']) || typeof value.origin !== 'string' ||
      !/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$/.test(value.origin)) throw new Rejected();
  const origin = new URL(value.origin);
  if (origin.origin !== value.origin) throw new Rejected();
  if (typeof value.expiresAt !== 'string') throw new Rejected();
  const expires = Date.parse(value.expiresAt);
  if (!Number.isFinite(expires) || new Date(expires).toISOString() !== value.expiresAt ||
      expires <= now || expires - now > LIMITS.maxLease || (registration && expires - now < LIMITS.minLease)) throw new Rejected();
  fromBase64(value.relayKey, 32, 32);
  return { ...value, expires };
}
async function readRoute(env, now) {
  const raw = await env.ROUTES.get(ROUTE_KEY, { type: 'text', cacheTtl: 30 });
  if (raw === null) return null;
  if (typeof raw !== 'string' || raw.length > LIMITS.route) throw new Rejected();
  const value = JSON.parse(raw);
  // An expired or malformed lease never supplies a fallback destination.
  try { return validateRoute(value, now()); } catch { return null; }
}
async function authorized(header, secret, cryptoImpl) {
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(secret)) throw new Rejected();
  if (typeof header !== 'string' || header.length > 136 || !header.startsWith('Bearer ')) return false;
  // WebCrypto verifies the MAC in constant time; no Node compatibility shim is needed.
  const key = await cryptoImpl.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const expected = await cryptoImpl.subtle.sign('HMAC', key, encoder.encode(secret));
  return cryptoImpl.subtle.verify('HMAC', key, expected, encoder.encode(header.slice(7)));
}
function raceAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(new Rejected());
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Rejected());
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function readBounded(message, limit, signal, status = 503) {
  const length = message.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) throw new Rejected(status);
  if (!message.body) return new Uint8Array();
  const reader = message.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await raceAbort(reader.read(), signal);
      if (done) break;
      if (!(value instanceof Uint8Array) || (size += value.byteLength) > limit) throw new Rejected(status);
      chunks.push(value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return body;
  } catch (error) {
    // Cancellation is best effort and handled; a hostile stream must not delay rejection.
    reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}
function requestHeaders(request, pathname) {
  const headers = [];
  let size = 0;
  const allowed = ['accept', 'content-type'];
  if (pathname === '/mcp') allowed.push('authorization', 'mcp-protocol-version', 'mcp-session-id');
  if (pathname === '/oauth/token') allowed.push('authorization');
  for (const name of allowed) {
    const value = request.headers.get(name);
    if (value !== null) {
      size += name.length + value.length;
      if (size > LIMITS.headers) throw new Rejected(431);
      headers.push([name, value]);
    }
  }
  return headers;
}
function allowedRedirect(location, issuer) {
  if (typeof location !== 'string' || location.length > 4096) return false;
  let url;
  try { url = new URL(location); } catch { return false; }
  if (url.href !== location || url.protocol !== 'https:' || url.hostname !== 'chatgpt.com' ||
      url.port || url.username || url.password || url.hash ||
      !(url.pathname === '/connector_platform_oauth_redirect' || /^\/connector\/oauth\/[A-Za-z0-9_-]{1,128}$/.test(url.pathname))) return false;
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 3 || new Set(keys).size !== 3 || !keys.includes('state') || !keys.includes('iss') ||
      url.searchParams.get('iss') !== issuer) return false;
  const state = url.searchParams.get('state');
  if (!state || state.length > 1024 || /[\x00-\x1f\x7f]/.test(state)) return false;
  return (keys.includes('code') && /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('code'))) ||
    (keys.includes('error') && url.searchParams.get('error') === 'access_denied');
}
function publicResponse(plain, pathname, issuer) {
  if (!exactKeys(plain, ['status', 'headers', 'body']) || !Number.isInteger(plain.status) ||
      plain.status < 200 || plain.status > 599 || !Array.isArray(plain.headers) || plain.headers.length > 64) throw new Rejected();
  const body = fromBase64(plain.body, LIMITS.body);
  const headers = new Headers();
  let size = 0;
  const seen = new Set();
  for (const pair of plain.headers) {
    if (!Array.isArray(pair) || pair.length !== 2 || pair.some(value => typeof value !== 'string') ||
        /[\r\n\0]/.test(pair.join(''))) throw new Rejected();
    const [name, value] = pair;
    size += name.length + value.length;
    const lower = name.toLowerCase();
    if (size > LIMITS.headers || seen.has(lower)) throw new Rejected();
    seen.add(lower);
    if (RESPONSE_HEADERS.has(lower) || lower === 'location') headers.set(lower, value);
    if (lower === 'x-autodev-instance' && pathname.startsWith('/.well-known/')) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Rejected();
      headers.set(lower, value);
    }
  }
  if (plain.status >= 500 || plain.status === 429) throw new Rejected();
  if (plain.status >= 300 && plain.status < 400) {
    if (pathname !== '/oauth/result' || plain.status !== 302 || !allowedRedirect(headers.get('location'), issuer)) throw new Rejected();
    headers.set('cache-control', 'no-store');
    headers.set('referrer-policy', 'no-referrer');
    return new Response(null, { status: 302, headers });
  }
  if (headers.has('location')) throw new Rejected();
  const media = (headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const html = pathname === '/oauth/authorize' || pathname === '/oauth/result';
  if (![204, 205].includes(plain.status) && media !== 'application/json' && !(html && media === 'text/html')) throw new Rejected();
  headers.set('cache-control', 'no-store');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  if (media === 'text/html') headers.set('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'");
  if ([204, 205, 304].includes(plain.status) && body.length) throw new Rejected();
  return new Response([204, 205, 304].includes(plain.status) ? null : body, { status: plain.status, headers });
}
async function encryptedForward(request, url, route, deps, signal, body, trace) {
  trace.stage = 'request_crypto';
  const key = await deps.crypto.subtle.importKey('raw', fromBase64(route.relayKey, 32, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const id = toBase64(deps.crypto.getRandomValues(new Uint8Array(16)));
  const iv = deps.crypto.getRandomValues(new Uint8Array(12));
  const plain = encoder.encode(JSON.stringify({ method: request.method, path: url.pathname + url.search,
    headers: requestHeaders(request, url.pathname), body: toBase64(body), issuedAt: deps.now() }));
  if (plain.length > LIMITS.plain) throw new Rejected(413);
  const data = new Uint8Array(await deps.crypto.subtle.encrypt({ name: 'AES-GCM', iv,
    additionalData: encoder.encode(`AutoDev relay v1\nrequest\n${url.origin}\n${id}`), tagLength: 128 }, key, plain));
  const envelope = JSON.stringify({ v: 1, id, iv: toBase64(iv), data: toBase64(data) });
  if (encoder.encode(envelope).length > LIMITS.wire) throw new Rejected(413);
  if (route.expires <= deps.now() || signal.aborted) throw new Rejected();
  // No public headers or credentials reach the tunnel outside the authenticated ciphertext.
  trace.stage = 'relay_fetch';
  const upstream = await raceAbort(deps.fetch(route.origin + '/_autodev/relay', { method: 'POST',
    headers: { 'content-type': 'application/json', 'accept': 'application/json', 'accept-encoding': 'identity' },
    body: envelope, redirect: 'manual', signal }), signal);
  if (upstream.status !== 200) {
    trace.stage = `relay_http_${upstream.status}`;
    upstream.body?.cancel().catch(() => {});
    throw new Rejected();
  }
  if (upstream.headers.has('content-encoding') && upstream.headers.get('content-encoding') !== 'identity') {
    trace.stage = 'relay_encoding';
    upstream.body?.cancel().catch(() => {});
    throw new Rejected();
  }
  if ((upstream.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    trace.stage = 'relay_content_type';
    upstream.body?.cancel().catch(() => {});
    throw new Rejected();
  }
  trace.stage = 'response_crypto';
  const wire = JSON.parse(decoder.decode(await readBounded(upstream, LIMITS.wire, signal)));
  if (!exactKeys(wire, ['v', 'id', 'iv', 'data']) || wire.v !== 1 || wire.id !== id) throw new Rejected();
  const responseIv = fromBase64(wire.iv, 12, 12);
  if (wire.iv === toBase64(iv)) throw new Rejected();
  const responseData = fromBase64(wire.data, LIMITS.plain + 16);
  if (responseData.length < 16) throw new Rejected();
  const decoded = await deps.crypto.subtle.decrypt({ name: 'AES-GCM', iv: responseIv,
    additionalData: encoder.encode(`AutoDev relay v1\nresponse\n${url.origin}\n${id}`), tagLength: 128 }, key, responseData);
  if (decoded.byteLength > LIMITS.plain || route.expires <= deps.now() || signal.aborted) throw new Rejected();
  trace.stage = 'public_response';
  return publicResponse(JSON.parse(decoder.decode(decoded)), url.pathname, url.origin);
}

/** Dependency injection is per instance for tests; production holds no request or route cache. */
export function createWorker({ fetch: fetchImpl = (...args) => globalThis.fetch(...args), now = Date.now,
  crypto: cryptoImpl = globalThis.crypto, timeout = LIMITS.timeout } = {}) {
  const deps = { fetch: fetchImpl, now, crypto: cryptoImpl };
  return { async fetch(request, env) {
    const trace = { stage: 'request_validation' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const abort = () => controller.abort();
    request.signal.addEventListener('abort', abort, { once: true });
    try {
      if (request.signal.aborted) throw new Rejected();
      const url = new URL(request.url);
      if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || request.url.length > LIMITS.url) return json(400, { error: 'invalid_request' });
      if (url.pathname === '/_autodev/route') {
        if (request.method !== 'PUT' || url.search) return json(404, { error: 'not_found' });
        trace.stage = 'route_auth';
        if (!await authorized(request.headers.get('authorization'), env.ROUTE_SECRET, cryptoImpl)) return json(401, { error: 'unauthorized' });
        trace.stage = 'request_validation';
        if ((request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() !== 'application/json' || request.headers.has('content-encoding')) return json(400, { error: 'invalid_request' });
        const routeBody = await readBounded(request, LIMITS.route, controller.signal, 413);
        let route;
        try { route = validateRoute(JSON.parse(decoder.decode(routeBody)), now(), true); }
        catch { return json(400, { error: 'invalid_request' }); }
        trace.stage = 'route_write';
        await raceAbort(env.ROUTES.put(ROUTE_KEY, JSON.stringify({ origin: route.origin, expiresAt: route.expiresAt, relayKey: route.relayKey }),
          { expirationTtl: Math.floor((route.expires - now()) / 1000) }), controller.signal);
        return json(200, { ok: true, expiresAt: route.expiresAt });
      }
      if (url.pathname === '/_autodev/health') {
        if (request.method !== 'GET' || url.search) return json(404, { error: 'not_found' });
        trace.stage = 'route_lookup';
        const route = await raceAbort(readRoute(env, now), controller.signal);
        return json(200, { ok: true, routeReady: route !== null });
      }
      const methods = ROUTES.get(url.pathname);
      if (!methods) return json(404, { error: 'not_found' });
      if (!methods.includes(request.method)) return json(405, { error: 'method_not_allowed' });
      if (url.search && url.pathname !== '/oauth/authorize' && url.pathname !== '/oauth/result') return json(400, { error: 'invalid_request' });
      if (request.headers.has('content-encoding') || request.headers.has('upgrade')) return json(400, { error: 'invalid_request' });
      const body = await readBounded(request, LIMITS.body, controller.signal, 413);
      if (request.method === 'GET' && body.length) return json(400, { error: 'invalid_request' });
      trace.stage = 'route_lookup';
      const route = await raceAbort(readRoute(env, now), controller.signal);
      if (!route) throw new Rejected();
      return await encryptedForward(request, url, route, deps, controller.signal, body, trace);
    } catch (error) {
      if (error instanceof Rejected && error.status !== 503) return json(error.status, { error: 'request_rejected' });
      return unavailable(trace.stage);
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', abort);
    }
  } };
}

export default createWorker();
