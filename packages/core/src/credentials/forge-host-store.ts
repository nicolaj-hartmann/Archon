/**
 * Install-wide store of one encrypted credential per forge host, as a JSON file
 * at `getForgeHostsPath()` (`forge-hosts.json` under the Archon home).
 *
 * The token value never appears in the file, in a log line, or in an error
 * message. Writes are serialized and atomically replaced (tmp + rename in the
 * target's directory). Save and delete pass every non-target entry's ciphertext
 * through byte-identical, so a credential encrypted under a different key
 * survives a save untouched. Reads degrade: an unreadable document or an
 * undecryptable entry yields an empty/omitted result plus one warn naming the
 * host — never the token or its ciphertext. Callers pass `normalizeHost`-ed
 * keys; the store does not normalize.
 */
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getForgeHostsPath } from '@archon/paths/archon-paths';
import { createLogger } from '@archon/paths/logger';
import { decryptToken, encryptToken, getEncryptionKey } from '../utils/token-crypto';

/** Host metadata as the store reports it — no credential material. */
export interface ForgeHostMeta {
  host: string;
  created_at: string;
  updated_at: string;
}

export interface SaveForgeHostOptions {
  /** Injectable clock (ISO-8601 string). */
  now?: () => string;
  /** Test seam: called after the tmp file is fully written, before the rename. */
  beforeRename?: (tmpPath: string) => void;
}

/**
 * The store file exists but cannot be read and parsed as a JSON object. Save
 * and delete refuse with this rather than overwrite or drop entries they
 * cannot see.
 */
export class ForgeHostsFileUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForgeHostsFileUnreadableError';
  }
}

type Document = Record<string, unknown>;

function isRecord(value: unknown): value is Document {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger). */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('forge-host-store');
  return cachedLog;
}

/** One warn per distinct unreadable state per process (path-scoped). */
const warnedDocuments = new Set<string>();
function warnUnreadableDocument(path: string, raw: string | undefined): void {
  const state = raw === undefined ? 'fs-error' : createHash('sha256').update(raw).digest('hex');
  const id = `${path}::${state}`;
  if (warnedDocuments.has(id)) return;
  warnedDocuments.add(id);
  getLog().warn({ path }, 'forge_hosts_store_unreadable');
}

const warnedEntries = new Set<string>();
function warnUndecryptableEntry(path: string, host: string, ciphertext: string): void {
  const id = `${path}::${host}::${createHash('sha256').update(ciphertext).digest('hex')}`;
  if (warnedEntries.has(id)) return;
  warnedEntries.add(id);
  getLog().warn({ path, host }, 'forge_host_credential_undecryptable');
}

function unreadableDocumentMessage(path: string): string {
  return (
    `The forge host credential store at ${path} cannot be read and parsed as a JSON object. ` +
    'Repair or delete the file, then retry (stored host credentials will be lost).'
  );
}

/** Read the raw file; ENOENT and other read failures are distinguished so the two call sites can degrade or refuse. */
function readRawDocument(
  path: string
): { status: 'missing' } | { status: 'ok'; raw: string } | { status: 'failed' } {
  try {
    return { status: 'ok', raw: readFileSync(path, 'utf8') };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { status: 'missing' }
      : { status: 'failed' };
  }
}

/**
 * Read the document for a write; refuses when the file cannot be fully read
 * and parsed.
 */
function readDocumentForWrite(path: string): Document {
  const raw = readRawDocument(path);
  if (raw.status === 'missing') return {}; // fresh start
  if (raw.status === 'failed') {
    warnUnreadableDocument(path, undefined);
    throw new ForgeHostsFileUnreadableError(unreadableDocumentMessage(path));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.raw);
  } catch {
    warnUnreadableDocument(path, raw.raw);
    throw new ForgeHostsFileUnreadableError(unreadableDocumentMessage(path));
  }
  if (!isRecord(parsed)) {
    warnUnreadableDocument(path, raw.raw);
    throw new ForgeHostsFileUnreadableError(unreadableDocumentMessage(path));
  }
  return parsed;
}

/** Read the document for a degraded read: unreadable → empty, one warn. */
function readDocumentForRead(path: string): Document {
  const raw = readRawDocument(path);
  if (raw.status !== 'ok') {
    if (raw.status === 'failed') warnUnreadableDocument(path, undefined);
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw.raw);
    if (!isRecord(parsed)) {
      warnUnreadableDocument(path, raw.raw);
      return {};
    }
    return parsed;
  } catch {
    warnUnreadableDocument(path, raw.raw);
    return {};
  }
}

/** Atomic replace: tmp file in the target's directory, then rename over. */
function writeDocumentAtomic(
  path: string,
  doc: Document,
  beforeRename?: (tmpPath: string) => void
): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(tmpPath, 0o600); // writeFileSync's mode is diluted by umask; enforce explicitly
  } catch {
    /* non-fatal on Windows / filesystems without POSIX perms */
  }
  beforeRename?.(tmpPath);
  renameSync(tmpPath, path);
}

let writeChain: Promise<unknown> = Promise.resolve();

/** Serialize save/delete so no write loses another's entry. */
function serializeWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = writeChain.then(task, task);
  writeChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * Upsert one host's credential; other entries' ciphertexts pass through
 * unchanged.
 */
export async function saveForgeHost(
  host: string,
  token: string,
  options: SaveForgeHostOptions = {}
): Promise<void> {
  await serializeWrite(async () => {
    const path = getForgeHostsPath();
    const doc = readDocumentForWrite(path);
    const now = options.now?.() ?? new Date().toISOString();
    const previous = isRecord(doc[host]) ? doc[host] : undefined;
    doc[host] = {
      token: encryptToken(token, getEncryptionKey()),
      created_at: typeof previous?.created_at === 'string' ? previous.created_at : now,
      updated_at: now,
    };
    writeDocumentAtomic(path, doc, options.beforeRename);
  });
}

/** Remove one host's credential. Idempotent: an absent host is a no-op. */
export async function deleteForgeHost(host: string): Promise<void> {
  await serializeWrite(async () => {
    const path = getForgeHostsPath();
    const doc = readDocumentForWrite(path);
    if (!(host in doc)) return;
    const rest: Document = {};
    for (const [key, value] of Object.entries(doc)) {
      if (key !== host) rest[key] = value;
    }
    writeDocumentAtomic(path, rest);
  });
}

/** The decrypted host → token map; undecryptable entries are omitted with one warn. */
export async function getForgeHostCredentials(): Promise<Map<string, string>> {
  const path = getForgeHostsPath();
  const doc = readDocumentForRead(path);
  const entries = Object.entries(doc);
  if (entries.length === 0) return new Map();
  const key = getEncryptionKey();
  const credentials = new Map<string, string>();
  for (const [host, entry] of entries) {
    const ciphertext = isRecord(entry) ? entry.token : undefined;
    if (typeof ciphertext !== 'string') continue;
    try {
      credentials.set(host, decryptToken(ciphertext, key));
    } catch {
      warnUndecryptableEntry(path, host, ciphertext);
    }
  }
  return credentials;
}

/**
 * Metadata for every stored host — never a token or ciphertext; undecryptable
 * entries still list.
 */
export async function listForgeHosts(): Promise<ForgeHostMeta[]> {
  const doc = readDocumentForRead(getForgeHostsPath());
  return Object.entries(doc).map(([host, entry]) => ({
    host,
    created_at: isRecord(entry) && typeof entry.created_at === 'string' ? entry.created_at : '',
    updated_at: isRecord(entry) && typeof entry.updated_at === 'string' ? entry.updated_at : '',
  }));
}
