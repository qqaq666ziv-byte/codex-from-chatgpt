import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { snapshotSource, sourceDiff } from "../src/snapshot.js";

const testRoot = path.resolve(".local-tests");
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.autocrlf=false", "-c", "core.hooksPath=.no-test-hooks", "-c", "commit.gpgsign=false", ...args], { cwd, windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function fixture(t: { after: (cleanup: () => void) => void }) {
  mkdirSync(testRoot, { recursive: true });
  const directory = mkdtempSync(path.join(testRoot, "snapshot-"));
  const workspace = path.join(directory, "repository");
  mkdirSync(workspace);
  git(workspace, "init", "--quiet");
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(`${testRoot}${path.sep}`));
    rmSync(resolved, { recursive: true, force: true });
  });
  const write = (name: string, content: string | Buffer) => { const file = path.join(workspace, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, content); };
  return { directory, workspace: realpathSync(workspace), write };
}

test("source snapshots capture real tracked and untracked UTF-8 changes, deletions and base commit", (t) => {
  const { workspace, write } = fixture(t);
  write("tracked.ts", "export const label = '原始';\n");
  write("deleted.txt", "remove this\n");
  write(".gitignore", "ignored.txt\n");
  git(workspace, "add", "--", ".");
  git(workspace, "-c", "user.name=AutoDev Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture baseline");
  const before = snapshotSource(workspace);
  assert.match(before.head!, /^[a-f0-9]{40,64}$/);
  write("tracked.ts", "export const label = '更新 🐕';\n");
  write("新增.txt", "未追蹤內容\n");
  write("ignored.txt", "ignored fixture text");
  unlinkSync(path.join(workspace, "deleted.txt"));
  const after = snapshotSource(workspace);
  const patch = sourceDiff(before, after);
  assert.equal(after.head, before.head);
  assert.equal(after.files["tracked.ts"]!.content, "export const label = '更新 🐕';\n");
  assert.equal(after.files["新增.txt"]!.sha256, createHash("sha256").update("未追蹤內容\n").digest("hex"));
  assert.equal(after.files["ignored.txt"], undefined);
  assert.equal(after.files["deleted.txt"], undefined);
  assert.match(patch, /-export const label = '原始';/);
  assert.match(patch, /\+export const label = '更新 🐕';/);
  assert.match(patch, /\+未追蹤內容/);
  assert.match(patch, /-remove this/);
  assert.equal(patch.includes("ignored fixture text"), false);
});

test("protected paths are excluded even if tracked and their sentinel contents never enter source evidence", (t) => {
  const { workspace, write } = fixture(t);
  const names = [".env", ".env.production", "nested/.env.local", "auth.json", ".codex/auth.json", "credentials.json", "server.pem", "private.key", ".runtime/config.json", ".local-tests/data.txt", ".ai-bridge/execution.json", "client-token", "admin-token", ".npmrc", ".netrc", ".pypirc", ".ssh/id_fixture", ".aws/config", ".kube/config"];
  const sentinel = "FIXTURE_PRIVATE_DATA_MUST_NOT_BE_COLLECTED";
  for (const name of names) write(name, sentinel);
  write("source.ts", "export const ordinary = true;\n");
  git(workspace, "add", "--force", "--", ".");
  const snapshot = snapshotSource(workspace);
  assert.deepEqual(Object.keys(snapshot.files), ["source.ts"]);
  assert.deepEqual(snapshot.omitted.map((item) => item.path).sort(), [...names].sort());
  assert.ok(snapshot.omitted.every((item) => item.reason === "sensitive_or_private_path"));
  assert.equal(JSON.stringify(snapshot).includes(sentinel), false);
  assert.equal(sourceDiff({ head: null, files: {}, omitted: [] }, snapshot).includes(sentinel), false);
});

test("known token formats are redacted and flagged while binary/non-UTF8 data needs separate review", (t) => {
  const { workspace, write } = fixture(t);
  const fakeToken = `sk-${"A".repeat(25)}`;
  write("example.ts", `const sample = '${fakeToken}';\n`);
  write("image.bin", Buffer.from([1, 0, 2]));
  write("legacy.txt", Buffer.from([0xff, 0xfe, 0x80]));
  const snapshot = snapshotSource(workspace);
  assert.equal(snapshot.files["example.ts"]!.content.includes(fakeToken), false);
  assert.match(snapshot.files["example.ts"]!.content, /\[REDACTED\]/);
  assert.equal(snapshot.files["image.bin"], undefined);
  assert.equal(snapshot.files["legacy.txt"], undefined);
  assert.deepEqual(snapshot.omitted.map((item) => item.reason).sort(), ["binary_requires_separate_review", "known_token_patterns_redacted", "non_utf8_requires_separate_review"].sort());
  assert.equal(sourceDiff({ head: null, files: {}, omitted: [] }, snapshot).includes(fakeToken), false);
});

test("tracked paths redirected through a Windows junction or POSIX symlink fail closed", (t) => {
  const { directory, workspace, write } = fixture(t);
  write("linked/source.ts", "safe baseline\n");
  git(workspace, "add", "--", ".");
  const outside = path.join(directory, "outside-registered-project");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "source.ts"), "FIXTURE_OUTSIDE_DATA_MUST_NOT_BE_READ");
  renameSync(path.join(workspace, "linked"), path.join(workspace, "original-directory"));
  symlinkSync(outside, path.join(workspace, "linked"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => snapshotSource(workspace), /link|refused/i);
});

test("registering a repository subfolder is rejected instead of broadening source collection", (t) => {
  const { workspace, write } = fixture(t);
  write("nested/source.ts", "within nested folder\n");
  assert.throws(() => snapshotSource(path.join(workspace, "nested")), /repository root|subfolder/i);
});
