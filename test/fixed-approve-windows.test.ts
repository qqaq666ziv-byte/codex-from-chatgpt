import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { transformSync } from 'esbuild';

const execute = promisify(execFile);
const issuer = 'https://synthetic-approve.synthetic-account.workers.dev';
const redirect = 'https://chatgpt.com/connector_platform_oauth_redirect';

test('fixed approve launcher in PowerShell 5.1 and 7 completes isolated DPAPI OAuth and reports safe failures', { skip: process.platform !== 'win32', timeout: 90000 }, async t => {
  const ports: number[] = [];
  for (let i = 0; i < 3; i++) {
    const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    ports.push((server.address() as { port: number }).port); await new Promise<void>(resolve => server.close(() => resolve()));
  }
  const directory = mkdtempSync(path.resolve('.local-tests/fixed approve 中文-'));
  const dist = path.join(directory, 'dist/src'), runtime = path.join(directory, '.runtime');
  mkdirSync(dist, { recursive: true }); mkdirSync(runtime); mkdirSync(path.join(directory, 'scripts'));
  writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
  for (const name of ['fixed-tunnel.ps1', 'local-common.ps1']) copyFileSync(path.resolve('scripts', name), path.join(directory, 'scripts', name));
  for (const name of readdirSync('src').filter(name => name.endsWith('.ts'))) {
    let source = readFileSync(path.join('src', name), 'utf8');
    // Only the isolated fixture's ports/startup are substituted. The actual
    // launcher, ownership checks, request serialization and approve branch run.
    if (name === 'fixed-tunnel.ts') source = source.replace('publicPort: 8798, controlPort: 8799, nativeAdminPort: 8800', `publicPort: ${ports[0]}, controlPort: ${ports[1]}, nativeAdminPort: ${ports[2]}`);
    if (name === 'fixed-tunnel-runner.ts') source = source.replace('void main().catch', 'if (!process.argv.includes("--fixture-gateway")) void main().catch') + `
      if (process.argv.includes('--fixture-gateway')) {
        const identity = processIdentity(process.pid)!;
        const instance = process.argv.find(a => a.startsWith('--autodev-fixed-instance='))!.split('=')[1]!;
        const gateway = await createGateway({ issuer: '${issuer}', publicPort: ${ports[0]}, controlPort: ${ports[1]},
          upstream: 'http://127.0.0.1:1/mcp', clientToken: 'synthetic-client-token', adminToken: readLocalToken(runtime, 'admin'),
          instance, oauthStateFile: path.join(runtime, 'fixed-oauth.dpapi'), managementCommand: 'fixed-tunnel.ps1' });
        atomic(recordFile, { schemaVersion: 1, publicPort: ${ports[0]}, controlPort: ${ports[1]}, nativeAdminPort: ${ports[2]},
          pid: process.pid, created: identity.created, executable: process.execPath, entry, instance,
          childPid: process.pid, childCreated: identity.created, shutdownConfirmed: false });
        process.on('message', async () => { await gateway.close(); process.disconnect(); });
        process.send?.('ready');
      }
    `;
    writeFileSync(path.join(dist, name.replace(/\.ts$/, '.js')), transformSync(source, { loader: 'ts', target: 'es2022', format: 'esm' }).code);
  }
  const admin = randomBytes(32).toString('base64url');
  writeFileSync(path.join(runtime, 'admin-token'), admin);
  writeFileSync(path.join(runtime, 'fixed-tunnel.json'), JSON.stringify({ schemaVersion: 1, origin: issuer, provider: 'cloudflare-workers-quick', cost: { status: 'unverified' } }));
  const child = fork(path.join(dist, 'fixed-tunnel-runner.js'), ['--fixture-gateway', '--autodev-fixed-instance=' + randomUUID()], { execArgv: [], windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(async () => { if (child.connected) { const exited = once(child, 'exit'); child.send('close'); await exited; } });
  await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error('Fixture gateway startup failed'); })]);
  const publicUrl = `http://127.0.0.1:${ports[0]}`, controlUrl = `http://127.0.0.1:${ports[1]}`;
  const registration = await fetch(publicUrl + '/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Isolated approval fixture', redirect_uris: [redirect], token_endpoint_auth_method: 'none' }) });
  assert.equal(registration.status, 201);
  const client = await registration.json() as { client_id: string };
  const launch = async (shell: string, id: string, code: string) => {
    try { const result = await execute(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(directory, 'scripts/fixed-tunnel.ps1'), '-Action', 'approve', '-RequestId', id, '-VerificationCode', code], { windowsHide: true, timeout: 15000, env: { ...process.env, AUTODEV_NODE_EXECUTABLE: process.execPath } }); return { code: 0, output: result.stdout + result.stderr }; }
    catch (error) { const e = error as { code: number; stdout: string; stderr: string }; return { code: e.code, output: e.stdout + e.stderr }; }
  };
  for (const shell of ['powershell.exe', 'pwsh.exe']) {
    const verifier = randomBytes(32).toString('base64url');
    const params = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: redirect, state: 'synthetic', resource: issuer + '/mcp', scope: 'autodev', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
    const begin = await fetch(publicUrl + '/oauth/authorize?' + params); assert.equal(begin.status, 200);
    const html = await begin.text();
    const id = /<code>([^<]+)<\/code>/.exec(html)![1]!;
    const code = /<strong>([^<]+)<\/strong>/.exec(html)![1]!;
    const status = await fetch(controlUrl + '/status', { headers: { Authorization: 'Bearer ' + admin } });
    const pending = (await status.json() as { pending: { request_id: string; verification_code: string }[] }).pending;
    assert.ok(pending.some(p => p.request_id === id && p.verification_code === code));
    const wrong = await launch(shell, id, 'WRONG-CODE');
    assert.equal(wrong.code, 1); assert.match(wrong.output, /HTTP 403.*access_denied.*local_approval.*verification_code_mismatch/);
    assert.ok(!wrong.output.includes(id) && !wrong.output.includes(admin));
    const approved = await launch(shell, id, code); assert.equal(approved.code, 0, approved.output); assert.match(approved.output, /Matching local OAuth request approved/);
    const duplicate = await launch(shell, id, code); assert.equal(duplicate.code, 1); assert.match(duplicate.output, /HTTP 400.*already_decided/);
    const finish = await fetch(publicUrl + '/oauth/result?request_id=' + id, { redirect: 'manual' }); assert.equal(finish.status, 302);
    const callback = new URL(finish.headers.get('location')!); assert.equal(callback.searchParams.get('iss'), issuer);
    const exchange = await fetch(publicUrl + '/oauth/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code: callback.searchParams.get('code')!, code_verifier: verifier, client_id: client.client_id, redirect_uri: redirect, resource: issuer + '/mcp' }) });
    assert.equal(exchange.status, 200); await exchange.body?.cancel();
    const redeemed = await launch(shell, id, code); assert.equal(redeemed.code, 1); assert.match(redeemed.output, /HTTP 400.*consent_unavailable/);
    assert.ok(!redeemed.output.includes(id) && !redeemed.output.includes(code));
    t.diagnostic(`${shell}: wrong code exit 1; approve exit 0; duplicate/redeemed exit 1; PKCE exchange HTTP 200 (isolated only)`);
  }
});
