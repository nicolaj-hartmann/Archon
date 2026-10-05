import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginDiscoveryError, discoverPlugins } from '@archon/forge/discovery';
import { dispatchForge } from '@archon/forge/dispatch';
import type { ForgeRequest } from '@archon/forge/operations';
import { removeTempTree } from '@archon/paths/test-utils';

const fixtureChild = join(import.meta.dir, 'fixtures', 'fixture-child.ts');
const fingerprint = (value: string): string => createHash('sha256').update(value).digest('hex');
const CORE_TOKEN = 'core-ci-rotate-me';
const LEVIOR_TOKEN = 'levior-rotate-me';

/**
 * One plugin, two hosts, two per-host token vars. This is the configuration the
 * gitea community tests run against: every host maps to the same `gitea` plugin
 * but a distinct `token_env`.
 */
const hostMappings = {
  'code.core.ci': { plugin: 'gitea', token_env: 'CODE_CORE_CI_TOKEN' },
  'code.levior.io': { plugin: 'gitea', token_env: 'CODE_LEVIOR_IO_TOKEN' },
};

function giteaConfig(reportPath: string) {
  return {
    plugins: [
      {
        plugin: 'gitea',
        command: process.execPath,
        args: [fixtureChild, '--report', reportPath],
      },
    ],
    hosts: hostMappings,
    scanPath: false,
  };
}

const coreRequest = {
  operationId: 'core-op',
  op: 'checks.state',
  ref: { repo: { host: 'code.core.ci', path: 'o/r' }, number: 42 },
} satisfies ForgeRequest;

const root = await mkdtemp(join(tmpdir(), 'forge-gitea-dispatch-'));
afterAll(async () => {
  await removeTempTree(root);
});

describe('forge-gitea dispatch', () => {
  test('each host maps to its own token_env and the child sees only ARCHON_FORGE_TOKEN', async () => {
    const report = join(root, 'isolated.json');
    const discovery = await discoverPlugins({
      config: giteaConfig(report),
      env: { ...process.env },
    });
    const result = await dispatchForge(coreRequest, {
      discovery,
      env: { ...process.env, CODE_CORE_CI_TOKEN: CORE_TOKEN },
    });
    expect(result.response).toMatchObject({ ok: true, result: { op: 'checks.state' } });
    expect(result.plugin).toEqual({ name: 'gitea', version: '1' });
    // The child observed its own environment: the injected token's fingerprint,
    // and null for both raw host variables — SAFE_ENV never passes them through.
    expect(JSON.parse(readFileSync(report, 'utf8'))).toEqual({
      archonFingerprint: fingerprint(CORE_TOKEN),
      coreCi: null,
      levior: null,
    });
  });

  test('the other host token alone leaves code.core.ci without a credential', async () => {
    const report = join(root, 'other-host.json');
    const discovery = await discoverPlugins({
      config: giteaConfig(report),
      env: { ...process.env },
    });
    const result = await dispatchForge(coreRequest, {
      discovery,
      env: { ...process.env, CODE_LEVIOR_IO_TOKEN: LEVIOR_TOKEN },
    });
    expect(result.response).toMatchObject({ ok: false, error: { kind: 'no_credential' } });
    if (!result.response.ok) expect(result.response.error.message).toContain('CODE_CORE_CI_TOKEN');
  });

  test('two discovered plugins named gitea take down every host, including unclaimed ones', async () => {
    const config = {
      plugins: [
        { plugin: 'gitea', command: process.execPath, args: [fixtureChild] },
        // A second candidate the operator would get by symlinking the same
        // executable under a different name: distinct args, same plugin name.
        {
          plugin: 'gitea',
          command: process.execPath,
          args: [fixtureChild, '--report', join(root, 'duplicate.json')],
        },
      ],
      hosts: hostMappings,
      scanPath: false,
    };
    try {
      await discoverPlugins({ config, env: { ...process.env } });
      throw new Error('expected duplicate discovery');
    } catch (error) {
      expect(error).toBeInstanceOf(PluginDiscoveryError);
      expect((error as PluginDiscoveryError).kind).toBe('duplicate_host');
    }
    const result = await dispatchForge(
      {
        operationId: 'duplicate-github',
        op: 'checks.state',
        ref: { repo: { host: 'github.com', path: 'a/b' }, number: 1 },
      } satisfies ForgeRequest,
      { config, env: { ...process.env } }
    );
    expect(result.response).toMatchObject({ ok: false, error: { kind: 'duplicate_host' } });
  });

  test('an unset per-host token fails no_credential without spawning the plugin', async () => {
    const report = join(root, 'never-spawned.json');
    const discovery = await discoverPlugins({
      config: giteaConfig(report),
      env: { ...process.env },
    });
    const result = await dispatchForge(coreRequest, { discovery, env: { ...process.env } });
    expect(result.response).toMatchObject({ ok: false, error: { kind: 'no_credential' } });
    if (!result.response.ok) expect(result.response.error.message).toContain('CODE_CORE_CI_TOKEN');
    // The metadata handshake spawns the child; the op must not. The report file
    // is written only in the op branch.
    expect(existsSync(report)).toBe(false);
  });
});
