import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);
for (const shell of ['powershell.exe', 'pwsh.exe']) {
  test(`${shell}: fixed authorization management preserves arguments and failed revocations fail`, { skip: process.platform !== 'win32' }, async t => {
    if (shell === 'pwsh.exe') {
      try { await execute(shell, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { windowsHide: true }); }
      catch { t.skip('PowerShell 7 unavailable'); return; }
    }
    mkdirSync('.local-tests', { recursive: true });
    const root = mkdtempSync(path.resolve('.local-tests', 'authorization 中文 &-'));
    mkdirSync(path.join(root, 'scripts'));
    mkdirSync(path.join(root, 'dist', 'src'), { recursive: true });
    for (const name of ['fixed-tunnel.ps1', 'local-common.ps1']) copyFileSync(path.join('scripts', name), path.join(root, 'scripts', name));
    writeFileSync(path.join(root, 'dist', 'src', 'fixed-tunnel-runner.js'), `
const [action,id]=process.argv.slice(2);
if(action==='grants') console.log(JSON.stringify({grants:[]}));
else if(action==='revoke' && id==='a'.repeat(43)) console.log('revoked');
else process.exit(41);
`);
    const run = (args: string[]) => execute(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'fixed-tunnel.ps1'), ...args],
      { windowsHide: true, timeout: 15_000, env: { ...process.env, AUTODEV_NODE_EXECUTABLE: process.execPath } });
    assert.deepEqual(JSON.parse((await run(['-Action', 'grants'])).stdout), { grants: [] });
    assert.match((await run(['-Action', 'revoke', '-GrantId', 'a'.repeat(43)])).stdout, /revoked/);
    for (const id of ['invalid', 'b'.repeat(43)]) await assert.rejects(run(['-Action', 'revoke', '-GrantId', id]), (error: unknown) => {
      const value = error as { code?: number; stdout?: string };
      return value.code !== 0 && !value.stdout?.includes('revoked');
    });
  });
}
