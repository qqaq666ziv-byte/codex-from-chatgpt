import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { OAuthGate, OAuthError, type OAuthTokenResult } from '../src/oauth.js';
import { EncryptedOAuthStateStore, OAuthStateError, windowsDpapiCipher, type OAuthStateCipher, type OAuthPersistentState } from '../src/oauth-state.js';

const execute = promisify(execFile);
const issuer = 'https://fixed-autodev.example';
const redirect = 'https://chatgpt.com/connector_platform_oauth_redirect';
const verifier = 'a'.repeat(43);
const challenge = createHash('sha256').update(verifier).digest('base64url');
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const product = fileURLToPath(new URL('../', import.meta.url));
const testRoot = path.join(product, '.local-tests');
mkdirSync(testRoot, { recursive: true });
const clientBody = { client_name: 'Synthetic persisted ChatGPT client', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] };
const oauthError = (code: string) => (value: unknown) => value instanceof OAuthError && value.code === code;

function testCipher(): OAuthStateCipher {
  const key = randomBytes(32);
  return {
    encrypt(plain) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const body = Buffer.concat([cipher.update(plain), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), body]);
    },
    decrypt(bytes) {
      const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]);
    },
  };
}

function fixture(cipher: OAuthStateCipher = testCipher()) {
  const directory = mkdtempSync(path.join(testRoot, 'oauth persisted 中文-'));
  const filePath = path.join(directory, 'fixed-oauth.dpapi');
  let time = 1_800_000_000_000;
  const store = (origin = issuer) => new EncryptedOAuthStateStore({ filePath, issuer: origin, cipher });
  const gate = (origin = issuer) => new OAuthGate({ issuer: origin, now: () => time, stateStore: store(origin) });
  return { directory, filePath, cipher, store, gate, time: () => time, advance: (ms: number) => { time += ms; } };
}

function authorization(gate: OAuthGate, clientId: string) {
  const pending = gate.begin(new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, state: 'synthetic-secret-consent-state', resource: gate.resource, scope: 'autodev', code_challenge: challenge, code_challenge_method: 'S256' }));
  gate.localApproval(pending.request_id, true, pending.verification_code);
  const finished = gate.finish(pending.request_id);
  assert.ok('redirect_url' in finished);
  const code = new URL(finished.redirect_url).searchParams.get('code')!;
  return { pending, code, form: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: redirect, resource: gate.resource, code_verifier: verifier }) };
}
function grant(gate: OAuthGate, clientId = gate.register(clientBody).client_id) {
  const consent = authorization(gate, clientId);
  const tokens = gate.token(consent.form);
  return { clientId, tokens, ...consent };
}
function refresh(clientId: string, tokens: OAuthTokenResult) {
  return new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, resource: `${issuer}/mcp`, refresh_token: tokens.refresh_token });
}
function unseal(f: ReturnType<typeof fixture>): OAuthPersistentState {
  const envelope = JSON.parse(readFileSync(f.filePath, 'utf8'));
  return JSON.parse(f.cipher.decrypt(Buffer.from(envelope.ciphertext, 'base64')).toString('utf8'));
}
function seal(f: ReturnType<typeof fixture>, state: unknown) {
  const bytes = f.cipher.encrypt(Buffer.from(JSON.stringify(state)));
  writeFileSync(f.filePath, JSON.stringify({ schemaVersion: 1, ciphertext: bytes.toString('base64'), checksum: hash(bytes) }));
}

test('fixed-issuer clients and grant identity survive restart; refresh replay durably revokes the entire family', () => {
  const f = fixture();
  const first = f.gate();
  const issued = grant(first);
  const identity = first.verify(issued.tokens.access_token);
  const second = f.gate();
  assert.deepEqual(second.verify(issued.tokens.access_token), identity);
  const rotated = second.token(refresh(issued.clientId, issued.tokens));
  assert.equal(second.verify(rotated.access_token).grant_id, identity.grant_id);
  const third = f.gate();
  assert.equal(third.verify(rotated.access_token).grant_id, identity.grant_id);
  assert.throws(() => third.token(refresh(issued.clientId, issued.tokens)), oauthError('invalid_grant'));
  const fourth = f.gate();
  assert.throws(() => fourth.verify(rotated.access_token), oauthError('invalid_token'));
  assert.throws(() => fourth.token(refresh(issued.clientId, rotated)), oauthError('invalid_grant'));
  const pending = fourth.begin(new URLSearchParams({ response_type: 'code', client_id: issued.clientId, redirect_uri: redirect, state: 'again', resource: `${issuer}/mcp`, scope: 'autodev', code_challenge: challenge, code_challenge_method: 'S256' }));
  assert.equal(fourth.finish(pending.request_id).status, 'pending');
});

test('pending consent, unredeemed codes and plaintext tokens are absent from durable state', () => {
  const f = fixture();
  const first = f.gate();
  const issued = grant(first);
  const waiting = authorization(first, issued.clientId);
  const second = f.gate();
  assert.deepEqual(second.pendingRequests(), []);
  assert.throws(() => second.finish(waiting.pending.request_id), oauthError('invalid_request'));
  assert.throws(() => second.token(waiting.form), oauthError('invalid_grant'));
  const state = unseal(f);
  const serialized = JSON.stringify(state);
  for (const secret of [issued.tokens.access_token, issued.tokens.refresh_token, issued.code, waiting.code, verifier, 'synthetic-secret-consent-state', waiting.pending.verification_code]) {
    assert.equal(serialized.includes(secret), false);
    for (const name of readdirSync(f.directory)) assert.equal(readFileSync(path.join(f.directory, name), 'utf8').includes(secret), false);
  }
  assert.deepEqual(Object.keys(state).sort(), ['accessTokens', 'clients', 'grants', 'issuer', 'refreshTokens', 'schemaVersion', 'usedCodes', 'usedRefresh', 'writtenAt'].sort());
  assert.throws(() => second.token(issued.form), oauthError('invalid_grant'));
  assert.throws(() => f.gate().verify(issued.tokens.access_token), oauthError('invalid_token'));
});

test('issuer, ciphertext, schema, client binding, rotation state and clock corruption fail closed without overwriting evidence', () => {
  const f = fixture();
  grant(f.gate());
  const original = readFileSync(f.filePath);
  assert.throws(() => f.gate('https://another-autodev.example'), OAuthStateError);
  assert.deepEqual(readFileSync(f.filePath), original);
  const originalState = unseal(f);
  for (const mutate of [
    (state: any) => { state.schemaVersion = 2; },
    (state: any) => { state.issuer = 'https://wrong.example'; },
    (state: any) => { state.grants[0].clientId = 'unknown'; },
    (state: any) => { state.grants[0].expiresAt = state.writtenAt + 9 * 60 * 60_000; },
    (state: any) => { state.grants[0].rotations = 64; },
    (state: any) => { state.accessTokens[0][1].expiresAt = state.writtenAt + 11 * 60_000; },
    (state: any) => { state.clients[0].redirects = ['https://evil.example/callback']; },
    (state: any) => { state.writtenAt += 1; },
  ]) {
    const state = structuredClone(originalState);
    mutate(state);
    seal(f, state);
    const rejected = readFileSync(f.filePath);
    assert.throws(() => f.gate(), OAuthStateError);
    assert.deepEqual(readFileSync(f.filePath), rejected);
  }
  writeFileSync(f.filePath, original);
  const envelope = JSON.parse(original.toString('utf8'));
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
  ciphertext[ciphertext.length - 1]! ^= 1;
  envelope.ciphertext = ciphertext.toString('base64');
  envelope.checksum = hash(ciphertext); // Valid transport hash cannot bypass authenticated encryption.
  writeFileSync(f.filePath, JSON.stringify(envelope));
  assert.throws(() => f.gate(), OAuthStateError);
});

test('a filesystem mutation-fence write failure issues no token and prevents restart replay', () => {
  const f = fixture();
  const gate = f.gate();
  const issued = grant(gate);
  const original = readFileSync(f.filePath);
  mkdirSync(`${f.filePath}.pending`);
  assert.throws(() => gate.token(refresh(issued.clientId, issued.tokens)), oauthError('temporarily_unavailable'));
  assert.throws(() => gate.verify(issued.tokens.access_token), oauthError('temporarily_unavailable'));
  assert.throws(() => gate.register(clientBody), oauthError('temporarily_unavailable'));
  assert.deepEqual(readFileSync(f.filePath), original);
  assert.throws(() => f.gate(), OAuthStateError);
});

test('cipher failure after the durable fence preserves the previous snapshot and blocks all subsequent authorization', () => {
  const cipher = testCipher();
  let failed = false;
  const f = fixture({ decrypt: cipher.decrypt, encrypt: bytes => { if (failed) throw new Error('synthetic private cipher diagnostic'); return cipher.encrypt(bytes); } });
  const gate = f.gate();
  const issued = grant(gate);
  const original = readFileSync(f.filePath);
  failed = true;
  assert.throws(() => gate.token(refresh(issued.clientId, issued.tokens)), value => value instanceof OAuthError && value.code === 'temporarily_unavailable' && !value.message.includes('synthetic private'));
  assert.ok(existsSync(`${f.filePath}.pending`));
  assert.deepEqual(readFileSync(f.filePath), original);
  failed = false;
  assert.throws(() => f.gate(), OAuthStateError);
  assert.throws(() => gate.verify(issued.tokens.access_token), oauthError('temporarily_unavailable'));
});

test('a stale store cannot overwrite a newer registration or issue tokens from an old snapshot', () => {
  const f = fixture();
  const first = f.gate();
  const initial = grant(first);
  const stale = f.gate();
  const rotated = first.token(refresh(initial.clientId, initial.tokens));
  const saved = readFileSync(f.filePath);
  assert.throws(() => stale.token(refresh(initial.clientId, initial.tokens)), oauthError('temporarily_unavailable'));
  assert.deepEqual(readFileSync(f.filePath), saved);
  const restarted = f.gate();
  assert.equal(restarted.verify(rotated.access_token).client_id, initial.clientId);
  assert.throws(() => restarted.token(refresh(initial.clientId, initial.tokens)), oauthError('invalid_grant'));
});

test('absolute grant/access expiry and the refresh rotation limit survive process reconstruction', () => {
  const f = fixture();
  let gate = f.gate();
  const issued = grant(gate);
  f.advance(10 * 60_000 + 1);
  gate = f.gate();
  assert.throws(() => gate.verify(issued.tokens.access_token), oauthError('invalid_token'));
  let tokens = gate.token(refresh(issued.clientId, issued.tokens));
  for (let i = 1; i < 64; i++) { gate = f.gate(); tokens = gate.token(refresh(issued.clientId, tokens)); }
  gate = f.gate();
  assert.throws(() => gate.token(refresh(issued.clientId, tokens)), oauthError('invalid_grant'));
  assert.throws(() => f.gate().verify(tokens.access_token), oauthError('invalid_token'));
  const fresh = grant(f.gate(), issued.clientId);
  f.advance(8 * 60 * 60_000 + 1);
  assert.throws(() => f.gate().token(refresh(issued.clientId, fresh.tokens)), oauthError('invalid_grant'));
  const afterExpiry = readFileSync(f.filePath);
  f.advance(-1);
  assert.throws(() => f.gate(), OAuthStateError);
  assert.deepEqual(readFileSync(f.filePath), afterExpiry);
});

test('OAuth state refuses linked directories and a non-file mutation fence', () => {
  const f = fixture();
  const target = path.join(f.directory, 'physical');
  mkdirSync(target);
  const linked = path.join(f.directory, 'linked');
  symlinkSync(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => new EncryptedOAuthStateStore({ filePath: path.join(linked, 'oauth.dpapi'), issuer, cipher: f.cipher }), OAuthStateError);
  // A directory fence is portable and is also invalid; symbolic-link support
  // may require Windows developer mode, so do not change system policy to test it.
  mkdirSync(`${f.filePath}.pending`);
  assert.throws(() => f.gate(), OAuthStateError);
});

test('Windows refuses a locked snapshot replacement, preserves the old bytes and leaves a restart fence', { skip: process.platform !== 'win32', timeout: 30_000 }, async () => {
  const f = fixture();
  const gate = f.gate();
  const issued = grant(gate);
  const original = readFileSync(f.filePath);
  const script = `$ErrorActionPreference='Stop'; $handle=$null; try { $handle=[IO.File]::Open('${f.filePath.replaceAll("'", "''")}',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); [Console]::Out.WriteLine('READY'); [Console]::Out.Flush(); $null=[Console]::In.ReadLine() } finally { if ($handle) { $handle.Dispose() } }`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const ended = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Synthetic file-lock helper failed'))); });
  try {
    await new Promise<void>((resolve, reject) => {
      let output = '';
      child.stdout.on('data', chunk => { output += String(chunk); if (output.includes('READY')) resolve(); });
      child.once('error', reject);
      child.once('exit', () => reject(new Error('Synthetic file-lock helper exited before readiness')));
    });
    assert.throws(() => gate.token(refresh(issued.clientId, issued.tokens)), oauthError('temporarily_unavailable'));
    assert.deepEqual(readFileSync(f.filePath), original);
    assert.ok(existsSync(`${f.filePath}.pending`));
    assert.throws(() => f.gate(), OAuthStateError);
    assert.throws(() => gate.verify(issued.tokens.access_token), oauthError('temporarily_unavailable'));
  } finally { child.stdin.end('release\n'); await ended; }
});

for (const shell of ['powershell.exe', 'pwsh.exe']) {
  test(`${shell}: real DPAPI state survives a fresh Node process and refresh replay remains revoked`, { skip: process.platform !== 'win32', timeout: 90_000 }, async context => {
    if (shell === 'pwsh.exe') {
      try { await execute(shell, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { windowsHide: true }); }
      catch { context.skip('PowerShell 7 is unavailable'); return; }
    }
    const f = fixture(windowsDpapiCipher({ shell }));
    const gate = f.gate();
    const issued = grant(gate);
    const identity = gate.verify(issued.tokens.access_token);
    const script = `
import {readFileSync} from 'node:fs';
import {OAuthGate} from ${JSON.stringify(new URL('../src/oauth.ts', import.meta.url).href)};
import {EncryptedOAuthStateStore,windowsDpapiCipher} from ${JSON.stringify(new URL('../src/oauth-state.ts', import.meta.url).href)};
const [filePath,issuer,shell]=process.argv.slice(1);const input=JSON.parse(readFileSync(0,'utf8'));
const gate=new OAuthGate({issuer,now:()=>input.now,stateStore:new EncryptedOAuthStateStore({filePath,issuer,cipher:windowsDpapiCipher({shell})})});
const identity=gate.verify(input.tokens.access_token);
const rotated=gate.token(new URLSearchParams({grant_type:'refresh_token',client_id:input.clientId,resource:issuer+'/mcp',refresh_token:input.tokens.refresh_token}));
process.stdout.write(JSON.stringify({identity,rotated}));
`;
    const output = await new Promise<string>((resolve, reject) => {
      const child = execFile(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, f.filePath, issuer, shell], { cwd: product, windowsHide: true, timeout: 45_000, maxBuffer: 100_000 }, (error, stdout) => error ? reject(error) : resolve(stdout));
      child.stdin!.end(JSON.stringify({ tokens: issued.tokens, clientId: issued.clientId, now: f.time() }));
    });
    const result = JSON.parse(output);
    assert.deepEqual(result.identity, identity);
    const restored = f.gate();
    assert.equal(restored.verify(result.rotated.access_token).grant_id, identity.grant_id);
    assert.throws(() => restored.token(refresh(issued.clientId, issued.tokens)), oauthError('invalid_grant'));
    assert.throws(() => f.gate().verify(result.rotated.access_token), oauthError('invalid_token'));
    for (const name of readdirSync(f.directory)) {
      const text = readFileSync(path.join(f.directory, name), 'utf8');
      assert.equal(text.includes(issued.tokens.access_token), false);
      assert.equal(text.includes(issued.tokens.refresh_token), false);
      assert.equal(text.includes(issuer), false);
    }
  });
}
