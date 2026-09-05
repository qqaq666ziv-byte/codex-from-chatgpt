import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export type OAuthErrorCode = "invalid_request" | "invalid_client_metadata" | "invalid_redirect_uri" | "invalid_client" | "unauthorized_client" | "invalid_scope" | "invalid_target" | "invalid_grant" | "unsupported_grant_type" | "invalid_token" | "access_denied" | "temporarily_unavailable";
export class OAuthError extends Error {
  constructor(readonly code: OAuthErrorCode, readonly status: number, message: string) {
    super(message);
    this.name = "OAuthError";
  }
}

export type OAuthGateOptions = { issuer: string; now?: () => number };
export type OAuthPendingRequest = { request_id: string; verification_code: string; expires_at: string; client_name: string; scope: "autodev" };
export type OAuthTokenResult = { access_token: string; token_type: "Bearer"; expires_in: number; refresh_token: string; scope: "autodev" };
export type OAuthIdentity = { grant_id: string; client_id: string; resource: string; scope: "autodev"; expires_at: string };
type Client = { id: string; name: string; redirects: string[] };
type Consent = {
  id: string; verificationCode: string; clientId: string; clientName: string; redirect: string; state: string;
  challenge: string; expiresAt: number; status: "pending" | "approved" | "denied"; redirectUrl?: string; codeHash?: string;
};
type Grant = { id: string; clientId: string; expiresAt: number; rotations: number };
type TokenRef = { grantId: string; expiresAt: number };
const PENDING_MS = 5 * 60_000;
const CODE_MS = 60_000;
const ACCESS_MS = 10 * 60_000;
const GRANT_MS = 8 * 60 * 60_000;
const CAPACITY = 32;
const MAX_ROTATIONS = 64;
const opaque = () => randomBytes(32).toString("base64url");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const iso = (time: number) => new Date(time).toISOString();
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const equal = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

function failure(code: OAuthErrorCode, message: string, status = 400): never { throw new OAuthError(code, status, message); }
function validRedirect(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512) return false;
  try {
    const url = new URL(value);
    return value === url.href && url.protocol === "https:" && url.hostname === "chatgpt.com" && !url.port && !url.username && !url.password && !url.search && !url.hash &&
      (url.pathname === "/connector_platform_oauth_redirect" || /^\/connector\/oauth\/[A-Za-z0-9_-]{1,128}$/.test(url.pathname));
  } catch { return false; }
}

function validUiLocales(value: string): boolean {
  if (value.length === 0 || value.length > 256) return false;
  const locales = value.split(" ");
  if (locales.length > 8 || locales.some((locale) => !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(locale))) return false;
  try { Intl.getCanonicalLocales(locales); return true; } catch { return false; }
}

function shortCode(): string {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  // Rejection sampling avoids bias even if the readable alphabet changes.
  let result = "";
  while (result.length < 8) {
    for (const byte of randomBytes(16)) {
      if (byte >= Math.floor(256 / alphabet.length) * alphabet.length) continue;
      result += alphabet[byte % alphabet.length]!;
      if (result.length === 8) break;
    }
  }
  return `${result.slice(0, 4)}-${result.slice(4)}`;
}

/**
 * Single-user development OAuth authority; all grants die with this instance.
 * The gateway MUST expose localApproval/pendingRequests only through its
 * authenticated local admin channel, never through public OAuth HTTP routes.
 * No OpenAI API key, hosted identity service or persistent token file is used.
 * DCR public clients + PKCE follow the documented ChatGPT MCP auth contract:
 * https://developers.openai.com/plugins/build/auth
 * This deliberately does not advertise CIMD or accept arbitrary redirect URLs.
 */
export class OAuthGate {
  readonly issuer: string;
  readonly resource: string;
  private readonly clock: () => number;
  private lastNow = 0;
  private readonly clients = new Map<string, Client>();
  private readonly consents = new Map<string, Consent>();
  private readonly codes = new Map<string, string>();
  private readonly grants = new Map<string, Grant>();
  private readonly accessTokens = new Map<string, TokenRef>();
  private readonly refreshTokens = new Map<string, TokenRef>();
  private readonly usedRefresh = new Map<string, TokenRef>();
  private readonly usedCodes = new Map<string, TokenRef>();
  private readonly rates = new Map<string, { since: number; count: number }>();

  constructor(options: OAuthGateOptions) {
    try {
      const issuer = new URL(options.issuer);
      if (issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.search || issuer.hash || issuer.pathname !== "/" ||
          (options.issuer !== issuer.origin && options.issuer !== `${issuer.origin}/`)) throw new Error("Invalid issuer");
      this.issuer = issuer.origin;
    } catch { failure("invalid_request", "OAuth issuer must be one canonical HTTPS origin"); }
    this.resource = `${this.issuer}/mcp`;
    this.clock = options.now ?? Date.now;
  }

  metadata() {
    return {
      issuer: this.issuer, authorization_endpoint: `${this.issuer}/oauth/authorize`, token_endpoint: `${this.issuer}/oauth/token`, registration_endpoint: `${this.issuer}/oauth/register`,
      response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"], scopes_supported: ["autodev"], authorization_response_iss_parameter_supported: true,
    };
  }

  resourceMetadata() {
    return { resource: this.resource, authorization_servers: [this.issuer], scopes_supported: ["autodev"], bearer_methods_supported: ["header"] };
  }

  register(body: unknown) {
    const now = this.prepare("register", 64);
    if (!object(body)) failure("invalid_client_metadata", "Expected public OAuth client metadata");
    const allowed = new Set(["redirect_uris", "client_name", "token_endpoint_auth_method", "grant_types", "response_types"]);
    if (Object.keys(body).some((key) => !allowed.has(key)) || (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none")) failure("invalid_client_metadata", "Only public clients with token endpoint auth method none are supported");
    if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length < 1 || body.redirect_uris.length > 4 || !body.redirect_uris.every(validRedirect) || new Set(body.redirect_uris).size !== body.redirect_uris.length) failure("invalid_redirect_uri", "Redirect URIs must exactly match supported ChatGPT callbacks");
    if (body.grant_types !== undefined && (!Array.isArray(body.grant_types) || [...body.grant_types].sort().join(",") !== "authorization_code,refresh_token")) failure("invalid_client_metadata", "This development client requires authorization_code and refresh_token grants");
    if (body.response_types !== undefined && (!Array.isArray(body.response_types) || body.response_types.length !== 1 || body.response_types[0] !== "code")) failure("invalid_client_metadata", "Only the authorization code response type is supported");
    const name = body.client_name ?? "ChatGPT";
    if (typeof name !== "string" || name.trim().length === 0 || name.length > 120 || /[\x00-\x1f\x7f]/.test(name)) failure("invalid_client_metadata", "Client name must be bounded display text");
    if (this.clients.size >= CAPACITY) failure("temporarily_unavailable", "Development client capacity reached; restart the gateway to register more connections", 503);
    const id = opaque();
    const redirects = [...body.redirect_uris] as string[];
    // ChatGPT reuses DCR client_id for this connection, including reauthorization.
    // Clients therefore live for this process; tokens retain bounded lifetimes.
    this.clients.set(id, { id, name, redirects });
    return { client_id: id, client_id_issued_at: Math.floor(now / 1000), client_name: name, redirect_uris: [...redirects], token_endpoint_auth_method: "none" as const, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] };
  }

  begin(params: URLSearchParams): OAuthPendingRequest {
    const now = this.prepare("begin", 128);
    const form = this.form(params, ["response_type", "client_id", "redirect_uri", "state", "resource", "scope", "code_challenge", "code_challenge_method"], ["ui_locales"]);
    // ChatGPT sends this optional display preference. It never changes consent,
    // identity, scope, token bindings, or the gateway's configured UI language.
    if (form.ui_locales !== undefined && !validUiLocales(form.ui_locales)) failure("invalid_request", "UI locales must be a bounded list of language tags");
    if (form.response_type !== "code") failure("invalid_request", "Only response_type code is supported");
    const client = this.client(form.client_id!);
    if (!validRedirect(form.redirect_uri) || !client.redirects.includes(form.redirect_uri)) failure("invalid_redirect_uri", "Redirect URI was not registered for this client");
    if (!form.state || form.state.length > 1024 || /[\x00-\x1f\x7f]/.test(form.state)) failure("invalid_request", "A bounded state value is required");
    if (form.resource !== this.resource) failure("invalid_target", "Resource must identify this gateway MCP endpoint exactly");
    if (form.scope !== "autodev") failure("invalid_scope", "Only the autodev scope is available");
    if (form.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(form.code_challenge!) || Buffer.from(form.code_challenge!, "base64url").toString("base64url") !== form.code_challenge) failure("invalid_request", "A canonical S256 PKCE challenge is required");
    if (this.consents.size >= CAPACITY) failure("temporarily_unavailable", "Development consent capacity reached; wait for pending requests to finish or expire", 503);
    const consent: Consent = { id: opaque(), verificationCode: shortCode(), clientId: client.id, clientName: client.name, redirect: form.redirect_uri, state: form.state,
      challenge: form.code_challenge!, expiresAt: now + PENDING_MS, status: "pending" };
    this.consents.set(consent.id, consent);
    return this.pendingView(consent);
  }

  pendingRequests(): OAuthPendingRequest[] {
    this.prepare();
    return [...this.consents.values()].filter((consent) => consent.status === "pending").map((consent) => this.pendingView(consent));
  }

  localApproval(requestId: string, approve: boolean, verificationCode: string) {
    const now = this.prepare("approval", 128);
    const consent = this.consent(requestId);
    if (typeof approve !== "boolean" || typeof verificationCode !== "string" || !equal(verificationCode, consent.verificationCode)) failure("access_denied", "Verification code does not match this pending request", 403);
    if (consent.status !== "pending") failure("invalid_request", "This request has already received a local decision");
    this.client(consent.clientId);
    const redirect = new URL(consent.redirect);
    redirect.searchParams.set("state", consent.state);
    redirect.searchParams.set("iss", this.issuer);
    if (approve) {
      const reserved = [...this.consents.values()].filter((entry) => entry.status === "approved").length;
      if (this.grants.size + reserved >= CAPACITY) failure("temporarily_unavailable", "Development grant capacity reached; wait for grants to expire", 503);
      const code = opaque();
      consent.codeHash = digest(code);
      this.codes.set(consent.codeHash, consent.id);
      redirect.searchParams.set("code", code);
      consent.status = "approved";
    } else {
      redirect.searchParams.set("error", "access_denied");
      consent.status = "denied";
    }
    consent.expiresAt = now + CODE_MS;
    consent.redirectUrl = redirect.href;
    return { request_id: consent.id, status: consent.status };
  }

  finish(requestId: string): { status: "pending" } | { status: "approved" | "denied"; redirect_url: string } {
    this.prepare("finish", 2048);
    const consent = this.consent(requestId);
    if (consent.status === "pending") return { status: "pending" };
    return { status: consent.status, redirect_url: consent.redirectUrl! };
  }

  token(params: URLSearchParams): OAuthTokenResult {
    const now = this.prepare("token", 256);
    if (!(params instanceof URLSearchParams) || params.getAll("grant_type").length !== 1) failure("invalid_request", "Exactly one grant_type is required");
    if (params.get("grant_type") === "authorization_code") return this.exchangeCode(params, now);
    if (params.get("grant_type") === "refresh_token") return this.refresh(params, now);
    failure("unsupported_grant_type", "Only authorization_code and refresh_token grants are supported");
  }

  verify(token: string): OAuthIdentity {
    const now = this.prepare();
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) failure("invalid_token", "A valid gateway access token is required", 401);
    const ref = this.accessTokens.get(digest(token));
    const grant = ref ? this.grants.get(ref.grantId) : undefined;
    if (!ref || !grant || ref.expiresAt <= now || grant.expiresAt <= now) failure("invalid_token", "Access token is invalid, expired or revoked", 401);
    return { grant_id: grant.id, client_id: grant.clientId, resource: this.resource, scope: "autodev", expires_at: iso(ref.expiresAt) };
  }

  private exchangeCode(params: URLSearchParams, now: number): OAuthTokenResult {
    const form = this.form(params, ["grant_type", "code", "client_id", "redirect_uri", "resource", "code_verifier"]);
    const client = this.client(form.client_id!);
    if (form.resource !== this.resource) failure("invalid_target", "Resource must identify this gateway MCP endpoint exactly");
    if (!validRedirect(form.redirect_uri) || !client.redirects.includes(form.redirect_uri)) failure("invalid_grant", "Authorization code binding is invalid");
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(form.code_verifier!) || !/^[A-Za-z0-9_-]{43}$/.test(form.code!)) failure("invalid_grant", "Authorization code or PKCE verifier is invalid");
    const codeHash = digest(form.code!);
    const reused = this.usedCodes.get(codeHash);
    if (reused) { this.revoke(reused.grantId); failure("invalid_grant", "Authorization code has already been used; its grant was revoked"); }
    const requestId = this.codes.get(codeHash);
    const consent = requestId ? this.consents.get(requestId) : undefined;
    const challenge = createHash("sha256").update(form.code_verifier!).digest("base64url");
    if (!consent || consent.status !== "approved" || consent.expiresAt <= now || consent.clientId !== client.id || consent.redirect !== form.redirect_uri || !equal(consent.challenge, challenge)) failure("invalid_grant", "Authorization code is invalid, expired or bound to another request");
    if (this.grants.size >= CAPACITY) failure("temporarily_unavailable", "Development grant capacity reached", 503);
    const grant: Grant = { id: opaque(), clientId: client.id, expiresAt: now + GRANT_MS, rotations: 0 };
    this.grants.set(grant.id, grant);
    this.codes.delete(codeHash);
    this.consents.delete(consent.id);
    this.usedCodes.set(codeHash, { grantId: grant.id, expiresAt: grant.expiresAt });
    return this.issue(grant, now);
  }

  private refresh(params: URLSearchParams, now: number): OAuthTokenResult {
    const form = this.form(params, ["grant_type", "refresh_token", "client_id", "resource"], ["scope"]);
    const client = this.client(form.client_id!);
    if (form.resource !== this.resource) failure("invalid_target", "Resource must identify this gateway MCP endpoint exactly");
    if (form.scope !== undefined && form.scope !== "autodev") failure("invalid_scope", "Refresh cannot expand the authorized scope");
    if (!/^[A-Za-z0-9_-]{43}$/.test(form.refresh_token!)) failure("invalid_grant", "Refresh token is invalid");
    const tokenHash = digest(form.refresh_token!);
    const reused = this.usedRefresh.get(tokenHash);
    if (reused) { this.revoke(reused.grantId); failure("invalid_grant", "Refresh token replay detected; its grant was revoked"); }
    const ref = this.refreshTokens.get(tokenHash);
    const grant = ref ? this.grants.get(ref.grantId) : undefined;
    if (!ref || !grant || ref.expiresAt <= now || grant.clientId !== client.id) failure("invalid_grant", "Refresh token is invalid, expired or bound to another client");
    if (grant.rotations >= MAX_ROTATIONS) { this.revoke(grant.id); failure("invalid_grant", "Development refresh rotation limit reached; reconnect with local approval"); }
    this.refreshTokens.delete(tokenHash);
    this.usedRefresh.set(tokenHash, ref);
    grant.rotations++;
    return this.issue(grant, now);
  }

  private issue(grant: Grant, now: number): OAuthTokenResult {
    const access = opaque();
    const refresh = opaque();
    const expiresAt = Math.min(now + ACCESS_MS, grant.expiresAt);
    this.accessTokens.set(digest(access), { grantId: grant.id, expiresAt });
    this.refreshTokens.set(digest(refresh), { grantId: grant.id, expiresAt: grant.expiresAt });
    return { access_token: access, token_type: "Bearer", expires_in: Math.floor((expiresAt - now) / 1000), refresh_token: refresh, scope: "autodev" };
  }

  private revoke(grantId: string): void {
    this.grants.delete(grantId);
    for (const index of [this.accessTokens, this.refreshTokens, this.usedRefresh, this.usedCodes]) {
      for (const [key, ref] of index) if (ref.grantId === grantId) index.delete(key);
    }
  }

  private form(params: URLSearchParams, required: string[], optional: string[] = []): Record<string, string> {
    if (!(params instanceof URLSearchParams) || params.toString().length > 12_000) failure("invalid_request", "Expected a bounded OAuth form");
    const allowed = new Set([...required, ...optional]);
    if ([...params.keys()].some((key) => !allowed.has(key) || params.getAll(key).length !== 1) || required.some((key) => params.getAll(key).length !== 1 || !params.get(key))) failure("invalid_request", "OAuth parameters are missing, duplicated or unsupported");
    return Object.fromEntries(params);
  }

  private client(id: string): Client {
    const client = typeof id === "string" ? this.clients.get(id) : undefined;
    if (!client) failure("invalid_client", "Client is unknown; register this connection again", 401);
    return client;
  }

  private consent(id: string): Consent {
    const consent = typeof id === "string" ? this.consents.get(id) : undefined;
    if (!consent) failure("invalid_request", "Consent request is unknown, expired or already redeemed");
    return consent;
  }

  private pendingView(consent: Consent): OAuthPendingRequest {
    return { request_id: consent.id, verification_code: consent.verificationCode, expires_at: iso(consent.expiresAt), client_name: consent.clientName, scope: "autodev" };
  }

  private prepare(rate?: string, maximum = 0): number {
    const current = this.clock();
    if (!Number.isSafeInteger(current) || current < 0) failure("temporarily_unavailable", "Gateway clock is unavailable", 503);
    const now = this.lastNow = Math.max(this.lastNow, current);
    for (const [id, consent] of this.consents) if (consent.expiresAt <= now) { this.consents.delete(id); if (consent.codeHash) this.codes.delete(consent.codeHash); }
    for (const [id, grant] of this.grants) if (grant.expiresAt <= now) this.revoke(id);
    for (const index of [this.accessTokens, this.refreshTokens, this.usedRefresh, this.usedCodes]) for (const [key, ref] of index) if (ref.expiresAt <= now) index.delete(key);
    if (rate) {
      let bucket = this.rates.get(rate);
      if (!bucket || now - bucket.since >= 60_000) { bucket = { since: now, count: 0 }; this.rates.set(rate, bucket); }
      if (++bucket.count > maximum) failure("temporarily_unavailable", "Development OAuth request rate exceeded; wait before retrying", 429);
    }
    return now;
  }
}
