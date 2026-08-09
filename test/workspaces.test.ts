import assert from "node:assert/strict";
import test from "node:test";

import { validateWorkspace } from "../src/workspaces.js";

test("canonical workspace stays under the configured root", async () => {
  const result = await validateWorkspace("/Users/joseanu/workspace/codex-agent-mcp");
  assert.equal(result, "/Users/joseanu/workspace/codex-agent-mcp");
});

test("workspace traversal and outside paths are rejected", async () => {
  await assert.rejects(
    validateWorkspace("/Users/joseanu/workspace/../.codex"),
    /segmentos '\.\.'/,
  );
  await assert.rejects(validateWorkspace("/tmp"), /dentro de \/Users\/joseanu\/workspace/);
});
