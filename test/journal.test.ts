import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { IdempotencyJournal, JournalDefinitiveError, JournalError } from "../src/journal.js";

const testRoot = path.resolve(".local-tests");

function fixture(t: { after: (cleanup: () => void) => void }) {
  mkdirSync(testRoot, { recursive: true });
  const directory = mkdtempSync(path.join(testRoot, "journal-"));
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(`${testRoot}${path.sep}`));
    rmSync(resolved, { recursive: true, force: true });
  });
  const file = path.join(directory, "journal.json");
  return { directory, file, journal: new IdempotencyJournal(file) };
}

function code(expected: JournalError["code"]) {
  return (error: unknown) => error instanceof JournalError && error.code === expected;
}

function checksum(document: Record<string, unknown>): void {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
    return JSON.stringify(value);
  };
  document.checksum = createHash("sha256").update(canonical({ schemaVersion: document.schemaVersion, records: document.records })).digest("hex");
}

test("pending is on disk before dispatch; canonical requests replay one detached result across restart", async (t) => {
  const { directory, file, journal } = fixture(t);
  let calls = 0;
  const original = { job: { id: "job-1" } };
  const first = await journal.execute("submit-1", { z: [1, { b: false, a: "中文" }], a: null }, () => {
    calls++;
    assert.equal(JSON.parse(readFileSync(file, "utf8")).records[0].status, "pending");
    return original;
  });
  original.job.id = "changed original";
  first.job.id = "changed returned result";
  const restarted = new IdempotencyJournal(file);
  assert.deepEqual(await restarted.execute("submit-1", { a: null, z: [1, { a: "中文", b: false }] }, () => { calls++; return { job: { id: "duplicate" } }; }), { job: { id: "job-1" } });
  const listed = restarted.list();
  listed[0]!.status = "failed";
  assert.equal(restarted.list()[0]!.status, "succeeded");
  assert.equal(calls, 1);
  assert.deepEqual(readdirSync(directory), ["journal.json"]);
});

test("same key concurrent submissions join one operation; conflicting body is rejected while pending", async (t) => {
  const { journal } = fixture(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const first = journal.execute("concurrent", { operation: "start", project: "one" }, async () => { calls++; await gate; return { id: "job-1" }; });
  const second = journal.execute("concurrent", { project: "one", operation: "start" }, () => { calls++; return { id: "wrong" }; });
  await assert.rejects(journal.execute("concurrent", { operation: "continue", project: "one" }, () => "wrong"), code("CONFLICT"));
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  a.id = "mutated";
  assert.equal(b.id, "job-1");
});

test("restart converts durable pending to uncertain and never dispatches it", async (t) => {
  const { file, journal } = fixture(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const running = journal.execute("crashed", { operation: "start" }, async () => { await gate; return { id: "only-original" }; });
  const restarted = new IdempotencyJournal(file);
  assert.equal(restarted.list()[0]!.status, "uncertain");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).records[0].status, "uncertain");
  let calls = 0;
  await assert.rejects(restarted.execute("crashed", { operation: "start" }, () => { calls++; return "duplicate"; }), code("UNCERTAIN"));
  await assert.rejects(restarted.execute("crashed", { operation: "stop" }, () => "duplicate"), code("CONFLICT"));
  assert.equal(calls, 0);
  // The original instance is only kept alive here to avoid leaking a promise;
  // production creates a replacement only after releasing its single-writer lock.
  release();
  await running;
});

test("abrupt process exit after an effect leaves a durable submission that cannot execute twice", async (t) => {
  const { file, directory } = fixture(t);
  const effect = path.join(directory, "effect.txt");
  const script = `
    import { writeFileSync } from 'node:fs';
    import { IdempotencyJournal } from './src/journal.ts';
    const journal = new IdempotencyJournal(process.argv[1]);
    await journal.execute('power-loss', { operation: 'start' }, () => {
      writeFileSync(process.argv[2], 'created exactly once');
      process.exit(73);
    });
  `;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, file, effect], {
    cwd: process.cwd(), windowsHide: true, encoding: "utf8", timeout: 15_000,
  });
  assert.equal(child.status, 73, child.stderr);
  assert.equal(readFileSync(effect, "utf8"), "created exactly once");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).records[0].status, "pending");
  const restarted = new IdempotencyJournal(file);
  let duplicate = false;
  await assert.rejects(restarted.execute("power-loss", { operation: "start" }, () => { duplicate = true; return {}; }), code("UNCERTAIN"));
  assert.equal(duplicate, false);
  assert.equal(restarted.list()[0]!.status, "uncertain");
});

test("unknown operation errors remain uncertain, omit raw secrets, and cannot replay", async (t) => {
  const { file, journal } = fixture(t);
  await assert.rejects(journal.execute("lost-response", { operation: "start" }, () => { throw new Error("Bearer private-secret-value"); }), code("UNCERTAIN"));
  assert.equal(readFileSync(file, "utf8").includes("private-secret-value"), false);
  assert.equal(journal.list()[0]!.status, "uncertain");
  let calls = 0;
  await assert.rejects(new IdempotencyJournal(file).execute("lost-response", { operation: "start" }, () => { calls++; return "bad"; }), code("UNCERTAIN"));
  assert.equal(calls, 0);
});

test("explicit no-effect rejection is failed and remains deduplicated across restart", async (t) => {
  const { file, journal } = fixture(t);
  await assert.rejects(journal.execute("rejected", {}, () => { throw new JournalDefinitiveError(); }), code("FAILED"));
  assert.equal(journal.list()[0]!.status, "failed");
  await assert.rejects(new IdempotencyJournal(file).execute("rejected", {}, () => "unexpected retry"), code("FAILED"));
});

test("non-JSON successful results are uncertain rather than safe to retry", async (t) => {
  const { file, journal } = fixture(t);
  let effects = 0;
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  for (const [index, result] of [undefined, BigInt(1), cyclic, new Date(), Number.NaN].entries()) {
    const key = `result-${index}`;
    await assert.rejects(journal.execute(key, {}, () => { effects++; return result; }), code("UNCERTAIN"));
  }
  assert.equal(effects, 5);
  assert.ok(new IdempotencyJournal(file).list().every((record) => record.status === "uncertain"));
});

test("invalid or lossy payloads never dispatch or persist", async (t) => {
  const { journal, directory } = fixture(t);
  let called = false;
  let getterRead = false;
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const extraArray = [1];
  Object.assign(extraArray, { hiddenIntent: "ignored by JSON.stringify" });
  const invalid = [undefined, BigInt(1), Number.POSITIVE_INFINITY, new Date(), cyclic, { key: undefined }, Array(2), extraArray, "\ud800", { get secret() { getterRead = true; return "value"; } }];
  for (const payload of invalid) await assert.rejects(journal.execute("key", payload, () => { called = true; return null; }), code("INVALID_INPUT"));
  for (const key of ["", " ", "k".repeat(257)]) await assert.rejects(journal.execute(key, {}, () => { called = true; return null; }), code("INVALID_INPUT"));
  assert.equal(called, false);
  assert.equal(getterRead, false);
  assert.deepEqual(journal.list(), []);
  assert.deepEqual(readdirSync(directory), []);
});

test("storage failure before dispatch prevents operation and same-process retries", async (t) => {
  const { journal, file } = fixture(t);
  mkdirSync(file);
  let calls = 0;
  await assert.rejects(journal.execute("cannot-store", {}, () => { calls++; return null; }), code("IO_ERROR"));
  await assert.rejects(journal.execute("cannot-store", {}, () => { calls++; return null; }), code("UNCERTAIN"));
  assert.equal(calls, 0);
});

test("storage failure after side effect preserves the durable pending record for restart", async (t) => {
  const { journal, file } = fixture(t);
  const durable = `${file}.durable`;
  let effects = 0;
  await assert.rejects(journal.execute("accepted-but-unwritten", {}, () => {
    effects++;
    renameSync(file, durable);
    mkdirSync(file);
    return { job: "created" };
  }), code("UNCERTAIN"));
  assert.equal(journal.list()[0]!.status, "uncertain");
  await assert.rejects(journal.execute("accepted-but-unwritten", {}, () => { effects++; return {}; }), code("UNCERTAIN"));
  // Restore the actual durable pending checkpoint to simulate reopening it.
  rmdirSync(file);
  renameSync(durable, file);
  await assert.rejects(new IdempotencyJournal(file).execute("accepted-but-unwritten", {}, () => { effects++; return {}; }), code("UNCERTAIN"));
  assert.equal(effects, 1);
});

test("corrupt checksum and malformed schema fail closed without rewriting evidence", async (t) => {
  const { file, journal } = fixture(t);
  await journal.execute("ok", {}, () => ({ job: "one" }));
  const valid = JSON.parse(readFileSync(file, "utf8"));
  const cases: string[] = ["{interrupted", "null"];
  const changed = structuredClone(valid);
  changed.records[0].result.job = "tampered";
  cases.push(JSON.stringify(changed));
  for (const modify of [
    (doc: typeof valid) => { doc.schemaVersion = 2; },
    (doc: typeof valid) => { doc.records.push(doc.records[0]); },
    (doc: typeof valid) => { doc.records[0].status = "unexpected"; },
    (doc: typeof valid) => { delete doc.records[0].result; },
    (doc: typeof valid) => { doc.records[0].arbitrary = "unknown"; },
  ]) {
    const candidate = structuredClone(valid);
    modify(candidate);
    checksum(candidate);
    cases.push(JSON.stringify(candidate));
  }
  for (const text of cases) {
    writeFileSync(file, text);
    assert.throws(() => new IdempotencyJournal(file), code("CORRUPT"));
    assert.equal(readFileSync(file, "utf8"), text);
  }
});

test("independent keys can finish out of order without losing journal records", async (t) => {
  const { file, journal } = fixture(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = journal.execute("first", {}, async () => { await gate; return 1; });
  await journal.execute("second", {}, () => 2);
  release();
  await first;
  assert.deepEqual(new IdempotencyJournal(file).list().map((record) => [record.key, record.status, record.result]), [["first", "succeeded", 1], ["second", "succeeded", 2]]);
});
