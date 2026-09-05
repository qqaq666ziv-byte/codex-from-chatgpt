import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const product = fileURLToPath(new URL('../', import.meta.url));
const testRoot = path.join(product, '.local-tests');
const helper = path.join(product, 'scripts/cloudflare-cli.mjs');
const realCli = path.join(product, 'edge/node_modules/wrangler/wrangler-dist/cli.js');
const syntheticKeys = ['NODE_OPTIONS', 'NODE_PATH', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'OPENAI_API_KEY', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'WRANGLER_API_BASE_URL', 'WRANGLER_LOG_PATH', 'AUTODEV_FIXTURE_SECRET'];

function fixture() {
  mkdirSync(testRoot, { recursive: true });
  const directory = mkdtempSync(path.join(testRoot, 'cloudflare cli 中文-'));
  const edge = path.join(directory, 'edge');
  const packageRoot = path.join(edge, 'node_modules/wrangler');
  const cli = path.join(packageRoot, 'wrangler-dist/cli.js');
  const script = path.join(directory, 'scripts/cloudflare-cli.mjs');
  const cliHome = path.join(directory, '.runtime/cloudflare-cli');
  const sentinel = path.join(directory, 'preload-executed.txt');
  const preload = path.join(directory, 'sentinel.cjs');
  for (const folder of [path.dirname(script), path.dirname(cli), path.join(packageRoot, 'bin')]) mkdirSync(folder, { recursive: true });
  copyFileSync(helper, script);
  writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  writeFileSync(path.join(packageRoot, 'bin/wrangler.js'), 'process.stderr.write("UNEXPECTED_BIN_WRAPPER"); process.exitCode = 91;');
  writeFileSync(preload, `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'synthetic preload executed');`);
  writeFileSync(path.join(edge, '.env'), 'AUTODEV_DOTENV_SENTINEL=synthetic-dotenv-value\n');
  writeFileSync(path.join(edge, '.env.local'), 'AUTODEV_DOTENV_SENTINEL=synthetic-local-dotenv-value\n');
  const environment: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(process.env)) if (/^(PATH|SystemRoot|WINDIR|SYSTEMDRIVE|COMSPEC|PATHEXT)$/i.test(key) && process.env[key]) environment[key] = process.env[key];
  Object.assign(environment, { HOME: directory, USERPROFILE: directory, APPDATA: directory, LOCALAPPDATA: directory, XDG_CONFIG_HOME: directory, TEMP: directory, TMP: directory });
  async function run(source: string, timeout = 15_000) {
    const runner = path.join(directory, 'runner.mjs');
    writeFileSync(runner, `import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { wrangler, wranglerEnvironment, cliHome } from ${JSON.stringify(pathToFileURL(script).href)};
// Set these only after this isolated runner has started. The test process never preloads the sentinel.
for (const key of ${JSON.stringify(syntheticKeys)}) process.env[key] = 'synthetic-inherited-value';
process.env.NODE_OPTIONS = ${JSON.stringify(`--require ${JSON.stringify(preload)}`)};
${source}
`);
    return execute(process.execPath, [runner], { cwd: directory, env: environment, windowsHide: true, timeout, maxBuffer: 3 * 1024 * 1024 });
  }
  const emptyFiles = () => existsSync(cliHome) ? readdirSync(cliHome).filter(name => /^empty-.*\.txt$/.test(name)) : [];
  return { directory, edge, cli, script, cliHome, sentinel, run, emptyFiles };
}

const inspectCli = `const fs = require('node:fs');
const path = require('node:path');
const at = process.argv.indexOf('--env-file');
const environmentFile = at >= 0 ? process.argv[at + 1] : undefined;
process.stdout.write(JSON.stringify({
  pid: process.pid, ppid: process.ppid, entry: process.argv[1], cwd: process.cwd(),
  envFileCount: process.argv.filter(arg => arg === '--env-file').length,
  environmentFile, emptyFileExists: !!environmentFile && fs.existsSync(environmentFile),
  emptyFileLength: environmentFile ? fs.statSync(environmentFile).size : -1,
  emptyFileContent: environmentFile ? fs.readFileSync(environmentFile, 'utf8') : null,
  home: process.env.USERPROFILE, temp: process.env.TEMP,
  unexpectedEnvironment: ${JSON.stringify(syntheticKeys)}.filter(key => process.env[key] !== undefined),
  dotenvExists: fs.existsSync(path.join(process.cwd(), '.env')),
  nodeVersion: process.versions.node,
}) + '\\n');
`;

test('Wrangler environment accepts only explicit OS paths and replaces all profile, logging and dotenv settings', async () => {
  const f = fixture();
  const { stdout } = await f.run(`
const source = { Path: 'synthetic-search-path', SYSTEMROOT: 'synthetic-system-root', WINDIR: 'synthetic-windir', SYSTEMDRIVE: 'synthetic-drive', COMSPEC: 'synthetic-shell', PATHEXT: '.EXE',
  HOME: 'synthetic-private-home', USERPROFILE: 'synthetic-private-profile', APPDATA: 'synthetic-private-appdata', TEMP: 'synthetic-private-temp',
  WRANGLER_SEND_METRICS: 'true', WRANGLER_WRITE_LOGS: 'true', CLOUDFLARE_INCLUDE_PROCESS_ENV: 'true', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'true' };
for (const key of ${JSON.stringify(syntheticKeys)}) source[key] = 'synthetic-secret';
const environment = wranglerEnvironment(source);
assert.deepEqual(environment, {
  Path: source.Path, SYSTEMROOT: source.SYSTEMROOT, WINDIR: source.WINDIR, SYSTEMDRIVE: source.SYSTEMDRIVE, COMSPEC: source.COMSPEC, PATHEXT: source.PATHEXT,
  USERPROFILE: cliHome, APPDATA: cliHome, LOCALAPPDATA: cliHome, XDG_CONFIG_HOME: cliHome, XDG_CACHE_HOME: cliHome,
  TEMP: path.join(cliHome, 'temp'), TMP: path.join(cliHome, 'temp'),
  WRANGLER_SEND_METRICS: 'false', WRANGLER_WRITE_LOGS: 'false', WRANGLER_LOG_SANITIZE: 'true',
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false', CI: 'true', NO_COLOR: '1'
});
assert.equal(source.HOME, 'synthetic-private-home');
console.log('strict-environment-pass');`);
  assert.equal(stdout.trim(), 'strict-environment-pass');
  assert.equal(existsSync(f.sentinel), false);
  assert.equal(existsSync(f.cliHome), false);
});

test('each Wrangler invocation owns a unique empty env file and directly starts the pinned CLI with sanitized environment', { skip: Number(process.versions.node.split('.')[0]) < 22 }, async () => {
  const f = fixture();
  writeFileSync(f.cli, inspectCli);
  const { stdout } = await f.run(`
const records = [];
for (let i = 0; i < 2; i++) {
  const result = await wrangler(['--version']);
  assert.equal(result.code, 0); assert.equal(result.timedOut, false); assert.equal(result.stderr, '');
  const facts = JSON.parse(result.stdout);
  assert.equal(facts.ppid, process.pid);
  assert.equal(fs.existsSync(facts.environmentFile), false);
  records.push(facts);
}
console.log(JSON.stringify(records));`);
  const records = JSON.parse(stdout);
  assert.equal(records.length, 2);
  assert.notEqual(records[0].environmentFile, records[1].environmentFile);
  for (const record of records) {
    assert.equal(record.entry, f.cli);
    assert.equal(record.cwd, f.edge);
    assert.equal(record.envFileCount, 1);
    assert.equal(path.dirname(record.environmentFile), f.cliHome);
    assert.match(path.basename(record.environmentFile), /^empty-[0-9a-f-]{36}\.txt$/);
    assert.equal(record.emptyFileExists, true);
    assert.equal(record.emptyFileLength, 0);
    assert.equal(record.emptyFileContent, '');
    assert.equal(record.dotenvExists, true);
    assert.deepEqual(record.unexpectedEnvironment, []);
    assert.equal(record.home, f.cliHome);
    assert.equal(record.temp, path.join(f.cliHome, 'temp'));
  }
  assert.deepEqual(f.emptyFiles(), []);
  assert.equal(existsSync(f.sentinel), false);
  assert.equal(readFileSync(path.join(f.edge, '.env'), 'utf8'), 'AUTODEV_DOTENV_SENTINEL=synthetic-dotenv-value\n');
});

test('Wrangler timeout kills the actual CLI process before settling and deletes its empty env file', { skip: Number(process.versions.node.split('.')[0]) < 22 }, async () => {
  const f = fixture();
  writeFileSync(f.cli, inspectCli + 'setInterval(() => {}, 1000);');
  const { stdout } = await f.run(`
const result = await wrangler(['synthetic-hang'], { timeout: 3000 });
assert.equal(result.timedOut, true);
assert.notEqual(result.code, 0);
const facts = JSON.parse(result.stdout);
assert.equal(facts.ppid, process.pid);
assert.throws(() => process.kill(facts.pid, 0), error => error.code === 'ESRCH');
assert.equal(fs.existsSync(facts.environmentFile), false);
console.log(JSON.stringify({ actualChildClosed: true, emptyFileRemoved: true, directEntry: facts.entry }));`);
  assert.deepEqual(JSON.parse(stdout), { actualChildClosed: true, emptyFileRemoved: true, directEntry: f.cli });
  assert.deepEqual(f.emptyFiles(), []);
});

test('the Node 22 floor rejects older runtimes before creating files or starting a child', async () => {
  const f = fixture();
  writeFileSync(f.cli, 'throw new Error("must not start below Node 22");');
  const { stdout } = await f.run(`
for (const version of ['20.20.0', '21.7.3']) {
  Object.defineProperty(process.versions, 'node', { configurable: true, value: version });
  assert.throws(() => wrangler(['--version']), /Node.js 22 or newer/);
  assert.equal(fs.existsSync(cliHome), false);
}
console.log('node-floor-pass');`);
  assert.equal(stdout.trim(), 'node-floor-pass');
  assert.equal(existsSync(f.cliHome), false);
});

test('the exact Node 22 guard boundary permits the isolated CLI and nonzero exits still remove its env file', async () => {
  const f = fixture();
  writeFileSync(f.cli, inspectCli + 'process.exitCode = 37;');
  const { stdout } = await f.run(`
// This probes the version guard only; the actual executable remains the installed test runtime.
Object.defineProperty(process.versions, 'node', { configurable: true, value: '22.0.0' });
const result = await wrangler(['synthetic-failure']);
assert.equal(result.code, 37); assert.equal(result.timedOut, false);
const facts = JSON.parse(result.stdout);
assert.equal(fs.existsSync(facts.environmentFile), false);
console.log('node-boundary-and-exit-cleanup-pass');`);
  assert.equal(stdout.trim(), 'node-boundary-and-exit-cleanup-pass');
  assert.deepEqual(f.emptyFiles(), []);
});

test('a child launch failure removes the owned empty env file and returns only a generic error', { skip: Number(process.versions.node.split('.')[0]) < 22 }, async () => {
  const f = fixture();
  const { stdout } = await f.run(`
Object.defineProperty(process, 'execPath', { value: path.join(cliHome, 'synthetic-nonexistent-node.exe') });
await assert.rejects(wrangler(['--version']), error => error.message === 'Cloudflare CLI could not start.');
assert.deepEqual(fs.readdirSync(cliHome).filter(name => name.startsWith('empty-')), []);
console.log('spawn-error-cleanup-pass');`);
  assert.equal(stdout.trim(), 'spawn-error-cleanup-pass');
  assert.deepEqual(f.emptyFiles(), []);
});

test('the installed pinned CLI --version ignores synthetic dotenv files and cannot inherit a NODE_OPTIONS preload', { skip: process.platform !== 'win32' || Number(process.versions.node.split('.')[0]) < 22 || !existsSync(realCli), timeout: 30_000 }, async () => {
  const f = fixture();
  const factsFile = path.join(f.directory, 'installed-cli-facts.json');
  // This fixture imports the installed CLI in the same PID. It does not run its bin wrapper,
  // use existing credential storage, or permit network activity.
  writeFileSync(f.cli, `
const fs = require('node:fs');
const path = require('node:path');
const read = fs.readFileSync;
const forbiddenFiles = new Set([${JSON.stringify(path.join(f.edge, '.env'))}, ${JSON.stringify(path.join(f.edge, '.env.local'))}]);
let dotenvRead = false, networkAttempt = false;
fs.readFileSync = function(file, ...args) {
  if (typeof file === 'string' && forbiddenFiles.has(path.resolve(file))) dotenvRead = true;
  return read.call(this, file, ...args);
};
const denied = () => { networkAttempt = true; throw new Error('Network disabled in isolated CLI version test.'); };
require('node:net').Socket.prototype.connect = denied;
globalThis.fetch = denied;
process.on('exit', () => fs.writeFileSync(${JSON.stringify(factsFile)}, JSON.stringify({
  dotenvRead, networkAttempt, dotenvLoaded: process.env.AUTODEV_DOTENV_SENTINEL !== undefined,
  preloadInherited: process.env.NODE_OPTIONS !== undefined,
  envFile: process.argv[process.argv.indexOf('--env-file') + 1]
})));
// Node's main-module flag preserves the installed CLI's require.main guard.
require('node:module')._load(${JSON.stringify(realCli)}, null, true);
`);
  const { stdout } = await f.run(`
const result = await wrangler(['--version'], { timeout: 20_000 });
assert.equal(result.code, 0, 'Installed CLI --version must succeed.');
assert.equal(result.timedOut, false);
assert.match(result.stdout, /4\\.129\\.0/);
console.log('installed-version-pass');`, 25_000);
  assert.equal(stdout.trim(), 'installed-version-pass');
  const facts = JSON.parse(readFileSync(factsFile, 'utf8'));
  assert.equal(facts.dotenvRead, false);
  assert.equal(facts.dotenvLoaded, false);
  assert.equal(facts.preloadInherited, false);
  assert.equal(facts.networkAttempt, false);
  assert.equal(existsSync(facts.envFile), false);
  assert.equal(existsSync(f.sentinel), false);
  assert.deepEqual(f.emptyFiles(), []);
});

for (const action of ['login', 'status']) for (const outcome of ['complete', 'timeout', 'truncated']) {
  test(`${action} main entry ${outcome === 'complete' ? 'accepts a complete result' : `rejects ${outcome} even when the child closes with code zero`}`, { skip: Number(process.versions.node.split('.')[0]) < 22 }, async () => {
    const f = fixture();
    const { stdout } = await f.run(`
const childProcess = (await import('node:child_process')).default;
const { EventEmitter } = await import('node:events');
const { PassThrough } = await import('node:stream');
const { syncBuiltinESMExports } = await import('node:module');
const originalSpawn = childProcess.spawn, originalTimeout = globalThis.setTimeout, originalLog = console.log;
const messages = []; let kills = 0, launches = 0;
// Only this isolated runner substitutes the child. No login, network or real CLI starts.
childProcess.spawn = () => {
  launches++;
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.kill = () => { kills++; return true; };
  setImmediate(() => {
    child.stdout.write(JSON.stringify({ accounts: [{ id: 'synthetic-account' }] }));
    if (${JSON.stringify(outcome)} === 'truncated') child.stderr.write(Buffer.alloc(2 * 1024 * 1024 + 1, 120));
    child.emit('close', 0);
  });
  return child;
};
syncBuiltinESMExports();
globalThis.setTimeout = (callback, delay, ...args) => {
  if (delay >= 120_000) {
    if (${JSON.stringify(outcome)} === 'timeout') queueMicrotask(callback);
    return originalTimeout(() => {}, 60_000);
  }
  return originalTimeout(callback, delay, ...args);
};
console.log = value => messages.push(value);
try {
  process.argv[1] = ${JSON.stringify(f.script)};
  process.argv[2] = ${JSON.stringify(action)};
  await import(${JSON.stringify(pathToFileURL(f.script).href + '?isolated-main-entry')});
} finally {
  childProcess.spawn = originalSpawn; syncBuiltinESMExports();
  globalThis.setTimeout = originalTimeout; console.log = originalLog;
}
const code = process.exitCode ?? 0; process.exitCode = 0;
console.log(JSON.stringify({ code, messages, launches, kills }));`);
    const facts = JSON.parse(stdout);
    assert.equal(facts.launches, 1);
    assert.equal(facts.code, outcome === 'complete' ? 0 : 1);
    assert.equal(facts.kills, outcome === 'complete' ? 0 : 1);
    if (action === 'status') {
      assert.equal(facts.messages.length, 1);
      const status = JSON.parse(facts.messages[0]);
      assert.equal(status.authenticated, outcome === 'complete');
      assert.equal(status.accountCount, outcome === 'complete' ? 1 : null);
    } else {
      assert.equal(facts.messages.length, 2);
      assert.match(facts.messages[1], outcome === 'complete' ? /sign-in completed/ : /sign-in did not complete/);
    }
    assert.deepEqual(f.emptyFiles(), []);
    assert.equal(existsSync(f.sentinel), false);
  });
}
