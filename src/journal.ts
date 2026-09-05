import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export type JournalRecord = {
  key: string;
  status: "pending" | "succeeded" | "failed" | "uncertain";
  payload_hash: string;
  result?: unknown;
  /** A fixed diagnostic, never the operation's potentially sensitive message. */
  error?: string;
};

export class JournalError extends Error {
  constructor(readonly code: "INVALID_INPUT" | "CONFLICT" | "UNCERTAIN" | "FAILED" | "CORRUPT" | "IO_ERROR", message: string) {
    super(message);
    this.name = "JournalError";
  }
}

/** Use only when the caller can prove the operation had no external effect. */
export class JournalDefinitiveError extends Error {
  constructor() {
    super("Operation was definitively rejected before any external effect");
    this.name = "JournalDefinitiveError";
  }
}

type JournalDocument = { schemaVersion: 1; records: JournalRecord[]; checksum: string };
const HASH = /^[a-f0-9]{64}$/;
const UNCERTAIN = "Operation outcome is uncertain; reconcile before issuing another mutation";
const FAILED = "Operation was definitively rejected before any external effect";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Canonical JSON rejects lossy values and never evaluates accessors/toJSON. */
function canonical(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    if (Buffer.from(value, "utf8").toString("utf8") !== value) throw new Error("Invalid Unicode");
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== "object" || value === null || ancestors.has(value)) throw new Error("Invalid JSON");
  if (Object.getOwnPropertySymbols(value).length > 0) throw new Error("Invalid JSON symbol");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertyNames(value).length !== value.length + 1) throw new Error("Invalid JSON array");
      const entries: string[] = [];
      for (let index = 0; index < value.length; index++) {
        const property = Object.getOwnPropertyDescriptor(value, String(index));
        if (!property || !("value" in property) || !property.enumerable) throw new Error("Invalid JSON array");
        entries.push(canonical(property.value, ancestors));
      }
      return `[${entries.join(",")}]`;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error("Invalid JSON object");
    const entries: string[] = [];
    for (const key of Object.getOwnPropertyNames(value).sort()) {
      const property = Object.getOwnPropertyDescriptor(value, key)!;
      if (!("value" in property) || !property.enumerable) throw new Error("Invalid JSON property");
      entries.push(`${canonical(key, ancestors)}:${canonical(property.value, ancestors)}`);
    }
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function clone<T>(value: T): T {
  return JSON.parse(canonical(value)) as T;
}

function validKey(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256 && Buffer.from(value, "utf8").toString("utf8") === value;
}

function validateRecord(record: unknown): asserts record is JournalRecord {
  if (!isObject(record) || !validKey(record.key) || typeof record.payload_hash !== "string" || !HASH.test(record.payload_hash)) throw new Error("Invalid record");
  const keys = Object.keys(record).sort().join(",");
  if (record.status === "pending") {
    if (keys !== "key,payload_hash,status") throw new Error("Invalid pending record");
  } else if (record.status === "succeeded") {
    if (keys !== "key,payload_hash,result,status") throw new Error("Invalid successful record");
  } else if (record.status === "failed" || record.status === "uncertain") {
    if (keys !== "error,key,payload_hash,status" || record.error !== (record.status === "failed" ? FAILED : UNCERTAIN)) throw new Error("Invalid error record");
  } else throw new Error("Invalid record status");
}

/**
 * Durable, fail-closed deduplication for mutations. The server must hold its
 * runtime single-writer lock before creating this journal. A key is scoped to
 * the entire journal; include the operation name in its canonical payload.
 * State belongs in an ACL-protected local runtime, never a public artifact.
 */
export class IdempotencyJournal {
  private readonly filePath: string;
  private readonly directory: string;
  private readonly records = new Map<string, JournalRecord>();
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(filePath: string) {
    if (typeof filePath !== "string" || !filePath.trim()) throw new JournalError("INVALID_INPUT", "A journal file path is required");
    try {
      const requested = path.resolve(filePath);
      const parent = path.dirname(requested);
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      if (!lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink()) throw new Error("Invalid journal directory");
      this.directory = realpathSync(parent);
      this.filePath = path.join(this.directory, path.basename(requested));
    } catch {
      throw new JournalError("IO_ERROR", "Cannot prepare the journal runtime directory");
    }
    this.load();
    let recovered = false;
    for (const record of this.records.values()) {
      if (record.status === "pending") {
        this.records.set(record.key, { key: record.key, status: "uncertain", payload_hash: record.payload_hash, error: UNCERTAIN });
        recovered = true;
      }
    }
    if (recovered) this.persist();
  }

  list(): JournalRecord[] {
    return clone([...this.records.values()]);
  }

  execute<T>(key: string, payload: unknown, operation: () => T | Promise<T>): Promise<T> {
    let payloadHash: string;
    try {
      if (!validKey(key) || typeof operation !== "function") throw new Error("Invalid request");
      payloadHash = hash(canonical(payload));
    } catch {
      return Promise.reject(new JournalError("INVALID_INPUT", "Idempotency requires a nonempty key and a lossless JSON payload"));
    }

    const existing = this.records.get(key);
    if (existing) {
      if (existing.payload_hash !== payloadHash) return Promise.reject(new JournalError("CONFLICT", "Idempotency key already belongs to a different request"));
      const pending = this.inFlight.get(key);
      if (pending) return pending.then((result) => clone(result as T));
      if (existing.status === "succeeded") return Promise.resolve(clone(existing.result as T));
      if (existing.status === "failed") return Promise.reject(new JournalError("FAILED", FAILED));
      return Promise.reject(new JournalError("UNCERTAIN", UNCERTAIN));
    }

    this.records.set(key, { key, status: "pending", payload_hash: payloadHash });
    try {
      this.persist();
    } catch {
      // A failed write can still have reached disk. Never dispatch or permit a
      // same-process retry against a possibly persisted pending submission.
      this.markUncertain(key, payloadHash);
      return Promise.reject(new JournalError("IO_ERROR", "Could not persist the submission; operation was not dispatched"));
    }

    // Schedule after registering the promise so re-entrant/concurrent callers
    // see the same operation, even when the implementation returns immediately.
    const promise = Promise.resolve().then(async () => {
      let result: T;
      try {
        result = await operation();
      } catch (error) {
        if (error instanceof JournalDefinitiveError) {
          this.records.set(key, { key, status: "failed", payload_hash: payloadHash, error: FAILED });
          try {
            this.persist();
          } catch {
            this.markUncertain(key, payloadHash);
            throw new JournalError("UNCERTAIN", UNCERTAIN);
          }
          throw new JournalError("FAILED", FAILED);
        }
        this.markUncertain(key, payloadHash);
        throw new JournalError("UNCERTAIN", UNCERTAIN);
      }

      let ownedResult: T;
      try {
        ownedResult = clone(result);
        this.records.set(key, { key, status: "succeeded", payload_hash: payloadHash, result: ownedResult });
        this.persist();
      } catch {
        // The side effect may have succeeded even if serialization or storage
        // failed. Never call it a failed operation that is safe to repeat.
        this.markUncertain(key, payloadHash);
        throw new JournalError("UNCERTAIN", UNCERTAIN);
      }
      return ownedResult;
    });
    this.inFlight.set(key, promise);
    void promise.finally(() => { this.inFlight.delete(key); }).catch(() => {});
    return promise.then((result) => clone(result));
  }

  private markUncertain(key: string, payloadHash: string): void {
    this.records.set(key, { key, status: "uncertain", payload_hash: payloadHash, error: UNCERTAIN });
    try { this.persist(); } catch { /* The earlier durable pending record remains fail-closed. */ }
  }

  private assertDirectory(): void {
    const directory = lstatSync(this.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink() || realpathSync(this.directory) !== this.directory) throw new Error("Journal directory changed");
  }

  private load(): void {
    let text: string;
    try {
      this.assertDirectory();
      let stat;
      try { stat = lstatSync(this.filePath); } catch (error) {
        if (isObject(error) && error.code === "ENOENT") return;
        throw error;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) throw new JournalError("CORRUPT", "Journal is not a regular state file");
      text = readFileSync(this.filePath, "utf8");
    } catch (error) {
      if (error instanceof JournalError) throw error;
      throw new JournalError("IO_ERROR", "Cannot read the journal state");
    }
    try {
      const value: unknown = JSON.parse(text);
      if (!isObject(value) || Object.keys(value).sort().join(",") !== "checksum,records,schemaVersion" || value.schemaVersion !== 1 ||
          typeof value.checksum !== "string" || !HASH.test(value.checksum) || !Array.isArray(value.records)) throw new Error("Invalid document");
      const body = { schemaVersion: 1, records: value.records };
      if (hash(canonical(body)) !== value.checksum) throw new Error("Checksum mismatch");
      for (const record of value.records) {
        validateRecord(record);
        if (this.records.has(record.key)) throw new Error("Duplicate key");
        this.records.set(record.key, record);
      }
    } catch {
      throw new JournalError("CORRUPT", "Journal state is corrupt or unsupported; automatic replay is disabled");
    }
  }

  private persist(): void {
    const temporary = path.join(this.directory, `.journal-${process.pid}-${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    let temporaryCreated = false;
    try {
      this.assertDirectory();
      try {
        const stat = lstatSync(this.filePath);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Invalid state destination");
      } catch (error) {
        if (!isObject(error) || error.code !== "ENOENT") throw error;
      }
      const body = { schemaVersion: 1 as const, records: [...this.records.values()] };
      const document: JournalDocument = { ...body, checksum: hash(canonical(body)) };
      descriptor = openSync(temporary, "wx", 0o600);
      temporaryCreated = true;
      writeFileSync(descriptor, `${canonical(document)}\n`, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, this.filePath);
      temporaryCreated = false;
      // Windows does not support fsync on directory handles. NTFS uses the
      // fsynced temporary file and atomic rename; POSIX also syncs the entry.
      if (process.platform !== "win32") {
        const directoryHandle = openSync(this.directory, "r");
        try { fsyncSync(directoryHandle); } finally { closeSync(directoryHandle); }
      }
    } catch {
      throw new JournalError("IO_ERROR", "Cannot durably write the journal state");
    } finally {
      if (descriptor !== undefined) { try { closeSync(descriptor); } catch {} }
      if (temporaryCreated) { try { unlinkSync(temporary); } catch {} }
    }
  }
}
