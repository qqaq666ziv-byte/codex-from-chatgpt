import test from "node:test";

import { CodexAppServer } from "../src/codex-app-server.js";

test("optional integration: installed codex app-server handshake and thread/list", { skip: process.env.CODEX_REAL_APP_SERVER !== "1" }, async () => {
  const client = new CodexAppServer({ rpcTimeoutMs: 15_000, shutdownTimeoutMs: 2_000 });
  await client.start();
  try {
    const response = await client.request<{ data: unknown[] }>("thread/list", { limit: 1, useStateDbOnly: true });
    if (!Array.isArray(response.data)) throw new Error("thread/list no devolvió data[]");
  } finally {
    await client.stop();
  }
});
