import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { setImmediate as yieldLoop } from 'node:timers/promises';

import { CodexAppServer } from "../src/codex-app-server.js";

for (const exitedBeforeClose of [false, true]) test(`unconfirmed shutdown rejects and cannot replace ${exitedBeforeClose ? 'an exited root with open pipes' : 'the live owner'}`, async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdout = new PassThrough(), stderr = new PassThrough();
  let first = true, spawned = 0, kills = 0;
  Object.assign(child, { stdout, stderr, exitCode:null, signalCode:null, killed:false,
    kill: () => { kills++; return false; },
    stdin: new Writable({ write(chunk, _encoding, done) {
      const line=String(chunk).trim();
      if (first && process.platform === 'win32') { first=false; queueMicrotask(()=>stdout.write('AUTODEV_CODEX_READY\n')); done(); return; }
      const message=JSON.parse(line);
      if (message.id!==undefined) queueMicrotask(()=>stdout.write(JSON.stringify({id:message.id,result:{}})+'\n'));
      done();
    }}),
  });
  const client=new CodexAppServer({command:process.execPath,shutdownTimeoutMs:20,killTimeoutMs:20,
    spawnProcess:(()=>{spawned++;return child;}) as typeof spawn});
  await client.start();
  if (exitedBeforeClose) Object.assign(child,{exitCode:0});
  const stop=assert.rejects(client.stop(),/shutdown was not confirmed/);
  await yieldLoop(); context.mock.timers.tick(20000);
  await yieldLoop(); context.mock.timers.tick(100);
  await yieldLoop(); context.mock.timers.tick(100);
  await stop;
  assert.equal(client.isReady(),false);
  if (!exitedBeforeClose) assert.ok(kills>0);
  const restart=assert.rejects(client.start(),/shutdown was not confirmed/);
  await yieldLoop(); context.mock.timers.tick(20000);
  await yieldLoop(); context.mock.timers.tick(100);
  await yieldLoop(); context.mock.timers.tick(100);
  await restart;
  assert.equal(spawned,1);
  stdout.end();stderr.end();
});

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
