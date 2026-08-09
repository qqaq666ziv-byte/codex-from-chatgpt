import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import test from "node:test";

import { CodexAppServer } from "../src/codex-app-server.js";

function fixtureClient() {
  return new CodexAppServer({
    command: process.execPath,
    commandArgs: [path.join(process.cwd(), "test/fixtures/fake-app-server.mjs")],
    rpcTimeoutMs: 1_000,
    shutdownTimeoutMs: 30,
    killTimeoutMs: 30,
  });
}

test("fallo JSONL y close posterior notifican una sola salida con la causa original", async () => {
  const client = fixtureClient();
  const exits: Error[] = [];
  client.addExitListener((error) => exits.push(error));
  await client.start();
  await assert.rejects(client.request("badJson"), /JSONL inválido/);
  await client.stop();
  assert.equal(exits.length, 1);
  assert.match(exits[0]?.message ?? "", /JSONL inválido/);
});

test("stop y start concurrentes se serializan y no mezclan el child de salida", async () => {
  const client = fixtureClient();
  await client.start();
  await Promise.all([client.stop(), client.start()]);
  assert.equal(client.isReady(), true);
  await client.stop();
  assert.equal(client.isReady(), false);
});

test("un error tardío del child viejo no contamina el lifecycle actual", async () => {
  const children: ChildProcessWithoutNullStreams[] = [];
  const client = new CodexAppServer({
    command: process.execPath,
    commandArgs: [path.join(process.cwd(), "test/fixtures/fake-app-server.mjs")],
    rpcTimeoutMs: 1_000,
    shutdownTimeoutMs: 30,
    killTimeoutMs: 30,
    spawnProcess: ((command, args, options) => {
      const child = spawn(command, args, options) as ChildProcessWithoutNullStreams;
      children.push(child);
      return child;
    }) as typeof spawn,
  });
  const exits: Error[] = [];
  client.addExitListener((error) => exits.push(error));
  await client.start();
  await client.stop();
  const oldChild = children[0];
  await client.start();
  const pending = client.request("slow");
  oldChild?.emit("error", new Error("old child failure"));
  assert.equal(client.isReady(), true);
  assert.equal(exits.length, 0);
  await assert.rejects(pending, /Timeout de RPC/);
  assert.equal((await client.request<{ code: number }>("triggerUnknown")).code, -32601);
  await client.stop();
});
