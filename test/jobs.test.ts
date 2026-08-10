import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { AppServerMessage, AppServerClient, JsonRpcId } from "../src/codex-app-server.js";
import { AppServerError, CodexAppServer } from "../src/codex-app-server.js";
import { COMPLETION_REPORT_MARKER, JobManager } from "../src/jobs.js";
import { StateStore } from "../src/store.js";

const workspace = process.cwd();

class FakeAppServer implements AppServerClient {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly responses: Array<{ id: JsonRpcId; result: unknown }> = [];
  readonly errorResponses: Array<{ id: JsonRpcId; code: number; message: string }> = [];
  private turnNumber = 0;
  private readonly messageListeners = new Set<(message: AppServerMessage) => void>();
  private readonly exitListeners = new Set<(error: Error) => void>();
  earlyCompletion = false;
  earlyLegacyApproval = false;
  terminalTurn = false;
  terminalItems: unknown[] = [];
  threadStartError: Error | null = null;
  turnStartError: Error | null = null;
  resumeResponse: unknown | null = null;
  resumeGate: Promise<void> | null = null;
  readonly resumeStarted: Promise<void>;
  private resolveResumeStarted!: () => void;
  interruptGate: Promise<void> | null = null;
  readonly interruptStarted: Promise<void>;
  private resolveInterruptStarted!: () => void;
  readThread: unknown = { id: "thread-1", turns: [] };

  constructor() {
    this.resumeStarted = new Promise<void>((resolve) => { this.resolveResumeStarted = resolve; });
    this.interruptStarted = new Promise<void>((resolve) => { this.resolveInterruptStarted = resolve; });
  }

  addMessageListener(listener: (message: AppServerMessage) => void): () => void { this.messageListeners.add(listener); return () => this.messageListeners.delete(listener); }
  addExitListener(listener: (error: Error) => void): () => void { this.exitListeners.add(listener); return () => this.exitListeners.delete(listener); }
  async start(): Promise<void> {}
  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (method === "thread/start") {
      if (this.threadStartError) throw this.threadStartError;
      return { thread: { id: "thread-1" } } as T;
    }
    if (method === "thread/read") return { thread: this.readThread } as T;
    if (method === "thread/resume") {
      this.resolveResumeStarted();
      if (this.resumeGate) await this.resumeGate;
      return (this.resumeResponse ?? { thread: this.readThread }) as T;
    }
    if (method === "turn/start") {
      if (this.turnStartError) throw this.turnStartError;
      this.turnNumber += 1;
      const turnId = `turn-${this.turnNumber}`;
      if (this.earlyLegacyApproval) this.emit({ id: "legacy-early", method: "execCommandApproval", params: { conversationId: "thread-1", callId: "call-early", command: ["pwd"], cwd: workspace } });
      if (this.earlyCompletion) this.emit({ method: "turn/completed", params: { threadId: "thread-1", turnId, turn: { id: turnId, status: "completed", items: [] } } });
      return { turn: { id: turnId, status: this.terminalTurn ? "completed" : "inProgress", items: this.terminalItems } } as T;
    }
    if (method === "turn/interrupt") {
      this.resolveInterruptStarted();
      if (this.interruptGate) await this.interruptGate;
      return {} as T;
    }
    return {} as T;
  }
  async stop(): Promise<void> {}
  respond(id: JsonRpcId, result: unknown): void { this.responses.push({ id, result }); }
  respondError(id: JsonRpcId, code: number, message: string): void { this.errorResponses.push({ id, code, message }); }
  emit(message: AppServerMessage): void { for (const listener of this.messageListeners) listener(message); }
  emitExit(error = new Error("fake app-server crash")): void { for (const listener of this.exitListeners) listener(error); }
}

function managerFixture(): { fake: FakeAppServer; manager: JobManager; store: StateStore } {
  const store = new StateStore(path.join(mkdtempSync(path.join(tmpdir(), "codex-agent-mcp-")), "state.json"));
  const fake = new FakeAppServer();
  return { fake, manager: new JobManager(fake, { store }), store };
}

function completed(fake: FakeAppServer, turnId = "turn-1", threadId = "thread-1", items: unknown[] = []): void {
  fake.emit({ method: "turn/completed", params: { threadId, turnId, turn: { id: turnId, status: "completed", items } } });
}

test("happy path start -> completed keeps a compact summary", async () => {
  const { fake, manager } = managerFixture();
  const started = await manager.start(workspace, "inspecciona sin modificar");
  fake.emit({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "message-1", delta: "resultado" } });
  fake.emit({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", id: "message-1", text: "resultado", phase: "final_answer" } } });
  fake.emit({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "commandExecution", id: "cmd-1", command: "pwd", status: "completed" } } });
  fake.emit({ method: "turn/diff/updated", params: { threadId: "thread-1", turnId: "turn-1", diff: "diff --git a/a b/a" } });
  completed(fake);
  const snapshot = manager.get(started.job_id, { detail: "debug" });
  assert.equal(snapshot.status, "completed");
  assert.equal(snapshot.final_message, "resultado");
  assert.deepEqual(snapshot.commands_executed, ["pwd"]);
  assert.equal(snapshot.latest_diff, "diff --git a/a b/a");
});

test("codex_get detail modes keep standard supervisory data separate from debug data", async () => {
  const { fake, manager } = managerFixture();
  const started = await manager.start(workspace, "reporta el estado");
  fake.emit({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "commandExecution", id: "cmd-1", command: "rg -n TODO .", status: "inProgress" } } });
  const compact = manager.get(started.job_id, { detail: "compact" });
  const standard = manager.get(started.job_id);
  assert.equal(compact.status, "running");
  assert.equal(compact.activity, "Codex is working");
  assert.equal(standard.activity, "Codex is working");
  assert.equal("commands_executed" in standard, false);
  assert.equal("latest_diff" in standard, false);

  fake.emit({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", id: "final", text: "Hecho", phase: "final_answer" } } });
  fake.emit({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "commandExecution", id: "cmd-2", command: "npm test", status: "completed", exitCode: 0 } } });
  fake.emit({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "fileChange", id: "file-1", changes: [{ path: "src/a.ts" }] } } });
  fake.emit({ method: "turn/diff/updated", params: { threadId: "thread-1", turnId: "turn-1", diff: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n+new line\n-old line" } });
  completed(fake);

  const finalStandard = manager.get(started.job_id);
  assert.equal(finalStandard.final_message, "Hecho");
  assert.deepEqual(finalStandard.files_changed, ["src/a.ts"]);
  assert.deepEqual(finalStandard.diffstat, { files: 1, insertions: 1, deletions: 1 });
  assert.deepEqual(finalStandard.validation, [{ kind: "test", command: "npm test", status: "passed", exit_code: 0 }]);
  assert.equal("commands_executed" in finalStandard, false);
  assert.equal("latest_diff" in finalStandard, false);

  const debug = manager.get(started.job_id, { detail: "debug" });
  assert.deepEqual(debug.commands_executed, ["npm test"]);
  assert.match(debug.latest_diff ?? "", /^diff --git/);
});

test("since_revision devuelve un snapshot pequeño y sólo cambia con estado observable", async () => {
  const { fake, manager } = managerFixture();
  const started = await manager.start(workspace, "sondeo");
  const first = manager.get(started.job_id, { detail: "compact" });
  const unchanged = manager.get(started.job_id, { detail: "compact", since_revision: first.revision });
  assert.deepEqual(unchanged, { status: "running", revision: first.revision, unchanged: true });
  assert.equal(manager.get(started.job_id, { detail: "compact" }).revision, first.revision);

  fake.emit({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "commandExecution", id: "cmd-1", command: "npm run build", status: "inProgress" } } });
  const changed = manager.get(started.job_id, { detail: "compact", since_revision: first.revision });
  assert.equal(changed.unchanged, undefined);
  assert.ok(changed.revision > first.revision);
  assert.equal(changed.activity, "Running build");
});

test("comandos exploratorios y diffs raw no avanzan la revision supervisory", async () => {
  const { fake, manager } = managerFixture();
  const started = await manager.start(workspace, "mantén el polling estable");
  const baseline = manager.get(started.job_id, { detail: "compact" });
  for (const [index, command] of ["rg -n TODO .", "sed -n '1,20p' README.md", "cat package.json"].entries()) {
    fake.emit({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "commandExecution", id: `explore-${index}`, command, status: "inProgress" } } });
    fake.emit({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "commandExecution", id: `explore-${index}`, command, status: "completed", exitCode: 0 } } });
  }
  fake.emit({ method: "turn/diff/updated", params: { threadId: "thread-1", turnId: "turn-1", diff: "diff --git a/one b/one" } });
  fake.emit({ method: "turn/diff/updated", params: { threadId: "thread-1", turnId: "turn-1", diff: "diff --git a/two b/two" } });
  const compact = manager.get(started.job_id, { detail: "compact" });
  assert.equal(compact.revision, baseline.revision);
  assert.equal(compact.activity, "Codex is working");
  const debug = manager.get(started.job_id, { detail: "debug" });
  assert.deepEqual(debug.commands_executed, ["rg -n TODO .", "sed -n '1,20p' README.md", "cat package.json"]);
  assert.equal(debug.latest_diff, "diff --git a/two b/two");
});

test("debug con since_revision igual devuelve los diagnosticos actuales", async () => {
  const { fake, manager } = managerFixture();
  const started = await manager.start(workspace, "diagnostico actual");
  const current = manager.get(started.job_id, { detail: "compact" });

  fake.emit({
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { type: "commandExecution", id: "explore-debug", command: "rg -n TODO .", status: "inProgress" },
    },
  });
  fake.emit({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { type: "commandExecution", id: "explore-debug", command: "rg -n TODO .", status: "completed", exitCode: 0 },
    },
  });
  fake.emit({
    method: "turn/diff/updated",
    params: { threadId: "thread-1", turnId: "turn-1", diff: "diff --git a/current b/current" },
  });

  const debug = manager.get(started.job_id, { detail: "debug", since_revision: current.revision });
  assert.equal(debug.revision, current.revision);
  assert.equal(debug.unchanged, undefined);
  assert.deepEqual(debug.commands_executed, ["rg -n TODO ."]);
  assert.equal(debug.latest_diff, "diff --git a/current b/current");
});

test("recognized validation activity and validation state advance revision", async () => {
  const { fake, manager } = managerFixture();
  const started = await manager.start(workspace, "observa validacion");
  const baseline = manager.get(started.job_id, { detail: "compact" });
  fake.emit({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "commandExecution", id: "test", command: "npm test", status: "inProgress" } } });
  const running = manager.get(started.job_id, { detail: "compact" });
  assert.ok(running.revision > baseline.revision);
  assert.equal(running.activity, "Running tests");
  fake.emit({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "commandExecution", id: "test", command: "npm test", status: "completed", exitCode: 0 } } });
  const completedValidation = manager.get(started.job_id, { detail: "compact" });
  assert.ok(completedValidation.revision > running.revision);
  assert.equal(completedValidation.activity, "Tests completed");
});

test("files, approvals, and terminal status are supervisory revision changes", async () => {
  const { fake, manager } = managerFixture();
  const started = await manager.start(workspace, "observa control");
  const baseline = manager.get(started.job_id, { detail: "compact" });
  fake.emit({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "fileChange", id: "file-1", changes: [{ path: "src/control.ts" }] } } });
  const filesChanged = manager.get(started.job_id, { detail: "standard" });
  assert.ok(filesChanged.revision > baseline.revision);
  assert.deepEqual(filesChanged.files_changed, ["src/control.ts"]);
  fake.emit({ id: 88, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-88", command: "npm test" } });
  const approval = manager.get(started.job_id, { detail: "compact" });
  assert.ok(approval.revision > filesChanged.revision);
  assert.equal(approval.pending_approval?.request_id, 88);
  fake.emit({ method: "turn/completed", params: { threadId: "thread-1", turnId: "turn-1", turn: { id: "turn-1", status: "completed", items: [] } } });
  const terminal = manager.get(started.job_id, { detail: "compact" });
  assert.ok(terminal.revision > approval.revision);
  assert.equal(terminal.status, "completed");
});

test("since_revision mayor que la revision actual falla claramente", async () => {
  const { manager } = managerFixture();
  const started = await manager.start(workspace, "valida el cursor");
  const current = manager.get(started.job_id, { detail: "compact" });
  assert.throws(
    () => manager.get(started.job_id, { since_revision: current.revision + 1 }),
    /since_revision .*no puede ser mayor que la revision actual/,
  );
  const older = manager.get(started.job_id, { since_revision: current.revision - 1 });
  assert.equal(older.unchanged, undefined);
});

test("una approval pendiente se conserva incluso en polling unchanged", async () => {
  const { fake, manager } = managerFixture();
  const started = await manager.start(workspace, "pide aprobación");
  fake.emit({ id: 77, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-77", command: "npm test", cwd: workspace } });
  const current = manager.get(started.job_id, { detail: "compact" });
  assert.equal("command" in (current.pending_approval ?? {}), false);
  const unchanged = manager.get(started.job_id, { detail: "compact", since_revision: current.revision });
  assert.equal(unchanged.unchanged, true);
  assert.equal(unchanged.pending_approval?.request_id, 77);
  assert.equal(unchanged.pending_approval?.kind, "command_execution");
  assert.match((unchanged.pending_approval as { summary?: string }).summary ?? "", /npm test/);
});

test("validation extraction is deterministic and excludes exploratory commands", async () => {
  const { fake, manager } = managerFixture();
  const started = await manager.start(workspace, "valida");
  const items = [
    { type: "commandExecution", id: "test", command: "npm test", status: "completed", exitCode: 0 },
    { type: "commandExecution", id: "types", command: "npm run typecheck", status: "failed", exitCode: 2, aggregatedOutput: "Type error" },
    { type: "commandExecution", id: "build", command: "npm run build", status: "completed" },
    { type: "commandExecution", id: "lint", command: "npm run lint", status: "completed", exitCode: 0 },
    { type: "commandExecution", id: "diff", command: "git diff --check", status: "completed", exitCode: 0 },
    { type: "commandExecution", id: "http", command: "curl -fsS http://127.0.0.1:8787/readyz", status: "completed", exitCode: 0 },
    { type: "commandExecution", id: "search", command: "rg -n TODO .", status: "completed", exitCode: 0 },
  ];
  for (const item of items) fake.emit({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item } });
  fake.emit({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", id: "final", text: "validado", phase: "final_answer" } } });
  completed(fake);
  const validation = manager.get(started.job_id).validation;
  assert.deepEqual(validation?.map(({ kind, command, status, exit_code }) => ({ kind, command, status, exit_code })), [
    { kind: "test", command: "npm test", status: "passed", exit_code: 0 },
    { kind: "typecheck", command: "npm run typecheck", status: "failed", exit_code: 2 },
    { kind: "build", command: "npm run build", status: "completed", exit_code: undefined },
    { kind: "lint", command: "npm run lint", status: "passed", exit_code: 0 },
    { kind: "diff_check", command: "git diff --check", status: "passed", exit_code: 0 },
    { kind: "http_check", command: "curl -fsS http://127.0.0.1:8787/readyz", status: "passed", exit_code: 0 },
  ]);
});

test("debug output is bounded without discarding the stored diagnostic state", async () => {
  const { fake, manager, store } = managerFixture();
  const started = await manager.start(workspace, "mucho diagnóstico");
  for (let index = 0; index < 125; index += 1) {
    fake.emit({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "commandExecution", id: `cmd-${index}`, command: `echo ${index}`, status: "completed", exitCode: 0 } } });
  }
  const largeDiff = `diff --git a/a b/a\n${"+line\n".repeat(5_000)}`;
  fake.emit({ method: "turn/diff/updated", params: { threadId: "thread-1", turnId: "turn-1", diff: largeDiff } });
  const debug = manager.get(started.job_id, { detail: "debug" });
  assert.equal(debug.commands_executed?.length, 100);
  assert.equal(debug.commands_truncated, true);
  assert.equal(debug.latest_diff_truncated, true);
  assert.ok((debug.latest_diff?.length ?? 0) < largeDiff.length);
  assert.equal(store.load()[0]?.commands_executed.length, 125);
  assert.equal(store.load()[0]?.latest_diff, largeDiff);
});

test("completion handoff is appended once while preserving the caller prompt", async () => {
  const { fake, manager } = managerFixture();
  const original = "Implement exactly this requested change.";
  const started = await manager.start(workspace, original);
  const firstTurn = fake.requests.find((request) => request.method === "turn/start");
  const firstText = ((firstTurn?.params as { input: Array<{ text: string }> }).input[0]?.text) ?? "";
  assert.ok(firstText.startsWith(original));
  assert.equal(firstText.split(COMPLETION_REPORT_MARKER).length - 1, 1);
  assert.match(firstText, /actions taken/);
  assert.match(firstText, /validation performed and results/);
  assert.match(firstText, /unresolved warnings or limitations/);
  completed(fake);
  await manager.continue(started.job_id, "Now verify the result.");
  const turnStarts = fake.requests.filter((request) => request.method === "turn/start");
  const secondText = ((turnStarts[1]?.params as { input: Array<{ text: string }> }).input[0]?.text) ?? "";
  assert.equal(secondText, "Now verify the result.");
  assert.equal(secondText.includes(COMPLETION_REPORT_MARKER), false);
});

test("terminal turn/start y turn/completed registran items antes de cerrar", async () => {
  const { fake, manager } = managerFixture();
  fake.terminalTurn = true;
  fake.terminalItems = [
    { type: "agentMessage", id: "final", text: "terminado", phase: "final_answer" },
    { type: "commandExecution", id: "cmd", command: "npm test", status: "completed" },
    { type: "fileChange", id: "file", changes: [{ path: "src/a.ts" }] },
  ];
  const started = await manager.start(workspace, "terminal inmediato");
  const snapshot = manager.get(started.job_id, { detail: "debug" });
  assert.equal(snapshot.status, "completed");
  assert.equal(snapshot.final_message, "terminado");
  assert.deepEqual(snapshot.commands_executed, ["npm test"]);
  assert.deepEqual(snapshot.files_changed, ["src/a.ts"]);
});

test("turn/completed terminal registra sus items antes de cerrar", async () => {
  const { fake, manager } = managerFixture();
  const started = await manager.start(workspace, "completion con items");
  fake.emit({ method: "turn/completed", params: { threadId: "thread-1", turnId: "turn-1", turn: {
    id: "turn-1", status: "completed", items: [
      { type: "agentMessage", id: "final-event", text: "respuesta del evento", phase: "final_answer" },
      { type: "commandExecution", id: "cmd-event", command: "git diff", status: "completed" },
      { type: "fileChange", id: "file-event", changes: [{ path: "README.md" }] },
    ],
  } } });
  const snapshot = manager.get(started.job_id, { detail: "debug" });
  assert.equal(snapshot.status, "completed");
  assert.equal(snapshot.final_message, "respuesta del evento");
  assert.deepEqual(snapshot.commands_executed, ["git diff"]);
  assert.deepEqual(snapshot.files_changed, ["README.md"]);
});

test("continue conserva thread y cambia turn", async () => {
  const { fake, manager } = managerFixture();
  const started = await manager.start(workspace, "primera instruccion");
  completed(fake);
  const continued = await manager.continue(started.job_id, "continúa con el mismo contexto");
  assert.equal(continued.thread_id, "thread-1");
  assert.equal(continued.turn_id, "turn-2");
  assert.deepEqual(fake.requests.filter((item) => item.method === "turn/start").map((item) => (item.params as { threadId: string }).threadId), ["thread-1", "thread-1"]);
});

test("interrupt usa turn/interrupt y espera turn/completed", async () => {
  const { fake, manager } = managerFixture();
  const started = await manager.start(workspace, "haz una revisión larga");
  const interrupting = await manager.interrupt(started.job_id);
  assert.equal(interrupting.status, "interrupting");
  assert.deepEqual(fake.requests.find((item) => item.method === "turn/interrupt")?.params, { threadId: "thread-1", turnId: "turn-1" });
  fake.emit({ method: "turn/completed", params: { threadId: "thread-1", turnId: "turn-1", turn: { id: "turn-1", status: "interrupted", items: [] } } });
  assert.equal(manager.get(started.job_id).status, "interrupted");
});

test("interrupt no regresa un turn terminal a interrupting", async () => {
  const { fake, manager } = managerFixture();
  const started = await manager.start(workspace, "race interrupt");
  let releaseInterrupt!: () => void;
  fake.interruptGate = new Promise<void>((resolve) => { releaseInterrupt = resolve; });
  const interrupting = manager.interrupt(started.job_id);
  await fake.interruptStarted;
  fake.emit({ method: "turn/completed", params: { threadId: "thread-1", turnId: "turn-1", turn: { id: "turn-1", status: "interrupted", items: [] } } });
  releaseInterrupt();
  assert.equal((await interrupting).status, "interrupted");
  assert.equal(manager.get(started.job_id).status, "interrupted");
});

test("completion temprana se captura antes de que turn/start devuelva el id", async () => {
  const { fake, manager } = managerFixture();
  fake.earlyCompletion = true;
  const started = await manager.start(workspace, "rápido");
  assert.equal(started.status, "completed");
  assert.equal(manager.get(started.job_id).status, "completed");
});

test("eventos de otro thread o turn no completan el job equivocado", async () => {
  const { fake, manager } = managerFixture();
  const started = await manager.start(workspace, "sigue trabajando");
  fake.emit({ method: "turn/completed", params: { threadId: "other-thread", turnId: "turn-1", turn: { id: "turn-1", status: "completed" } } });
  fake.emit({ method: "turn/completed", params: { threadId: "thread-1", turnId: "other-turn", turn: { id: "other-turn", status: "completed" } } });
  assert.equal(manager.get(started.job_id).status, "running");
});

test("error notification conserva la causa estructurada de Codex", async () => {
  const { fake, manager } = managerFixture();
  const started = await manager.start(workspace, "error estructurado");
  fake.emit({ method: "error", params: {
    threadId: "thread-1", turnId: "turn-1", willRetry: false,
    error: { message: "falló el modelo", codexErrorInfo: { code: "rate_limit" }, additionalDetails: "detalle real" },
  } });
  assert.equal(manager.get(started.job_id).status, "recovery_required");
  assert.match(manager.get(started.job_id).error ?? "", /falló el modelo/);
  assert.match(manager.get(started.job_id).error ?? "", /rate_limit/);
  assert.match(manager.get(started.job_id).error ?? "", /detalle real/);
});

test("dos approvals coexisten y request_id decide cuál responder", async () => {
  const { fake, manager } = managerFixture();
  const started = await manager.start(workspace, "necesita aprobación");
  for (const [id, itemId] of [[10, "item-1"], [11, "item-2"]] as const) fake.emit({ id, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", turnId: "turn-1", itemId, command: "pwd", cwd: workspace } });
  assert.equal(manager.get(started.job_id).pending_approvals.length, 2);
  await manager.respondApproval(started.job_id, 11, "decline");
  assert.deepEqual(fake.responses, [{ id: 11, result: { decision: "decline" } }]);
  assert.equal(manager.get(started.job_id).status, "awaiting_approval");
  assert.equal(manager.get(started.job_id).pending_approvals[0]?.request_id, 10);
});

test("approval legacy del protocolo también se correlaciona por request_id", async () => {
  const { fake, manager } = managerFixture();
  const started = await manager.start(workspace, "approval legacy");
  fake.emit({ id: "legacy-1", method: "execCommandApproval", params: { conversationId: "thread-1", callId: "call-1", command: ["pwd"], cwd: workspace, reason: "legacy" } });
  assert.equal(manager.get(started.job_id).pending_approvals[0]?.request_id, "legacy-1");
  await manager.respondApproval(started.job_id, "legacy-1", "approved");
  assert.deepEqual(fake.responses, [{ id: "legacy-1", result: { decision: "approved" } }]);
});

test("approval legacy temprana se bufferiza por conversationId hasta conocer turnId", async () => {
  const { fake, manager } = managerFixture();
  fake.earlyLegacyApproval = true;
  const started = await manager.start(workspace, "approval temprana");
  const approval = manager.get(started.job_id).pending_approvals[0];
  assert.equal(approval?.request_id, "legacy-early");
  assert.equal(approval?.turn_id, "turn-1");
});

test("permissions rechaza entries que no siguen el schema 0.147.0", async () => {
  const { fake, manager } = managerFixture();
  const started = await manager.start(workspace, "permissions");
  fake.emit({ id: 20, method: "item/permissions/requestApproval", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-20" } });
  await assert.rejects(manager.respondApproval(started.job_id, 20, { permissions: { fileSystem: { entries: [{ arbitrary: true }] } }, scope: "turn" } as never), /decision no admitida/);
  assert.equal(manager.get(started.job_id).pending_approvals?.length ?? 0, 1);
  await manager.respondApproval(started.job_id, 20, { permissions: { network: null, fileSystem: { entries: null, globScanMaxDepth: null } }, scope: "turn" });
  assert.equal(manager.get(started.job_id).pending_approvals?.length ?? 0, 0);
  fake.emit({ id: 21, method: "item/permissions/requestApproval", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-21" } });
  const omittedScopeDecision = { permissions: {
    network: {},
    fileSystem: { entries: [
      { access: "read", path: { type: "special", value: { kind: "project_roots" } } },
      { access: "write", path: { type: "special", value: { kind: "unknown", path: "/tmp" } } },
    ] },
  } } as never;
  await manager.respondApproval(started.job_id, 21, omittedScopeDecision);
  assert.equal(manager.get(started.job_id).pending_approvals?.length ?? 0, 0);
});

test("un turno activo bloquea otro start y el app-server crash deja recovery_required", async () => {
  const { fake, manager } = managerFixture();
  const started = await manager.start(workspace, "uno");
  await assert.rejects(manager.start(workspace, "dos"), /backend ocupado/);
  fake.emitExit();
  assert.equal(manager.get(started.job_id).status, "recovery_required");
});

test("crash -> restart -> thread inProgress -> resume mantiene recovery honesto", async () => {
  const { fake, manager, store } = managerFixture();
  const started = await manager.start(workspace, "recuperable");
  fake.emitExit(new Error("proceso muerto"));
  assert.equal(manager.get(started.job_id).status, "recovery_required");
  const restartedFake = new FakeAppServer();
  restartedFake.readThread = { id: "thread-1", turns: [{ id: "turn-1", status: "inProgress", items: [] }] };
  const restarted = new JobManager(restartedFake, { store });
  await restarted.initialize();
  assert.equal(restarted.get(started.job_id).status, "running");
  assert.equal(restarted.get(started.job_id).turn_id, "turn-1");
  assert.equal(restartedFake.requests.filter((request) => request.method === "thread/resume").length, 1);
});

test("dos recoveries potencialmente activas mantienen un fence global para nuevos turns", async () => {
  const { manager, store } = managerFixture();
  const first = await manager.start(workspace, "primer job");
  const persisted = store.load()[0];
  assert.ok(persisted);
  store.save([persisted, { ...persisted, job_id: "job-second", thread_id: "thread-2", turn_id: "turn-2", status: "running" }]);
  const restartedFake = new FakeAppServer();
  restartedFake.readThread = { id: "thread-1", turns: [{ id: "turn-1", status: "inProgress", items: [] }] };
  const restarted = new JobManager(restartedFake, { store });
  await restarted.initialize();
  await assert.rejects(restarted.start(workspace, "no debe iniciar"), /backend bloqueado/);
  assert.equal(restarted.get(first.job_id).status, "recovery_required");
  assert.equal(restarted.get("job-second").status, "recovery_required");
});

test("turn/start timeout se puede reconciliar en el mismo proceso antes de interrupt", async () => {
  const { fake, manager, store } = managerFixture();
  fake.turnStartError = new AppServerError("timeout de turn", -32002);
  await assert.rejects(manager.start(workspace, "turn incierto"), /job_id=/);
  const persisted = store.load()[0];
  assert.ok(persisted);
  fake.turnStartError = null;
  fake.readThread = { id: "thread-1", turns: [{ id: "turn-1", status: "inProgress", items: [] }] };
  const interrupted = await manager.interrupt(persisted.job_id);
  assert.equal(interrupted.status, "interrupting");
  assert.equal(fake.requests.some((request) => request.method === "thread/resume"), true);
});

test("state durable permite restart y rehidrata sin inventar completion", async () => {
  const { fake, manager, store } = managerFixture();
  const started = await manager.start(workspace, "persistente");
  completed(fake, "turn-1", "thread-1", [{ type: "agentMessage", id: "m", text: "persistido", phase: "final_answer" }]);
  const persistedRevision = store.load()[0]?.revision;
  assert.ok(persistedRevision !== undefined);
  const secondFake = new FakeAppServer();
  secondFake.readThread = { id: "thread-1", turns: [{ id: "turn-1", status: "completed", items: [{ type: "agentMessage", id: "m", text: "persistido", phase: "final_answer" }] }] };
  const second = new JobManager(secondFake, { store });
  await second.initialize();
  assert.equal(second.get(started.job_id).revision, persistedRevision);
  assert.equal(second.get(started.job_id).status, "completed");
  assert.equal(second.get(started.job_id).final_message, "persistido");
  assert.equal(secondFake.requests.some((request) => request.method === "thread/read"), false);
  const continued = await second.continue(started.job_id, "continúa");
  assert.equal(continued.thread_id, "thread-1");
});

test("running persistido se reanuda como running, no como completed", async () => {
  const { manager, store } = managerFixture();
  const started = await manager.start(workspace, "queda activo");
  const fake = new FakeAppServer();
  fake.readThread = { id: "thread-1", turns: [{ id: "turn-1", status: "inProgress", items: [] }] };
  const restarted = new JobManager(fake, { store });
  await restarted.initialize();
  assert.equal(restarted.get(started.job_id).status, "running");
  assert.equal(restarted.get(started.job_id).turn_id, "turn-1");
});

test("thread/resume exige el mismo turn inProgress", async () => {
  const { manager, store } = managerFixture();
  const started = await manager.start(workspace, "resume exacto");
  const fake = new FakeAppServer();
  fake.readThread = { id: "thread-1", turns: [{ id: "turn-1", status: "inProgress", items: [] }] };
  fake.resumeResponse = { thread: { id: "thread-1", turns: [{ id: "turn-other", status: "inProgress", items: [] }] } };
  const restarted = new JobManager(fake, { store });
  await restarted.initialize();
  assert.equal(restarted.get(started.job_id).status, "recovery_required");
  await assert.rejects(restarted.start(workspace, "bloqueado"), /backend bloqueado/);
});

test("turn terminal observado durante thread/resume no vuelve a running", async () => {
  const { manager, store } = managerFixture();
  const started = await manager.start(workspace, "race resume");
  const fake = new FakeAppServer();
  fake.readThread = { id: "thread-1", turns: [{ id: "turn-1", status: "inProgress", items: [] }] };
  let releaseResume!: () => void;
  fake.resumeGate = new Promise<void>((resolve) => { releaseResume = resolve; });
  const restarted = new JobManager(fake, { store });
  const initializing = restarted.initialize();
  await fake.resumeStarted;
  fake.emit({ method: "turn/completed", params: { threadId: "thread-1", turnId: "turn-1", turn: { id: "turn-1", status: "completed", items: [] } } });
  releaseResume();
  await initializing;
  assert.equal(restarted.get(started.job_id).status, "completed");
});

test("codex_get ve el índice persistido antes de initialize", async () => {
  const { manager, store } = managerFixture();
  const started = await manager.start(workspace, "visible tras restart");
  const restarted = new JobManager(new FakeAppServer(), { store });
  assert.equal(restarted.get(started.job_id).job_id, started.job_id);
});

test("state antiguo sin revision se rehidrata con revision 0", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "codex-agent-mcp-"));
  const file = path.join(directory, "state.json");
  writeFileSync(file, JSON.stringify({ version: 1, jobs: [{
    job_id: "legacy-job", thread_id: "legacy-thread", workspace, turn_id: null, status: "completed",
    final_message: "legacy", latest_diff: null, files_changed: [], commands_executed: [], error: null,
    updated_at: new Date().toISOString(),
  }] }));
  const manager = new JobManager(new FakeAppServer(), { store: new StateStore(file) });
  assert.equal(manager.get("legacy-job").revision, 0);
  assert.equal(manager.get("legacy-job").final_message, "legacy");
});

test("thread/start timeout queda journalizado y activa el fence sin adopción heurística", async () => {
  const store = new StateStore(path.join(mkdtempSync(path.join(tmpdir(), "codex-agent-mcp-")), "state.json"));
  const fake = new FakeAppServer();
  fake.threadStartError = Object.assign(new Error("timeout"), { code: -32002 });
  const manager = new JobManager(fake, { store });
  await assert.rejects(manager.start(workspace, "creación incierta"), /job_id=/);
  const jobs = store.load();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.thread_id, null);
  assert.equal(jobs[0]?.status, "recovery_required");
  await assert.rejects(manager.start(workspace, "otro job"), /backend bloqueado/);
});

test("thread/start rechazo explícito falla el job y no deja fence", async () => {
  const { fake, manager, store } = managerFixture();
  fake.threadStartError = new AppServerError("workspace rechazado", -32602, { reason: "invalid workspace" });
  let failure: Error | undefined;
  try {
    await manager.start(workspace, "rechazo definitivo");
  } catch (error) {
    failure = error as Error;
  }
  assert.ok(failure);
  assert.match(failure.message, /workspace rechazado/);
  const persisted = store.load()[0];
  assert.ok(persisted);
  assert.equal(manager.get(persisted.job_id).status, "failed");
  assert.match(manager.get(persisted.job_id).error ?? "", /workspace rechazado/);
  fake.threadStartError = null;
  const next = await manager.start(workspace, "nuevo trabajo");
  assert.equal(next.status, "running");
});

test("thread/start incierto no adopta un thread por preview o timestamp", async () => {
  const store = new StateStore(path.join(mkdtempSync(path.join(tmpdir(), "codex-agent-mcp-")), "state.json"));
  const fake = new FakeAppServer();
  fake.threadStartError = new AppServerError("timeout", -32002);
  const manager = new JobManager(fake, { store });
  await assert.rejects(manager.start(workspace, "adopción cerrada"), /job_id=/);
  assert.equal(fake.requests.some((request) => request.method === "thread/list"), false);
  assert.equal(store.load()[0]?.thread_id, null);
});

test("fallo de persistencia en listener se diagnostica sin tumbar el proceso", async () => {
  class FailingStore extends StateStore {
    private saves = 0;
    override save(jobs: Parameters<StateStore["save"]>[0]): void {
      if (this.saves++ > 2) throw new Error("disco no disponible");
      super.save(jobs);
    }
  }
  const store = new FailingStore(path.join(mkdtempSync(path.join(tmpdir(), "codex-agent-mcp-")), "state.json"));
  const fake = new FakeAppServer();
  const manager = new JobManager(fake, { store });
  const started = await manager.start(workspace, "persistencia");
  assert.doesNotThrow(() => fake.emit({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "commandExecution", command: "pwd", status: "completed" } } }));
  assert.equal(manager.get(started.job_id).status, "recovery_required");
});

test("fallo de persistencia inicial activa el fence de recovery", async () => {
  class InitialFailingStore extends StateStore {
    override save(_jobs: Parameters<StateStore["save"]>[0]): void {
      throw new Error("disco no disponible");
    }
  }
  const store = new InitialFailingStore(path.join(mkdtempSync(path.join(tmpdir(), "codex-agent-mcp-")), "state.json"));
  const manager = new JobManager(new FakeAppServer(), { store });
  let failure: Error | undefined;
  try {
    await manager.start(workspace, "persistencia inicial");
  } catch (error) {
    failure = error as Error;
  }
  assert.ok(failure);
  assert.match(failure.message, /No se pudo persistir el estado local/);
  const jobId = /job_id=([^\)]+)/.exec(failure.message)?.[1];
  assert.ok(jobId);
  assert.equal(manager.get(jobId).status, "recovery_required");
  await assert.rejects(manager.start(workspace, "bloqueado"), /backend bloqueado/);
});

test("store corrupto no tumba el servicio y conserva diagnóstico", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "codex-agent-state-"));
  const file = path.join(directory, "state.json");
  writeFileSync(file, "not json\n");
  const store = new StateStore(file);
  assert.deepEqual(store.load(), []);
  assert.match(store.getDiagnostic() ?? "", /corrupto/);
});

test("app-server real fake fixture: timeout, JSONL fatal, unknown request error y recuperación", async () => {
  const commandArgs = [path.join(process.cwd(), "test/fixtures/fake-app-server.mjs")];
  const client = new CodexAppServer({ command: process.execPath, commandArgs, rpcTimeoutMs: 500, shutdownTimeoutMs: 80, killTimeoutMs: 80 });
  await client.start();
  const unknown = await client.request<{ code: number }>("triggerUnknown");
  assert.equal(unknown.code, -32601);
  await assert.rejects(client.request("slow"), /Timeout de RPC/);
  await assert.rejects(client.request("badJson"), /JSONL inválido/);
  await client.stop();
  await client.start();
  await assert.rejects(client.request("crash"), /terminó inesperadamente/);
  await client.start();
  assert.equal(client.isReady(), true);
  await client.stop();
});
