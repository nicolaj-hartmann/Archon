import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { forgeManifestSchema, forgeReleaseAsset } from '@archon/plugin-manifest';

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..', '..');
const manifestPath = join(REPO_ROOT, 'plugins', 'forge-gitea', 'archon-plugin.json');

describe('forge-gitea manifest and release asset naming', () => {
  test('the shipped manifest parses through forgeManifestSchema', () => {
    const raw: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const manifest = forgeManifestSchema.parse(raw);
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      kind: 'forge',
      name: 'forge-gitea',
      executable: 'archon-forge-gitea',
    });
  });

  test('release asset names match what installForge requests for this executable', () => {
    expect(forgeReleaseAsset('archon-forge-gitea', 'bun-linux-x64')).toBe(
      'archon-forge-gitea-linux-x64'
    );
    expect(forgeReleaseAsset('archon-forge-gitea', 'bun-windows-x64')).toBe(
      'archon-forge-gitea-windows-x64.exe'
    );
  });
});
