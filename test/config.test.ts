import assert from "node:assert/strict";
import test from "node:test";

import { assertSafeHost, isLoopbackHost, runtimeConfig } from "../src/config.js";

test("HOST sólo permite loopback sin opt-in", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
  assert.throws(() => assertSafeHost("0.0.0.0", false), /no es loopback/);
  assert.doesNotThrow(() => assertSafeHost("0.0.0.0", true));
});

test("runtime config valida duraciones y requiere opt-in para bind externo", () => {
  assert.throws(() => runtimeConfig({ HOST: "0.0.0.0" }), /no es loopback/);
  const config = runtimeConfig({ HOST: "0.0.0.0", CODEX_AGENT_ALLOW_NON_LOOPBACK: "1", PORT: "9000", CODEX_RPC_TIMEOUT_MS: "17" });
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 9000);
  assert.equal(config.rpcTimeoutMs, 17);
});
