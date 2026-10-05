import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { discoverPlugins } from './discovery';
import { dispatchForge } from './dispatch';

const fixture = join(import.meta.dir, 'fixtures', 'test-plugin.ts');
const fingerprintFixture = join(import.meta.dir, 'fixtures', 'token-fingerprint-plugin.ts');
// Hand-pinned SHA-256 digests of the fixture credentials (expected values, never
// recomputed from the delivered value at test time).
const ENV_VALUE_1_SHA256 = 'bad5280178f03c6ca65861049c2e63a1cf975d30129eea962be740486ea2ab91'; // sha256('env-value-1')
const STORED_VALUE_2_SHA256 = '03b412a22eeab396cec9e867f39d8f8e301fd091b970aba873eccfe2b5e70bbf'; // sha256('stored-value-2')

function fingerprintConfig(digestFile: string) {
  return {
    plugins: [
      {
        plugin: 'fingerprint',
        command: process.execPath,
        args: [
          fingerprintFixture,
          '--name',
          'fingerprint',
          '--host',
          'code.core.ci',
          '--digest-file',
          digestFile,
        ],
      },
    ],
    hosts: { 'code.core.ci': { plugin: 'fingerprint', token_env: 'FIXED_TOKEN' } },
    scanPath: false,
  };
}

function config(mode = 'ok') {
  return {
    plugins: [{ plugin: 'test', command: process.execPath, args: [fixture, '--mode', mode] }],
    scanPath: false,
  };
}

describe('forge plugin discovery and dispatch', () => {
  test('does not discover for an absent or local resolve target', async () => {
    const result = await dispatchForge(
      { operationId: 'local', op: 'resolve', remote: '/tmp/repo' },
      {
        config: { plugins: [{ plugin: 'test', command: '/definitely/missing' }], scanPath: false },
      }
    );
    expect(result.response).toEqual({
      operationId: 'local',
      ok: true,
      result: { op: 'resolve', value: { kind: 'none', forge: 'none' } },
    });
    expect(result.plugin).toBeNull();
  });

  test('performs metadata before an operation and preserves correlation in audit', async () => {
    const discovery = await discoverPlugins({ config: config() });
    const result = await dispatchForge(
      { operationId: 'resolve-ü', op: 'resolve', remote: 'git@forge.example:team/repo.git' },
      { discovery }
    );
    expect(result.response).toEqual({
      operationId: 'resolve-ü',
      ok: true,
      result: { op: 'resolve', value: { kind: 'none', forge: 'none' } },
    });
    expect(result.plugin).toEqual({ name: 'test', version: '1.0.0' });
    expect(result.audit.operationId).toBe('resolve-ü');
    expect(result.audit.result).toEqual({
      operationId: 'resolve-ü',
      ok: true,
      result: { op: 'resolve', value: { kind: 'none', forge: 'none' } },
    });
  });

  test('returns malformed stdout and exit classes as distinct protocol/process failures', async () => {
    const malformedDiscovery = await discoverPlugins({
      config: config('malformed'),
    });
    const malformed = await dispatchForge(
      { operationId: 'bad', op: 'resolve', remote: 'https://forge.example/a' },
      { discovery: malformedDiscovery }
    );
    expect(malformed.response).toMatchObject({ ok: false, error: { kind: 'invalid_response' } });

    const processDiscovery = await discoverPlugins({
      config: config('token-error'),
    });
    const failed = await dispatchForge(
      { operationId: 'failed', op: 'resolve', remote: 'https://forge.example/a' },
      { discovery: processDiscovery }
    );
    expect(failed.response).toMatchObject({
      ok: false,
      error: { kind: 'process_failed', exitCode: 7 },
    });
  });

  test('does not execute an undeclared operation', async () => {
    const discovery = await discoverPlugins({
      config: config('unsupported'),
    });
    const result = await dispatchForge(
      { operationId: 'unsupported', op: 'resolve', remote: 'https://forge.example/a' },
      { discovery }
    );
    expect(result.response).toMatchObject({ ok: false, error: { kind: 'unsupported_op' } });
  });

  test('rejects duplicate host claims', async () => {
    await expect(
      discoverPlugins({
        config: {
          plugins: [
            { plugin: 'test', command: process.execPath, args: [fixture] },
            { plugin: 'other', command: process.execPath, args: [fixture, '--name', 'other'] },
          ],
          scanPath: false,
        },
      })
    ).rejects.toThrow();
  });

  test('requires and remaps only a declared credential', async () => {
    const discovery = await discoverPlugins({
      config: config('token'),
      env: { ...process.env, TEST_FORGE_TOKEN: 'secret' },
    });
    const missing = await dispatchForge(
      {
        operationId: 'missing',
        op: 'checks.state',
        ref: { repo: { host: 'forge.example', path: 'a/b' }, number: 1 },
      },
      { discovery, env: {} }
    );
    expect(missing.response).toMatchObject({ ok: false, error: { kind: 'no_credential' } });
    const present = await dispatchForge(
      { operationId: 'present', op: 'resolve', remote: 'https://forge.example/a' },
      { discovery, env: { TEST_FORGE_TOKEN: 'secret' } }
    );
    expect(present.response.ok).toBe(true);
  });
});

test('does not accept a success response for a different operation', async () => {
  const discovery = await discoverPlugins({ config: config() });
  const result = await dispatchForge(
    {
      operationId: 'wrong-op',
      op: 'checks.state',
      ref: { repo: { host: 'forge.example', path: 'team/repo' }, number: 42 },
    },
    { discovery }
  );
  expect(result.response).toMatchObject({ ok: false, error: { kind: 'invalid_response' } });
});

test.each(['bad-protocol', 'bad-metadata'])('refuses %s before operation dispatch', async mode => {
  const result = await dispatchForge(
    { operationId: 'handshake', op: 'resolve', remote: 'https://forge.example/team/repo' },
    { config: config(mode) }
  );
  expect(result.response).toMatchObject({ ok: false, error: { kind: 'invalid_response' } });
});

test('refuses resolved identity that differs from the selected host', async () => {
  const discovery = await discoverPlugins({
    config: config('wrong-resolve'),
  });
  const result = await dispatchForge(
    { operationId: 'wrong-identity', op: 'resolve', remote: 'https://forge.example/a/b' },
    { discovery }
  );
  expect(result.response).toMatchObject({ ok: false, error: { kind: 'invalid_response' } });
  expect(result.audit.target).toBeNull();
});

// ── Stored host-credential fallback (plan #14, tests 7–11) ──────────────────────
//
// The child fingerprints the delivered ARCHON_FORGE_TOKEN by writing its
// SHA-256 hex digest to --digest-file; the test compares the digest against
// hand-pinned constants so the plaintext credential never enters stdout.

describe('dispatchForge hostCredentials option', () => {
  let tmpDir: string;
  let digestFile: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'archon-forge-dispatch-'));
    digestFile = join(tmpDir, 'digest.txt');
  });

  afterEach(async () => {
    await removeTempTree(tmpDir);
  });

  function resetDigest(): void {
    if (existsSync(digestFile)) unlinkSync(digestFile);
  }

  test('an env value for the host\u2019s credential name wins over the stored host credential', async () => {
    const discovery = await discoverPlugins({ config: fingerprintConfig(digestFile) });
    const result = await dispatchForge(
      { operationId: 'env-wins', op: 'resolve', remote: 'https://code.core.ci/team/repo' },
      {
        discovery,
        env: { FIXED_TOKEN: 'env-value-1' },
        hostCredentials: new Map([['code.core.ci', 'stored-value-2']]),
      }
    );
    expect(result.response.ok).toBe(true);
    expect(readFileSync(digestFile, 'utf8')).toBe(ENV_VALUE_1_SHA256);
  });

  test('when no env value is present, the stored host credential is delivered', async () => {
    const discovery = await discoverPlugins({ config: fingerprintConfig(digestFile) });
    const result = await dispatchForge(
      { operationId: 'stored-wins', op: 'resolve', remote: 'https://code.core.ci/team/repo' },
      {
        discovery,
        env: {},
        hostCredentials: new Map([['code.core.ci', 'stored-value-2']]),
      }
    );
    expect(result.response.ok).toBe(true);
    expect(readFileSync(digestFile, 'utf8')).toBe(STORED_VALUE_2_SHA256);
  });

  test('env presence is independent of the hostCredentials argument', async () => {
    for (const hostCredentials of [
      undefined,
      new Map<string, string>(),
      new Map<string, string>([['unrelated.example', 'tok-u']]),
    ]) {
      resetDigest();
      const discovery = await discoverPlugins({ config: fingerprintConfig(digestFile) });
      const result = await dispatchForge(
        { operationId: 'env-independent', op: 'resolve', remote: 'https://code.core.ci/team/repo' },
        { discovery, env: { FIXED_TOKEN: 'env-value-1' }, hostCredentials }
      );
      expect(result.response.ok).toBe(true);
      expect(readFileSync(digestFile, 'utf8')).toBe(ENV_VALUE_1_SHA256);
    }
  });

  test('no_credential names the env var; a stored credential for a different host is never delivered', async () => {
    const discovery = await discoverPlugins({
      config: {
        plugins: [
          {
            plugin: 'fingerprint',
            command: process.execPath,
            args: [fingerprintFixture, '--name', 'fingerprint', '--host', 'host-a'],
          },
          {
            plugin: 'fingerprint-b',
            command: process.execPath,
            args: [
              fingerprintFixture,
              '--name',
              'fingerprint-b',
              '--host',
              'host-b',
              '--token-env',
              'T_HOST_B',
              '--digest-file',
              digestFile,
            ],
          },
        ],
        scanPath: false,
      },
    });
    const result = await dispatchForge(
      {
        operationId: 'no-leak',
        op: 'checks.state',
        ref: { repo: { host: 'host-b', path: 'team/b' }, number: 1 },
      },
      { discovery, env: {}, hostCredentials: new Map([['host-a', 'tok-a']]) }
    );
    expect(result.response).toMatchObject({ ok: false, error: { kind: 'no_credential' } });
    expect(JSON.stringify(result.response)).toContain('T_HOST_B');
    // No child was launched for host-b, so the fingerprint file was never written
    // — in particular the host-a credential could not have reached a child process.
    expect(existsSync(digestFile)).toBe(false);
  });

  test('unclaimed host → no_plugin_for_host, with no credential read at all', async () => {
    const discovery = await discoverPlugins({
      config: {
        plugins: [
          {
            plugin: 'fingerprint',
            command: process.execPath,
            args: [fingerprintFixture, '--name', 'fingerprint', '--host', 'host-a'],
          },
        ],
        scanPath: false,
      },
    });
    const result = await dispatchForge(
      {
        operationId: 'no-select',
        op: 'checks.state',
        ref: { repo: { host: 'unclaimed.example', path: 'team/c' }, number: 1 },
      },
      { discovery, env: {}, hostCredentials: new Map([['unclaimed.example', 'tok-u']]) }
    );
    expect(result.response).toMatchObject({ ok: false, error: { kind: 'no_plugin_for_host' } });
    expect(JSON.stringify(result)).not.toContain('tok-u');
  });
});
