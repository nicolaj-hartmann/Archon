import { describe, expect, test } from 'bun:test';
import { runForgeReadConformance } from '@archon/forge/conformance';
import type { ForgeRequest } from '@archon/forge/operations';
import { giteaPluginMetadata, handleGiteaOperation } from './operations';

const API = 'https://code.core.ci/api/v1';
const ref = { repo: { host: 'code.core.ci', path: 'org/repo' }, number: 42 };
const checksRequest = {
  operationId: 'checks-main',
  op: 'checks.state',
  ref,
} satisfies ForgeRequest;

type GiteaFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function json(value: unknown, status = 200, headers?: Record<string, string>): Response {
  return Response.json(value, { status, headers });
}

/**
 * A Gitea commit-status row in its live 16.0.x shape: `status` (never `state`),
 * numeric `id`, `context` as the unit name, nullable `creator`.
 */
function statusRow(id: number, status: string, context: string, revision: string): unknown {
  return {
    id,
    status,
    target_url: `https://ci.core.ci/builds/${id}`,
    description: 'live probe',
    url: `${API}/repos/org/repo/statuses/${revision}`,
    context,
    creator: { login: 'ci-bot' },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:01Z',
  };
}

interface StatusesFixture {
  revision: string;
  /** pages[0] is page 1. The loop must stop only on an empty page. */
  pages: unknown[][];
  headers?: Record<string, string>;
}

function statusesFetch(fixture: StatusesFixture) {
  const urls: string[] = [];
  const fetch: GiteaFetch = async input => {
    const url = String(input);
    urls.push(url);
    if (url === `${API}/repos/org/repo/pulls/42`)
      return json({
        head: { ref: 'main', sha: fixture.revision, repo: { full_name: 'org/repo' } },
      });
    const match = /\/repos\/org\/repo\/commits\/([^/]+)\/statuses\?limit=30&page=(\d+)$/.exec(url);
    if (match !== null && match[1] === fixture.revision) {
      const rows = fixture.pages[Number(match[2]) - 1];
      if (rows === undefined) throw new Error(`Unexpected statuses request: ${url}`);
      return json(rows, 200, fixture.headers);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  return { fetch, urls };
}

async function checksValue(fetch: GiteaFetch) {
  const response = await handleGiteaOperation(checksRequest, { token: 'token', fetch });
  if (!response.ok || response.result.op !== 'checks.state')
    throw new Error(`Expected checks.state, got ${JSON.stringify(response)}`);
  return response.result.value;
}

/** Find one unit by id, or fail naming every id the plugin actually enumerated. */
function unit(value: { units: { unit: { id: string } }[] }, id: string) {
  const found = value.units.find(candidate => candidate.unit.id === id);
  if (found === undefined)
    throw new Error(`Unit ${id} missing from ${JSON.stringify(value.units.map(u => u.unit.id))}`);
  return found;
}

describe('forge-gitea operations', () => {
  test('metadata pins the plugin envelope', () => {
    expect(giteaPluginMetadata).toEqual({
      protocol: 1,
      name: 'gitea',
      version: '1',
      forge: 'gitea',
      hosts: [],
      capabilities: [
        'resolve',
        'checks.state',
        'pr.view',
        'pr.create',
        'pr.edit-body',
        'pr.ready',
        'comment.upsert',
      ],
      token_env: [],
    });
  });

  test('an ambient clone GITEA_TOKEN is never a credential for plugin operations', async () => {
    const calls: string[] = [];
    const previous = process.env.GITEA_TOKEN;
    process.env.GITEA_TOKEN = 'ambient';
    try {
      const noFetch: GiteaFetch = async input => {
        calls.push(String(input));
        throw new Error('must not fetch without an injected token');
      };
      const response = await handleGiteaOperation(checksRequest, {
        token: undefined,
        fetch: noFetch,
      });
      expect(response).toMatchObject({ ok: false, error: { kind: 'no_credential' } });
      if (!response.ok) expect(response.error.message).toContain('ARCHON_FORGE_TOKEN');
      expect(calls).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.GITEA_TOKEN;
      else process.env.GITEA_TOKEN = previous;
    }
  });

  describe('resolve', () => {
    const resolve = (remote: string, token: string | undefined = undefined) =>
      handleGiteaOperation({ operationId: `resolve-${remote}`, op: 'resolve', remote }, { token });

    test.each([
      [
        'lowercases a remote host and preserves its port, stripping the .git suffix',
        'https://CODE.CORE.CI:3000/Org/Repo.git',
        { host: 'code.core.ci:3000', path: 'Org/Repo' },
      ],
      [
        'splits a bare origin remote on the first colon',
        'code.levior.io:acme/widgets.git',
        { host: 'code.levior.io', path: 'acme/widgets' },
      ],
      [
        'resolves an https remote without a port',
        'https://code.core.ci/acme/widgets',
        { host: 'code.core.ci', path: 'acme/widgets' },
      ],
    ] as const)('%s', async (_, remote, repo) => {
      const response = await resolve(remote);
      expect(response).toMatchObject({
        ok: true,
        result: { op: 'resolve', value: { kind: 'resolved', repo } },
      });
    });

    test('a local path resolves to kind none', async () => {
      const response = await resolve('/tmp/local');
      expect(response).toEqual({
        operationId: 'resolve-/tmp/local',
        ok: true,
        result: { op: 'resolve', value: { kind: 'none', forge: 'none' } },
      });
    });

    test('a URL carrying credentials is refused', async () => {
      const response = await resolve('https://user:secret@code.core.ci/o/r');
      expect(response).toMatchObject({ ok: false, error: { kind: 'invalid_request' } });
    });
  });

  describe('checks.state', () => {
    test('enumerates live status rows deduped to the highest id per context', async () => {
      const fake = statusesFetch({
        revision: 'REV',
        pages: [
          [
            statusRow(31, 'success', 'ci / build', 'REV'),
            statusRow(30, 'failure', 'ci / build', 'REV'),
            statusRow(27, 'pending', 'ci / lint', 'REV'),
          ],
          [],
        ],
      });
      const value = await checksValue(fake.fetch);
      expect(value.revision).toBe('REV');
      expect(value.required).toBeNull();
      // Hand-expected, not summarized through the code under test:
      // 'success' is green, 'pending' stays pending, and the stale 'ci / build'
      // failure (id 30, below id 31) is deduped away.
      expect(value.summary).toEqual({
        state: 'pending',
        counts: { total: 2, green: 1, red: 0, pending: 1, gated: 0, unknown: 0 },
      });
      expect(value.units).toHaveLength(2);
      expect(unit(value, '31')).toMatchObject({
        unit: { kind: 'commit_status', id: '31' },
        state: 'green',
        result: 'success',
        phase: 'completed',
      });
      expect(unit(value, '27')).toMatchObject({
        unit: { kind: 'commit_status', id: '27' },
        state: 'pending',
        result: null,
        phase: 'pending',
      });
    });

    test('a non-standard status maps to unknown, not to a guessed outcome', async () => {
      const fake = statusesFetch({
        revision: 'REV',
        pages: [[statusRow(50, 'warning', 'security', 'REV')], []],
      });
      const value = await checksValue(fake.fetch);
      expect(value.summary).toEqual({
        state: 'unknown',
        counts: { total: 1, green: 0, red: 0, pending: 0, gated: 0, unknown: 1 },
      });
      expect(unit(value, '50')).toMatchObject({
        unit: { kind: 'commit_status', id: '50' },
        state: 'unknown',
        result: 'unknown',
        phase: 'unknown',
      });
    });

    test('out-of-order delivery dedupes to the highest id', async () => {
      const fake = statusesFetch({
        revision: 'REV',
        // The vendor delivered the lower id first: the survivor must still be id 31.
        pages: [
          [
            statusRow(30, 'failure', 'ci / build', 'REV'),
            statusRow(31, 'success', 'ci / build', 'REV'),
          ],
          [],
        ],
      });
      const value = await checksValue(fake.fetch);
      expect(value.summary).toEqual({
        state: 'green',
        counts: { total: 1, green: 1, red: 0, pending: 0, gated: 0, unknown: 0 },
      });
      expect(unit(value, '31')).toMatchObject({
        unit: { kind: 'commit_status', id: '31' },
        state: 'green',
        result: 'success',
        phase: 'completed',
      });
    });

    test('a revision with no statuses reports none', async () => {
      const fake = statusesFetch({ revision: 'MISSING', pages: [[]] });
      const value = await checksValue(fake.fetch);
      expect(value.revision).toBe('MISSING');
      expect(value.summary).toEqual({
        state: 'none',
        counts: { total: 0, green: 0, red: 0, pending: 0, gated: 0, unknown: 0 },
      });
      expect(value.units).toEqual([]);
    });

    test('the list fetch stops only on an empty page, never on a short page or x-total-count', async () => {
      const pages = [
        [statusRow(101, 'success', 'c1', 'REV'), statusRow(102, 'success', 'c2', 'REV')],
        [statusRow(103, 'success', 'c3', 'REV'), statusRow(104, 'success', 'c4', 'REV')],
        [],
      ];
      const withHeader = statusesFetch({
        revision: 'REV',
        pages,
        headers: { 'x-total-count': '120' },
      });
      const value = await checksValue(withHeader.fetch);
      expect(value.units).toHaveLength(4);
      // Exactly three list fetches at the pinned cap, pages 1..3.
      expect(withHeader.urls).toEqual([
        `${API}/repos/org/repo/pulls/42`,
        `${API}/repos/org/repo/commits/REV/statuses?limit=30&page=1`,
        `${API}/repos/org/repo/commits/REV/statuses?limit=30&page=2`,
        `${API}/repos/org/repo/commits/REV/statuses?limit=30&page=3`,
      ]);

      // Without the header the stop condition cannot be x-total-count either:
      // identical pages, identical fetch count.
      const withoutHeader = statusesFetch({ revision: 'REV', pages });
      const plain = await checksValue(withoutHeader.fetch);
      expect(plain.units).toHaveLength(4);
      expect(withoutHeader.urls.filter(url => url.includes('/statuses'))).toHaveLength(3);
    });

    test('a vendor that repeats page 1 for out-of-range pages cannot hang the list fetch', async () => {
      // Observed on Forgejo 16.0.1 (issue-comments listing; D14 smoke on
      // code.core.ci): out-of-range pages answer with the first page again, so
      // an empty page never arrives. The walk must end when a page carries no
      // new item id. The fixture refuses page 3, so the pre-fix loop fails
      // here instead of hanging.
      const repeated = [
        statusRow(201, 'success', 'rc1', 'REV'),
        statusRow(202, 'success', 'rc2', 'REV'),
      ];
      const fixture = statusesFetch({ revision: 'REV', pages: [repeated, repeated] });
      const value = await checksValue(fixture.fetch);
      expect(value.units).toHaveLength(2);
      unit(value, '201');
      unit(value, '202');
      expect(value.summary).toEqual({
        state: 'green',
        counts: { total: 2, green: 2, red: 0, pending: 0, gated: 0, unknown: 0 },
      });
      expect(fixture.urls.filter(url => url.includes('/statuses'))).toHaveLength(2);
    });

    test('passes the public read conformance kit for live-shaped status rows', async () => {
      const fixtures: Record<string, StatusesFixture> = {
        'conform-live': {
          revision: 'REV',
          pages: [
            [
              statusRow(31, 'success', 'ci / build', 'REV'),
              statusRow(30, 'failure', 'ci / build', 'REV'),
              statusRow(27, 'pending', 'ci / lint', 'REV'),
            ],
            [],
          ],
        },
        'conform-warning': {
          revision: 'REV',
          pages: [[statusRow(50, 'warning', 'security', 'REV')], []],
        },
        'conform-order': {
          revision: 'REV',
          pages: [
            [
              statusRow(30, 'failure', 'ci / build', 'REV'),
              statusRow(31, 'success', 'ci / build', 'REV'),
            ],
            [],
          ],
        },
        'conform-missing': { revision: 'MISSING', pages: [[]] },
      };
      const failures = await runForgeReadConformance(
        request =>
          handleGiteaOperation(request, {
            token: 'token',
            fetch: statusesFetch(fixtures[request.operationId]).fetch,
          }),
        [
          {
            name: 'live rows',
            request: { operationId: 'conform-live', op: 'checks.state', ref },
            expected: {
              revision: 'REV',
              state: 'pending',
              units: [
                { kind: 'commit_status', id: '31' },
                { kind: 'commit_status', id: '27' },
              ],
            },
          },
          {
            name: 'non-standard status',
            request: { operationId: 'conform-warning', op: 'checks.state', ref },
            expected: {
              revision: 'REV',
              state: 'unknown',
              units: [{ kind: 'commit_status', id: '50' }],
            },
          },
          {
            name: 'out-of-order dedup',
            request: { operationId: 'conform-order', op: 'checks.state', ref },
            expected: {
              revision: 'REV',
              state: 'green',
              units: [{ kind: 'commit_status', id: '31' }],
            },
          },
          {
            name: 'no statuses',
            request: { operationId: 'conform-missing', op: 'checks.state', ref },
            expected: { revision: 'MISSING', state: 'none', units: [] },
          },
        ]
      );
      expect(failures).toEqual([]);
    });
  });
});
