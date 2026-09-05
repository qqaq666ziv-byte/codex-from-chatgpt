import { realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEFAULT_WORKSPACE_ROOT = path.join(os.homedir(), "workspace");

export class WorkspaceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceValidationError";
  }
}

function hasTraversal(input: string): boolean {
  // Windows accepts both separators, including a mixture in one path.
  const separators = process.platform === "win32" ? /[\\/]/ : /\//;
  return input.split(separators).some((part) => part === "..");
}

function isFullyQualified(input: string): boolean {
  if (!path.isAbsolute(input)) return false;
  // A rooted path such as \work or /work still depends on the current drive.
  return process.platform !== "win32" || /^[A-Za-z]:[\\/]/.test(input) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(input);
}

function configuredRoot(root = process.env.CODEX_WORKSPACE_ROOT ?? DEFAULT_WORKSPACE_ROOT): string {
  if (typeof root !== "string" || !isFullyQualified(root) || root.includes("\0") || hasTraversal(root)) {
    throw new WorkspaceValidationError("CODEX_WORKSPACE_ROOT debe ser una ruta absoluta sin segmentos '..'.");
  }
  return root;
}

/** Resolves an existing directory under the canonical, administrative workspace root. */
export async function validateWorkspace(input: string, rootInput?: string): Promise<string> {
  if (typeof input !== "string" || input.length === 0) {
    throw new WorkspaceValidationError("workspace debe ser una ruta no vacía.");
  }
  if (input.includes("\0")) {
    throw new WorkspaceValidationError("workspace contiene un byte NUL inválido.");
  }
  if (!isFullyQualified(input)) {
    throw new WorkspaceValidationError("workspace debe ser una ruta absoluta.");
  }
  if (hasTraversal(input)) {
    throw new WorkspaceValidationError("workspace no puede contener segmentos '..'.");
  }

  const rootInputValue = configuredRoot(rootInput);
  let root: string;
  let candidate: string;
  try {
    root = await realpath(path.resolve(rootInputValue));
    if (!(await stat(root)).isDirectory()) throw new Error("la raíz no es un directorio");
    candidate = await realpath(path.resolve(input));
    if (!(await stat(candidate)).isDirectory()) throw new Error("el workspace no es un directorio");
  } catch {
    throw new WorkspaceValidationError(`workspace no existe o no puede resolverse: ${input}`);
  }

  const relative = path.relative(root, candidate);
  const escapesRoot = relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  if (escapesRoot) {
    throw new WorkspaceValidationError(`workspace debe estar dentro de ${rootInputValue}: ${input}`);
  }
  return candidate;
}
