import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { CodexAppServer } from '../src/codex-app-server.js';
import { codexProcess } from '../src/codex-process.js';
import { processIdentity } from '../src/secure-process.js';

const execute = promisify(execFile);

for (const operation of ['stop', 'protocol-error', 'root-exit'] as const) {
  test(`Windows owned CMD tree: ${operation} removes an ignore-EOF app-server and its grandchild`, { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
    mkdirSync('.local-tests', { recursive: true });
    const root = mkdtempSync(path.resolve('.local-tests/codex tree 中文 & '));
    const shim = path.join(root, 'codex.cmd');
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "%~dp0fake.mjs" %*\r\n`, 'ascii');
    writeFileSync(path.join(root, 'fake.mjs'), `
import { spawn } from 'node:child_process';
import readline from 'node:readline';
const descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
setInterval(()=>{},1000); // Deliberately survives EOF, unlike the normal fake.
readline.createInterface({input:process.stdin}).on('line',line=>{
 const value=JSON.parse(line);
 if(value.method==='badJson'){process.stdout.write('invalid JSON\\n');return;}
 if(value.method==='exitRoot'){process.exit(0);return;}
 if(value.id!==undefined)process.stdout.write(JSON.stringify({id:value.id,result:value.method==='identity'?{pids:[process.ppid,process.pid,descendant.pid]}:{}})+'\\n');
});
`, 'utf8');
    // The full suite compiles several Windows owners concurrently; allow the
    // synthetic Node child to initialize without changing production deadlines.
    const client = new CodexAppServer({ command: shim, rpcTimeoutMs: 10000, shutdownTimeoutMs: 50, spawnOptions: { windowsHide: true } });
    let identities: Array<{pid:number;created:string}> = [];
    try {
      await client.start();
      const { pids } = await client.request<{pids:number[]}>('identity');
      identities = pids.map(pid => { const identity=processIdentity(pid); assert.ok(identity); return {pid,created:identity.created}; });
      assert.equal(new Set(identities.map(v=>v.pid)).size, 3);
      if (operation === 'protocol-error') await assert.rejects(client.request('badJson'), /JSONL/);
      if (operation === 'root-exit') await assert.rejects(client.request('exitRoot'));
      await client.stop();
      assert.equal(client.isAlive(), false);
      for (const identity of identities) assert.notEqual(processIdentity(identity.pid)?.created, identity.created, 'A member of this exact test launch survived shutdown');
    } finally { await client.stop(); }
  });
}

test('Windows CMD shim transports real JSONL stdin and exits on EOF under paths with spaces and ampersand', { skip: process.platform !== 'win32', timeout: 15000 }, async () => {
  mkdirSync('.local-tests', { recursive: true });
  const root = mkdtempSync(path.resolve('.local-tests/codex shim & '));
  const shim = path.join(root, 'codex.cmd');
  const fake = path.join(root, 'fake.mjs');
  copyFileSync('test/fixtures/fake-app-server.mjs', fake);
  writeFileSync(shim, `@echo off\r\n"${process.execPath}" "%~dp0fake.mjs" %*\r\n`, 'ascii');
  const client = new CodexAppServer({ command: shim, rpcTimeoutMs: 10000, spawnOptions: { windowsHide: true } });
  try {
    await client.start();
    assert.equal(client.isReady(), true);
    assert.equal((await client.request<{ code: number }>('triggerUnknown')).code, -32601);
  } finally { await client.stop(); }
  assert.equal(client.isAlive(), false);
  assert.throws(() => codexProcess(shim, ['unsafe%PATH%']));
  const ps1 = path.join(root, 'codex.ps1'); writeFileSync(ps1, 'throw "must never run"');
  assert.throws(() => codexProcess(ps1, []), /PowerShell/);
});

for (const shell of ['powershell.exe', 'pwsh.exe']) {
  test(`${shell}: pinned executables work without transient PATH; PS1 is rejected`, { skip: process.platform !== 'win32', timeout: 15000 }, async context => {
    try { await execute(shell, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { windowsHide: true }); }
    catch { context.skip('shell unavailable'); return; }
    const script = `. '${path.resolve('scripts/local-common.ps1').replaceAll("'", "''")}'; $env:AUTODEV_NODE_EXECUTABLE='${process.execPath.replaceAll("'", "''")}'; $env:PATH=''; $p=Resolve-AutoDevNode; if($p -ne $env:AUTODEV_NODE_EXECUTABLE){exit 2}; & $p --version; $env:AUTODEV_CODEX_EXECUTABLE='relative.ps1'; try {Resolve-AutoDevCodex;exit 3}catch{exit 0}`;
    const result = await execute(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10000 });
    assert.match(result.stdout, /v\d+\./);
  });
}
