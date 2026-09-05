import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import test, { type TestContext } from "node:test";

import { createGateway } from "../src/gateway.js";

const issuer = "https://autodev.example";
const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
const clientToken = "synthetic-upstream-client-credential";
const adminToken = "synthetic-local-admin-credential";
type Pending = { request_id: string; verification_code: string; client_name: string; expires_at: string };

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

function statusWithHost(url: string, headers: Record<string, string>): Promise<number> {
  // fetch may normalize Host back to its URL. Exercise the actual HTTP Host
  // defense with Node's lower-level client, without contacting another host.
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "GET", headers }, res => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(5_000, () => req.destroy(new Error("Fixture request timed out")));
    req.end();
  });
}

async function fixture(t: TestContext) {
  const requests: Array<{ method: string; url: string; headers: IncomingHttpHeaders; body: string }> = [];
  let sessionNumber = 0;
  let sse = false;
  const upstream = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
    if (sse) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end("data: should not be forwarded as an SSE response\n\n");
      return;
    }
    if (req.method === "DELETE") { res.writeHead(204); res.end(); return; }
    res.setHeader("Content-Type", "application/json");
    if (!req.headers["mcp-session-id"]) res.setHeader("mcp-session-id", `fixture-session-${++sessionNumber}`);
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
  });
  const upstreamPort = await listen(upstream);
  const publicReservation = createServer();
  const controlReservation = createServer();
  const publicPort = await listen(publicReservation);
  const controlPort = await listen(controlReservation);
  await Promise.all([close(publicReservation), close(controlReservation)]);
  let gateway: Awaited<ReturnType<typeof createGateway>>;
  try {
    gateway = await createGateway({ issuer, publicPort, controlPort, upstream: `http://127.0.0.1:${upstreamPort}/mcp`, clientToken, adminToken });
  } catch (error) { await close(upstream); throw error; }
  t.after(async () => { await gateway.close(); await close(upstream); });
  return {
    publicUrl: `http://127.0.0.1:${publicPort}`,
    controlUrl: `http://127.0.0.1:${controlPort}`,
    requests,
    enableSse: () => { sse = true; },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function register(f: Fixture, clientName = "Gateway integration fixture") {
  const response = await fetch(`${f.publicUrl}/oauth/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: clientName, redirect_uris: [redirectUri], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  });
  assert.equal(response.status, 201);
  const client = await response.json() as { client_id: string; client_secret?: string; redirect_uris: string[]; token_endpoint_auth_method: string };
  assert.equal(typeof client.client_id, "string");
  assert.ok(client.client_id.length > 0);
  assert.equal(client.client_secret, undefined);
  assert.deepEqual(client.redirect_uris, [redirectUri]);
  assert.equal(client.token_endpoint_auth_method, "none");
  return client;
}

async function pending(f: Fixture): Promise<Pending[]> {
  const response = await fetch(`${f.controlUrl}/status`, { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(response.status, 200);
  const state = await response.json() as { pending: Pending[]; issuer: string };
  assert.equal(state.issuer, issuer);
  return state.pending;
}

async function begin(f: Fixture, clientId: string) {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("hex");
  const params = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, scope: "autodev", resource: `${issuer}/mcp`, state, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" });
  const response = await fetch(`${f.publicUrl}/oauth/authorize?${params}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html/);
  assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  const html = await response.text();
  const requestId = /<code>([^<]+)<\/code>/.exec(html)?.[1];
  assert.ok(requestId);
  const request = (await pending(f)).find(entry => entry.request_id === requestId);
  assert.ok(request);
  assert.ok(html.includes(request.verification_code));
  assert.equal(html.includes(clientToken), false);
  assert.equal(html.includes(adminToken), false);
  return { verifier, state, request, html, clientId };
}
type Authorization = Awaited<ReturnType<typeof begin>>;

async function localDecision(f: Fixture, flow: Authorization, code = flow.request.verification_code, approve = true) {
  return fetch(`${f.controlUrl}/approve`, {
    method: "POST", headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ request_id: flow.request.request_id, verification_code: code, approve }),
  });
}

async function approvedCode(f: Fixture, flow: Authorization) {
  const decision = await localDecision(f, flow);
  assert.equal(decision.status, 200);
  const redirect = await fetch(`${f.publicUrl}/oauth/result?request_id=${encodeURIComponent(flow.request.request_id)}`, { redirect: "manual" });
  assert.equal(redirect.status, 302);
  const location = new URL(redirect.headers.get("location")!);
  assert.equal(location.origin + location.pathname, redirectUri);
  assert.equal(location.searchParams.get("state"), flow.state);
  const code = location.searchParams.get("code");
  assert.ok(code);
  return code;
}

async function redeem(f: Fixture, flow: Authorization, code: string, overrides: Record<string, string> = {}) {
  return fetch(`${f.publicUrl}/oauth/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: flow.clientId, code, redirect_uri: redirectUri, resource: `${issuer}/mcp`, code_verifier: flow.verifier, ...overrides }),
  });
}

async function access(f: Fixture, clientId: string) {
  const flow = await begin(f, clientId);
  const code = await approvedCode(f, flow);
  const response = await redeem(f, flow, code);
  assert.equal(response.status, 200);
  const token = await response.json() as { access_token: string; refresh_token: string; token_type: string; scope: string };
  assert.equal(token.token_type, "Bearer");
  assert.equal(token.scope, "autodev");
  assert.ok(token.access_token && token.refresh_token);
  return token;
}

const mcpBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } });

test("gateway discovery exposes only public OAuth endpoints and keeps administration local", async t => {
  const f = await fixture(t);
  for (const pathname of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    const response = await fetch(f.publicUrl + pathname);
    assert.equal(response.status, 200);
    const metadata = await response.json() as { resource: string; authorization_servers: string[] };
    assert.equal(metadata.resource, `${issuer}/mcp`);
    assert.deepEqual(metadata.authorization_servers, [issuer]);
    assert.equal(JSON.stringify(metadata).includes("127.0.0.1"), false);
  }
  const response = await fetch(`${f.publicUrl}/.well-known/oauth-authorization-server`);
  const metadata = await response.json() as Record<string, unknown>;
  assert.equal(response.status, 200);
  assert.equal(metadata.issuer, issuer);
  assert.equal(metadata.authorization_endpoint, `${issuer}/oauth/authorize`);
  assert.equal(metadata.token_endpoint, `${issuer}/oauth/token`);
  assert.equal(metadata.registration_endpoint, `${issuer}/oauth/register`);
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
  for (const redirect of ["https://untrusted.example/callback", "https://chatgpt.com.untrusted.example/connector_platform_oauth_redirect", "http://chatgpt.com/connector_platform_oauth_redirect"]) {
    const rejectedClient = await fetch(`${f.publicUrl}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Invalid redirect fixture", redirect_uris: [redirect], token_endpoint_auth_method: "none" }) });
    assert.equal(rejectedClient.status, 400);
    assert.equal((await rejectedClient.json() as Record<string, unknown>).client_id, undefined);
  }
  for (const pathname of ["/status", "/approve", "/shutdown", "/admin/status", "/admin/approval"]) {
    const blocked = await fetch(f.publicUrl + pathname, { method: "POST", headers: { Authorization: `Bearer ${adminToken}` }, body: "{}" });
    assert.equal(blocked.status, 404);
  }
  for (const headers of [{}, { Authorization: "Bearer wrong-token" }, { Authorization: `Bearer ${clientToken}` }]) {
    assert.equal((await fetch(`${f.controlUrl}/status`, { headers })).status, 401);
  }
  assert.equal((await fetch(`${f.controlUrl}/status`, { headers: { Authorization: `Bearer ${adminToken}`, Origin: "https://untrusted.example" } })).status, 403);
  assert.equal(await statusWithHost(`${f.controlUrl}/status`, { Authorization: `Bearer ${adminToken}`, Host: "untrusted.example" }), 403);
  assert.equal(await statusWithHost(`${f.publicUrl}/.well-known/oauth-authorization-server`, { Host: "untrusted.example" }), 403);
  assert.deepEqual(await pending(f), []);
  assert.equal(f.requests.length, 0);
});

test("OAuth authorization requires the matching local verification code and a bound PKCE redemption", async t => {
  const f = await fixture(t);
  const client = await register(f, "Fixture <script>untrusted</script>");
  const flow = await begin(f, client.client_id);
  assert.match(flow.html, /&lt;script&gt;untrusted&lt;\/script&gt;/);
  assert.doesNotMatch(flow.html, /<script>untrusted<\/script>/);
  const awaiting = await fetch(`${f.publicUrl}/oauth/result?request_id=${flow.request.request_id}`, { redirect: "manual" });
  assert.equal(awaiting.status, 200);
  assert.equal(awaiting.headers.get("location"), null);
  const wrongCode = await localDecision(f, flow, "incorrect-confirmation-code");
  assert.equal(wrongCode.status, 400);
  assert.ok((await pending(f)).some(entry => entry.request_id === flow.request.request_id));
  const code = await approvedCode(f, flow);
  const exchange = await redeem(f, flow, code);
  assert.equal(exchange.status, 200);
  const token = await exchange.json() as { access_token: string; token_type: string; expires_in: number };
  assert.ok(token.access_token);
  assert.equal(token.token_type, "Bearer");
  assert.ok(token.expires_in > 0 && token.expires_in <= 600);
  assert.equal((await redeem(f, flow, code)).status, 400, "An authorization code must be single use");

  const other = await register(f);
  for (const overrides of [{ code_verifier: "wrong-verifier" }, { client_id: other.client_id }, { resource: "https://different.example/mcp" }, { redirect_uri: "https://untrusted.example/callback" }]) {
    const rejectedFlow = await begin(f, client.client_id);
    const rejectedCode = await approvedCode(f, rejectedFlow);
    const rejected = await redeem(f, rejectedFlow, rejectedCode, overrides);
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json() as Record<string, unknown>).access_token, undefined);
  }
  const denied = await begin(f, client.client_id);
  assert.equal((await localDecision(f, denied, denied.request.verification_code, false)).status, 200);
  const denial = await fetch(`${f.publicUrl}/oauth/result?request_id=${denied.request.request_id}`, { redirect: "manual" });
  assert.equal(denial.status, 302);
  const denialLocation = new URL(denial.headers.get("location")!);
  assert.equal(denialLocation.searchParams.get("error"), "access_denied");
  assert.equal(denialLocation.searchParams.get("code"), null);
  assert.equal(denialLocation.searchParams.get("state"), denied.state);
  assert.equal(f.requests.length, 0);
});

test("MCP proxy uses only the internal client credential and binds each session to its OAuth grant", async t => {
  const f = await fixture(t);
  for (const authorization of [undefined, "Bearer invalid-access-token", `Bearer ${adminToken}`, `Bearer ${clientToken}`]) {
    const response = await fetch(`${f.publicUrl}/mcp`, { method: "POST", headers: authorization ? { Authorization: authorization } : {}, body: mcpBody });
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate") ?? "", /oauth-protected-resource\/mcp/);
  }
  assert.equal(f.requests.length, 0);
  const client = await register(f);
  const first = await access(f, client.client_id);
  const second = await access(f, client.client_id);
  const initialized = await fetch(`${f.publicUrl}/mcp`, { method: "POST", body: mcpBody, headers: {
    Authorization: `Bearer ${first.access_token}`, "x-admin-token": adminToken, Cookie: "fixture=not-forwarded", "mcp-protocol-version": "2025-03-26",
  } });
  assert.equal(initialized.status, 200);
  const session = initialized.headers.get("mcp-session-id");
  assert.ok(session);
  const forwarded = f.requests.at(-1)!;
  assert.equal(forwarded.url, "/mcp");
  assert.equal(forwarded.headers.authorization, `Bearer ${clientToken}`);
  assert.equal(forwarded.headers["x-admin-token"], undefined);
  assert.equal(forwarded.headers.cookie, undefined);
  assert.equal(forwarded.headers["mcp-protocol-version"], "2025-03-26");
  assert.equal(forwarded.body, mcpBody);
  const beforeCrossGrant = f.requests.length;
  for (const method of ["POST", "DELETE"]) {
    const foreign = await fetch(`${f.publicUrl}/mcp`, { method, headers: { Authorization: `Bearer ${second.access_token}`, "mcp-session-id": session }, ...(method === "POST" ? { body: mcpBody } : {}) });
    assert.equal(foreign.status, 404);
  }
  assert.equal(f.requests.length, beforeCrossGrant);
  const continued = await fetch(`${f.publicUrl}/mcp`, { method: "POST", body: mcpBody, headers: { Authorization: `Bearer ${first.access_token}`, "mcp-session-id": session } });
  assert.equal(continued.status, 200);
  assert.equal(f.requests.at(-1)!.headers["mcp-session-id"], session);
  const refresh = await fetch(`${f.publicUrl}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: first.refresh_token, resource: `${issuer}/mcp` }) });
  assert.equal(refresh.status, 200);
  const refreshed = await refresh.json() as { access_token: string };
  const resumed = await fetch(`${f.publicUrl}/mcp`, { method: "POST", body: mcpBody, headers: { Authorization: `Bearer ${refreshed.access_token}`, "mcp-session-id": session } });
  assert.equal(resumed.status, 200, "Refreshing an access token must retain its grant's MCP session");
  const removed = await fetch(`${f.publicUrl}/mcp`, { method: "DELETE", headers: { Authorization: `Bearer ${refreshed.access_token}`, "mcp-session-id": session } });
  assert.equal(removed.status, 204);
  const stale = await fetch(`${f.publicUrl}/mcp`, { method: "POST", body: mcpBody, headers: { Authorization: `Bearer ${refreshed.access_token}`, "mcp-session-id": session } });
  assert.equal(stale.status, 404);
});

test("gateway rejects GET streaming and never exposes an upstream SSE response", async t => {
  const f = await fixture(t);
  const get = await fetch(`${f.publicUrl}/mcp`);
  assert.equal(get.status, 405);
  assert.match(get.headers.get("content-type") ?? "", /^application\/json/);
  assert.equal(f.requests.length, 0);
  const client = await register(f);
  const token = await access(f, client.client_id);
  f.enableSse();
  const streaming = await fetch(`${f.publicUrl}/mcp`, { method: "POST", body: mcpBody, headers: { Authorization: `Bearer ${token.access_token}` } });
  assert.equal(streaming.status, 400);
  assert.doesNotMatch(streaming.headers.get("content-type") ?? "", /text\/event-stream/);
  assert.doesNotMatch(await streaming.text(), /should not be forwarded/);
});
