import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { StateStore } from "../src/store.js";

function stateJob(jobId: string, threadId: string | null) {
  return {
    job_id: jobId,
    thread_id: threadId,
    workspace: "/Users/joseanu/workspace/codex-agent-mcp",
    turn_id: null,
    status: "completed",
    final_message: null,
    latest_diff: null,
    files_changed: [],
    commands_executed: [],
    error: null,
    updated_at: new Date().toISOString(),
  };
}

test("state store usa escritura atómica y permisos 0600 incluso si el archivo anterior era amplio", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "codex-agent-state-"));
  const file = path.join(directory, "state.json");
  const store = new StateStore(file);
  store.save([stateJob("job-1", "thread-1")]);
  chmodSync(file, 0o644);
  store.save([stateJob("job-1", "thread-1")]);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("state ambiguo con job_id o thread_id duplicados se rechaza completo", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "codex-agent-state-"));
  const file = path.join(directory, "state.json");
  writeFileSync(file, JSON.stringify({ version: 1, jobs: [stateJob("same", "thread-a"), stateJob("same", "thread-b")] }));
  const store = new StateStore(file);
  assert.deepEqual(store.load(), []);
  assert.match(store.getDiagnostic() ?? "", /job_id duplicado/);

  writeFileSync(file, JSON.stringify({ version: 1, jobs: [stateJob("job-a", "same-thread"), stateJob("job-b", "same-thread")] }));
  assert.deepEqual(store.load(), []);
  assert.match(store.getDiagnostic() ?? "", /thread_id duplicado/);
});
