import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const product = fileURLToPath(new URL('../', import.meta.url));
export const cliHome = path.join(product, '.runtime', 'cloudflare-cli');
export function wranglerEnvironment(source = process.env) {
  const result = {};
  for (const [key, value] of Object.entries(source)) {
    if (/^(PATH|SystemRoot|WINDIR|SYSTEMDRIVE|COMSPEC|PATHEXT)$/i.test(key) && value) result[key] = value;
  }
  return { ...result, USERPROFILE: cliHome, APPDATA: cliHome, LOCALAPPDATA: cliHome,
    XDG_CONFIG_HOME: cliHome, XDG_CACHE_HOME: cliHome, TEMP: path.join(cliHome, 'temp'), TMP: path.join(cliHome, 'temp'),
    WRANGLER_SEND_METRICS: 'false', WRANGLER_WRITE_LOGS: 'false', WRANGLER_LOG_SANITIZE: 'true',
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false',
    CI: 'true', NO_COLOR: '1' };
}

// Only the official CLI consumes its workspace-scoped OAuth storage. Never read
// credential files or return its raw diagnostics to model-visible reports.
export function wrangler(args, { input, timeout = 120_000, onAuthLink } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Pinned Wrangler requires Node.js 22 or newer.');
  mkdirSync(path.join(cliHome, 'temp'), { recursive: true });
  // Wrangler's global CLI dotenv loader is separate from the dev-vars flags.
  // Override it explicitly with this invocation's own empty file.
  const emptyEnvironment = path.join(cliHome, `empty-${randomUUID()}.txt`);
  writeFileSync(emptyEnvironment, '', { flag: 'wx', mode: 0o600 });
  return new Promise((resolve, reject) => {
    // Invoke the exact entry used by the pinned bin wrapper. Owning the actual
    // CLI PID means timeout cannot leave a wrapper's deployment grandchild alive.
    const child = spawn(process.execPath, ['--no-warnings', path.join(product, 'edge/node_modules/wrangler/wrangler-dist/cli.js'), ...args, '--env-file', emptyEnvironment],
      { cwd: path.join(product, 'edge'), env: wranglerEnvironment(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', bytes = 0, timedOut = false, outputTruncated = false, authLinkShown = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    const collect = key => chunk => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) { outputTruncated = true; child.kill(); return; }
      if (key === 'out') {
        stdout += chunk.toString();
        const link = stdout.match(/https:\/\/dash\.cloudflare\.com\/oauth2\/auth\?[^\s]+/)?.[0];
        if (link && !authLinkShown && onAuthLink) { authLinkShown = true; onAuthLink(link); }
      } else stderr += chunk.toString();
    };
    child.stdout.on('data', collect('out')); child.stderr.on('data', collect('err'));
    const cleanup = () => { clearTimeout(timer); try { unlinkSync(emptyEnvironment); } catch {} };
    child.once('error', () => { cleanup(); reject(new Error('Cloudflare CLI could not start.')); });
    child.once('close', code => { cleanup(); resolve({ code, stdout, stderr, timedOut, outputTruncated }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2];
  if (action === 'login') {
    console.log('Starting Cloudflare browser sign-in. Authorize the displayed Workers/KV scopes only.');
    const result = await wrangler(['login', '--browser', 'false', '--scopes', 'account:read', 'user:read', 'workers_scripts:write', 'workers_routes:write', 'workers_kv:write'], {
      timeout: 300_000, onAuthLink: link => console.log(`Open the official one-time authorization page: ${link}`),
    });
    const completed = result.code === 0 && !result.timedOut && !result.outputTruncated;
    console.log(completed ? 'Cloudflare CLI sign-in completed in private workspace storage.' : 'Cloudflare sign-in did not complete; no resources were deployed.');
    process.exitCode = completed ? 0 : 1;
  } else if (action === 'status') {
    const result = await wrangler(['whoami', '--json']);
    const completed = result.code === 0 && !result.timedOut && !result.outputTruncated;
    let value;
    try { value = JSON.parse(result.stdout); } catch {}
    console.log(JSON.stringify({ authenticated: completed && !!value,
      accountCount: completed && Array.isArray(value?.accounts) ? value.accounts.length : null,
      costPlan: 'Verify Workers Free in the account dashboard before deployment.' }));
    process.exitCode = completed ? 0 : 1;
  } else {
    console.error('Use cloudflare.ps1 login or status.'); process.exitCode = 1;
  }
}
