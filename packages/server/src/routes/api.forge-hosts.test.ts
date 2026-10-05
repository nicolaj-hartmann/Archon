import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import { validationErrorHook } from './openapi-defaults';
import { makeListDashboardRunsMock, mockAllWorkflowModules } from '../test/workflow-mock-factories';

// ---------------------------------------------------------------------------
// Mock setup — must precede the dynamic import of ./api below. Exercises the
// install-wide forge-host routes (GET/PUT/DELETE /api/forge-hosts,
// POST /api/forge-hosts/test). Save and delete are bounded by the trusted
// forge.hosts list in the user's ~/.archon/config.yaml.
// ---------------------------------------------------------------------------

const noopLogger = () => ({
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(function (this: unknown) {
    return this;
  }),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
});

// --- Controllable web-auth module (../auth) ---
let authInstance: { api: { getSession: (args: unknown) => Promise<unknown> } } | null = null;
mock.module('../auth', () => ({
  getAuth: () => authInstance,
  isWebAuthEnabled: () => false,
  getSignupMode: () => 'disabled',
  isApiGateEnabled: () => false,
}));

// --- Identity resolution (X-Archon-User → user) ---
mock.module('@archon/core/db/users', () => ({
  findOrCreateUserByPlatformIdentity: mock(async (_platform: string, platformUserId: string) => ({
    id: `user-from-${platformUserId}`,
    display_name: null,
    email: null,
    role: 'admin' as const,
    created_at: new Date(),
    updated_at: new Date(),
  })),
}));

// --- Forge-host store surface (the unit under test, via mocked core) ---
type ForgeHostMeta = { host: string; created_at: string; updated_at: string };
let storeHosts: ForgeHostMeta[] = [];
const storeSaveCalls: { host: string; token: string }[] = [];
const storeDeleteCalls: string[] = [];
let storeSaveImpl: (host: string, token: string) => Promise<void> = async () => {};

class ForgeHostsFileUnreadableError extends Error {}

const mockStoreSave = mock(async (host: string, token: string) => {
  storeSaveCalls.push({ host, token });
  await storeSaveImpl(host, token);
});
const mockStoreList = mock(async (): Promise<ForgeHostMeta[]> => storeHosts);
const mockStoreCredentials = mock(async () => new Map<string, string>());
const mockStoreDelete = mock(async (host: string) => {
  storeDeleteCalls.push(host);
});

mock.module('@archon/core', () => ({
  handleMessage: mock(async () => {}),
  getDatabaseType: () => 'postgresql',
  loadConfig: mock(async () => ({})),
  cloneRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  registerRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  ConversationNotFoundError: class ConversationNotFoundError extends Error {},
  generateAndSetTitle: mock(async () => {}),
  resolveTitleRequest: mock(async () => ({ provider: 'claude', options: {} })),
  isPerUserGitHubEnabled: () => false,
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
  createLogger: noopLogger,
  // Forge-host store under test:
  saveForgeHost: mockStoreSave,
  listForgeHosts: mockStoreList,
  getForgeHostCredentials: mockStoreCredentials,
  deleteForgeHost: mockStoreDelete,
  ForgeHostsFileUnreadableError,
}));

// --- Trusted config (~/.archon/config.yaml) — the claim source for save/delete ---
let configDir: string;
let configPath: string;
function writeTrustedConfig(): void {
  writeFileSync(
    configPath,
    ['forge:', '  hosts:', '    code.core.ci: gitea', '    code.core.ci:3000: gitea', ''].join('\n')
  );
}
mock.module('@archon/paths', () => ({
  createLogger: noopLogger,
  getWorkflowFolderSearchPaths: mock(() => ['.archon/workflows']),
  getCommandFolderSearchPaths: mock(() => ['.archon/commands']),
  getBundledWorkflowsPath: mock(() => '/tmp/.archon-test-nonexistent/workflows'),
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
  getArchonHome: () => '/tmp/.archon',
  getRunArtifactsPath: (owner: string, repo: string, runId: string): string =>
    `/tmp/.archon/workspaces/${owner}/${repo}/artifacts/runs/${runId}`,
  getArchonConfigPath: () => configPath,
}));

mockAllWorkflowModules();

mock.module('@archon/git', () => ({
  removeWorktree: mock(async () => {}),
  toRepoPath: (p: string) => p,
  toWorktreePath: (p: string) => p,
}));

mock.module('@archon/core/db/conversations', () => ({
  listConversations: mock(async () => []),
  findConversationByPlatformId: mock(async () => null),
  getOrCreateConversation: mock(async () => ({ id: 'c', platform_conversation_id: 'web-x' })),
  softDeleteConversation: mock(async () => {}),
  updateConversationTitle: mock(async () => {}),
  getConversationById: mock(async () => null),
}));

mock.module('@archon/core/db/codebases', () => ({
  listCodebases: mock(async () => []),
  getCodebase: mock(async () => null),
  deleteCodebase: mock(async () => {}),
}));

mock.module('@archon/core/db/isolation-environments', () => ({
  listByCodebase: mock(async () => []),
  updateStatus: mock(async () => {}),
}));

mock.module('@archon/core/db/workflows', () => ({
  listWorkflowRuns: mock(async () => []),
  listDashboardRuns: makeListDashboardRunsMock(),
  getWorkflowRun: mock(async () => null),
  getWorkflowRunByWorkerPlatformId: mock(async () => null),
}));

mock.module('@archon/core/db/workflow-events', () => ({
  listWorkflowEvents: mock(async () => []),
  createWorkflowEvent: mock(async () => {}),
}));

mock.module('@archon/core/db/messages', () => ({
  addMessage: mock(async () => ({ id: 'm' })),
  listMessages: mock(async () => []),
}));

mock.module('@archon/core/utils/commands', () => ({
  findCommandFiles: mock(async () => []),
}));

// --- Connection probe (server-side fetch; exercised with a canned result) ---
const probeCalls: { host: string; token: string }[] = [];
let probeResult: { ok: boolean; login?: string; kind?: string; message?: string } = {
  ok: true,
  login: 'Hartmann',
};
const mockProbe = mock(async (host: string, token: string) => {
  probeCalls.push({ host, token });
  return probeResult;
});
mock.module('../forge-host-probe', () => ({
  testForgeHostConnection: mockProbe,
}));

import { registerApiRoutes } from './api';

function makeApp(): OpenAPIHono {
  const app = new OpenAPIHono({ defaultHook: validationErrorHook });
  const mockWebAdapter = {
    setConversationDbId: mock(() => {}),
    emitSSE: mock(async () => {}),
    emitLockEvent: mock(async () => {}),
  } as unknown as WebAdapter;
  const mockLockManager = {
    acquireLock: mock(async (_id: string, fn: () => Promise<void>) => {
      await fn();
      return { status: 'started' };
    }),
    getStats: mock(() => ({ active: 0, queued: 0 })),
  } as unknown as ConversationLockManager;
  registerApiRoutes(app, mockWebAdapter, mockLockManager);
  return app;
}

const ALICE = { 'X-Archon-User': 'alice' };
const trackTempRoot = trackTempRoots();

beforeEach(() => {
  authInstance = null;
  storeHosts = [
    {
      host: 'code.core.ci',
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-02-02T00:00:00Z',
    },
  ];
  storeSaveCalls.length = 0;
  storeDeleteCalls.length = 0;
  probeCalls.length = 0;
  storeSaveImpl = async () => {};
  probeResult = { ok: true, login: 'Hartmann' };
  mockStoreSave.mockClear();
  mockStoreList.mockClear();
  mockStoreCredentials.mockClear();
  mockStoreDelete.mockClear();
  mockProbe.mockClear();

  // Fresh trusted-config tree per test; the tracked roots are torn down per test.
  configDir = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-forge-route-')));
  configPath = join(configDir, 'config.yaml');
  writeTrustedConfig();
});

describe('GET /api/forge-hosts', () => {
  test('authenticated: metadata only, deep-equal shape, no secret value', async () => {
    const res = await makeApp().request('/api/forge-hosts', { headers: ALICE });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      hosts: [
        {
          host: 'code.core.ci',
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-02-02T00:00:00Z',
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain('secret-token-xyz');
  });

  test('unauthenticated: 401 with the pinned message, the store is never read', async () => {
    const res = await makeApp().request('/api/forge-hosts');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: 'Web authentication required to manage forge hosts',
    });
    expect(mockStoreList).not.toHaveBeenCalled();
  });
});

describe('PUT /api/forge-hosts/:host', () => {
  test('claimed host: 200, store.save called with host + token, no token in the response', async () => {
    const res = await makeApp().request('/api/forge-hosts/code.core.ci', {
      method: 'PUT',
      headers: { ...ALICE, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'secret-token-xyz' }),
    });
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain('secret-token-xyz');
    expect(JSON.parse(raw)).toEqual({ success: true, host: 'code.core.ci' });
    expect(storeSaveCalls).toEqual([{ host: 'code.core.ci', token: 'secret-token-xyz' }]);
  });

  test('install-wide: PUT/DELETE under different identities make the same store calls', async () => {
    const put = await makeApp().request('/api/forge-hosts/code.core.ci', {
      method: 'PUT',
      headers: { 'X-Archon-User': 'bob', 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'tok-second' }),
    });
    expect(put.status).toBe(200);
    const del = await makeApp().request('/api/forge-hosts/code.core.ci', {
      method: 'DELETE',
      headers: ALICE,
    });
    expect(del.status).toBe(200);
    expect(storeSaveCalls).toEqual([{ host: 'code.core.ci', token: 'tok-second' }]);
    expect(storeDeleteCalls).toEqual(['code.core.ci']);
  });

  test('unclaimed host: 400 naming forge.hosts, the store is not called', async () => {
    const res = await makeApp().request('/api/forge-hosts/unclaimed.example', {
      method: 'PUT',
      headers: { ...ALICE, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'secret-token-xyz' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain('forge.hosts');
    expect(storeSaveCalls).toEqual([]);
  });

  test('path containing a slash: 400, the store is not called', async () => {
    const res = await makeApp().request('/api/forge-hosts/code.core.ci/x', {
      method: 'PUT',
      headers: { ...ALICE, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'secret-token-xyz' }),
    });
    expect(res.status).toBe(400);
    expect(storeSaveCalls).toEqual([]);
  });

  test('host containing @: 400, the store is not called', async () => {
    const res = await makeApp().request('/api/forge-hosts/user@code.core.ci', {
      method: 'PUT',
      headers: { ...ALICE, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'secret-token-xyz' }),
    });
    expect(res.status).toBe(400);
    expect(storeSaveCalls).toEqual([]);
  });

  test('unauthenticated: 401 with the pinned message, the store is not called', async () => {
    const res = await makeApp().request('/api/forge-hosts/code.core.ci', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'secret-token-xyz' }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: 'Web authentication required to manage forge hosts',
    });
    expect(storeSaveCalls).toEqual([]);
  });
});

describe('PUT /api/forge-hosts/:host — host normalization (port, case, percent-encoding)', () => {
  test('host with a port is stored under the literal port form', async () => {
    const res = await makeApp().request('/api/forge-hosts/code.core.ci%3A3000', {
      method: 'PUT',
      headers: { ...ALICE, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'tok-port' }),
    });
    expect(res.status).toBe(200);
    expect(storeSaveCalls).toEqual([{ host: 'code.core.ci:3000', token: 'tok-port' }]);
  });

  test('uppercase host is stored under the normalized lowercase key', async () => {
    const res = await makeApp().request('/api/forge-hosts/Code.Core.CI', {
      method: 'PUT',
      headers: { ...ALICE, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'tok-case' }),
    });
    expect(res.status).toBe(200);
    expect(storeSaveCalls).toEqual([{ host: 'code.core.ci', token: 'tok-case' }]);
  });

  test('invalid percent-escape: 400, the store is not called', async () => {
    const res = await makeApp().request('/api/forge-hosts/bad%zz', {
      method: 'PUT',
      headers: { ...ALICE, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'tok-escape' }),
    });
    expect(res.status).toBe(400);
    expect(storeSaveCalls).toEqual([]);
  });
});

describe('DELETE /api/forge-hosts/:host', () => {
  test('delete is idempotent and returns success', async () => {
    const res = await makeApp().request('/api/forge-hosts/code.core.ci', {
      method: 'DELETE',
      headers: ALICE,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    const res2 = await makeApp().request('/api/forge-hosts/code.core.ci', {
      method: 'DELETE',
      headers: ALICE,
    });
    expect(res2.status).toBe(200);
    expect(storeDeleteCalls).toEqual(['code.core.ci', 'code.core.ci']);
  });
});

describe('POST /api/forge-hosts/test', () => {
  test('claimed host: 200 with the probe result, no token in the response', async () => {
    const res = await makeApp().request('/api/forge-hosts/test', {
      method: 'POST',
      headers: { ...ALICE, 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: 'code.core.ci', token: 'secret-token-xyz' }),
    });
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain('secret-token-xyz');
    expect(JSON.parse(raw)).toEqual({ ok: true, login: 'Hartmann' });
    expect(probeCalls).toEqual([{ host: 'code.core.ci', token: 'secret-token-xyz' }]);
  });

  test('unclaimed host: 400 naming forge.hosts, no probe runs', async () => {
    const res = await makeApp().request('/api/forge-hosts/test', {
      method: 'POST',
      headers: { ...ALICE, 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: 'unclaimed.example', token: 'secret-token-xyz' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain('forge.hosts');
    expect(probeCalls).toEqual([]);
  });

  test('malformed host: 400, no probe runs', async () => {
    const res = await makeApp().request('/api/forge-hosts/test', {
      method: 'POST',
      headers: { ...ALICE, 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: 'user@code.core.ci', token: 'x' }),
    });
    expect(res.status).toBe(400);
    expect(probeCalls).toEqual([]);
  });
});

describe('store failures', () => {
  test('ForgeHostsFileUnreadableError from save: 500 naming forge-hosts.json and the repair, no token', async () => {
    storeSaveImpl = async () => {
      throw new ForgeHostsFileUnreadableError('cannot read the store document');
    };
    const res = await makeApp().request('/api/forge-hosts/code.core.ci', {
      method: 'PUT',
      headers: { ...ALICE, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'secret-token-xyz' }),
    });
    expect(res.status).toBe(500);
    const raw = await res.text();
    expect(raw).toContain('forge-hosts.json');
    expect(/repair|delete/i.test(raw)).toBe(true);
    expect(raw).not.toContain('secret-token-xyz');
  });
});
