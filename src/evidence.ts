import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export type EvidenceIdentity = {
  jobId: string;
  threadId: string;
  turnId: string;
  revision: number;
};

export type EvidenceArtifact = { name: string; sha256: string; byteLength: number };

export type EvidenceManifest = {
  schemaVersion: 1;
  id: string;
  identity: EvidenceIdentity;
  createdAt: string;
  artifacts: EvidenceArtifact[];
  metadata: Record<string, unknown>;
};

export type EvidencePage = {
  manifestId: string;
  artifactName: string;
  sha256: string;
  content: string;
  /** Offsets and limits count UTF-8 bytes, never UTF-16 code units. */
  offset: number;
  nextCursor: string | null;
  done: boolean;
};

type Snapshot = { manifest: EvidenceManifest; contents: Record<string, string>; integrity: string };
type Cursor = { version: 1; manifestId: string; artifactName: string; sha256: string; offset: number };
const HASH = /^[a-f0-9]{64}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEFAULT_PAGE_BYTES = 64 * 1024;
const MAX_PAGE_BYTES = 1024 * 1024;

export class EvidenceError extends Error {
  constructor(readonly code: "INVALID_INPUT" | "INVALID_CURSOR" | "NOT_FOUND" | "CORRUPT" | "IO_ERROR", message: string) {
    super(message);
    this.name = "EvidenceError";
  }
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reject lossy JSON values instead of silently changing the snapshot identity. */
function canonical(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    if (Buffer.from(value, "utf8").toString("utf8") !== value) throw new Error("unpaired Unicode surrogate");
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== "object" || value === null || ancestors.has(value)) throw new Error("invalid or cyclic JSON value");
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error("metadata must contain plain JSON objects");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) throw new Error("symbol keys are not JSON values");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const values: string[] = [];
      for (let index = 0; index < value.length; index++) values.push(canonical(value[index], ancestors));
      return `[${values.join(",")}]`;
    }
    return `{${Object.keys(value).sort().map((key) => `${canonical(key, ancestors)}:${canonical((value as Record<string, unknown>)[key], ancestors)}`).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function validateIdentity(identity: unknown): asserts identity is EvidenceIdentity {
  if (!object(identity) || Object.keys(identity).sort().join(",") !== "jobId,revision,threadId,turnId" ||
      ![identity.jobId, identity.threadId, identity.turnId].every((id) => typeof id === "string" && id.length > 0 && id.length <= 512) ||
      !Number.isSafeInteger(identity.revision) || (identity.revision as number) < 0) {
    throw new Error("identity requires jobId, threadId, turnId and a non-negative safe integer revision");
  }
}

function snapshotId(manifest: Omit<EvidenceManifest, "id" | "createdAt">): string {
  return hash(canonical({ schemaVersion: manifest.schemaVersion, identity: manifest.identity, artifacts: manifest.artifacts, metadata: manifest.metadata }));
}

function cursorFor(cursor: Cursor): string {
  const encoded = Buffer.from(canonical(cursor), "utf8").toString("base64url");
  return `v1.${encoded}.${hash(encoded)}`;
}

function cursorOffset(token: string, manifestId: string, artifact: EvidenceArtifact, bytes: Buffer): number {
  try {
    if (typeof token !== "string" || token.length > 4096) throw new Error("invalid token size");
    const match = /^v1\.([A-Za-z0-9_-]+)\.([a-f0-9]{64})$/.exec(token);
    if (!match || !match[1] || hash(match[1]) !== match[2]) throw new Error("invalid token checksum");
    const decoded = Buffer.from(match[1], "base64url");
    if (decoded.toString("base64url") !== match[1]) throw new Error("invalid token encoding");
    const value: unknown = JSON.parse(decoded.toString("utf8"));
    if (!object(value) || Object.keys(value).sort().join(",") !== "artifactName,manifestId,offset,sha256,version" ||
        value.version !== 1 || value.manifestId !== manifestId || value.artifactName !== artifact.name || value.sha256 !== artifact.sha256 ||
        !Number.isSafeInteger(value.offset) || (value.offset as number) < 0 || (value.offset as number) > bytes.length ||
        canonical(value) !== decoded.toString("utf8")) throw new Error("cursor does not identify this artifact snapshot");
    const offset = value.offset as number;
    if (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) throw new Error("cursor splits a Unicode character");
    return offset;
  } catch {
    throw new EvidenceError("INVALID_CURSOR", "Invalid evidence cursor or cursor belongs to a different artifact snapshot");
  }
}

/**
 * Immutable, content-addressed evidence. The configured directory must already
 * belong to the private runtime security boundary (including Windows ACLs).
 * The API accepts logical artifact names only, never caller-supplied paths.
 * Snapshots persist together in one file, so a reader cannot observe half a
 * manifest or artifacts from another revision. Hashes detect damage, not an
 * attacker able to rewrite both runtime state and all evidence.
 */
export class EvidenceStore {
  private readonly directory: string;

  constructor(rootDir: string) {
    if (typeof rootDir !== "string" || !rootDir) throw new EvidenceError("INVALID_INPUT", "An evidence runtime directory is required");
    mkdirSync(rootDir, { recursive: true, mode: 0o700 });
    if (!lstatSync(rootDir).isDirectory() || lstatSync(rootDir).isSymbolicLink()) {
      throw new EvidenceError("INVALID_INPUT", "Evidence runtime must be a directory, not a symbolic link");
    }
    this.directory = realpathSync(rootDir);
  }

  publish(identity: EvidenceIdentity, artifacts: Record<string, string>, metadata: Record<string, unknown> = {}): EvidenceManifest {
    let snapshot: Snapshot;
    try {
      validateIdentity(identity);
      if (!object(artifacts) || !object(metadata)) throw new Error("artifacts and metadata must be objects");
      // JSON round-tripping owns all values; mutating a caller's objects cannot
      // change either the published snapshot or later read results.
      const contents = JSON.parse(canonical(artifacts)) as Record<string, string>;
      const descriptors = Object.keys(contents).sort().map((name): EvidenceArtifact => {
        if (!NAME.test(name) || typeof contents[name] !== "string") throw new Error("invalid logical artifact name or non-text artifact");
        const bytes = Buffer.from(contents[name], "utf8");
        return { name, sha256: hash(bytes), byteLength: bytes.length };
      });
      const base = {
        schemaVersion: 1 as const,
        identity: JSON.parse(canonical(identity)) as EvidenceIdentity,
        artifacts: descriptors,
        metadata: JSON.parse(canonical(metadata)) as Record<string, unknown>,
      };
      const body = { manifest: { ...base, id: snapshotId(base), createdAt: new Date().toISOString() }, contents };
      snapshot = { ...body, integrity: hash(canonical(body)) };
    } catch (error) {
      throw new EvidenceError("INVALID_INPUT", `Invalid evidence snapshot: ${error instanceof Error ? error.message : "invalid input"}`);
    }

    const target = this.filename(snapshot.manifest.id);
    const temporary = path.join(this.directory, `.evidence-${process.pid}-${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
      this.assertDirectory();
      descriptor = openSync(temporary, "wx", 0o600);
      writeFileSync(descriptor, `${canonical(snapshot)}\n`, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      try {
        // Unlike rename, hard-link creation atomically refuses an existing ID.
        // There is no fallback that could overwrite a concurrent publication.
        linkSync(temporary, target);
      } catch (error) {
        if (!object(error) || error.code !== "EEXIST") throw error;
        const existing = this.load(snapshot.manifest.id);
        if (canonical(existing.contents) !== canonical(snapshot.contents) ||
            canonical({ ...existing.manifest, createdAt: "" }) !== canonical({ ...snapshot.manifest, createdAt: "" })) {
          throw new EvidenceError("CORRUPT", "Evidence ID collision; existing snapshot was not overwritten");
        }
        return existing.manifest;
      }
      // Windows does not support opening directories for fsync through Node.
      if (process.platform !== "win32") {
        const directoryFd = openSync(this.directory, "r");
        try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
      }
      return snapshot.manifest;
    } catch (error) {
      if (error instanceof EvidenceError) throw error;
      throw new EvidenceError("IO_ERROR", `Could not atomically publish evidence (${object(error) && typeof error.code === "string" ? error.code : "I/O error"})`);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      try { unlinkSync(temporary); } catch { /* An unlinked temporary or failed cleanup does not change the published snapshot. */ }
    }
  }

  manifest(id: string): EvidenceManifest {
    return this.load(id).manifest;
  }

  read(manifestId: string, artifactName: string, cursor?: string, limit = DEFAULT_PAGE_BYTES): EvidencePage {
    if (typeof artifactName !== "string" || !NAME.test(artifactName) || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_BYTES) {
      throw new EvidenceError("INVALID_INPUT", "Expected a logical artifact name and page size between 1 and 1048576 UTF-8 bytes");
    }
    const snapshot = this.load(manifestId);
    const artifact = snapshot.manifest.artifacts.find((item) => item.name === artifactName);
    if (!artifact) throw new EvidenceError("NOT_FOUND", "Artifact is not in this evidence manifest");
    const bytes = Buffer.from(snapshot.contents[artifactName]!, "utf8");
    const offset = cursor === undefined ? 0 : cursorOffset(cursor, manifestId, artifact, bytes);
    let end = Math.min(bytes.length, offset + limit);
    while (end > offset && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    // A budget below one code point still makes progress by returning that
    // complete code point (at most four bytes, even with a one-byte budget).
    if (end === offset && end < bytes.length) {
      end++;
      while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end++;
    }
    const done = end === bytes.length;
    return {
      manifestId, artifactName, sha256: artifact.sha256,
      content: bytes.subarray(offset, end).toString("utf8"), offset, done,
      nextCursor: done ? null : cursorFor({ version: 1, manifestId, artifactName, sha256: artifact.sha256, offset: end }),
    };
  }

  private assertDirectory(): void {
    const stat = lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(this.directory) !== this.directory) {
      throw new EvidenceError("CORRUPT", "Evidence runtime directory has changed");
    }
  }

  private filename(id: string): string {
    if (typeof id !== "string" || !HASH.test(id)) throw new EvidenceError("INVALID_INPUT", "Invalid evidence manifest ID");
    return path.join(this.directory, `${id}.json`);
  }

  private load(id: string): Snapshot {
    const file = this.filename(id);
    let raw: string;
    try {
      this.assertDirectory();
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new EvidenceError("CORRUPT", "Evidence snapshot is not a regular file");
      const encoded = readFileSync(file);
      raw = encoded.toString("utf8");
      if (!Buffer.from(raw, "utf8").equals(encoded)) throw new EvidenceError("CORRUPT", "Evidence snapshot contains invalid UTF-8");
    } catch (error) {
      if (error instanceof EvidenceError) throw error;
      if (object(error) && error.code === "ENOENT") throw new EvidenceError("NOT_FOUND", "Evidence snapshot was not found");
      throw new EvidenceError("IO_ERROR", "Could not read evidence snapshot");
    }
    try {
      const value: unknown = JSON.parse(raw);
      if (!object(value) || Object.keys(value).sort().join(",") !== "contents,integrity,manifest" || !object(value.manifest) || !object(value.contents) ||
          typeof value.integrity !== "string" || !HASH.test(value.integrity) ||
          value.integrity !== hash(canonical({ manifest: value.manifest, contents: value.contents }))) throw new Error("invalid snapshot shape or checksum");
      const manifest = value.manifest;
      if (Object.keys(manifest).sort().join(",") !== "artifacts,createdAt,id,identity,metadata,schemaVersion" ||
          manifest.schemaVersion !== 1 || manifest.id !== id || typeof manifest.createdAt !== "string" ||
          !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(manifest.createdAt) ||
          !Number.isFinite(Date.parse(manifest.createdAt)) || !Array.isArray(manifest.artifacts) || !object(manifest.metadata)) throw new Error("invalid manifest shape");
      validateIdentity(manifest.identity);
      canonical(value);
      const contents = value.contents;
      const names = Object.keys(contents).sort();
      if (names.length !== manifest.artifacts.length) throw new Error("artifact count mismatch");
      for (let index = 0; index < names.length; index++) {
        const name = names[index]!;
        const content = contents[name];
        const artifact: unknown = manifest.artifacts[index];
        if (!NAME.test(name) || typeof content !== "string" || !object(artifact) ||
            Object.keys(artifact).sort().join(",") !== "byteLength,name,sha256" || artifact.name !== name ||
            typeof artifact.sha256 !== "string" || !HASH.test(artifact.sha256) || !Number.isSafeInteger(artifact.byteLength)) throw new Error("invalid artifact descriptor");
        const bytes = Buffer.from(content, "utf8");
        if (artifact.byteLength !== bytes.length || artifact.sha256 !== hash(bytes)) throw new Error("artifact hash mismatch");
      }
      if (snapshotId(manifest as unknown as EvidenceManifest) !== id) throw new Error("manifest hash mismatch");
      return value as unknown as Snapshot;
    } catch {
      throw new EvidenceError("CORRUPT", "Evidence snapshot is corrupt or has an unsupported schema; refusing partial evidence");
    }
  }
}

/**
 * Best-effort removal of known token formats, NOT a complete secrecy boundary.
 * Callers must exclude secret files, raw private conversations and runtime logs
 * before collecting evidence; unknown secrets cannot be recognized by regex.
 */
export function redactSensitiveText(text: string): string {
  return text
    .replace(/\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{30,})\b/g, "[REDACTED]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[REDACTED]")
    .replace(/(\b(?:access_token|refresh_token|id_token|api_key|apikey|client_secret|password)\b["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s&,;\r\n]+)/gi, "$1[REDACTED]");
}
