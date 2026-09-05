import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateWorkspace } from "../src/workspaces.js";

const testRoot = fileURLToPath(new URL("../.local-tests/", import.meta.url));
mkdirSync(testRoot, { recursive: true });
const runtimeRoot = mkdtempSync(path.join(testRoot, "workspaces-"));

function fixture(): { root: string; outside: string; valid: string } {
  const directory = mkdtempSync(path.join(runtimeRoot, "case-"));
  const root = path.join(directory, "authorized");
  const outside = path.join(directory, "authorized-neighbor");
  const valid = path.join(root, "valid");
  mkdirSync(valid, { recursive: true });
  mkdirSync(outside);
  return { root, outside, valid };
}

test("canonical workspace stays under the explicitly configured root", async () => {
  const { root, valid } = fixture();
  assert.equal(await validateWorkspace(valid, root), realpathSync(valid));
  assert.equal(await validateWorkspace(root, root), realpathSync(root));
  assert.equal(await validateWorkspace(`${valid}${path.sep}.`, root), realpathSync(valid));
});

test("traversal is rejected in both candidate and administrative root before resolution", async () => {
  const { root, valid } = fixture();
  const traversal = `${valid}${path.sep}..${path.sep}valid`;
  await assert.rejects(validateWorkspace(traversal, root), /segmentos '\.\.'/);
  await assert.rejects(validateWorkspace(valid, traversal), /segmentos '\.\.'/);
});

test("Windows forward, backward and mixed separator traversal is rejected", { skip: process.platform !== "win32" }, async () => {
  const { root, valid } = fixture();
  for (const traversal of [`${valid}/../valid`, `${valid}\\..\\valid`, `${valid}/..\\valid`, `${valid}\\../valid`]) {
    await assert.rejects(validateWorkspace(traversal, root), /segmentos '\.\.'/);
    await assert.rejects(validateWorkspace(valid, traversal), /segmentos '\.\.'/);
  }
  assert.equal(await validateWorkspace(valid.replaceAll("\\", "/"), root.replaceAll("\\", "/")), realpathSync(valid));
});

test("sibling directory with the same prefix cannot escape the configured root", async () => {
  const { root, outside } = fixture();
  await assert.rejects(validateWorkspace(outside, root), /dentro de/);
});

test("directory junction or symlink escape is rejected after realpath", async () => {
  const { root, outside, valid } = fixture();
  const escape = path.join(root, "escape");
  const alias = path.join(root, "alias");
  // Directory junctions exercise realpath confinement without Windows symlink privileges.
  const linkType = process.platform === "win32" ? "junction" : "dir";
  symlinkSync(outside, escape, linkType);
  symlinkSync(valid, alias, linkType);
  await assert.rejects(validateWorkspace(escape, root), /dentro de/);
  assert.equal(await validateWorkspace(alias, root), realpathSync(valid));
});

test("relative, missing, non-directory and NUL paths fail closed", async () => {
  const { root, valid } = fixture();
  const file = path.join(root, "file.txt");
  writeFileSync(file, "fixture");
  await assert.rejects(validateWorkspace("", root), /no vacía/);
  await assert.rejects(validateWorkspace("relative", root), /absoluta/);
  await assert.rejects(validateWorkspace(`${valid}\0`, root), /NUL/);
  await assert.rejects(validateWorkspace(path.join(root, "missing"), root), /no existe/);
  await assert.rejects(validateWorkspace(file, root), /no existe/);
  await assert.rejects(validateWorkspace(valid, "relative"), /absoluta/);
  await assert.rejects(validateWorkspace(valid, `${root}\0`), /absoluta/);
  await assert.rejects(validateWorkspace(valid, file), /no existe/);
});

test("Windows drive-relative and current-drive rooted paths are rejected", { skip: process.platform !== "win32" }, async () => {
  const { root, valid } = fixture();
  for (const input of ["C:work", "/work", "\\work"]) {
    await assert.rejects(validateWorkspace(input, root), /absoluta/);
    await assert.rejects(validateWorkspace(valid, input), /absoluta/);
  }
});
