import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type OAuthStoredClient = { id: string; name: string; redirects: string[] };
export type OAuthStoredGrant = { id: string; clientId: string; expiresAt: number; rotations: number };
export type OAuthStoredToken = { grantId: string; expiresAt: number };
export type OAuthPersistentState = {
  schemaVersion: 1; issuer: string; writtenAt: number;
  clients: OAuthStoredClient[]; grants: OAuthStoredGrant[];
  accessTokens: [string, OAuthStoredToken][]; refreshTokens: [string, OAuthStoredToken][];
  usedRefresh: [string, OAuthStoredToken][]; usedCodes: [string, OAuthStoredToken][];
};
export interface OAuthStateStore {
  load(issuer: string, now: number): OAuthPersistentState | undefined;
  save(state: OAuthPersistentState): void;
}
export type OAuthStateCipher = { encrypt(plaintext: Buffer): Buffer; decrypt(ciphertext: Buffer): Buffer };
export class OAuthStateError extends Error {
  constructor(message = 'OAuth authorization state is unavailable; local recovery is required.') { super(message); this.name = 'OAuthStateError'; }
}

const MAX_BYTES = 4 * 1024 * 1024;
const CAPACITY = 32;
const ROTATIONS = 64;
const GRANT_MS = 8 * 60 * 60_000;
const ACCESS_MS = 10 * 60_000;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string) => Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
const time = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const opaque = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v) && Buffer.from(v, 'base64url').toString('base64url') === v;
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const samePath = (left: string, right: string) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;

function canonicalIssuer(value: string): boolean {
  try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value && !url.username && !url.password; } catch { return false; }
}
function redirect(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 512) return false;
  try {
    const url = new URL(value);
    return value === url.href && url.protocol === 'https:' && url.hostname === 'chatgpt.com' && !url.port && !url.username && !url.password && !url.search && !url.hash &&
      (url.pathname === '/connector_platform_oauth_redirect' || /^\/connector\/oauth\/[A-Za-z0-9_-]{1,128}$/.test(url.pathname));
  } catch { return false; }
}

/** Validate structure and security bindings before any restored authorization is usable. */
export function validateOAuthState(value: unknown, issuer: string, now: number): OAuthPersistentState {
  try {
    if (!canonicalIssuer(issuer) || !time(now) || !object(value) || !exact(value, 'schemaVersion,issuer,writtenAt,clients,grants,accessTokens,refreshTokens,usedRefresh,usedCodes') || value.schemaVersion !== 1 || value.issuer !== issuer || !time(value.writtenAt) || value.writtenAt > now) throw 0;
    if (!Array.isArray(value.clients) || value.clients.length > CAPACITY || !Array.isArray(value.grants) || value.grants.length > CAPACITY) throw 0;
    const clients = new Map<string, OAuthStoredClient>();
    for (const client of value.clients) {
      if (!object(client) || !exact(client, 'id,name,redirects') || !opaque(client.id) || typeof client.name !== 'string' || !client.name.trim() || client.name.length > 120 || /[\x00-\x1f\x7f]/.test(client.name) || !Array.isArray(client.redirects) || client.redirects.length < 1 || client.redirects.length > 4 || !client.redirects.every(redirect) || new Set(client.redirects).size !== client.redirects.length || clients.has(client.id)) throw 0;
      clients.set(client.id, client as OAuthStoredClient);
    }
    const grants = new Map<string, OAuthStoredGrant>();
    for (const grant of value.grants) {
      if (!object(grant) || !exact(grant, 'id,clientId,expiresAt,rotations') || !opaque(grant.id) || typeof grant.clientId !== 'string' || !clients.has(grant.clientId) || !time(grant.expiresAt) || grant.expiresAt > value.writtenAt + GRANT_MS || !time(grant.rotations) || grant.rotations > ROTATIONS || grants.has(grant.id)) throw 0;
      grants.set(grant.id, grant as OAuthStoredGrant);
    }
    const seen = new Set<string>();
    const counts = new Map<string, { refresh: number; used: number; code: number }>();
    for (const name of ['accessTokens', 'refreshTokens', 'usedRefresh', 'usedCodes'] as const) {
      const entries = value[name];
      const maximum = name === 'refreshTokens' || name === 'usedCodes' ? CAPACITY : CAPACITY * (ROTATIONS + 1);
      if (!Array.isArray(entries) || entries.length > maximum) throw 0;
      for (const entry of entries) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !/^[a-f0-9]{64}$/.test(entry[0]) || seen.has(entry[0]) || !object(entry[1]) || !exact(entry[1], 'grantId,expiresAt')) throw 0;
        seen.add(entry[0]);
        const ref = entry[1];
        const grant = typeof ref.grantId === 'string' ? grants.get(ref.grantId) : undefined;
        if (!grant || !time(ref.expiresAt) || ref.expiresAt > grant.expiresAt || (name === 'accessTokens' && ref.expiresAt > value.writtenAt + ACCESS_MS) || (name !== 'accessTokens' && ref.expiresAt !== grant.expiresAt)) throw 0;
        const count = counts.get(grant.id) ?? { refresh: 0, used: 0, code: 0 };
        if (name === 'refreshTokens') count.refresh++;
        if (name === 'usedRefresh') count.used++;
        if (name === 'usedCodes') count.code++;
        counts.set(grant.id, count);
      }
    }
    for (const grant of grants.values()) {
      const count = counts.get(grant.id);
      if (!count || count.refresh !== 1 || count.used !== grant.rotations || count.code !== 1) throw 0;
    }
    return JSON.parse(JSON.stringify(value)) as OAuthPersistentState;
  } catch { throw new OAuthStateError('OAuth state schema, issuer, clock or grant bindings are invalid; the original state was preserved.'); }
}

/** DPAPI CurrentUser: plaintext travels through anonymous process pipes only. */
export function windowsDpapiCipher(options: { shell?: string } = {}): OAuthStateCipher {
  if (process.platform !== 'win32') throw new OAuthStateError('Persistent OAuth requires Windows current-user DPAPI on this installation.');
  const shell = options.shell ?? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const run = (mode: 'Protect' | 'Unprotect', input: Buffer): Buffer => {
    try {
      const script = `$ErrorActionPreference='Stop'; try { Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $entropy=[Text.Encoding]::UTF8.GetBytes('AutoDev persistent OAuth v1'); $result=[Security.Cryptography.ProtectedData]::${mode}($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result)) } catch { [Console]::Error.Write('OAUTH_CIPHER_ERROR'); exit 1 }`;
      const encoded = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { input: input.toString('base64'), encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: MAX_BYTES * 2 });
      if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw 0;
      const result = Buffer.from(encoded, 'base64');
      if (result.length < 1 || result.length > MAX_BYTES + 4096 || result.toString('base64') !== encoded) throw 0;
      return result;
    } catch { throw new OAuthStateError('Windows OAuth encryption is unavailable; no plaintext authorization state was written.'); }
  };
  return { encrypt: value => run('Protect', value), decrypt: value => run('Unprotect', value) };
}

/**
 * Caller must own the gateway's single-writer runtime lease for this lifetime.
 * A persisted mutation fence prevents restart from replaying the previous
 * snapshot after an uncertain write. The fence contains no authorization data.
 * Hashes detect damage; DPAPI authenticates and encrypts the issuer-bound state.
 */
export class EncryptedOAuthStateStore implements OAuthStateStore {
  private readonly file: string;
  private readonly directory: string;
  private readonly pending: string;
  private readonly cipher: OAuthStateCipher;
  private baseline: string | undefined;
  private lastWritten = 0;
  private loaded = false;
  private poisoned = false;
  constructor(private readonly options: { filePath: string; issuer: string; cipher?: OAuthStateCipher }) {
    try {
      if (!canonicalIssuer(options.issuer)) throw 0;
      const requested = path.resolve(options.filePath);
      const parent = path.dirname(requested);
      this.directory = realpathSync.native(parent);
      if (!samePath(parent, this.directory) || !lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink()) throw 0;
      this.file = path.join(this.directory, path.basename(requested));
      this.pending = `${this.file}.pending`;
      this.cipher = options.cipher ?? windowsDpapiCipher();
    } catch { throw new OAuthStateError('Cannot prepare the physical OAuth state directory or cipher.'); }
  }

  load(issuer: string, now: number): OAuthPersistentState | undefined {
    try {
      if (this.loaded || this.poisoned || issuer !== this.options.issuer) throw 0;
      this.assertDirectory();
      try { lstatSync(this.pending); throw new OAuthStateError(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const raw = this.read();
      if (raw === undefined) { this.loaded = true; return; }
      const envelope: unknown = JSON.parse(raw.toString('utf8'));
      if (!object(envelope) || !exact(envelope, 'schemaVersion,ciphertext,checksum') || envelope.schemaVersion !== 1 || typeof envelope.ciphertext !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.ciphertext) || typeof envelope.checksum !== 'string') throw 0;
      const bytes = Buffer.from(envelope.ciphertext, 'base64');
      if (bytes.toString('base64') !== envelope.ciphertext || hash(bytes) !== envelope.checksum) throw 0;
      const plaintext = this.cipher.decrypt(bytes);
      let state: OAuthPersistentState;
      try {
        if (plaintext.length > MAX_BYTES) throw 0;
        state = validateOAuthState(JSON.parse(plaintext.toString('utf8')), issuer, now);
      } finally { plaintext.fill(0); }
      this.baseline = hash(raw);
      this.lastWritten = state.writtenAt;
      this.loaded = true;
      return state;
    } catch { this.poisoned = true; throw new OAuthStateError('OAuth state is corrupt, belongs to another issuer, or has an unresolved write; no state was replaced.'); }
  }

  save(state: OAuthPersistentState): void {
    let plaintext: Buffer | undefined;
    try {
      if (!this.loaded || this.poisoned || state.writtenAt < this.lastWritten) throw 0;
      validateOAuthState(state, this.options.issuer, state.writtenAt);
      this.assertDirectory();
      this.assertBaseline();
      this.writeExclusive(this.pending, Buffer.from('{"schemaVersion":1,"status":"pending"}\n'));
      plaintext = Buffer.from(JSON.stringify(state));
      if (plaintext.length > MAX_BYTES) throw 0;
      const bytes = this.cipher.encrypt(plaintext);
      if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_BYTES + 4096) throw 0;
      const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, ciphertext: bytes.toString('base64'), checksum: hash(bytes) }));
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      this.writeExclusive(temporary, payload);
      this.assertDirectory();
      this.assertBaseline();
      renameSync(temporary, this.file);
      this.baseline = hash(payload);
      unlinkSync(this.pending);
      this.lastWritten = state.writtenAt;
    } catch { this.poisoned = true; throw new OAuthStateError('OAuth state could not be committed; authorization is disabled until local recovery.'); }
    finally { plaintext?.fill(0); }
  }

  private assertDirectory(): void {
    if (!lstatSync(this.directory).isDirectory() || lstatSync(this.directory).isSymbolicLink() || !samePath(realpathSync.native(this.directory), this.directory)) throw 0;
  }
  private read(): Buffer | undefined {
    let item;
    try { item = lstatSync(this.file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (!item.isFile() || item.isSymbolicLink() || item.size < 1 || item.size > MAX_BYTES * 2) throw 0;
    return readFileSync(this.file);
  }
  private assertBaseline(): void {
    const current = this.read();
    if ((current === undefined ? undefined : hash(current)) !== this.baseline) throw 0;
  }
  private writeExclusive(file: string, value: Buffer): void {
    const descriptor = openSync(file, 'wx', 0o600);
    try { writeFileSync(descriptor, value); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  }
}
