/**
 * TDD spec (plan #14, tests 1–6) — the forge-host credential store.
 *
 * The store is a JSON file at $ARCHON_HOME/forge-hosts.json (getForgeHostsPath)
 * holding one entry per normalized host: `{ token: <encrypted>, created_at,
 * updated_at }`. Tokens are encrypted with the shared local key
 * (token-crypto). Every read is degraded-safe: an unreadable document or a
 * credential encrypted under a different key yields an empty/omitted result
 * plus exactly one warn log line that names the host (or the store file) and
 * never a token value or ciphertext. Saves are serialized (no lost entries)
 * and atomically replaced (the target holds a whole document at all times).
 *
 * No real network I/O; all expectations are hand-written literals.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getForgeHostsPath } from '@archon/paths/archon-paths';
import { captureLogLines, trackTempRoots } from '@archon/paths/test-utils';
import { clearLocalKeyCache } from '../utils/token-crypto';
import {
  deleteForgeHost,
  ForgeHostsFileUnreadableError,
  getForgeHostCredentials,
  listForgeHosts,
  saveForgeHost,
} from './forge-host-store';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const NOW_1 = () => '2025-01-01T00:00:00Z';
const NOW_2 = () => '2025-02-02T00:00:00Z';

let tmpDir: string;
let origKey: string | undefined;
let origHome: string | undefined;
const trackTempRoot = trackTempRoots();

function storePath(): string {
  return getForgeHostsPath();
}

beforeEach(() => {
  origKey = process.env.TOKEN_ENCRYPTION_KEY;
  origHome = process.env.ARCHON_HOME;
  tmpDir = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-forge-host-store-')));
  process.env.ARCHON_HOME = tmpDir;
  process.env.TOKEN_ENCRYPTION_KEY = KEY_A;
  clearLocalKeyCache();
});

afterEach(() => {
  if (origKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
  else process.env.TOKEN_ENCRYPTION_KEY = origKey;
  if (origHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = origHome;
  clearLocalKeyCache();
});

describe('saveForgeHost / getForgeHostCredentials / listForgeHosts', () => {
  test('saves the credential encrypted and round-trips it', async () => {
    await saveForgeHost('code.core.ci', 'tok-abc-123', { now: NOW_1 });

    const raw = readFileSync(storePath(), 'utf8');
    expect(raw).toContain('code.core.ci');
    expect(raw).not.toContain('tok-abc-123');
    // 0600 — the store holds credential material (mode bits are not honored on win32).
    if (process.platform !== 'win32') {
      expect(statSync(storePath()).mode & 0o777).toBe(0o600);
    }

    expect(await getForgeHostCredentials()).toEqual(new Map([['code.core.ci', 'tok-abc-123']]));

    const hosts = await listForgeHosts();
    expect(hosts).toEqual([
      {
        host: 'code.core.ci',
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      },
    ]);
    expect(JSON.stringify(hosts)).not.toContain('tok-abc-123');
  });

  test('upserts one host: one entry, latest credential, created_at preserved / updated_at moved', async () => {
    await saveForgeHost('code.core.ci', 'tok-first', { now: NOW_1 });
    await saveForgeHost('code.core.ci', 'tok-second', { now: NOW_2 });

    const doc = JSON.parse(readFileSync(storePath(), 'utf8')) as Record<
      string,
      { token: string; created_at: string; updated_at: string }
    >;
    expect(Object.keys(doc)).toEqual(['code.core.ci']);

    expect(await getForgeHostCredentials()).toEqual(new Map([['code.core.ci', 'tok-second']]));

    const [entry] = await listForgeHosts();
    expect(entry.created_at).toBe('2025-01-01T00:00:00Z');
    expect(entry.updated_at).toBe('2025-02-02T00:00:00Z');
  });

  test('deleteForgeHost is idempotent', async () => {
    await saveForgeHost('code.core.ci', 'tok-first', { now: NOW_1 });

    await deleteForgeHost('code.core.ci');
    await deleteForgeHost('code.core.ci'); // deleting again must not throw

    expect(await listForgeHosts()).toEqual([]);
    expect(await getForgeHostCredentials()).toEqual(new Map());
  });

  test('unreadable document: empty reads, exactly one warn naming forge-hosts, save rejects, file untouched', async () => {
    await saveForgeHost('real.example', 'tok-real', { now: NOW_1 });
    writeFileSync(storePath(), '{not json');

    const captured = captureLogLines();
    try {
      expect(await getForgeHostCredentials()).toEqual(new Map());
      expect(await listForgeHosts()).toEqual([]);

      const warns = captured.lines.filter(
        line => line.level === 40 && JSON.stringify(line).includes('forge-hosts')
      );
      expect(warns).toHaveLength(1);
      // No token value or ciphertext in the warn.
      expect(JSON.stringify(warns[0])).not.toContain('tok-real');
      expect(JSON.stringify(warns[0])).not.toContain('{not json');

      await expect(saveForgeHost('other.example', 'tok-other', { now: NOW_2 })).rejects.toThrow(
        ForgeHostsFileUnreadableError
      );

      expect(readFileSync(storePath(), 'utf8')).toBe('{not json');
    } finally {
      captured.restore();
    }
  });

  test('credential encrypted under a different key is omitted: warn names the host, file passes the ciphertext through byte-identical', async () => {
    await saveForgeHost('a.example', 'tok-a-real', { now: NOW_1 });
    const before = JSON.parse(readFileSync(storePath(), 'utf8')) as Record<
      string,
      { token: string }
    >;
    const ciphertextA = before['a.example'].token;

    process.env.TOKEN_ENCRYPTION_KEY = KEY_B;
    clearLocalKeyCache();

    const captured = captureLogLines();
    try {
      expect(await getForgeHostCredentials()).toEqual(new Map());

      const warns = captured.lines.filter(
        line => line.level === 40 && JSON.stringify(line).includes('a.example')
      );
      expect(warns).toHaveLength(1);
      expect(JSON.stringify(warns[0])).not.toContain('tok-a-real');
      expect(JSON.stringify(warns[0])).not.toContain(ciphertextA);

      // A save under the current key still succeeds; the unreadable entry
      // passes through untouched.
      await saveForgeHost('b.example', 'tok-b-new', { now: NOW_2 });
      const after = JSON.parse(readFileSync(storePath(), 'utf8')) as Record<
        string,
        { token: string }
      >;
      expect(after['a.example'].token).toBe(ciphertextA);
      expect(await getForgeHostCredentials()).toEqual(new Map([['b.example', 'tok-b-new']]));
    } finally {
      captured.restore();
    }
  });

  test('concurrent saves are serialized — no lost entries', async () => {
    await Promise.all([
      saveForgeHost('a.example', 'tok-a', { now: NOW_1 }),
      saveForgeHost('b.example', 'tok-b', { now: NOW_2 }),
    ]);

    const hosts = (await listForgeHosts()).map(h => h.host).sort();
    expect(hosts).toEqual(['a.example', 'b.example']);
    expect(await getForgeHostCredentials()).toEqual(
      new Map([
        ['a.example', 'tok-a'],
        ['b.example', 'tok-b'],
      ])
    );
  });

  test('write is atomic: target holds the whole old document until the rename; afterwards the whole new document; no *.tmp residue', async () => {
    await saveForgeHost('old.example', 'tok-old', { now: NOW_1 });
    const preDoc = JSON.parse(readFileSync(storePath(), 'utf8'));

    let tmpDuringWrite: string | undefined;
    await saveForgeHost('new.example', 'tok-new', {
      now: NOW_2,
      beforeRename: tmp => {
        tmpDuringWrite = tmp;
        // The target still holds the whole old document — no partial content.
        expect(JSON.parse(readFileSync(storePath(), 'utf8'))).toEqual(preDoc);
        expect(
          (JSON.parse(readFileSync(storePath(), 'utf8')) as Record<string, unknown>)['new.example']
        ).toBeUndefined();
        // The tmp file holds the whole new document.
        expect(JSON.parse(readFileSync(tmp, 'utf8'))['new.example']).toBeDefined();
      },
    });

    const postDoc = JSON.parse(readFileSync(storePath(), 'utf8')) as Record<string, unknown>;
    expect(postDoc['new.example']).toBeDefined();
    expect(postDoc['old.example']).toEqual(preDoc['old.example']);

    expect(tmpDuringWrite).toBeDefined();
    expect(existsSync(tmpDuringWrite!)).toBe(false);
    expect(readdirSync(dirname(storePath())).filter(f => f.endsWith('.tmp'))).toEqual([]);
  });
});
