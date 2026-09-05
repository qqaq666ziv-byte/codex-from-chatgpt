import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { AppServerClient, AppServerMessage, JsonRpcId } from "../src/codex-app-server.js";
import type { EvidenceManifest } from "../src/evidence.js";
import { JobManager } from "../src/jobs.js";
import type { LocalConfig } from "../src/local-config.js";
import { AutoDev } from "../src/product.js";
import { StateStore } from "../src/store.js";

const testRoot = path.resolve(".local-tests");

class ProductAppServer implements AppServerClient {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  private readonly listeners = new Set<(message: AppServerMessage) => void>();
  private turns = 0;
  private threads = 0;
  addMessageListener(listener: (message: AppServerMessage) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  addExitListener(_listener: (error: Error) => void) { return () => {}; }
  async start() {}
  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (method === "thread/start") {
      this.threads++;
      return { thread: { id: `thread-${this.threads}` }, model: "fixture-model", reasoningEffort: "medium", approvalPolicy: "on-request", sandbox: "workspace-write" } as T;
    }
    if (method === "thread/resume") return { thread: { id: (params as { threadId: string }).threadId, turns: [] }, model: "fixture-model", reasoningEffort: "medium", approvalPolicy: "on-request", sandbox: "workspace-write" } as T;
    if (method === "turn/start") return { turn: { id: `turn-${++this.turns}`, status: "inProgress", items: [] } } as T;
    return {} as T;
  }
  respond(_id: JsonRpcId, _result: unknown) {}
  respondError(_id: JsonRpcId, _code: number, _message: string) {}
  complete(threadId: string, turnId: string, workspace: string, options: { status?: string; command?: string; exitCode?: number; output?: string } = {}) {
    this.emit({ method: "turn/completed", params: { threadId, turnId, turn: { id: turnId, status: options.status ?? "completed", items: [
      { id: `test-${turnId}`, type: "commandExecution", command: options.command ?? "npm test", cwd: workspace, status: "completed", exitCode: options.exitCode ?? 0, aggregatedOutput: options.output ?? "fixture test command: 1 passed\n" },
      { id: `final-${turnId}`, type: "agentMessage", text: "Fixture execution completed. ChatGPT review remains pending.", phase: "final_answer" },
    ] } } });
  }
  emit(message: AppServerMessage) { for (const listener of this.listeners) listener(message); }
  count(method: string) { return this.requests.filter((request) => request.method === method).length; }
}

function fixture(t: { after: (cleanup: () => void) => void }) {
  mkdirSync(testRoot, { recursive: true });
  const directory = mkdtempSync(path.join(testRoot, "product-"));
  const workspace = path.join(directory, "repository");
  const runtimeDir = path.join(directory, "runtime");
  mkdirSync(workspace); mkdirSync(runtimeDir);
  execFileSync("git", ["-c", "core.hooksPath=.no-test-hooks", "init", "--quiet"], { cwd: workspace, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  writeFileSync(path.join(workspace, "source.ts"), "export const value = 1;\n");
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(`${testRoot}${path.sep}`));
    rmSync(resolved, { recursive: true, force: true });
  });
  const config: LocalConfig = { schemaVersion: 1, host: "127.0.0.1", port: 8799, model: "fixture-model", reasoningEffort: "medium", projects: [{ id: "fixture", name: "Fixture", path: realpathSync(workspace) }], runtimeDir, configPath: path.join(runtimeDir, "config.json") };
  const store = new StateStore(path.join(runtimeDir, "jobs.json"));
  const fake = new ProductAppServer();
  const manager = new JobManager(fake, { store, model: config.model, reasoningEffort: config.reasoningEffort, workspaceValidator: async (candidate) => {
    assert.equal(realpathSync(candidate), config.projects[0]!.path);
    return realpathSync(candidate);
  } });
  const product = new AutoDev(config, manager);
  return { directory, workspace, runtimeDir, config, store, fake, manager, product };
}

const task = (request_key: string) => ({ request_key, project_id: "fixture", requirements: "將 value 改為 2，保留其他行為。", acceptance: ["value 等於 2", "執行既有測試並保留結果"] });

async function finished(f: ReturnType<typeof fixture>, key = "start") {
  const result = await f.product.submit(task(key));
  writeFileSync(path.join(f.workspace, "source.ts"), "export const value = 2;\n");
  f.fake.complete(result.thread_id!, result.turn_id!, f.workspace);
  return { result, manifest: f.product.seal(result.job_id!) };
}

function readAll(product: AutoDev, session: string, manifest: EvidenceManifest, pageSize = 128) {
  const contents: Record<string, string> = {};
  for (const artifact of manifest.artifacts) {
    let cursor: string | undefined;
    let content = "";
    do {
      const page = product.readArtifact(session, manifest.id, artifact.name, cursor, pageSize);
      content += page.content;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(Buffer.byteLength(content), artifact.byteLength);
    contents[artifact.name] = content;
  }
  return contents;
}

function reviewInput(jobId: string, manifest: EvidenceManifest, key: string) {
  return { request_key: key, job_id: jobId, manifest_id: manifest.id, verdict: "pass" as const, summary: "已檢視完整需求、差異、來源身分與實際測試事件，符合本輪驗收。" };
}

test("duplicate submit/continue/cancel requests dispatch once and preserve the same Codex thread", async (t) => {
  const f = fixture(t);
  const [a, b] = await Promise.all([f.product.submit(task("submit-once")), f.product.submit(task("submit-once"))]);
  assert.deepEqual(a, b);
  assert.equal(f.fake.count("thread/start"), 1);
  assert.equal(f.fake.count("turn/start"), 1);
  await assert.rejects(f.product.submit({ ...task("submit-once"), requirements: "different task" }));
  f.fake.complete(a.thread_id!, a.turn_id!, f.workspace);
  const followup = { request_key: "continue-once", job_id: a.job_id!, requirements: "補上邊界情況。", acceptance: ["邊界測試通過"] };
  const [c, d] = await Promise.all([f.product.continue(followup), f.product.continue(followup)]);
  assert.deepEqual(c, d);
  assert.equal(c.thread_id, a.thread_id);
  assert.notEqual(c.turn_id, a.turn_id);
  assert.equal(f.fake.count("thread/start"), 1);
  assert.equal(f.fake.count("thread/resume"), 1);
  assert.equal(f.fake.count("turn/start"), 2);
  const cancellation = { request_key: "cancel-once", job_id: c.job_id!, turn_id: c.turn_id! };
  const [e, g] = await Promise.all([f.product.cancel(cancellation), f.product.cancel(cancellation)]);
  assert.deepEqual(e, g);
  assert.equal(e.status, "interrupting");
  assert.equal(f.fake.count("turn/interrupt"), 1);
  assert.equal(f.product.status(c.job_id!).review_status, "pending_chatgpt_review");
});

test("restart retains completed execution, pending review and immutable full evidence without resubmission", async (t) => {
  const f = fixture(t);
  const { result, manifest } = await finished(f);
  const contents = readAll(f.product, "original-session", manifest, 19);
  assert.match(contents["changes.patch"]!, /-export const value = 1;/);
  assert.match(contents["changes.patch"]!, /\+export const value = 2;/);
  const restartedFake = new ProductAppServer();
  const restartedManager = new JobManager(restartedFake, { store: f.store, workspaceValidator: async (candidate) => realpathSync(candidate) });
  const restarted = new AutoDev(f.config, restartedManager);
  const status = restarted.status(result.job_id!);
  assert.equal(status.execution_status, "completed");
  assert.equal(status.review_status, "pending_chatgpt_review");
  assert.equal(status.manifest_id, manifest.id);
  assert.deepEqual(readAll(restarted, "new-session", manifest, 31), contents);
  assert.deepEqual(await restarted.submit(task("start")), result);
  assert.equal(restartedFake.count("thread/start"), 0);
});

test("review requires every sequential page from the same session and then persists a qualified verdict", async (t) => {
  const f = fixture(t);
  const { result, manifest } = await finished(f);
  await assert.rejects(f.product.review("reviewer", reviewInput(result.job_id!, manifest, "review-before-reading")));
  const artifact = manifest.artifacts.find((item) => item.byteLength > 150)!;
  assert.ok(artifact);
  const first = f.product.readArtifact("reviewer", manifest.id, artifact.name, undefined, 32);
  assert.ok(first.nextCursor);
  const unseenSecond = f.product.evidenceStore.read(manifest.id, artifact.name, first.nextCursor!, 32);
  assert.ok(unseenSecond.nextCursor);
  assert.throws(() => f.product.readArtifact("reviewer", manifest.id, artifact.name, unseenSecond.nextCursor!, 32), /sequentially/i);
  await assert.rejects(f.product.review("reviewer", reviewInput(result.job_id!, manifest, "review-partial")));
  readAll(f.product, "reviewer", manifest, 43);
  await assert.rejects(f.product.review("other-session", reviewInput(result.job_id!, manifest, "review-wrong-session")));
  assert.equal(f.product.status(result.job_id!).review_status, "pending_chatgpt_review");
  const verdict = await f.product.review("reviewer", reviewInput(result.job_id!, manifest, "review-complete"));
  assert.equal(verdict.review_status, "pass");
  assert.equal(verdict.recorded_by, "authenticated MCP client");
  assert.match(verdict.identity_limit, /does not cryptographically attest/);
  assert.equal(new AutoDev(f.config, f.manager).status(result.job_id!).review_status, "pass");
});

test("closing a session removes its proof of having read the evidence", async (t) => {
  const f = fixture(t);
  const { result, manifest } = await finished(f);
  readAll(f.product, "closed-session", manifest);
  f.product.forgetSession("closed-session");
  await assert.rejects(f.product.review("closed-session", reviewInput(result.job_id!, manifest, "review-after-close")));
  assert.equal(f.product.status(result.job_id!).review_status, "pending_chatgpt_review");
});

test("review rejects source changed after capture and keeps the captured diff immutable", async (t) => {
  const f = fixture(t);
  const { result, manifest } = await finished(f);
  const original = readAll(f.product, "reviewer", manifest);
  writeFileSync(path.join(f.workspace, "source.ts"), "export const value = 99;\n");
  await assert.rejects(f.product.review("reviewer", reviewInput(result.job_id!, manifest, "review-stale-source")));
  assert.equal(f.product.status(result.job_id!).review_status, "pending_chatgpt_review");
  assert.equal(f.product.seal(result.job_id!).id, manifest.id);
  assert.deepEqual(readAll(f.product, "reviewer", manifest), original);
});

test("a previous round's evidence cannot approve the next round and both original and followup requirements survive", async (t) => {
  const f = fixture(t);
  const { result, manifest: first } = await finished(f);
  readAll(f.product, "reviewer", first);
  const continued = await f.product.continue({ request_key: "next-round", job_id: result.job_id!, requirements: "將 value 改為 3。", acceptance: ["value 等於 3"] });
  writeFileSync(path.join(f.workspace, "source.ts"), "export const value = 3;\n");
  f.fake.complete(continued.thread_id!, continued.turn_id!, f.workspace);
  const second = f.product.seal(result.job_id!);
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.identity.turnId, second.identity.turnId);
  await assert.rejects(f.product.review("reviewer", reviewInput(result.job_id!, first, "review-old-round")));
  await assert.rejects(f.product.review("reviewer", reviewInput(result.job_id!, second, "review-new-unread")));
  const current = readAll(f.product, "reviewer", second);
  const requirements = JSON.parse(current["requirements.json"]!);
  assert.equal(requirements.original_requirements, task("unused").requirements);
  assert.equal(requirements.current_requirements, "將 value 改為 3。");
  assert.deepEqual(requirements.current_acceptance, ["value 等於 3"]);
  assert.equal((await f.product.review("reviewer", reviewInput(result.job_id!, second, "review-current-round"))).review_status, "pass");
});

test("pass is rejected for failed tests or commands that merely print the word test", async (t) => {
  for (const options of [{ command: "npm test", exitCode: 1 }, { command: "echo test", exitCode: 0 }]) {
    const f = fixture(t);
    const result = await f.product.submit(task("no-passing-tests"));
    f.fake.complete(result.thread_id!, result.turn_id!, f.workspace, options);
    const manifest = f.product.seal(result.job_id!);
    readAll(f.product, "reviewer", manifest);
    await assert.rejects(f.product.review("reviewer", reviewInput(result.job_id!, manifest, "reject-no-test-evidence")), `A ${options.command} / ${options.exitCode} result must not prove passing tests`);
    assert.equal(f.product.status(result.job_id!).review_status, "pending_chatgpt_review");
  }
});

test("protected source never reaches diff artifacts and known token text never leaves status or evidence", async (t) => {
  const f = fixture(t);
  const sentinel = "FIXTURE_PRIVATE_SOURCE_MUST_NOT_BE_EXPOSED";
  writeFileSync(path.join(f.workspace, ".env"), sentinel);
  writeFileSync(path.join(f.workspace, "auth.json"), sentinel);
  const result = await f.product.submit(task("private-source"));
  const fakeToken = `sk-${"B".repeat(26)}`;
  f.fake.complete(result.thread_id!, result.turn_id!, f.workspace, { output: `1 passed; fixture token ${fakeToken}\n` });
  const status = f.product.status(result.job_id!);
  const manifest = f.product.seal(result.job_id!);
  const contents = readAll(f.product, "reviewer", manifest);
  const visible = JSON.stringify({ status, manifest, contents });
  assert.equal(visible.includes(sentinel), false);
  assert.equal(visible.includes(fakeToken), false);
  assert.match(contents["execution.json"]!, /\[REDACTED\]/);
});

test("redacted nested fields and quoted command output preserve valid evidence JSON and complete paging", async (t) => {
  const f = fixture(t);
  const result = await f.product.submit(task("quoted-sensitive-text"));
  f.fake.emit({ method: "item/completed", params: { threadId: result.thread_id, turnId: result.turn_id, item: {
    id: "sensitive-metadata", type: "commandExecution", command: "npm test", cwd: f.workspace,
    status: "completed", exitCode: 0, aggregatedOutput: 'password="FIXTURE_SECRET_QUOTED_VALUE"\n中文測試通過 🐕\n',
    metadata: { password: "FIXTURE_SECRET_FIELD_VALUE", safeLabel: "ordinary result" },
  } } });
  f.fake.complete(result.thread_id!, result.turn_id!, f.workspace);
  f.fake.emit({ method: "item/completed", params: { threadId: result.thread_id, turnId: result.turn_id, item: {
    id: "final-sensitive", type: "agentMessage", phase: "final_answer", text: "Completed. api_key=FIXTURE_SECRET_FINAL_VALUE",
  } } });
  const status = f.product.status(result.job_id!);
  const manifest = f.product.seal(result.job_id!);
  const contents = readAll(f.product, "reviewer", manifest, 17);
  const parsed = JSON.parse(contents["execution.json"]!);
  const item = parsed.items.find((entry: { id: string }) => entry.id === "sensitive-metadata");
  assert.equal(item.metadata.password, "[REDACTED]");
  assert.equal(item.metadata.safeLabel, "ordinary result");
  assert.match(item.aggregatedOutput, /中文測試通過 🐕/);
  assert.match(item.aggregatedOutput, /\[REDACTED\]/);
  const visible = JSON.stringify({ status, contents });
  for (const text of ["FIXTURE_SECRET_QUOTED_VALUE", "FIXTURE_SECRET_FIELD_VALUE", "FIXTURE_SECRET_FINAL_VALUE"]) assert.equal(visible.includes(text), false);
});

test("interrupted execution cannot pass even if a test command succeeded, but can receive requested changes", async (t) => {
  const f = fixture(t);
  const result = await f.product.submit(task("interrupted-task"));
  f.fake.complete(result.thread_id!, result.turn_id!, f.workspace, { status: "interrupted" });
  const manifest = f.product.seal(result.job_id!);
  readAll(f.product, "reviewer", manifest);
  await assert.rejects(f.product.review("reviewer", reviewInput(result.job_id!, manifest, "interrupted-cannot-pass")));
  const verdict = await f.product.review("reviewer", { ...reviewInput(result.job_id!, manifest, "request-repair"), verdict: "changes_requested", summary: "執行已中斷，請從現有變更檢查並完成剩餘驗收。" });
  assert.equal(verdict.review_status, "changes_requested");
  assert.equal(new AutoDev(f.config, f.manager).status(result.job_id!).execution_status, "interrupted");
});

test("two distinct simultaneous followups cannot create an unconfirmed extra round", async (t) => {
  const f = fixture(t);
  const { result } = await finished(f);
  const base = { job_id: result.job_id!, acceptance: ["測試通過"] };
  const results = await Promise.allSettled([
    f.product.continue({ ...base, request_key: "followup-a", requirements: "第一個後續需求。" }),
    f.product.continue({ ...base, request_key: "followup-b", requirements: "第二個後續需求。" }),
  ]);
  assert.equal(results.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(results.filter((entry) => entry.status === "rejected").length, 1);
  assert.equal(f.fake.count("turn/start"), 2);
  const status = f.product.status(result.job_id!);
  assert.equal(status.round, 2);
  const successful = results.find((entry) => entry.status === "fulfilled")!;
  assert.equal(status.turn_id, successful.value.turn_id);
});

test("late execution evidence cannot approve a manifest captured before that evidence arrived", async (t) => {
  const f = fixture(t);
  const { result, manifest } = await finished(f);
  const old = readAll(f.product, "reviewer", manifest);
  f.fake.emit({ method: "item/completed", params: { threadId: result.thread_id, turnId: result.turn_id, item: {
    id: "late-test-output", type: "commandExecution", command: "npm test", cwd: f.workspace,
    status: "completed", exitCode: 0, aggregatedOutput: "Different evidence only delivered after the review snapshot.\n",
  } } });
  await assert.rejects(f.product.review("reviewer", reviewInput(result.job_id!, manifest, "stale-execution-evidence")));
  assert.notEqual(f.product.status(result.job_id!).review_status, "pass");
  assert.deepEqual(readAll(f.product, "reviewer", manifest), old);
});

test("another active job cannot leave a completed task with an unconfirmed followup round", async (t) => {
  const f = fixture(t);
  const { result: first } = await finished(f, "completed-a");
  const second = await f.product.submit(task("active-b"));
  await assert.rejects(f.product.continue({ request_key: "blocked-followup-a", job_id: first.job_id!, requirements: "等待另一個工作結束才執行的需求。", acceptance: ["不覆蓋正在執行的工作"] }));
  assert.equal(f.fake.count("turn/start"), 2);
  assert.equal(f.fake.count("thread/resume"), 0);
  assert.equal(f.product.status(first.job_id!).round, 1);
  assert.equal(f.product.status(first.job_id!).execution_status, "completed");
  assert.equal(f.product.status(second.job_id!).execution_status, "running");
  assert.equal(f.product.status(second.job_id!).turn_id, second.turn_id);
});

test("a lost review response replays the durable verdict after reconnect without recording another review", async (t) => {
  const f = fixture(t);
  const { result, manifest } = await finished(f);
  readAll(f.product, "review-session-before-disconnect", manifest);
  const request = reviewInput(result.job_id!, manifest, "review-response-lost");
  const original = await f.product.review("review-session-before-disconnect", request);
  const restarted = new AutoDev(f.config, f.manager);
  const replay = await restarted.review("new-session-after-disconnect", request);
  assert.deepEqual(replay, original);
  assert.equal(restarted.journal.list().filter((record) => record.key === request.request_key).length, 1);
  await assert.rejects(restarted.review("new-session-after-disconnect", { ...request, request_key: "distinct-review-without-reading" }));
  assert.equal(restarted.status(result.job_id!).review_status, "pass");
});

test("deleting an omitted binary file does not make incomplete source evidence eligible for pass", async (t) => {
  const f = fixture(t);
  const binary = path.join(f.workspace, "binary-asset.bin");
  writeFileSync(binary, Buffer.from([0, 1, 2, 3]));
  const result = await f.product.submit(task("delete-binary"));
  unlinkSync(binary);
  f.fake.complete(result.thread_id!, result.turn_id!, f.workspace);
  const manifest = f.product.seal(result.job_id!);
  const contents = readAll(f.product, "reviewer", manifest);
  const identity = JSON.parse(contents["source-identity.json"]!);
  assert.ok(identity.before.omitted.some((item: { path: string; reason: string }) => item.path === "binary-asset.bin" && item.reason === "binary_requires_separate_review"));
  assert.deepEqual(identity.after.omitted, []);
  await assert.rejects(f.product.review("reviewer", reviewInput(result.job_id!, manifest, "reject-incomplete-before")));
  assert.equal(f.product.status(result.job_id!).review_status, "pending_chatgpt_review");
});

test("stale cancellation cannot interrupt a newer turn", async (t) => {
  const f = fixture(t);
  const { result } = await finished(f);
  const current = await f.product.continue({ request_key: "new-turn", job_id: result.job_id!, requirements: "執行下一個修正。", acceptance: ["新修正測試通過"] });
  await assert.rejects(f.product.cancel({ request_key: "stale-cancel", job_id: result.job_id!, turn_id: result.turn_id! }));
  assert.equal(f.fake.count("turn/interrupt"), 0);
  assert.equal(f.product.status(result.job_id!).turn_id, current.turn_id);
  assert.equal(f.product.status(result.job_id!).execution_status, "running");
});
