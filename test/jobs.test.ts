import assert from "node:assert/strict";
import test from "node:test";

import type { AppServerMessage, JsonRpcId } from "../src/codex-app-server.js";
import { CodexAppServer } from "../src/codex-app-server.js";
import { JobManager } from "../src/jobs.js";

class FakeAppServer {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly responses: Array<{ id: JsonRpcId; result: unknown }> = [];
  private turnNumber = 0;
  private readonly messageListeners = new Set<(message: AppServerMessage) => void>();
  private readonly exitListeners = new Set<(error: Error) => void>();

  addMessageListener(listener: (message: AppServerMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  addExitListener(listener: (error: Error) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  async start(): Promise<void> {}

  async request<T>(method: string, params: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (method === "thread/start") {
      return { thread: { id: "thread-1" } } as T;
    }
    if (method === "turn/start") {
      this.turnNumber += 1;
      return { turn: { id: `turn-${this.turnNumber}`, status: "inProgress" } } as T;
    }
    return {} as T;
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.responses.push({ id, result });
  }

  emit(message: AppServerMessage): void {
    for (const listener of this.messageListeners) {
      listener(message);
    }
  }

  emitExit(error: Error): void {
    for (const listener of this.exitListeners) {
      listener(error);
    }
  }
}

function makeManager(): { fake: FakeAppServer; manager: JobManager } {
  const fake = new FakeAppServer();
  const manager = new JobManager(fake as unknown as CodexAppServer);
  return { fake, manager };
}

const workspace = "/Users/joseanu/workspace/codex-agent-mcp";

test("start/get reduce app-server events to a compact final snapshot", async () => {
  const { fake, manager } = makeManager();
  const started = await manager.start(workspace, "inspecciona sin modificar");

  const threadStart = fake.requests.find((request) => request.method === "thread/start");
  assert.equal((threadStart?.params as { model?: string }).model, "gpt-5.6-luna");
  assert.equal((threadStart?.params as { ephemeral?: boolean }).ephemeral, undefined);
  const turnStart = fake.requests.find((request) => request.method === "turn/start");
  assert.equal((turnStart?.params as { model?: string }).model, "gpt-5.6-luna");
  assert.equal((turnStart?.params as { effort?: string }).effort, "high");

  fake.emit({
    method: "item/agentMessage/delta",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "message-1", delta: "resultado" },
  });
  fake.emit({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { type: "agentMessage", id: "message-1", text: "resultado", phase: "final_answer" },
    },
  });
  fake.emit({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { type: "commandExecution", id: "cmd-1", command: "pwd", status: "completed" },
    },
  });
  fake.emit({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { type: "commandExecution", id: "cmd-2", command: "cat /tmp/nope", status: "declined" },
    },
  });
  fake.emit({
    method: "turn/diff/updated",
    params: { threadId: "thread-1", turnId: "turn-1", diff: "diff --git a/a b/a" },
  });
  fake.emit({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    },
  });

  assert.equal(started.thread_id, "thread-1");
  assert.equal(manager.get(started.job_id).status, "completed");
  assert.equal(manager.get(started.job_id).final_message, "resultado");
  assert.deepEqual(manager.get(started.job_id).commands_executed, ["pwd"]);
  assert.equal(manager.get(started.job_id).latest_diff, "diff --git a/a b/a");
});

test("continue reuses the same thread and approval response is routed by job", async () => {
  const { fake, manager } = makeManager();
  const started = await manager.start(workspace, "primera instruccion");
  fake.emit({
    id: 42,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      command: "cat /etc/hosts",
      cwd: workspace,
      reason: "lectura fuera del workspace",
    },
  });

  const pending = manager.get(started.job_id);
  assert.equal(pending.status, "awaiting_approval");
  assert.equal(pending.pending_approval?.request_id, 42);
  assert.deepEqual(pending.pending_approval?.decision_values.slice(0, 2), ["accept", "acceptForSession"]);

  await manager.respondApproval(started.job_id, "decline");
  assert.deepEqual(fake.responses, [{ id: 42, result: { decision: "decline" } }]);
  fake.emit({
    method: "turn/completed",
    params: { threadId: "thread-1", turnId: "turn-1", turn: { id: "turn-1", status: "completed", items: [] } },
  });

  const continued = await manager.continue(started.job_id, "continua y confirma el contexto");
  assert.equal(continued.thread_id, "thread-1");
  assert.equal(continued.turn_id, "turn-2");
  assert.deepEqual(
    fake.requests.filter((request) => request.method === "turn/start").map((request) => (request.params as { threadId: string }).threadId),
    ["thread-1", "thread-1"],
  );
});

test("interrupt uses the active turn id and settles as interrupted", async () => {
  const { fake, manager } = makeManager();
  const started = await manager.start(workspace, "haz una revisión larga");

  const interrupting = await manager.interrupt(started.job_id);
  assert.equal(interrupting.status, "interrupting");
  const interruptRequest = fake.requests.find((request) => request.method === "turn/interrupt");
  assert.deepEqual(interruptRequest?.params, { threadId: "thread-1", turnId: "turn-1" });

  fake.emit({
    method: "turn/completed",
    params: { threadId: "thread-1", turnId: "turn-1", turn: { id: "turn-1", status: "interrupted", items: [] } },
  });
  assert.equal(manager.get(started.job_id).status, "interrupted");
});
