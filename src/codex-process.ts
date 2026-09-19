import { existsSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { SpawnOptions } from 'node:child_process';

/** Resolve applications, never a PowerShell shim. No shell profile or install. */
export function codexProcess(command: string, args: string[], env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform): { command: string; args: string[]; options: SpawnOptions } {
  if (platform !== 'win32') return { command, args, options: {} };
  let executable = command;
  if (!path.win32.isAbsolute(command)) {
    if (/[\\/]/.test(command)) executable = path.resolve(command);
    else {
      const entries = (env.PATH ?? env.Path ?? '').split(';').map(p => p.replace(/^"|"$/g, '')).filter(p => path.win32.isAbsolute(p));
      const names = path.extname(command) ? [command] : [`${command}.exe`, `${command}.cmd`];
      const found = names.flatMap(name => entries.map(dir => path.join(dir, name))).find(file => existsSync(file) && lstatSync(file).isFile());
      if (!found) throw new Error('Codex executable is missing; install or select an existing codex.exe/codex.cmd.');
      executable = found;
    }
  }
  if (!existsSync(executable) || !lstatSync(executable).isFile() || lstatSync(executable).isSymbolicLink()) throw new Error('Codex executable must be an existing physical file.');
  executable = realpathSync.native(executable);
  const extension = path.extname(executable).toLowerCase();
  if (extension === '.exe') return { command: executable, args, options: {} };
  if (extension !== '.cmd') throw new Error('Codex requires codex.exe or codex.cmd; PowerShell shims are not executed.');
  // cmd cannot execute escaped embedded quotes safely with the same rules as
  // native argv. Task prompts never enter this command: they use JSONL stdin.
  if ([executable, ...args].some(value => /[%"\r\n]/.test(value))) throw new Error('Unsupported characters in Codex command arguments.');
  const quoted = [executable, ...args].map(value => `"${value}"`).join(' ');
  return { command: path.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'),
    args: ['/d', '/v:off', '/s', '/c', `"${quoted}"`], options: { windowsVerbatimArguments: true } };
}
