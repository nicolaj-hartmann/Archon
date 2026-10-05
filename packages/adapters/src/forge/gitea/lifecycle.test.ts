import { describe, expect, test } from 'bun:test';
import { runForgeMutationConformance } from '@archon/forge/conformance';
import { contentDigest } from '@archon/forge/operations';
import type { ForgeMutationRequest, ForgeRequest } from '@archon/forge/operations';
import { giteaPluginMetadata, handleGiteaOperation } from './operations';

const HOST = 'code.core.ci';
const API = 'https://code.core.ci/api/v1';
const REPO = 'o/r';
const repo = { host: HOST, path: REPO };
const ref = { repo, number: 7 };

type GiteaFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

/** A Gitea pull row in its live 16.0.x shape: `draft`, `allow_maintainer_edit`,
 * `head.repo` always populated, `url` the API URL, `html_url` the web URL. */
interface PullLine {
  number: number;
  url: string;
  html_url: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  allow_maintainer_edit: boolean;
  head: { ref: string; sha: string; repo: { full_name: string } };
  base: { ref: string; sha: string };
}

function pullLine(overrides: Partial<PullLine> = {}): PullLine {
  return {
    number: 7,
    url: `${API}/repos/${REPO}/pulls/7`,
    html_url: `https://${HOST}/${REPO}/pulls/7`,
    title: 'A title',
    body: 'A body',
    state: 'open',
    draft: false,
    merged: false,
    allow_maintainer_edit: true,
    head: { ref: 'feature', sha: 'headsha', repo: { full_name: REPO } },
    base: { ref: 'main', sha: 'basesha' },
    ...overrides,
  };
}

interface CommentLine {
  id: number;
  body: string;
  user?: { login: string };
}

interface GiteaFixtureOptions {
  pulls?: PullLine[];
  /** What `POST /pulls` returns; registered by number for the read-back. */
  created?: PullLine;
  comments?: CommentLine[];
  /** The global id the vendor assigns to the next created comment. */
  nextCommentId?: number;
  /** The authenticated user's login as answered by `GET /user`. */
  selfLogin?: string;
  /** The vendor ignores the PATCH: state is unchanged after the request. */
  lose?: boolean;
  /**
   * Forgejo 16.0.1 behaviour (D14 smoke, code.core.ci): the comment listing
   * answers out-of-range pages with the first page again. Page 3 is refused so
   * a walk that ignores the repeat fails instead of hanging.
   */
  repeatCommentPages?: boolean;
  status?: (url: string, method: string) => number | undefined;
}

function fakeGitea(options: GiteaFixtureOptions = {}) {
  const pulls = new Map((options.pulls ?? []).map(pull => [pull.number, pull]));
  if (options.created !== undefined) pulls.set(options.created.number, options.created);
  const comments = options.comments ?? [];
  const calls: { url: string; method: string; body?: string | null }[] = [];
  let nextCommentId = options.nextCommentId ?? 777;
  const selfLogin = options.selfLogin ?? 'plugin-bot';
  const commentUser = (row: CommentLine) => row.user ?? { login: selfLogin };
  const commentUrl = (id: number) => `https://${HOST}/${REPO}/pulls/12#issuecomment-${id}`;
  const fetch: GiteaFetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body as string | null | undefined });
    const status = options.status?.(url, method);
    if (status !== undefined) return json({ message: 'refused' }, status);

    if (url === `${API}/user`) return json({ id: 1, login: selfLogin });

    const createMatch = /\/repos\/o\/r\/pulls$/.exec(url);
    if (createMatch !== null && method === 'POST') {
      if (options.created === undefined) throw new Error('fixture has no created pull');
      return json(options.created, 201);
    }

    const pullMatch = /\/repos\/o\/r\/pulls\/(\d+)$/.exec(url);
    if (pullMatch !== null) {
      const pull = pulls.get(Number(pullMatch[1]));
      if (pull === undefined)
        return json({ message: 'The target could not be found.', url, errors: [] }, 404);
      if (method === 'PATCH' && !options.lose) {
        const patch = JSON.parse(String(init?.body)) as { title?: string; body?: string };
        if (typeof patch.title === 'string') {
          pull.title = patch.title;
          // The vendor recomputes `draft` from the title prefix (pinned contract),
          // so a stripped title reads back as non-draft.
          pull.draft = /^(wip:|\[wip\])/i.test(pull.title);
        }
        if (typeof patch.body === 'string') pull.body = patch.body;
      }
      return json(pull);
    }

    const globalMatch = /\/repos\/o\/r\/issues\/comments\/(\d+)$/.exec(url);
    if (globalMatch !== null) {
      const row = comments.find(candidate => candidate.id === Number(globalMatch[1]));
      if (row === undefined)
        return json({ message: 'The target could not be found.', url, errors: [] }, 404);
      if (method === 'PATCH' && !options.lose)
        row.body = (JSON.parse(String(init?.body)) as { body: string }).body;
      return json({
        id: row.id,
        body: row.body,
        html_url: commentUrl(row.id),
        user: commentUser(row),
      });
    }

    const listUrl = new URL(url);
    if (listUrl.pathname === `/api/v1/repos/${REPO}/issues/12/comments`) {
      if (method === 'POST') {
        const body = (JSON.parse(String(init?.body)) as { body: string }).body;
        if (!options.lose) comments.push({ id: nextCommentId, body, user: { login: selfLogin } });
        const created = {
          id: nextCommentId,
          body,
          html_url: commentUrl(nextCommentId),
          user: { login: selfLogin },
        };
        nextCommentId++;
        return json(created, 201);
      }
      // Gitea caps the comment list at 30; the plugin paginates until the empty page.
      const page = Number(listUrl.searchParams.get('page') ?? '1');
      if (options.repeatCommentPages && page > 2)
        throw new Error(`Unexpected comment page beyond the vendor repeat: ${url}`);
      const rows =
        page === 1 || options.repeatCommentPages
          ? comments.map(row => ({
              id: row.id,
              body: row.body,
              html_url: commentUrl(row.id),
              user: commentUser(row),
            }))
          : [];
      return json(rows);
    }

    throw new Error(`Unexpected ${method} ${url}`);
  };
  return { fetch, calls };
}

const run = (request: ForgeRequest, fetch: GiteaFetch) =>
  handleGiteaOperation(request, { token: 'token', fetch });

describe('forge-gitea lifecycle', () => {
  describe('pr.view (head selector)', () => {
    const viewRepo = { host: HOST, path: 'averagehelper/ts-svg' };
    const request = {
      operationId: 'view-head',
      op: 'pr.view',
      selector: { kind: 'head', repo: viewRepo, headRepo: viewRepo, head: 'ts-svg' },
    } satisfies ForgeRequest;

    const matchRow = {
      number: 14666,
      url: `${API}/repos/AverageHelper/ts-svg/pulls/14666`,
      html_url: `https://${HOST}/AverageHelper/ts-svg/pulls/14666`,
      title: 'ts-svg',
      body: 'B',
      state: 'open',
      draft: true,
      merged: false,
      allow_maintainer_edit: false,
      head: { ref: 'ts-svg', sha: 'REV', repo: { full_name: 'AverageHelper/ts-svg' } },
      base: { ref: 'main', sha: 'BASE' },
    };
    const otherRow = {
      ...matchRow,
      number: 9,
      url: `${API}/repos/other/ts-svg/pulls/9`,
      html_url: `https://${HOST}/other/ts-svg/pulls/9`,
      draft: false,
      allow_maintainer_edit: true,
      head: { ref: 'ts-svg', sha: 'OTHER', repo: { full_name: 'other/ts-svg' } },
    };

    function selectorFake(rows: unknown[]) {
      const requested: string[] = [];
      const fetch: GiteaFetch = async input => {
        const url = String(input);
        requested.push(url);
        if (url === `${API}/repos/averagehelper/ts-svg/pulls?state=open&head=ts-svg&limit=30`)
          return json(rows);
        throw new Error(`Unexpected URL: ${url}`);
      };
      return { fetch, requested };
    }

    test('lists by bare branch name and filters the head repo case-insensitively', async () => {
      const fake = selectorFake([matchRow, otherRow]);
      const response = await run(request, fake.fetch);
      expect(response).toMatchObject({
        ok: true,
        result: {
          op: 'pr.view',
          value: {
            pr: {
              number: 14666,
              state: 'open',
              is_draft: true,
              head_repo: { host: HOST, path: 'AverageHelper/ts-svg' },
              maintainer_can_modify: false,
            },
          },
        },
      });
      // Exactly one fetch: the head param is the bare branch, never owner-qualified,
      // and no second fetch corrects the result.
      expect(fake.requested).toEqual([
        `${API}/repos/averagehelper/ts-svg/pulls?state=open&head=ts-svg&limit=30`,
      ]);
    });

    test('no row matching the head repo views as null', async () => {
      const fake = selectorFake([otherRow]);
      const response = await run(request, fake.fetch);
      expect(response).toMatchObject({ ok: true, result: { op: 'pr.view', value: null } });
    });

    test('two rows matching the head repo are a conflict', async () => {
      const fake = selectorFake([
        matchRow,
        { ...matchRow, number: 21, head: { ...matchRow.head, sha: 'OTHER' } },
      ]);
      const response = await run(request, fake.fetch);
      expect(response).toMatchObject({ ok: false, error: { kind: 'conflict' } });
    });
  });

  describe('pr.view (number)', () => {
    test('a merged closed pull views as state merged', async () => {
      const fake = fakeGitea({
        pulls: [
          pullLine({
            number: 77,
            state: 'closed',
            merged: true,
            url: `${API}/repos/${REPO}/pulls/77`,
            html_url: `https://${HOST}/${REPO}/pulls/77`,
          }),
        ],
      });
      const response = await run(
        {
          operationId: 'view-77',
          op: 'pr.view',
          selector: { kind: 'number', ref: { repo, number: 77 } },
        },
        fake.fetch
      );
      expect(response).toMatchObject({
        ok: true,
        result: { op: 'pr.view', value: { pr: { number: 77, state: 'merged' } } },
      });
    });

    test('a 404 with a JSON body maps to not_found', async () => {
      const fake = fakeGitea({});
      const response = await run(
        {
          operationId: 'view-404',
          op: 'pr.view',
          selector: { kind: 'number', ref: { repo, number: 999 } },
        },
        fake.fetch
      );
      expect(response).toMatchObject({ ok: false, error: { kind: 'not_found', status: 404 } });
    });

    test('a 404 with a plain-text body maps to not_found, not a parse error', async () => {
      const fetch: GiteaFetch = async () =>
        new Response('404 page not found', {
          status: 404,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      const response = await run(
        {
          operationId: 'view-404-text',
          op: 'pr.view',
          selector: { kind: 'number', ref: { repo, number: 999 } },
        },
        fetch
      );
      expect(response).toMatchObject({ ok: false, error: { kind: 'not_found', status: 404 } });
    });
  });

  describe('pr.create', () => {
    const created: PullLine = {
      number: 5,
      url: `${API}/repos/${REPO}/pulls/5`,
      html_url: `https://${HOST}/${REPO}/pulls/5`,
      title: 'WIP: Add feature',
      body: 'B',
      state: 'open',
      draft: true,
      merged: false,
      allow_maintainer_edit: true,
      head: { ref: 'b', sha: 'REV', repo: { full_name: 'o/fork' } },
      base: { ref: 'main', sha: 'basesha' },
    };
    const createdSameRepo: PullLine = {
      ...created,
      head: { ref: 'b', sha: 'REV', repo: { full_name: REPO } },
    };
    const cross = {
      operationId: 'create-cross',
      op: 'pr.create',
      repo,
      headRepo: { host: HOST, path: 'o/fork' },
      head: 'b',
      headRevision: 'REV',
      base: 'main',
      title: 'Add feature',
      body: 'B',
      draft: true,
    } satisfies ForgeMutationRequest;

    test('a cross-repo draft POSTs the exact body and reports the created pull', async () => {
      const fake = fakeGitea({ created });
      const response = await run(cross, fake.fetch);
      expect(response).toMatchObject({
        ok: true,
        result: {
          op: 'pr.create',
          value: {
            outcome: 'applied',
            changed: true,
            pr: {
              number: 5,
              is_draft: true,
              head_revision: 'REV',
              head_repo: { host: HOST, path: 'o/fork' },
            },
          },
        },
      });
      const post = fake.calls.find(call => call.method === 'POST');
      expect(JSON.parse(String(post?.body))).toEqual({
        title: 'WIP: Add feature',
        head: 'o:b',
        base: 'main',
        body: 'B',
      });
    });

    test('a same-repo draft POSTs the bare branch head', async () => {
      const same = {
        ...cross,
        operationId: 'create-same',
        headRepo: repo,
      } satisfies ForgeMutationRequest;
      const fake = fakeGitea({ created: createdSameRepo });
      const response = await run(same, fake.fetch);
      expect(response).toMatchObject({
        ok: true,
        result: { op: 'pr.create', value: { outcome: 'applied' } },
      });
      const post = fake.calls.find(call => call.method === 'POST');
      expect(JSON.parse(String(post?.body))).toEqual({
        title: 'WIP: Add feature',
        head: 'b',
        base: 'main',
        body: 'B',
      });
    });

    test('a read-back that lost the draft flag is verification_failed', async () => {
      const fake = fakeGitea({ created: { ...created, draft: false } });
      const response = await run({ ...cross, operationId: 'create-verify' }, fake.fetch);
      expect(response).toMatchObject({
        ok: false,
        mutation: {
          op: 'pr.create',
          outcome: 'verification_failed',
          observed: { number: 5 },
          leaveBehind: 'pull request 5 may exist',
        },
      });
    });

    test('a 409 refuses with zero fetches after the POST', async () => {
      const fake = fakeGitea({
        status: (url, method) =>
          method === 'POST' && url === `${API}/repos/${REPO}/pulls` ? 409 : undefined,
      });
      const response = await run({ ...cross, operationId: 'create-409' }, fake.fetch);
      expect(response).toMatchObject({
        ok: false,
        error: { kind: 'conflict', status: 409 },
        mutation: { op: 'pr.create', outcome: 'refused' },
      });
      expect(fake.calls).toHaveLength(1);
    });

    test('passes the public mutation conformance kit', async () => {
      const fixtures: Record<string, GiteaFixtureOptions> = {
        'create-cross': { created },
        'create-same': { created: createdSameRepo },
        'create-verify': { created: { ...created, draft: false } },
        'create-409': {
          status: (url, method) =>
            method === 'POST' && url === `${API}/repos/${REPO}/pulls` ? 409 : undefined,
        },
      };
      const failures = await runForgeMutationConformance(
        request =>
          handleGiteaOperation(request, {
            token: 'token',
            fetch: fakeGitea(fixtures[request.operationId]).fetch,
          }),
        giteaPluginMetadata,
        [
          { name: 'applied cross-repo draft', request: cross, expectedOutcome: 'applied' },
          {
            name: 'applied same-repo draft',
            request: { ...cross, operationId: 'create-same', headRepo: repo },
            expectedOutcome: 'applied',
          },
          {
            name: 'verification failed on draft mismatch',
            request: { ...cross, operationId: 'create-verify' },
            expectedOutcome: 'verification_failed',
          },
          {
            name: 'refused on 409',
            request: { ...cross, operationId: 'create-409' },
            expectedOutcome: 'refused',
          },
          {
            name: 'refused on a cross-host head repository',
            request: {
              ...cross,
              operationId: 'create-cross-host',
              headRepo: { host: 'other.forge.example', path: 'o/fork' },
            },
            expectedOutcome: 'refused',
          },
        ]
      );
      expect(failures).toEqual([]);
    });

    test('a head repository on another host refuses before any fetch', async () => {
      const fake = fakeGitea({});
      const response = await run(
        {
          ...cross,
          operationId: 'create-cross-host-direct',
          headRepo: { host: 'other.forge.example', path: 'o/fork' },
        },
        fake.fetch
      );
      expect(response).toMatchObject({
        ok: false,
        error: { kind: 'invalid_request' },
        mutation: { op: 'pr.create', outcome: 'refused' },
      });
      expect(fake.calls).toEqual([]);
    });
  });

  describe('pr.edit-body', () => {
    test('PATCHes the new body and verifies by digest', async () => {
      const fake = fakeGitea({ pulls: [pullLine({ body: 'old' })] });
      const response = await run(
        { operationId: 'edit', op: 'pr.edit-body', ref, body: 'new body' },
        fake.fetch
      );
      expect(response).toMatchObject({
        ok: true,
        result: {
          op: 'pr.edit-body',
          value: { outcome: 'applied', changed: true, bodyDigest: contentDigest('new body') },
        },
      });
      const patch = fake.calls.find(call => call.method === 'PATCH');
      expect(JSON.parse(String(patch?.body))).toEqual({ body: 'new body' });
    });

    test('a pre-read already equal skips the PATCH', async () => {
      const fake = fakeGitea({ pulls: [pullLine({ body: 'same' })] });
      const response = await run(
        { operationId: 'edit-same', op: 'pr.edit-body', ref, body: 'same' },
        fake.fetch
      );
      expect(response).toMatchObject({
        ok: true,
        result: {
          op: 'pr.edit-body',
          value: { outcome: 'applied', changed: false, bodyDigest: contentDigest('same') },
        },
      });
      expect(fake.calls.every(call => call.method === 'GET')).toBe(true);
    });

    test('an empty body clears the description', async () => {
      const fake = fakeGitea({ pulls: [pullLine({ body: 'old' })] });
      const response = await run(
        { operationId: 'edit-clear', op: 'pr.edit-body', ref, body: '' },
        fake.fetch
      );
      expect(response).toMatchObject({
        ok: true,
        result: {
          op: 'pr.edit-body',
          value: { outcome: 'applied', changed: true, bodyDigest: contentDigest('') },
        },
      });
      const patch = fake.calls.find(call => call.method === 'PATCH');
      expect(JSON.parse(String(patch?.body))).toEqual({ body: '' });
    });

    test('a pre-read answered 404 maps to not_found', async () => {
      const fake = fakeGitea({});
      const response = await run(
        { operationId: 'edit-404', op: 'pr.edit-body', ref, body: 'new' },
        fake.fetch
      );
      expect(response).toMatchObject({ ok: false, error: { kind: 'not_found', status: 404 } });
    });
  });

  describe('pr.ready', () => {
    const ready = (operationId: string) =>
      ({ operationId, op: 'pr.ready', ref }) satisfies ForgeRequest;

    test.each([
      ['WIP: investigate flaky e2e', 'investigate flaky e2e'],
      ['wip: x', 'x'],
      ['[WIP] y', 'y'],
    ] as const)('strips the %s prefix with an exact title PATCH', async (title, expected) => {
      const fake = fakeGitea({ pulls: [pullLine({ title, draft: true })] });
      const response = await run(ready(`ready-${expected}`), fake.fetch);
      expect(response).toMatchObject({
        ok: true,
        result: {
          op: 'pr.ready',
          value: { outcome: 'applied', changed: true, pr: { is_draft: false } },
        },
      });
      const patch = fake.calls.find(call => call.method === 'PATCH');
      expect(JSON.parse(String(patch?.body))).toEqual({ title: expected });
    });

    test.each([
      ['INWORK: z', 'an unrecognized draft prefix'],
      ['WIP: ', 'a title that strips to empty'],
    ] as const)('%s refuses without a PATCH', async (title, what) => {
      const fake = fakeGitea({ pulls: [pullLine({ title, draft: true })] });
      const response = await run(ready('ready-refused'), fake.fetch);
      expect(response).toMatchObject({
        ok: false,
        error: { kind: 'conflict' },
        mutation: { op: 'pr.ready', outcome: 'refused' },
      });
      expect(fake.calls.every(call => call.method === 'GET')).toBe(true);
      if (!response.ok)
        expect(JSON.stringify(response.error)).toContain(
          what === 'a title that strips to empty' ? 'empty' : 'prefix'
        );
    });

    test('an open non-draft pull applies without any write', async () => {
      const fake = fakeGitea({ pulls: [pullLine({ title: 'Plain', draft: false })] });
      const response = await run(ready('ready-plain'), fake.fetch);
      expect(response).toMatchObject({
        ok: true,
        result: {
          op: 'pr.ready',
          value: { outcome: 'applied', changed: false, pr: { is_draft: false, state: 'open' } },
        },
      });
      expect(fake.calls.every(call => call.method === 'GET')).toBe(true);
    });

    test('a merged pull refuses with the observed state', async () => {
      const fake = fakeGitea({
        pulls: [pullLine({ state: 'closed', merged: true, draft: false })],
      });
      const response = await run(ready('ready-merged'), fake.fetch);
      expect(response).toMatchObject({
        ok: false,
        error: { kind: 'conflict' },
        mutation: { op: 'pr.ready', outcome: 'refused', observed: { state: 'merged' } },
      });
    });

    test('a closed unmerged pull refuses without a write and pins the refusal copy', async () => {
      const fake = fakeGitea({
        pulls: [pullLine({ state: 'closed', merged: false, draft: true })],
      });
      const response = await run(ready('ready-closed'), fake.fetch);
      expect(response).toMatchObject({
        ok: false,
        error: {
          kind: 'conflict',
          message: 'A closed pull request cannot be marked ready',
        },
        mutation: { op: 'pr.ready', outcome: 'refused', observed: { state: 'closed' } },
      });
      expect(fake.calls.every(call => call.method === 'GET')).toBe(true);
    });

    test('a read-back still draft is verification_failed', async () => {
      const fake = fakeGitea({
        pulls: [pullLine({ title: 'WIP: investigate flaky e2e', draft: true })],
        lose: true,
      });
      const response = await run(ready('ready-lose'), fake.fetch);
      expect(response).toMatchObject({
        ok: false,
        mutation: {
          op: 'pr.ready',
          outcome: 'verification_failed',
          leaveBehind: 'the pull request draft state may have changed',
        },
      });
    });
  });

  describe('comment.upsert', () => {
    const MARKER = '<!-- archon:pr-review -->';
    const commentRef = { repo, number: 12 };
    const upsert = (operationId: string, body: string) =>
      ({
        operationId,
        op: 'comment.upsert',
        ref: commentRef,
        marker: MARKER,
        body,
      }) satisfies ForgeRequest;

    test('no marked comment: POST the marker and verify by global id', async () => {
      const fake = fakeGitea({
        pulls: [pullLine({ number: 12 })],
        comments: [{ id: 100, body: 'unrelated review' }],
        nextCommentId: 777,
      });
      const response = await run(upsert('comment-create', MARKER), fake.fetch);
      expect(response).toMatchObject({
        ok: true,
        result: {
          op: 'comment.upsert',
          value: {
            outcome: 'applied',
            changed: true,
            comment: { ref: commentRef, id: '777', bodyDigest: contentDigest(MARKER) },
          },
        },
      });
      const post = fake.calls.find(call => call.method === 'POST');
      expect(post?.url).toBe(`${API}/repos/${REPO}/issues/12/comments`);
      expect(JSON.parse(String(post?.body))).toEqual({ body: MARKER });
      // The read-back used the vendor's global id, not the list index.
      expect(fake.calls.some(call => call.url === `${API}/repos/${REPO}/issues/comments/777`)).toBe(
        true
      );
    });

    test('an existing marked comment is replaced via PATCH on its global id', async () => {
      const fake = fakeGitea({
        pulls: [pullLine({ number: 12 })],
        comments: [{ id: 402, body: `${MARKER}\nold report` }],
        nextCommentId: 403,
      });
      const response = await run(upsert('comment-replace', MARKER), fake.fetch);
      expect(response).toMatchObject({
        ok: true,
        result: {
          op: 'comment.upsert',
          value: {
            outcome: 'applied',
            changed: true,
            comment: { id: '402', bodyDigest: contentDigest(MARKER) },
          },
        },
      });
      const patch = fake.calls.find(call => call.method === 'PATCH');
      expect(patch?.url).toBe(`${API}/repos/${REPO}/issues/comments/402`);
      expect(JSON.parse(String(patch?.body))).toEqual({ body: MARKER });
    });

    test('a vendor that repeats its comment page for out-of-range pages cannot hang the upsert', async () => {
      // D14 smoke on code.core.ci (16.0.1): the issue-comments listing returns
      // page 1 for every out-of-range page. The replace walk must end when a
      // page carries no new comment ids; the fixture refuses anything beyond
      // the repeat.
      const fake = fakeGitea({
        pulls: [pullLine({ number: 12 })],
        comments: [{ id: 402, body: `${MARKER}\nold report` }],
        nextCommentId: 403,
        repeatCommentPages: true,
      });
      const response = await run(upsert('comment-repeat', MARKER), fake.fetch);
      expect(response).toMatchObject({
        ok: true,
        result: {
          op: 'comment.upsert',
          value: {
            outcome: 'applied',
            changed: true,
            comment: { id: '402', bodyDigest: contentDigest(MARKER) },
          },
        },
      });
      const patch = fake.calls.find(call => call.method === 'PATCH');
      expect(patch?.url).toBe(`${API}/repos/${REPO}/issues/comments/402`);
      // Two list fetches: the first page and its repeat. Nothing beyond.
      expect(
        fake.calls.filter(call => call.method === 'GET' && call.url.includes('issues/12/comments'))
      ).toHaveLength(2);
    });

    test('an identical existing comment applies without any write', async () => {
      const fake = fakeGitea({
        pulls: [pullLine({ number: 12 })],
        comments: [{ id: 402, body: MARKER }],
      });
      const response = await run(upsert('comment-same', MARKER), fake.fetch);
      expect(response).toMatchObject({
        ok: true,
        result: {
          op: 'comment.upsert',
          value: {
            outcome: 'applied',
            changed: false,
            comment: { id: '402', bodyDigest: contentDigest(MARKER) },
          },
        },
      });
      expect(fake.calls.every(call => call.method === 'GET')).toBe(true);
    });

    test('a body without the marker first line refuses before any HTTP call', async () => {
      const fake = fakeGitea({});
      const response = await run(upsert('comment-nomarker', 'hello'), fake.fetch);
      expect(response).toMatchObject({
        ok: false,
        error: { kind: 'invalid_request' },
        mutation: { op: 'comment.upsert', outcome: 'refused' },
      });
      expect(fake.calls).toEqual([]);
    });

    test('a target that is not a pull request refuses before any comment write', async () => {
      // Gitea serves pull-request threads through the issues endpoint, which
      // accepts ordinary issue numbers too: the pulls route is the proof that
      // the target is a pull request.
      const fake = fakeGitea({});
      const response = await run(upsert('comment-issue', MARKER), fake.fetch);
      expect(response).toMatchObject({
        ok: false,
        error: { kind: 'invalid_request' },
        mutation: { op: 'comment.upsert', outcome: 'refused' },
      });
      if (!response.ok) expect(response.error.message).toContain('not a pull request');
      // Exactly one read, against the pulls route: no comment list, no write.
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0].url).toBe(`${API}/repos/${REPO}/pulls/12`);
      expect(fake.calls[0].method).toBe('GET');
    });

    test('two marked comments refuse with zero writes', async () => {
      const fake = fakeGitea({
        pulls: [pullLine({ number: 12 })],
        comments: [
          { id: 1, body: MARKER },
          { id: 2, body: `${MARKER}\nsecond` },
        ],
      });
      const response = await run(upsert('comment-two', MARKER), fake.fetch);
      expect(response).toMatchObject({
        ok: false,
        error: { kind: 'conflict' },
        mutation: { op: 'comment.upsert', outcome: 'refused' },
      });
      expect(fake.calls.every(call => call.method === 'GET')).toBe(true);
    });

    test('a marked comment by another author cannot impersonate or block the canonical comment', async () => {
      const fake = fakeGitea({
        pulls: [pullLine({ number: 12 })],
        comments: [{ id: 1, body: MARKER, user: { login: 'mallory' } }],
        nextCommentId: 777,
      });
      const response = await run(upsert('comment-spoof', MARKER), fake.fetch);
      expect(response).toMatchObject({
        ok: true,
        result: {
          op: 'comment.upsert',
          value: {
            outcome: 'applied',
            changed: true,
            comment: { id: '777', bodyDigest: contentDigest(MARKER) },
          },
        },
      });
      // The spoof is neither patched nor counted: the plugin posts its own comment.
      expect(
        fake.calls.some(
          call => call.method === 'PATCH' && call.url === `${API}/repos/${REPO}/issues/comments/1`
        )
      ).toBe(false);
      expect(
        fake.calls.some(
          call => call.method === 'POST' && call.url === `${API}/repos/${REPO}/issues/12/comments`
        )
      ).toBe(true);
    });

    test('a spoofed marked comment does not conflict with the plugin\u0027s own marked comment', async () => {
      const fake = fakeGitea({
        pulls: [pullLine({ number: 12 })],
        comments: [
          { id: 1, body: MARKER, user: { login: 'mallory' } },
          { id: 402, body: `${MARKER}\nold report` },
        ],
        nextCommentId: 403,
      });
      const response = await run(upsert('comment-spoof-plus-own', MARKER), fake.fetch);
      expect(response).toMatchObject({
        ok: true,
        result: {
          op: 'comment.upsert',
          value: { outcome: 'applied', changed: true, comment: { id: '402' } },
        },
      });
      const patch = fake.calls.find(call => call.method === 'PATCH');
      expect(patch?.url).toBe(`${API}/repos/${REPO}/issues/comments/402`);
    });
  });
});
