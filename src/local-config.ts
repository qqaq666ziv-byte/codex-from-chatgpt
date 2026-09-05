import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const schema = z.object({
  schemaVersion: z.literal(1), host: z.literal('127.0.0.1'), port: z.number().int().min(1024).max(65535),
  model: z.string().min(1), reasoningEffort: z.enum(['low','medium','high','xhigh','max','ultra']),
  projects: z.array(z.object({id:z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),name:z.string().min(1),path:z.string().min(1)})),
});
export type LocalConfig = z.infer<typeof schema> & {runtimeDir:string;configPath:string};
export function loadLocalConfig(configPath = process.env.AUTODEV_CONFIG ?? path.resolve('.runtime/config.json')): LocalConfig {
  const resolved = realpathSync(configPath);
  const parsed = schema.parse(JSON.parse(readFileSync(resolved,'utf8').replace(/^\uFEFF/,'')));
  const ids = new Set<string>(); const paths = new Set<string>();
  for (const p of parsed.projects) {
    if (ids.has(p.id)) throw new Error('Duplicate project id.'); ids.add(p.id);
    if (!path.isAbsolute(p.path)) throw new Error('Project must use an absolute path.');
    const canonical = realpathSync(p.path);
    if (!statSync(canonical).isDirectory()) throw new Error('Project path is not a directory.');
    const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
    if (paths.has(key)) throw new Error('Duplicate canonical project.'); paths.add(key);
    p.path = canonical;
  }
  return {...parsed,configPath:resolved,runtimeDir:path.dirname(resolved)};
}
export function readLocalToken(runtimeDir:string, kind:'client'|'admin'):string {
  const token = readFileSync(path.join(runtimeDir,`${kind}-token`),'utf8').trim();
  if (!/^[a-zA-Z0-9+/_=-]{32,256}$/.test(token)) throw new Error('Missing or malformed local token; run setup.');
  return token;
}
export function authorized(header:string|undefined, token:string):boolean {
  const actual = Buffer.from(header ?? ''); const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual,expected);
}
