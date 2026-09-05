import { spawnSync } from 'node:child_process';
import { wrangler, product } from './cloudflare-cli.mjs';
import path from 'node:path';
const tested = spawnSync(process.execPath, ['--test', 'edge/test/*.test.mjs'], { cwd: product, stdio: 'inherit', windowsHide: true });
if (tested.status !== 0) process.exit(tested.status ?? 1);
for (const args of [['types', '--include-runtime', 'false', '--check'], ['deploy', '--dry-run', '--autoconfig', 'false']]) {
  const result = await wrangler([...args, '--config', path.join(product, 'edge/wrangler.jsonc')]);
  if (result.code !== 0 || result.timedOut || result.outputTruncated) {
    console.error('Worker binding types or deployment dry-run failed. No remote deployment was performed.'); process.exit(1);
  }
}
console.log('Worker behavior, generated bindings and pinned deployment dry-run passed. No remote resources changed.');
