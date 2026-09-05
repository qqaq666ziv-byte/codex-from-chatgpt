import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { OAuthGate, OAuthError, type OAuthTokenResult } from "../src/oauth.js";

const issuer = "https://autodev.example";
const redirect = "https://chatgpt.com/connector_platform_oauth_redirect";
const callback = "https://chatgpt.com/connector/oauth/fixture_callback-1";
const verifier = "a".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const body = (redirects = [redirect]) => ({ client_name: "ChatGPT fixture", redirect_uris: redirects, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
const error = (code: OAuthError["code"], status?: number) => (value: unknown) => value instanceof OAuthError && value.code === code && (status === undefined || value.status === status);

function fixture() {
  let time = 1_800_000_000_000;
  const gate = new OAuthGate({ issuer, now: () => time });
  const client = gate.register(body([redirect, callback]));
  const params = (overrides: Record<string, string> = {}) => new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: redirect, state: "opaque-fixture-state", resource: `${issuer}/mcp`, scope: "autodev", code_challenge: challenge, code_challenge_method: "S256", ...overrides });
  const authorize = () => {
    const pending = gate.begin(params());
    gate.localApproval(pending.request_id, true, pending.verification_code);
    const finish = gate.finish(pending.request_id);
    assert.equal(finish.status, "approved");
    assert.ok("redirect_url" in finish);
    const url = new URL(finish.redirect_url);
    assert.equal(url.origin + url.pathname, redirect);
    assert.equal(url.searchParams.get("state"), "opaque-fixture-state");
    assert.equal(url.searchParams.get("iss"), issuer);
    const form = new URLSearchParams({ grant_type: "authorization_code", client_id: client.client_id, code: url.searchParams.get("code")!, redirect_uri: redirect, resource: `${issuer}/mcp`, code_verifier: verifier });
    return { pending, form };
  };
  const grant = () => { const consent = authorize(); return { ...consent, tokens: gate.token(consent.form) }; };
  const refresh = (tokens: OAuthTokenResult, overrides: Record<string, string> = {}) => new URLSearchParams({ grant_type: "refresh_token", client_id: client.client_id, resource: `${issuer}/mcp`, refresh_token: tokens.refresh_token, ...overrides });
  return { gate, client, params, authorize, grant, refresh, advance: (ms: number) => { time += ms; } };
}

test("discovery advertises only public DCR, S256 and the exact protected resource", () => {
  const { gate } = fixture();
  const metadata = gate.metadata();
  assert.equal(metadata.issuer, issuer);
  assert.equal(metadata.authorization_endpoint, `${issuer}/oauth/authorize`);
  assert.equal(metadata.token_endpoint, `${issuer}/oauth/token`);
  assert.equal(metadata.registration_endpoint, `${issuer}/oauth/register`);
  assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ["none"]);
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
  assert.equal("client_id_metadata_document_supported" in metadata, false);
  assert.deepEqual(gate.resourceMetadata(), { resource: `${issuer}/mcp`, authorization_servers: [issuer], scopes_supported: ["autodev"], bearer_methods_supported: ["header"] });
  for (const invalid of ["http://autodev.example", `${issuer}/path`, `${issuer}?q=1`, `${issuer}#fragment`, "https://user:pass@autodev.example"]) assert.throws(() => new OAuthGate({ issuer: invalid }), error("invalid_request"));
});

test("DCR refuses arbitrary, encoded, queried and lookalike redirect targets", () => {
  const { gate } = fixture();
  for (const uri of ["https://evil.example/callback", "https://chatgpt.com.evil.example/connector_platform_oauth_redirect", "http://chatgpt.com/connector_platform_oauth_redirect", `${redirect}?next=evil`, `${redirect}#fragment`, "https://user@chatgpt.com/connector_platform_oauth_redirect", "https://chatgpt.com/connector/oauth/a%2fb", "https://chatgpt.com:443/connector_platform_oauth_redirect", "https://chatgpt.com/connector/oauth/../redirect"]) {
    assert.throws(() => gate.register(body([uri])), error("invalid_redirect_uri"));
  }
  assert.throws(() => gate.register({ ...body(), token_endpoint_auth_method: "client_secret_post" }), error("invalid_client_metadata"));
  assert.throws(() => gate.register({ ...body(), client_secret: "not-supported" }), error("invalid_client_metadata"));
  const accepted = gate.register(body([callback]));
  assert.deepEqual(accepted.redirect_uris, [callback]);
  accepted.redirect_uris.push("https://evil.example");
});

test("a public consent request cannot issue a code until verified local approval", () => {
  const f = fixture();
  const pending = f.gate.begin(f.params());
  assert.match(pending.request_id, /^[A-Za-z0-9_-]{43}$/);
  assert.match(pending.verification_code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.deepEqual(f.gate.finish(pending.request_id), { status: "pending" });
  assert.deepEqual(f.gate.pendingRequests(), [pending]);
  assert.equal(JSON.stringify(f.gate.pendingRequests()).includes("access_token"), false);
  assert.throws(() => f.gate.localApproval(pending.request_id, true, "WRNG-CODE"), error("access_denied", 403));
  assert.throws(() => f.gate.localApproval(pending.request_id, true, "錯誤驗證碼長度九字"), error("access_denied", 403));
  assert.deepEqual(f.gate.finish(pending.request_id), { status: "pending" });
  f.gate.localApproval(pending.request_id, true, pending.verification_code);
  assert.deepEqual(f.gate.pendingRequests(), []);
  assert.throws(() => f.gate.localApproval(pending.request_id, true, pending.verification_code), error("invalid_request"));
  assert.equal(f.gate.finish(pending.request_id).status, "approved");
});

test("denial returns a bound OAuth error and cannot be approved afterward", () => {
  const f = fixture();
  const pending = f.gate.begin(f.params({ redirect_uri: callback }));
  f.gate.localApproval(pending.request_id, false, pending.verification_code);
  const finish = f.gate.finish(pending.request_id);
  assert.ok("redirect_url" in finish);
  const url = new URL(finish.redirect_url);
  assert.equal(url.origin + url.pathname, callback);
  assert.equal(url.searchParams.get("error"), "access_denied");
  assert.equal(url.searchParams.get("state"), "opaque-fixture-state");
  assert.equal(url.searchParams.has("code"), false);
  assert.throws(() => f.gate.localApproval(pending.request_id, true, pending.verification_code), error("invalid_request"));
});

test("authorization requires one exact client, redirect, scope, audience, state and S256 challenge", () => {
  const f = fixture();
  for (const changes of [{ resource: issuer }, { scope: "autodev admin" }, { code_challenge_method: "plain" }, { code_challenge: "short" }, { state: "" }, { state: "x".repeat(1025) }, { response_type: "token" }, { client_id: "unknown" }, { redirect_uri: "https://evil.example" }]) assert.throws(() => f.gate.begin(f.params(changes)), OAuthError);
  const duplicate = f.params(); duplicate.append("client_id", f.client.client_id);
  assert.throws(() => f.gate.begin(duplicate), error("invalid_request"));
  assert.deepEqual(f.gate.pendingRequests(), []);
});

test("ChatGPT authorization with ui_locales still requires local approval and bound PKCE redemption", () => {
  const f = fixture();
  const pending = f.gate.begin(f.params({ ui_locales: "zh-TW" }));
  assert.deepEqual(f.gate.finish(pending.request_id), { status: "pending" });
  assert.equal("ui_locales" in pending, false);
  f.gate.localApproval(pending.request_id, true, pending.verification_code);
  const finish = f.gate.finish(pending.request_id);
  assert.ok("redirect_url" in finish);
  const result = new URL(finish.redirect_url);
  assert.equal(result.origin + result.pathname, redirect);
  assert.equal(result.searchParams.get("state"), "opaque-fixture-state");
  assert.equal(result.searchParams.get("iss"), issuer);
  assert.equal(result.searchParams.has("ui_locales"), false);
  const form = new URLSearchParams({ grant_type: "authorization_code", client_id: f.client.client_id, code: result.searchParams.get("code")!, redirect_uri: redirect, resource: `${issuer}/mcp`, code_verifier: "b".repeat(43) });
  assert.throws(() => f.gate.token(form), error("invalid_grant"));
  form.set("code_verifier", verifier);
  const identity = f.gate.verify(f.gate.token(form).access_token);
  assert.equal(identity.client_id, f.client.client_id);
  assert.equal(identity.resource, `${issuer}/mcp`);
  assert.equal(identity.scope, "autodev");
  assert.doesNotThrow(() => f.gate.begin(f.params({ ui_locales: "zh-Hant-TW en-US" })));
});

test("ui_locales rejects malformed, excessive and duplicate hints without relaxing authorization parameters", () => {
  const f = fixture();
  for (const ui_locales of ["", "zh_TW", "zh-TW\n", " zh-TW", "zh-TW  en-US", "<script>", "en-a", "zh-TW ".repeat(9).trim(), "en-" + "a".repeat(254)]) {
    assert.throws(() => f.gate.begin(f.params({ ui_locales })), error("invalid_request"));
  }
  const duplicate = f.params({ ui_locales: "zh-TW" });
  duplicate.append("ui_locales", "en-US");
  assert.throws(() => f.gate.begin(duplicate), error("invalid_request"));
  assert.throws(() => f.gate.begin(f.params({ ui_locales: "zh-TW", scope: "autodev admin" })), error("invalid_scope"));
  assert.throws(() => f.gate.begin(f.params({ ui_locales: "zh-TW", resource: `${issuer}/other` })), error("invalid_target"));
  assert.throws(() => f.gate.begin(f.params({ ui_locales: "zh-TW", unknown_hint: "ignored?" })), error("invalid_request"));
  assert.deepEqual(f.gate.pendingRequests(), []);
});

test("code redemption validates PKCE, redirect, resource and client before issuing bound tokens", () => {
  const f = fixture();
  const { form } = f.authorize();
  const other = f.gate.register(body());
  for (const [name, value] of [["code_verifier", "b".repeat(43)], ["resource", `${issuer}/wrong`], ["redirect_uri", callback], ["client_id", other.client_id]]) {
    const tampered = new URLSearchParams(form); tampered.set(name!, value!);
    assert.throws(() => f.gate.token(tampered), OAuthError);
  }
  const tokens = f.gate.token(form);
  assert.equal(tokens.token_type, "Bearer");
  assert.equal(tokens.expires_in, 600);
  assert.equal(tokens.scope, "autodev");
  const identity = f.gate.verify(tokens.access_token);
  assert.equal(identity.client_id, f.client.client_id);
  assert.equal(identity.resource, `${issuer}/mcp`);
  assert.equal(identity.scope, "autodev");
  assert.throws(() => f.gate.verify(`Bearer ${tokens.access_token}`), error("invalid_token", 401));
  assert.throws(() => f.gate.verify(`${tokens.access_token.slice(0, 42)}!`), error("invalid_token", 401));
});

test("authorization code replay is rejected and revokes the original grant", () => {
  const f = fixture();
  const { form, tokens } = f.grant();
  assert.throws(() => f.gate.token(form), error("invalid_grant"));
  assert.throws(() => f.gate.verify(tokens.access_token), error("invalid_token"));
  assert.throws(() => f.gate.token(f.refresh(tokens)), error("invalid_grant"));
});

test("refresh rotates tokens without changing grant identity and replay revokes the entire family", () => {
  const f = fixture();
  const { tokens: first } = f.grant();
  const originalId = f.gate.verify(first.access_token).grant_id;
  const second = f.gate.token(f.refresh(first));
  assert.ok(second.access_token !== first.access_token && second.refresh_token !== first.refresh_token);
  assert.equal(f.gate.verify(second.access_token).grant_id, originalId);
  assert.throws(() => f.gate.token(f.refresh(first)), error("invalid_grant"));
  assert.throws(() => f.gate.verify(first.access_token), error("invalid_token"));
  assert.throws(() => f.gate.verify(second.access_token), error("invalid_token"));
  assert.throws(() => f.gate.token(f.refresh(second)), error("invalid_grant"));
});

test("refresh cannot change client, resource or scope", () => {
  const f = fixture();
  const { tokens } = f.grant();
  const other = f.gate.register(body());
  for (const changes of [{ client_id: other.client_id }, { resource: `${issuer}/other` }, { scope: "admin" }]) assert.throws(() => f.gate.token(f.refresh(tokens, changes)), OAuthError);
  const duplicate = f.refresh(tokens); duplicate.append("resource", `${issuer}/mcp`);
  assert.throws(() => f.gate.token(duplicate), error("invalid_request"));
  assert.equal(f.gate.verify(f.gate.token(f.refresh(tokens)).access_token).client_id, f.client.client_id);
});

test("pending requests and authorization codes expire and all tokens die when the gateway restarts", () => {
  const f = fixture();
  const pending = f.gate.begin(f.params());
  f.advance(5 * 60_000);
  assert.deepEqual(f.gate.pendingRequests(), []);
  assert.throws(() => f.gate.localApproval(pending.request_id, true, pending.verification_code), error("invalid_request"));
  const { form } = f.authorize();
  f.advance(60_000);
  assert.throws(() => f.gate.token(form), error("invalid_grant"));
  const { tokens } = f.grant();
  const restarted = new OAuthGate({ issuer });
  assert.throws(() => restarted.verify(tokens.access_token), error("invalid_token"));
});

test("access expiry can use refresh until the absolute development lease expires", () => {
  const f = fixture();
  const { tokens } = f.grant();
  f.advance(10 * 60_000);
  assert.throws(() => f.gate.verify(tokens.access_token), error("invalid_token"));
  const renewed = f.gate.token(f.refresh(tokens));
  assert.equal(f.gate.verify(renewed.access_token).scope, "autodev");
  f.advance(8 * 60 * 60_000);
  assert.throws(() => f.gate.verify(renewed.access_token), error("invalid_token"));
  assert.throws(() => f.gate.token(f.refresh(renewed)), OAuthError);
  const reauthorized = f.grant();
  assert.equal(f.gate.verify(reauthorized.tokens.access_token).client_id, f.client.client_id);
});

test("development client, pending request and grant capacities are bounded", () => {
  const clients = fixture();
  for (let index = 1; index < 32; index++) clients.gate.register(body());
  assert.throws(() => clients.gate.register(body()), error("temporarily_unavailable", 503));
  clients.advance(8 * 60 * 60_000);
  assert.throws(() => clients.gate.register(body()), error("temporarily_unavailable", 503));
  assert.doesNotThrow(() => clients.gate.begin(clients.params()));
  assert.doesNotThrow(() => new OAuthGate({ issuer }).register(body()));
  const requests = fixture();
  for (let index = 0; index < 32; index++) requests.gate.begin(requests.params({ state: `state-${index}` }));
  assert.throws(() => requests.gate.begin(requests.params()), error("temporarily_unavailable", 503));
  requests.advance(5 * 60_000);
  assert.doesNotThrow(() => requests.gate.begin(requests.params()));
  const grants = fixture();
  for (let index = 0; index < 32; index++) grants.grant();
  const extra = grants.gate.begin(grants.params());
  assert.throws(() => grants.gate.localApproval(extra.request_id, true, extra.verification_code), error("temporarily_unavailable", 503));
  assert.equal(grants.gate.finish(extra.request_id).status, "pending");
});

test("invalid registration bursts and unlimited refresh rotations cannot grow memory without bound", () => {
  const f = fixture();
  for (let index = 1; index < 64; index++) assert.throws(() => f.gate.register({}), error("invalid_redirect_uri"));
  assert.throws(() => f.gate.register({}), error("temporarily_unavailable", 429));
  f.advance(60_000);
  assert.doesNotThrow(() => f.gate.register(body()));
  const rotation = fixture();
  let { tokens } = rotation.grant();
  for (let index = 0; index < 64; index++) tokens = rotation.gate.token(rotation.refresh(tokens));
  assert.throws(() => rotation.gate.token(rotation.refresh(tokens)), error("invalid_grant"));
  assert.throws(() => rotation.gate.verify(tokens.access_token), error("invalid_token"));
});
