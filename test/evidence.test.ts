import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { EvidenceError, EvidenceStore, redactSensitiveText, type EvidenceIdentity } from "../src/evidence.js";

const testRoot = path.resolve(".local-tests");
const identity: EvidenceIdentity = { jobId: "job-1", threadId: "thread-1", turnId: "turn-1", revision: 1 };

function fixture(t: { after: (cleanup: () => void) => void }) {
  mkdirSync(testRoot, { recursive: true });
  const directory = mkdtempSync(path.join(testRoot, "evidence-"));
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(`${testRoot}${path.sep}`));
    rmSync(resolved, { recursive: true, force: true });
  });
  return { directory, store: new EvidenceStore(directory) };
}

function errorCode(code: EvidenceError["code"]) {
  return (error: unknown) => error instanceof EvidenceError && error.code === code;
}

test("evidence persists content hashes, identity and independent immutable values across restarts", (t) => {
  const { directory, store } = fixture(t);
  const input = { "diff.patch": "old\nnew\n", "checks.txt": "PASS\n" };
  const metadata = { validation: { status: "executed" }, review: "pending" };
  const manifest = store.publish(identity, input, metadata);
  assert.deepEqual(manifest.identity, identity);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.artifacts[1]!.sha256, createHash("sha256").update(input["diff.patch"]).digest("hex"));
  assert.equal(manifest.artifacts[1]!.byteLength, 8);
  assert.equal(manifest.metadata.review, "pending");
  input["diff.patch"] = "caller mutation";
  metadata.validation.status = "mutated";
  manifest.identity.revision = 90;
  manifest.artifacts.pop();
  const restarted = new EvidenceStore(directory);
  const loaded = restarted.manifest(manifest.id);
  assert.equal(loaded.identity.revision, 1);
  assert.equal(loaded.artifacts.length, 2);
  assert.deepEqual(loaded.metadata.validation, { status: "executed" });
  assert.equal(restarted.read(manifest.id, "diff.patch").content, "old\nnew\n");
  assert.deepEqual(readdirSync(directory), [`${manifest.id}.json`]);
  if (process.platform !== "win32") assert.equal(statSync(path.join(directory, `${manifest.id}.json`)).mode & 0o777, 0o600);
});

test("identical publication is idempotent and preserves the first stored timestamp", (t) => {
  const { directory, store } = fixture(t);
  const first = store.publish(identity, { "b.txt": "b", "a.txt": "a" }, { z: 1, a: 2 });
  const file = path.join(directory, `${first.id}.json`);
  const before = readFileSync(file, "utf8");
  const second = new EvidenceStore(directory).publish({ ...identity }, { "a.txt": "a", "b.txt": "b" }, { a: 2, z: 1 });
  assert.deepEqual(second, first);
  assert.equal(readFileSync(file, "utf8"), before);
  assert.deepEqual(readdirSync(directory), [`${first.id}.json`]);
});

test("concurrent identical publications expose one complete snapshot and never replace it", async (t) => {
  const { directory, store } = fixture(t);
  const script = `
    import { EvidenceStore } from './src/evidence.ts';
    const store = new EvidenceStore(process.argv[1]);
    const manifest = store.publish({ jobId: 'job-1', threadId: 'thread-1', turnId: 'turn-1', revision: 1 }, { 'concurrent.txt': 'complete evidence '.repeat(1000) });
    process.stdout.write(JSON.stringify(manifest));
  `;
  const outputs = await Promise.all(Array.from({ length: 4 }, () => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, directory], { cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`Evidence child failed (${code}): ${stderr}`)));
  })));
  const manifests = outputs.map((output) => JSON.parse(output));
  for (const manifest of manifests) assert.deepEqual(manifest, manifests[0]);
  assert.deepEqual(readdirSync(directory), [`${manifests[0].id}.json`]);
  assert.equal(store.read(manifests[0].id, "concurrent.txt").content, "complete evidence ".repeat(1000));
});

test("pages reconstruct complete multi-megabyte artifacts without truncation", (t) => {
  const { store } = fixture(t);
  const content = "unchanged context\n+ actual change 世界🌏\n".repeat(32000);
  const manifest = store.publish(identity, { "diff.patch": content });
  let cursor: string | undefined;
  let reconstructed = "";
  let pages = 0;
  do {
    const page = store.read(manifest.id, "diff.patch", cursor, 64001);
    assert.equal(page.offset, Buffer.byteLength(reconstructed));
    assert.equal(page.done, page.nextCursor === null);
    assert.ok(Buffer.byteLength(page.content) <= 64001);
    reconstructed += page.content;
    cursor = page.nextCursor ?? undefined;
    pages++;
  } while (cursor);
  assert.equal(reconstructed, content);
  assert.ok(pages > 20);
});

test("UTF-8 paging preserves emoji, surrogate pairs and combining marks with budgets 1 through 7", (t) => {
  const { store } = fixture(t);
  const content = "a璨🌍e\u0301\r\n👩🏽‍💻z";
  const manifest = store.publish(identity, { "unicode.txt": content });
  for (let limit = 1; limit <= 7; limit++) {
    let cursor: string | undefined;
    let reconstructed = "";
    do {
      const page = store.read(manifest.id, "unicode.txt", cursor, limit);
      assert.equal(Buffer.from(page.content).toString("utf8"), page.content);
      assert.ok(!page.content.includes("\uFFFD"));
      assert.ok(page.content.length > 0);
      assert.ok(Buffer.byteLength(page.content) <= Math.max(limit, 4));
      reconstructed += page.content;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(reconstructed, content);
  }
});

test("empty artifact and empty artifact collection are valid complete evidence", (t) => {
  const { store } = fixture(t);
  const manifest = store.publish(identity, { "empty.txt": "" });
  assert.deepEqual(store.read(manifest.id, "empty.txt"), {
    manifestId: manifest.id, artifactName: "empty.txt", sha256: createHash("sha256").update("").digest("hex"),
    content: "", offset: 0, nextCursor: null, done: true,
  });
  const empty = store.publish({ ...identity, revision: 2 }, {});
  assert.deepEqual(store.manifest(empty.id).artifacts, []);
  assert.throws(() => store.read(empty.id, "missing.txt"), errorCode("NOT_FOUND"));
});

test("old cursors remain stable across restart and a newly published revision", (t) => {
  const { directory, store } = fixture(t);
  const old = store.publish(identity, { "diff.patch": "abcdefghijk" });
  const first = store.read(old.id, "diff.patch", undefined, 4);
  const newer = store.publish({ ...identity, revision: 2 }, { "diff.patch": "12345678901" });
  const restarted = new EvidenceStore(directory);
  assert.equal(restarted.read(old.id, "diff.patch", first.nextCursor!, 4).content, "efgh");
  assert.throws(() => restarted.read(newer.id, "diff.patch", first.nextCursor!), errorCode("INVALID_CURSOR"));
});

test("cursors reject malformed tokens, edited offsets and cross-artifact reuse even when content matches", (t) => {
  const { store } = fixture(t);
  const manifest = store.publish(identity, { "a.txt": "abcdef", "b.txt": "abcdef" });
  const cursor = store.read(manifest.id, "a.txt", undefined, 2).nextCursor!;
  for (const malformed of ["", "not-a-cursor", cursor + "=", cursor.slice(0, -1), cursor.replace("v1.", "v2."), "../private-file"]) {
    assert.throws(() => store.read(manifest.id, "a.txt", malformed), errorCode("INVALID_CURSOR"));
  }
  assert.throws(() => store.read(manifest.id, "b.txt", cursor), errorCode("INVALID_CURSOR"));
  const pieces = cursor.split(".");
  const value = JSON.parse(Buffer.from(pieces[1]!, "base64url").toString("utf8"));
  value.offset = 5;
  pieces[1] = Buffer.from(JSON.stringify(value)).toString("base64url");
  assert.throws(() => store.read(manifest.id, "a.txt", pieces.join(".")), errorCode("INVALID_CURSOR"));
});

test("checksum-valid cursors still reject fractional, out-of-bounds and mid-codepoint offsets", (t) => {
  const { store } = fixture(t);
  const manifest = store.publish(identity, { "a.txt": "a🌏b" });
  const cursor = store.read(manifest.id, "a.txt", undefined, 1).nextCursor!;
  const original = JSON.parse(Buffer.from(cursor.split(".")[1]!, "base64url").toString("utf8"));
  for (const offset of [-1, 1.5, 2, 100, Number.MAX_SAFE_INTEGER + 1]) {
    const payload = Buffer.from(JSON.stringify({ ...original, offset })).toString("base64url");
    const token = `v1.${payload}.${createHash("sha256").update(payload).digest("hex")}`;
    assert.throws(() => store.read(manifest.id, "a.txt", token), errorCode("INVALID_CURSOR"));
  }
});

test("manifest IDs and artifact names cannot address arbitrary paths", (t) => {
  const { store } = fixture(t);
  const manifest = store.publish(identity, { "safe.txt": "safe" });
  for (const id of ["../secrets", "C:\\private", "", "a".repeat(63), "A".repeat(64)]) {
    assert.throws(() => store.manifest(id), errorCode("INVALID_INPUT"));
  }
  for (const name of ["../private.txt", "C:\\private", "folder/file", ".", "..", "", "a".repeat(129)]) {
    assert.throws(() => store.read(manifest.id, name), errorCode("INVALID_INPUT"));
    assert.throws(() => store.publish(identity, { [name]: "x" }), errorCode("INVALID_INPUT"));
  }
  assert.throws(() => store.manifest("0".repeat(64)), errorCode("NOT_FOUND"));
});

test("corruption of any artifact fails the complete snapshot, including manifest and unrelated artifact reads", (t) => {
  const { directory, store } = fixture(t);
  const manifest = store.publish(identity, { "a.txt": "safe", "b.txt": "data" });
  const file = path.join(directory, `${manifest.id}.json`);
  const snapshot = JSON.parse(readFileSync(file, "utf8"));
  snapshot.contents["b.txt"] = "evil";
  const corrupted = JSON.stringify(snapshot);
  writeFileSync(file, corrupted);
  assert.throws(() => store.manifest(manifest.id), errorCode("CORRUPT"));
  assert.throws(() => store.read(manifest.id, "a.txt"), errorCode("CORRUPT"));
  assert.throws(() => store.publish(identity, { "a.txt": "safe", "b.txt": "data" }), errorCode("CORRUPT"));
  assert.equal(readFileSync(file, "utf8"), corrupted, "colliding path must never be silently replaced");
  assert.deepEqual(readdirSync(directory), [`${manifest.id}.json`]);
});

test("identity, metadata, descriptor and truncated JSON corruption are detected", (t) => {
  const { directory, store } = fixture(t);
  const manifest = store.publish(identity, { "a.txt": "safe" }, { review: "pending" });
  const file = path.join(directory, `${manifest.id}.json`);
  const original = readFileSync(file, "utf8");
  for (const mutate of [
    (s: any) => { s.manifest.identity.turnId = "other-turn"; },
    (s: any) => { s.manifest.createdAt = "2000-01-01T00:00:00.000Z"; },
    (s: any) => { s.manifest.metadata.review = "passed"; },
    (s: any) => { s.manifest.artifacts[0].byteLength = 3; },
    (s: any) => { s.contents["extra.txt"] = "extra"; },
    (s: any) => { s.manifest.schemaVersion = 99; },
  ]) {
    const snapshot = JSON.parse(original);
    mutate(snapshot);
    writeFileSync(file, JSON.stringify(snapshot));
    assert.throws(() => store.manifest(manifest.id), errorCode("CORRUPT"));
  }
  writeFileSync(file, original.slice(0, -8));
  assert.throws(() => store.manifest(manifest.id), errorCode("CORRUPT"));
});

test("invalid identity, lossy JSON and malformed UTF-16 are rejected without publishing files", (t) => {
  const { directory, store } = fixture(t);
  for (const revision of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => store.publish({ ...identity, revision }, {}), errorCode("INVALID_INPUT"));
  }
  assert.throws(() => store.publish({ ...identity, jobId: "" }, {}), errorCode("INVALID_INPUT"));
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  for (const metadata of [{ a: undefined }, { a: NaN }, { a: BigInt(1) }, cyclic, { a: new Date() }]) {
    assert.throws(() => store.publish(identity, {}, metadata), errorCode("INVALID_INPUT"));
  }
  assert.throws(() => store.publish(identity, { "bad.txt": "\uD800" }), errorCode("INVALID_INPUT"));
  assert.deepEqual(readdirSync(directory), []);
});

test("page size is explicitly bounded instead of silently clamping or truncating", (t) => {
  const { store } = fixture(t);
  const manifest = store.publish(identity, { "a.txt": "a" });
  for (const limit of [0, -1, 0.5, NaN, Infinity, 1048577]) {
    assert.throws(() => store.read(manifest.id, "a.txt", undefined, limit), errorCode("INVALID_INPUT"));
  }
});

test("focused redaction covers known tokens and leaves ordinary evidence intact", () => {
  const input = [
    "Authorization: Bearer synthetic.secret.value",
    "api_key='synthetic quoted value'", '"access_token": "synthetic-private-token"',
    "https://example.invalid?refresh_token=synthetic-token&ok=1",
    `sk-proj-${"x".repeat(32)}`, `ghp_${"A".repeat(36)}`, `github_pat_${"B".repeat(40)}`,
    "diff --git a/src/main.ts b/src/main.ts", "+ const greeting = '璨璨🌏';",
  ].join("\n");
  const output = redactSensitiveText(input);
  assert.ok(!output.includes("synthetic.secret"));
  assert.ok(!output.includes("synthetic quoted"));
  assert.ok(!output.includes("synthetic-private"));
  assert.ok(!output.includes("synthetic-token"));
  assert.ok(!output.includes("x".repeat(32)));
  assert.ok(!output.includes("A".repeat(36)));
  assert.ok(!output.includes("B".repeat(40)));
  assert.ok(output.includes("&ok=1"));
  assert.ok(output.includes("+ const greeting = '璨璨🌏';"));
  assert.equal(redactSensitiveText("an unknown secret format"), "an unknown secret format", "regex is deliberately not a complete secrecy boundary");
});
