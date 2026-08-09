import { realpath } from "node:fs/promises";
import path from "node:path";

export const WORKSPACE_ROOT = "/Users/joseanu/workspace";

export class WorkspaceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceValidationError";
  }
}

/**
 * Resolves a user-provided workspace to an existing canonical path under the
 * one local root this personal server is allowed to expose.
 */
export async function validateWorkspace(input: string): Promise<string> {
  if (typeof input !== "string" || input.length === 0) {
    throw new WorkspaceValidationError("workspace debe ser una ruta no vacía.");
  }

  if (input.includes("\0")) {
    throw new WorkspaceValidationError("workspace contiene un byte NUL inválido.");
  }

  if (!path.isAbsolute(input)) {
    throw new WorkspaceValidationError("workspace debe ser una ruta absoluta.");
  }

  // Reject traversal explicitly even when it would normalize back inside the
  // root. This keeps the boundary obvious in audit logs and error messages.
  if (input.split(path.sep).some((part) => part === "..")) {
    throw new WorkspaceValidationError("workspace no puede contener segmentos '..'.");
  }

  let root: string;
  let candidate: string;
  try {
    root = await realpath(WORKSPACE_ROOT);
    candidate = await realpath(path.resolve(input));
  } catch {
    throw new WorkspaceValidationError(
      `workspace no existe o no puede resolverse: ${input}`,
    );
  }

  const relative = path.relative(root, candidate);
  const escapesRoot =
    relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);

  if (escapesRoot) {
    throw new WorkspaceValidationError(
      `workspace debe estar dentro de ${WORKSPACE_ROOT}: ${input}`,
    );
  }

  // Passing the canonical path to Codex means a symlink cannot redirect the
  // cwd outside the allowed root between validation and thread/start.
  return candidate;
}
