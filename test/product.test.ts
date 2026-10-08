import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import type { AppServerClient, AppServerMessage, JsonRpcId } from "../src/codex-app-server.js";
import type { EvidenceManifest } from "../src/evidence.js";
import { JobManager } from "../src/jobs.js";
import type { LocalConfig } from "../src/local-config.js";
import { AutoDev, ReviewPreconditionError } from "../src/product.js";
import { JournalError } from "../src/journal.js";
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

test('independent repair review retains original acceptance, complete current source and cumulative changes',async t=>{
  const f=fixture(t);writeFileSync(path.join(f.workspace,'dependency.ts'),'export const dependency = 42;\n');
  const {result,manifest}=await finished(f,'independent');
  const original=readAll(f.product,'real-client-boundary-fixture',manifest);
  assert.match(original['source.json']!,/dependency = 42/);
  await f.product.review('real-client-boundary-fixture',{request_key:'finding',job_id:result.job_id!,manifest_id:manifest.id,verdict:'changes_requested',summary:'The acceptance regression needs a substantive test.'});
  const next=await f.product.continue({request_key:'repair',job_id:result.job_id!,requirements:'Add the missing regression test.',acceptance:['New regression passes.']});
  f.fake.complete(next.thread_id!,next.turn_id!,f.workspace);
  const current=f.product.seal(result.job_id!);const contents=readAll(f.product,'real-client-boundary-fixture',current);
  assert.match(contents['cumulative.patch']!,/\+export const value = 2/);
  assert.equal(contents['changes.patch'],'');
  const requirements=JSON.parse(contents['requirements.json']!);
  assert.ok(requirements.current_acceptance.includes('value 等於 2'));
  assert.match(requirements.current_requirements,/substantive test/);
  assert.equal(f.product.evidenceStore.read(manifest.id,'source.json').content,original['source.json']);
  await assert.rejects(f.product.review('different-client',{request_key:'invalid-pass',job_id:result.job_id!,manifest_id:current.id,verdict:'pass',summary:'No receipt'}),/EVIDENCE_NOT_READ/);
});

test('three unsuccessful repair rounds stop before another dispatch or journal write',async t=>{
  const f=fixture(t);const {result}=await finished(f,'repair-limit');
  for(let attempt=0;attempt<4;attempt++){
    const manifest=f.product.seal(result.job_id!);readAll(f.product,'fixture-reviewer',manifest);
    await f.product.review('fixture-reviewer',{request_key:`verdict-${attempt}`,job_id:result.job_id!,manifest_id:manifest.id,verdict:'changes_requested',summary:'A substantive unresolved regression remains.'});
    if(attempt<3){const next=await f.product.continue({request_key:`repair-${attempt}`,job_id:result.job_id!,requirements:'Fix the regression.',acceptance:['Regression passes.']});f.fake.complete(next.thread_id!,next.turn_id!,f.workspace);}
  }
  const count=f.product.journal.list().length;
  await assert.rejects(f.product.continue({request_key:'over-limit',job_id:result.job_id!,requirements:'Repeat indefinitely.',acceptance:['Pass.']}),/repair limit/);
  assert.equal(f.product.journal.list().length,count);assert.equal(f.fake.count('turn/start'),4);
});

async function finished(f: ReturnType<typeof fixture>, key = "start") {
  const result = await f.product.submit(task(key));
  writeFileSync(path.join(f.workspace, "source.ts"), "export const value = 2;\n");
  f.fake.complete(result.thread_id!, result.turn_id!, f.workspace);
  return { result, manifest: f.product.seal(result.job_id!) };
}

async function assertScopeSubmitJournalState(f:ReturnType<typeof fixture>,input:ReturnType<typeof scopedBinaryTask>,expected:'UNCERTAIN'|'FAILED'){
  const matches=(code:'UNCERTAIN'|'FAILED'|'CONFLICT')=>(error:unknown)=>error instanceof JournalError&&error.code===code;
  await assert.rejects(f.product.submit(input),matches(expected));
  assert.equal(f.product.journal.list().find(record=>record.key===input.request_key)?.status,expected.toLowerCase());
  await assert.rejects(f.product.submit(input),matches(expected));
  await assert.rejects(f.product.submit({...input,requirements:`${input.requirements}\nChanged request body.`}),matches('CONFLICT'));
  assert.equal(f.product.status().tasks.length,0);
  assert.equal(f.fake.count('turn/start'),0);
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

test("rejected review preflight leaves its key reusable after the same reader finishes all pages", async (t) => {
  const f = fixture(t);
  const { result, manifest } = await finished(f);
  const request = reviewInput(result.job_id!, manifest, "review-corrected-after-reading");
  await assert.rejects(f.product.review("reviewer", request), (error: unknown) => error instanceof ReviewPreconditionError && error.code === "EVIDENCE_NOT_READ" && error.unread_artifacts.length === manifest.artifacts.length);
  assert.equal(f.product.journal.list().some(record => record.key === request.request_key), false);
  const artifact = manifest.artifacts.find(item => item.byteLength > 64)!;
  f.product.readArtifact("reviewer", manifest.id, artifact.name, undefined, 32);
  await assert.rejects(f.product.review("reviewer", request), ReviewPreconditionError);
  assert.equal(f.product.journal.list().some(record => record.key === request.request_key), false);
  readAll(f.product, "reviewer", manifest);
  await assert.rejects(f.product.review("reviewer", { ...request, summary: " " }), /summary/i);
  assert.equal(f.product.journal.list().some(record => record.key === request.request_key), false);
  const [first, replay] = await Promise.all([f.product.review("reviewer", request), f.product.review("reviewer", request)]);
  assert.equal(first.review_status, "pass");
  assert.deepEqual(replay, first);
  assert.equal(f.product.journal.list().find(record => record.key === request.request_key)?.status, "succeeded");
  f.product.forgetSession("reviewer");
  assert.deepEqual(await f.product.review("new-reader-without-receipts", request), first);
  await assert.rejects(f.product.review("new-reader-without-receipts", { ...request, summary: "A different review body" }), (error: unknown) => error instanceof JournalError && error.code === "CONFLICT");
});

test("a review queued behind a new turn validates the current revision without poisoning its key", async (t) => {
  const f = fixture(t);
  const { result, manifest } = await finished(f);
  readAll(f.product, "reviewer", manifest);
  const request = reviewInput(result.job_id!, manifest, "review-after-concurrent-followup");
  const outcomes = await Promise.allSettled([
    f.product.continue({ request_key: "concurrent-followup", job_id: result.job_id!, requirements: "繼續修改 value。", acceptance: ["新一輪測試通過"] }),
    f.product.review("reviewer", request),
  ]);
  assert.equal(outcomes[0]!.status, "fulfilled");
  assert.equal(outcomes[1]!.status, "rejected");
  assert.equal(f.product.journal.list().some(record => record.key === request.request_key), false);
  assert.equal(f.product.status(result.job_id!).round, 2);
  assert.equal(f.product.status(result.job_id!).review_status, "pending_chatgpt_review");
});

test("a failed durable verdict write remains uncertain and cannot silently retry", async (t) => {
  const f = fixture(t);
  const { result, manifest } = await finished(f);
  readAll(f.product, "reviewer", manifest);
  const request = reviewInput(result.job_id!, manifest, "review-storage-failure");
  const statePath = path.join(f.runtimeDir, "product-state.json");
  const preserved = path.join(f.runtimeDir, "preserved-product-state.json");
  renameSync(statePath, preserved);
  mkdirSync(statePath);
  await assert.rejects(f.product.review("reviewer", request), (error: unknown) => error instanceof JournalError && error.code === "UNCERTAIN");
  assert.equal(f.product.journal.list().find(record => record.key === request.request_key)?.status, "uncertain");
  assert.equal(f.product.status(result.job_id!).review_status, "pending_chatgpt_review");
  rmdirSync(statePath);
  renameSync(preserved, statePath);
  const restarted = new AutoDev(f.config, f.manager);
  assert.equal(restarted.status(result.job_id!).review_status, "pending_chatgpt_review");
  readAll(restarted, "reviewer", manifest);
  await assert.rejects(restarted.review("reviewer", request), (error: unknown) => error instanceof JournalError && error.code === "UNCERTAIN");
});

test("reader expiry at journal dispatch rejects definitively before writing a verdict", async (t) => {
  const f = fixture(t);
  const { result, manifest } = await finished(f);
  readAll(f.product, "expiring-reader", manifest);
  const request = reviewInput(result.job_id!, manifest, "review-reader-expired-at-dispatch");
  const review = f.product.review("expiring-reader", request);
  queueMicrotask(() => f.product.forgetSession("expiring-reader"));
  await assert.rejects(review, (error: unknown) => error instanceof JournalError && error.code === "FAILED");
  assert.equal(f.product.journal.list().find(record => record.key === request.request_key)?.status, "failed");
  assert.equal(f.product.status(result.job_id!).review_status, "pending_chatgpt_review");
});

test("review rejects source changed after capture and keeps the captured diff immutable", async (t) => {
  const f = fixture(t);
  const { result, manifest } = await finished(f);
  const original = readAll(f.product, "reviewer", manifest);
  writeFileSync(path.join(f.workspace, "source.ts"), "export const value = 99;\n");
  await assert.rejects(f.product.review("reviewer", reviewInput(result.job_id!, manifest, "review-stale-source")));
  assert.equal(f.product.journal.list().some(record => record.key === "review-stale-source"), false);
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
  assert.equal(f.product.journal.list().some(record => record.key === "review-old-round"), false);
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
    assert.equal(f.product.journal.list().some(record => record.key === "reject-no-test-evidence"), false);
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
  assert.equal(f.product.journal.list().some(record => record.key === "stale-execution-evidence"), false);
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
  assert.equal(f.product.journal.list().some(record => record.key === "reject-incomplete-before"), false);
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

function scopedBinaryTask(f:ReturnType<typeof fixture>,request_key:string) {
  writeFileSync(path.join(f.workspace,'icon.png'),Buffer.from([0,1,2,3]));
  execFileSync('git',['add','.'],{cwd:f.workspace,windowsHide:true});
  execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=.no-test-hooks','commit','-m','Fixture baseline'],{cwd:f.workspace,windowsHide:true,stdio:'pipe'});
  const base=execFileSync('git',['rev-parse','HEAD'],{cwd:f.workspace,windowsHide:true,encoding:'utf8'}).trim();
  return {...task(request_key),requirements:`AutoDev-Review-Scope: ${JSON.stringify({mode:'changes',base_commit:base,excluded_binary_assets:[{path:'icon.png',reason:'Unchanged application icon unrelated to this calculation change.'}],required_binary_paths:[]})}\n${task(request_key).requirements}`};
}

function scopedBinaryModeTask(f:ReturnType<typeof fixture>,request_key:string,mode:number) {
  const binary=path.join(f.workspace,'icon.png');writeFileSync(binary,Buffer.from([0,1,2,3]));chmodSync(binary,mode);
  execFileSync('git',['add','.'],{cwd:f.workspace,windowsHide:true});
  execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=.no-test-hooks','commit','-m','Fixture mode baseline'],{cwd:f.workspace,windowsHide:true,stdio:'pipe'});
  const base=execFileSync('git',['rev-parse','HEAD'],{cwd:f.workspace,windowsHide:true,encoding:'utf8'}).trim();
  return {...task(request_key),requirements:`AutoDev-Review-Scope: ${JSON.stringify({mode:'changes',base_commit:base,excluded_binary_assets:[{path:'icon.png',reason:'Unchanged application icon unrelated to this calculation change.'}],required_binary_paths:[]})}\n${task(request_key).requirements}`};
}

test('change-scoped review excludes only pinned unchanged binaries, survives restart and becomes stale after asset mutation',async t=>{
  const f=fixture(t);const input=scopedBinaryTask(f,'scoped-unchanged');
  const fakeToken=`sk-${'C'.repeat(26)}`;
  input.requirements=input.requirements.replace('Unchanged application icon',`${fakeToken} Unchanged application icon`);
  const result=await f.product.submit(input);
  writeFileSync(path.join(f.workspace,'source.ts'),'export const value = 2;\n');
  f.fake.complete(result.thread_id!,result.turn_id!,f.workspace);
  const manifest=f.product.seal(result.job_id!);
  const restarted=new AutoDev(f.config,f.manager);
  const contents=readAll(restarted,'reviewer',manifest);
  assert.equal(JSON.stringify(contents).includes(fakeToken),false);
  const scope=JSON.parse(contents['review-scope.json']!);
  assert.equal(scope.declaration.mode,'changes');assert.equal(scope.excluded[0].path,'icon.png');assert.match(scope.excluded[0].sha256,/^[a-f0-9]{64}$/);assert.equal(scope.excluded[0].git_mode,'100644');assert.equal(scope.excluded[0].working_mode,'100644');assert.match(scope.excluded[0].git_blob_oid,/^[a-f0-9]{40,64}$/);
  assert.equal((await restarted.review('reviewer',reviewInput(result.job_id!,manifest,'scoped-pass'))).review_status,'pass');
  assert.equal(new AutoDev(f.config,f.manager).status(result.job_id!).review_status,'pass');
  writeFileSync(path.join(f.workspace,'icon.png'),Buffer.from([0,1,2,4]));
  assert.equal(restarted.status(result.job_id!).review_status,'stale_review');
  assert.equal(new AutoDev(f.config,f.manager).status(result.job_id!).review_status,'stale_review');
});

test('chmod-only change to an excluded binary prevents review pass',async t=>{
  if(process.platform==='win32'){t.skip('Windows does not expose Git executable-mode changes through chmod consistently.');return;}
  const f=fixture(t);const result=await f.product.submit(scopedBinaryTask(f,'scoped-mode-change'));
  chmodSync(path.join(f.workspace,'icon.png'),0o755);
  f.fake.complete(result.thread_id!,result.turn_id!,f.workspace);
  const manifest=f.product.seal(result.job_id!);readAll(f.product,'mode-reviewer',manifest);
  await assert.rejects(f.product.review('mode-reviewer',reviewInput(result.job_id!,manifest,'reject-mode-change')),/changed|separate review/i);
});

test('Git executable mode follows owner-execute at both permission boundaries',async t=>{
  if(process.platform==='win32'){t.skip('Windows does not expose Git executable-mode changes through chmod consistently.');return;}
  for(const [initialMode,changedMode,label] of [[0o755,0o655,'owner execute removed despite other execute bits'],[0o655,0o755,'owner execute added despite other execute bits']] as const){
    const f=fixture(t);const result=await f.product.submit(scopedBinaryModeTask(f,`mode-boundary-${label}`,initialMode));
    chmodSync(path.join(f.workspace,'icon.png'),changedMode);
    f.fake.complete(result.thread_id!,result.turn_id!,f.workspace);
    const manifest=f.product.seal(result.job_id!);readAll(f.product,`mode-reviewer-${label}`,manifest);
    await assert.rejects(f.product.review(`mode-reviewer-${label}`,reviewInput(result.job_id!,manifest,`reject-mode-boundary-${label}`)),/changed|separate review/i);
  }
});

test('Git mode-only change to an excluded binary prevents review pass',async t=>{
  const f=fixture(t);const result=await f.product.submit(scopedBinaryTask(f,'scoped-git-mode-change'));
  execFileSync('git',['update-index','--chmod=+x','--','icon.png'],{cwd:f.workspace,windowsHide:true});
  f.fake.complete(result.thread_id!,result.turn_id!,f.workspace);
  const manifest=f.product.seal(result.job_id!);readAll(f.product,'git-mode-reviewer',manifest);
  await assert.rejects(f.product.review('git-mode-reviewer',reviewInput(result.job_id!,manifest,'reject-git-mode-change')),/changed|separate review/i);
});

test('staged binary blob changed after scope capture blocks pass when worktree bytes are restored',async t=>{
  const f=fixture(t);const result=await f.product.submit(scopedBinaryTask(f,'staged-after-capture'));
  writeFileSync(path.join(f.workspace,'icon.png'),Buffer.from([0,9]));
  execFileSync('git',['add','icon.png'],{cwd:f.workspace,windowsHide:true});
  writeFileSync(path.join(f.workspace,'icon.png'),Buffer.from([0,1,2,3]));
  f.fake.complete(result.thread_id!,result.turn_id!,f.workspace);
  const manifest=f.product.seal(result.job_id!);readAll(f.product,'staged-reviewer',manifest);
  await assert.rejects(f.product.review('staged-reviewer',reviewInput(result.job_id!,manifest,'reject-staged-after-capture')),/changed|separate review/i);
});

test('first trusted change scope can bind on followup when excluded binaries match the initial snapshot',async t=>{
  const f=fixture(t);const input=scopedBinaryTask(f,'late-scope-binding');
  input.requirements=input.requirements.slice(input.requirements.indexOf('\n')+1);
  const result=await f.product.submit(input);
  f.fake.complete(result.thread_id!,result.turn_id!,f.workspace);
  const base=execFileSync('git',['rev-parse','HEAD'],{cwd:f.workspace,windowsHide:true,encoding:'utf8'}).trim();
  const requirements=`AutoDev-Review-Scope: ${JSON.stringify({mode:'changes',base_commit:base,excluded_binary_assets:[{path:'icon.png',reason:'Unchanged application icon unrelated to this calculation change.'}],required_binary_paths:[]})}\nContinue the requested source change.`;
  const next=await f.product.continue({request_key:'bind-scope-followup',job_id:result.job_id!,requirements,acceptance:['The requested source change is complete.']});
  const restarted=new AutoDev(f.config,f.manager);
  f.fake.complete(next.thread_id!,next.turn_id!,f.workspace);
  const manifest=restarted.seal(result.job_id!);const evidence=readAll(restarted,'scope-reviewer',manifest);
  assert.equal(JSON.parse(evidence['review-scope.json']!).excluded[0].path,'icon.png');
  await restarted.review('scope-reviewer',reviewInput(result.job_id!,manifest,'pass-first-scope'));
});

test('first followup scope cannot rebaseline a binary already changed by the initial turn',async t=>{
  const f=fixture(t);const input=scopedBinaryTask(f,'late-scope-changed-binary');
  input.requirements=input.requirements.slice(input.requirements.indexOf('\n')+1);
  const result=await f.product.submit(input);
  f.fake.complete(result.thread_id!,result.turn_id!,f.workspace);
  writeFileSync(path.join(f.workspace,'icon.png'),Buffer.from([0,9]));
  execFileSync('git',['add','icon.png'],{cwd:f.workspace,windowsHide:true});
  execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=.no-test-hooks','commit','-m','Fixture prior binary mutation'],{cwd:f.workspace,windowsHide:true,stdio:'pipe'});
  const changedBase=execFileSync('git',['rev-parse','HEAD'],{cwd:f.workspace,windowsHide:true,encoding:'utf8'}).trim();
  const requirements=`AutoDev-Review-Scope: ${JSON.stringify({mode:'changes',base_commit:changedBase,excluded_binary_assets:[{path:'icon.png',reason:'Unchanged application icon unrelated to this calculation change.'}],required_binary_paths:[]})}\nContinue the requested source change.`;
  await assert.rejects(f.product.continue({request_key:'reject-late-binary-rebase',job_id:result.job_id!,requirements,acceptance:['The requested source change is complete.']}));
  assert.equal(f.fake.count('turn/start'),1);
});

test('changed, new and deleted binary assets remain blocking in a declared change scope',async t=>{
  for(const operation of ['change','new','delete','late-change'] as const){
    const f=fixture(t);const result=await f.product.submit(scopedBinaryTask(f,`scoped-${operation}`));
    if(operation==='change')writeFileSync(path.join(f.workspace,'icon.png'),Buffer.from([0,9]));
    if(operation==='new')writeFileSync(path.join(f.workspace,'new.png'),Buffer.from([0,9]));
    if(operation==='delete')unlinkSync(path.join(f.workspace,'icon.png'));
    f.fake.complete(result.thread_id!,result.turn_id!,f.workspace);
    const manifest=f.product.seal(result.job_id!);readAll(f.product,'reviewer',manifest);
    if(operation==='late-change')writeFileSync(path.join(f.workspace,'icon.png'),Buffer.from([0,9]));
    await assert.rejects(f.product.review('reviewer',reviewInput(result.job_id!,manifest,`reject-${operation}`)),/changed|separate review|disappeared/i);
    assert.equal(f.product.status(result.job_id!).review_status,'pending_chatgpt_review');
  }
});

test('continued rounds retain the original binary review baseline',async t=>{
  const f=fixture(t);const result=await f.product.submit(scopedBinaryTask(f,'cumulative-binary-baseline'));
  writeFileSync(path.join(f.workspace,'source.ts'),'export const value = 2;\n');
  f.fake.complete(result.thread_id!,result.turn_id!,f.workspace);
  const firstManifest=f.product.seal(result.job_id!);readAll(f.product,'binary-reviewer',firstManifest);
  await f.product.review('binary-reviewer',{...reviewInput(result.job_id!,firstManifest,'binary-finding'),verdict:'changes_requested',summary:'The source change needs one more focused regression.'});

  writeFileSync(path.join(f.workspace,'icon.png'),Buffer.from([0,9]));
  execFileSync('git',['add','icon.png'],{cwd:f.workspace,windowsHide:true});
  execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=.no-test-hooks','commit','-m','Fixture binary change'],{cwd:f.workspace,windowsHide:true,stdio:'pipe'});
  const changedBase=execFileSync('git',['rev-parse','HEAD'],{cwd:f.workspace,windowsHide:true,encoding:'utf8'}).trim();
  const replacementScope=`AutoDev-Review-Scope: ${JSON.stringify({mode:'changes',base_commit:changedBase,excluded_binary_assets:[{path:'icon.png',reason:'Unchanged application icon unrelated to this calculation change.'}],required_binary_paths:[]})}`;
  await assert.rejects(f.product.continue({request_key:'rebase-binary-scope',job_id:result.job_id!,requirements:`${replacementScope}\nRepair the regression.`,acceptance:['The regression passes.']}));
  assert.equal(f.fake.count('turn/start'),1);

  const next=await f.product.continue({request_key:'cumulative-binary-repair',job_id:result.job_id!,requirements:'Add the requested focused regression.',acceptance:['The focused regression passes.']});
  f.fake.complete(next.thread_id!,next.turn_id!,f.workspace);
  const nextManifest=f.product.seal(result.job_id!);readAll(f.product,'binary-reviewer',nextManifest);
  await f.product.review('binary-reviewer',{...reviewInput(result.job_id!,nextManifest,'second-binary-finding'),verdict:'changes_requested',summary:'One more source regression remains.'});

  const restarted=new AutoDev(f.config,f.manager);
  const finalTurn=await restarted.continue({request_key:'cumulative-binary-final',job_id:result.job_id!,requirements:'Finish the remaining regression.',acceptance:['All regressions pass.']});
  f.fake.complete(finalTurn.thread_id!,finalTurn.turn_id!,f.workspace);
  const finalManifest=restarted.seal(result.job_id!);readAll(restarted,'binary-reviewer',finalManifest);
  await assert.rejects(restarted.review('binary-reviewer',{...reviewInput(result.job_id!,finalManifest,'cumulative-binary-pass'),summary:'The regressions pass and source review is complete.'}),/changed|separate review/i);
});

test('binary modified before dispatch cannot hide behind the current task baseline',async t=>{
  const f=fixture(t);const input=scopedBinaryTask(f,'preexisting-binary-change');
  writeFileSync(path.join(f.workspace,'icon.png'),Buffer.from([0,9]));
  await assertScopeSubmitJournalState(f,input,'FAILED');
});

test('non-ancestor review base is a pre-dispatch scope rejection',async t=>{
  const f=fixture(t);const input=scopedBinaryTask(f,'non-ancestor-review-base');
  const tree=execFileSync('git',['write-tree'],{cwd:f.workspace,windowsHide:true,encoding:'utf8'}).trim();
  const orphan=execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit-tree',tree,'-m','Unrelated synthetic base'],{cwd:f.workspace,windowsHide:true,encoding:'utf8'}).trim();
  const current=execFileSync('git',['rev-parse','HEAD'],{cwd:f.workspace,windowsHide:true,encoding:'utf8'}).trim();
  input.requirements=input.requirements.replace(current,orphan);
  await assertScopeSubmitJournalState(f,input,'FAILED');
});

test('missing full review base SHA is a definitive pre-dispatch rejection',async t=>{
  const f=fixture(t);const input=scopedBinaryTask(f,'missing-review-base');
  const current=execFileSync('git',['rev-parse','HEAD'],{cwd:f.workspace,windowsHide:true,encoding:'utf8'}).trim();
  input.requirements=input.requirements.replace(current,'f'.repeat(40));
  await assertScopeSubmitJournalState(f,input,'FAILED');
});

test('Git repository read failure during scope preflight remains uncertain',async t=>{
  const f=fixture(t);const input=scopedBinaryTask(f,'git-scope-io-failure');
  renameSync(path.join(f.workspace,'.git'),path.join(f.workspace,'.git-unavailable'));
  await assertScopeSubmitJournalState(f,input,'UNCERTAIN');
});

test('uncertain submit dispatch errors remain uncertain after scope preflight handling',async t=>{
  const f=fixture(t);const input=task('uncertain-submit-dispatch');
  const request=f.fake.request.bind(f.fake);let threadStarts=0;
  f.fake.request=async <T>(method:string,params?:unknown):Promise<T>=>{
    if(method==='thread/start'){threadStarts++;throw Object.assign(new Error('Synthetic app-server timeout'),{code:'ETIMEDOUT'});}
    return request<T>(method,params);
  };
  await assert.rejects(f.product.submit(input),(error:unknown)=>error instanceof JournalError&&error.code==='UNCERTAIN');
  assert.equal(f.product.journal.list().find(record=>record.key===input.request_key)?.status,'uncertain');
  await assert.rejects(f.product.submit(input),(error:unknown)=>error instanceof JournalError&&error.code==='UNCERTAIN');
  await assert.rejects(f.product.submit({...input,requirements:'Different task.'}),(error:unknown)=>error instanceof JournalError&&error.code==='CONFLICT');
  assert.equal(threadStarts,1);
  assert.equal(f.product.status().tasks.length,1);
});

test('staged binary blob cannot be hidden by restoring its worktree bytes before scope capture',async t=>{
  const f=fixture(t);const input=scopedBinaryTask(f,'staged-restored-binary');
  writeFileSync(path.join(f.workspace,'icon.png'),Buffer.from([0,9]));
  execFileSync('git',['add','icon.png'],{cwd:f.workspace,windowsHide:true});
  writeFileSync(path.join(f.workspace,'icon.png'),Buffer.from([0,1,2,3]));
  await assertScopeSubmitJournalState(f,input,'FAILED');
});

test('unmerged binary index without stage zero cannot be excluded',async t=>{
  const f=fixture(t);const input=scopedBinaryTask(f,'unmerged-binary-index');
  execFileSync('git',['checkout','-b','binary-side'],{cwd:f.workspace,windowsHide:true,stdio:'pipe'});
  writeFileSync(path.join(f.workspace,'icon.png'),Buffer.from([0,5,6]));
  execFileSync('git',['add','icon.png'],{cwd:f.workspace,windowsHide:true});
  execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=.no-test-hooks','commit','-m','Binary side change'],{cwd:f.workspace,windowsHide:true,stdio:'pipe'});
  execFileSync('git',['checkout','-'],{cwd:f.workspace,windowsHide:true,stdio:'pipe'});
  writeFileSync(path.join(f.workspace,'icon.png'),Buffer.from([0,7,8]));
  execFileSync('git',['add','icon.png'],{cwd:f.workspace,windowsHide:true});
  execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=.no-test-hooks','commit','-m','Binary main change'],{cwd:f.workspace,windowsHide:true,stdio:'pipe'});
  assert.throws(()=>execFileSync('git',['merge','binary-side'],{cwd:f.workspace,windowsHide:true,stdio:'pipe'}));
  await assertScopeSubmitJournalState(f,input,'FAILED');
});

test('legacy omitted binary state without hashes cannot acquire a pass after restart',async t=>{
  const f=fixture(t);const result=await f.product.submit(scopedBinaryTask(f,'legacy-binary'));
  f.fake.complete(result.thread_id!,result.turn_id!,f.workspace);
  const filename=path.join(f.runtimeDir,'product-state.json');
  const envelope=JSON.parse(readFileSync(filename,'utf8'));
  const round=envelope.state.records[0].rounds[0];
  delete round.reviewScope;delete round.before.omitted[0].sha256;delete round.before.omitted[0].bytes;
  envelope.checksum=createHash('sha256').update(JSON.stringify(envelope.state)).digest('hex');
  writeFileSync(filename,JSON.stringify(envelope));
  const restarted=new AutoDev(f.config,f.manager);const manifest=restarted.seal(result.job_id!);readAll(restarted,'reviewer',manifest);
  await assert.rejects(restarted.review('reviewer',reviewInput(result.job_id!,manifest,'reject-legacy')),/separate review/);
  const next=await restarted.continue({request_key:'legacy-binary-followup',job_id:result.job_id!,requirements:'Continue the task after restart.',acceptance:['The task is complete.']});
  f.fake.complete(next.thread_id!,next.turn_id!,f.workspace);
  const resumed=new AutoDev(f.config,f.manager);const resumedManifest=resumed.seal(result.job_id!);readAll(resumed,'reviewer',resumedManifest);
  await assert.rejects(resumed.review('reviewer',reviewInput(result.job_id!,resumedManifest,'reject-legacy-followup')),/separate review/);
});
