import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { validateWorkspace } from "../src/workspaces.js";

test("canonical workspace stays under the configured root", async () => {
  const result = await validateWorkspace("/Users/joseanu/workspace/codex-agent-mcp");
  assert.equal(result, "/Users/joseanu/workspace/codex-agent-mcp");
});

test("workspace traversal, outside path and invalid root are rejected", async () => {
  await assert.rejects(validateWorkspace("/Users/joseanu/workspace/../.codex"), /segmentos '\.\.'/);
  await assert.rejects(validateWorkspace("/tmp"), /dentro de \/Users\/joseanu\/workspace/);
  await assert.rejects(validateWorkspace("/tmp", "/path/../unsafe"), /segmentos '\.\.'/);
});

test("symlink escape is rejected after realpath", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "codex-workspace-root-"));
  const outside = mkdtempSync(path.join(tmpdir(), "codex-workspace-outside-"));
  const link = path.join(root, "escape");
  symlinkSync(outside, link, "dir");
  await assert.rejects(validateWorkspace(link, root), /dentro de/);
  mkdirSync(path.join(root, "valid"));
  assert.equal(await validateWorkspace(path.join(root, "valid"), root), realpathSync(path.join(root, "valid")));
});
