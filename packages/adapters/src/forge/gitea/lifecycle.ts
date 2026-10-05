/**
 * Gitea's pull-request lifecycle operations.
 *
 * Every mutation here submits at most one write and then reads the result back
 * from Gitea before claiming it. The outcome a caller receives is decided by how
 * far the write got: nothing submitted is a refusal, a submitted request whose
 * answer was lost is unknown, and an acknowledged write whose read-back does not
 * agree is a verification failure carrying what may remain on the forge.
 *
 * Gitea's draft state is its title prefix: the vendor recomputes `draft` from
 * the instance-configurable `WorkInProgressPrefixes` (default `["WIP:", "[WIP]"]`,
 * case-insensitive) and exposes no `draft` write field. The vendor's own `draft`
 * field is the detector everywhere; the default prefix list is used only to post
 * a draft title and to strip it in `pr.ready`.
 */

import { z } from 'zod';
import {
  contentDigest,
  forgePrRecordSchema,
  mutationTarget,
  type ForgeCommentRecord,
  type ForgeError,
  type ForgeMutationFailure,
  type ForgeMutationRequest,
  type ForgePrRecord,
  type ForgeRequest,
  type ForgeResponse,
} from '@archon/forge/operations';
import type { PrRef, RepoRef } from '@archon/forge';
import {
  GiteaError,
  giteaErrorDetail,
  giteaPages,
  giteaRequest,
  location,
  repositoryPath,
  type Fetch,
} from './api';

const repoSchema = z.object({ full_name: z.string().min(1) });
const pullSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.url(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(['open', 'closed']),
  draft: z.boolean(),
  merged: z.boolean().optional(),
  allow_maintainer_edit: z.boolean().nullable().optional(),
  // Gitea always populates the head repository; it can be another repository on
  // the same instance (a fork).
  head: z.object({ ref: z.string().min(1), sha: z.string().min(1), repo: repoSchema }),
  base: z.object({ ref: z.string().min(1), sha: z.string().min(1) }),
});
type Pull = z.infer<typeof pullSchema>;
const commentSchema = z.object({
  id: z.union([z.number().int(), z.string().min(1)]),
  html_url: z.url(),
  body: z.string().nullable(),
  user: z.object({ login: z.string().min(1) }),
});
type Comment = z.infer<typeof commentSchema>;

// Gitea's default WorkInProgressPrefixes.
const DRAFT_PREFIXES = ['[WIP]', 'WIP:'];
const DRAFT_TITLE_PREFIX = 'WIP: ';

function failure(
  operationId: string,
  error: ForgeError,
  mutation?: ForgeMutationFailure
): ForgeResponse {
  return mutation ? { operationId, ok: false, error, mutation } : { operationId, ok: false, error };
}

async function readPull(fetchImpl: Fetch, token: string, ref: PrRef): Promise<Pull> {
  const { root, path } = location(ref.repo);
  return pullSchema.parse(
    await giteaRequest(fetchImpl, token, `${root}/repos/${path}/pulls/${String(ref.number)}`)
  );
}

function prRecord(repo: RepoRef, pull: Pull): ForgePrRecord {
  return forgePrRecordSchema.parse({
    schemaVersion: 1,
    repo,
    number: pull.number,
    url: pull.html_url,
    head: pull.head.ref,
    base: pull.base.ref,
    is_draft: pull.draft,
    state: pull.merged ? 'merged' : pull.state,
    head_repo: { host: repo.host, path: pull.head.repo.full_name },
    head_revision: pull.head.sha,
    base_revision: pull.base.sha,
    maintainer_can_modify: pull.allow_maintainer_edit ?? null,
  });
}

/**
 * Repository identity, compared the way Gitea registers it.
 *
 * Gitea echoes `owner/name` in its canonically-registered case whatever case a
 * request carried, so an exact comparison would read a pull request that was
 * created exactly as asked as one whose head repository disagrees.
 */
function sameRepo(left: RepoRef, right: RepoRef): boolean {
  return (
    left.host.toLowerCase() === right.host.toLowerCase() &&
    left.path.toLowerCase() === right.path.toLowerCase()
  );
}

function evidenceBase(request: ForgeMutationRequest): {
  op: typeof request.op;
  target: ReturnType<typeof mutationTarget>;
} {
  return { op: request.op, target: mutationTarget(request) };
}
function refused(
  request: ForgeMutationRequest,
  error: ForgeError,
  observed?: ForgePrRecord
): ForgeResponse {
  return failure(request.operationId, error, {
    ...evidenceBase(request),
    outcome: 'refused',
    ...(observed ? { observed } : {}),
  });
}
function unknown(request: ForgeMutationRequest, error: ForgeError): ForgeResponse {
  return failure(request.operationId, error, {
    ...evidenceBase(request),
    outcome: 'outcome_unknown',
  });
}
function unverified(
  request: ForgeMutationRequest,
  message: string,
  leaveBehind: string,
  observed?: { pr?: ForgePrRecord; comment?: ForgeCommentRecord }
): ForgeResponse {
  return failure(
    request.operationId,
    { kind: 'invalid_response', message },
    {
      ...evidenceBase(request),
      outcome: 'verification_failed',
      leaveBehind,
      ...(observed?.pr ? { observed: observed.pr } : {}),
      ...(observed?.comment ? { comment: observed.comment } : {}),
    }
  );
}
function applied(request: ForgeMutationRequest, value: object): ForgeResponse {
  return {
    operationId: request.operationId,
    ok: true,
    result: {
      op: request.op,
      value: { target: mutationTarget(request), outcome: 'applied', ...value },
    },
  } as ForgeResponse;
}

async function createPullRequest(
  request: Extract<ForgeMutationRequest, { op: 'pr.create' }>,
  fetchImpl: Fetch,
  token: string,
  submit: (phase: 'submitted' | 'acknowledged') => void
): Promise<ForgeResponse> {
  const headRepository = repositoryPath(request.headRepo.path);
  if (!headRepository) {
    return refused(request, {
      kind: 'invalid_request',
      message: `Invalid Gitea head repository path: ${request.headRepo.path}`,
    });
  }
  // A fork may live in another repository, never on another host: a cross-host
  // head would be posted to the base instance as `<owner>:<branch>`, where the
  // vendor resolves the owner locally and can open a PR from an unintended fork
  // before the read-back could notice.
  if (request.headRepo.host.toLowerCase() !== request.repo.host.toLowerCase()) {
    return refused(request, {
      kind: 'invalid_request',
      message: 'The head repository must live on the same host as the base repository',
    });
  }
  const sameRepository = sameRepo(request.headRepo, request.repo);
  // `head` is `<headOwner>:<branch>` across repositories: the vendor parses the
  // first segment as a user name, and a repository path there is rejected.
  const head = sameRepository ? request.head : `${headRepository.owner}:${request.head}`;
  const title = request.draft ? `${DRAFT_TITLE_PREFIX}${request.title}` : request.title;
  const { root, path } = location(request.repo);
  submit('submitted');
  const raw = await giteaRequest(
    fetchImpl,
    token,
    `${root}/repos/${path}/pulls`,
    {
      method: 'POST',
      body: JSON.stringify({ title, head, base: request.base, body: request.body }),
    },
    () => {
      submit('acknowledged');
    }
  );
  let created: Pull;
  try {
    created = pullSchema.parse(raw);
  } catch {
    return unverified(
      request,
      'Created pull request response was malformed',
      'a pull request may exist'
    );
  }
  const leaveBehind = `pull request ${String(created.number)} may exist`;
  let observed: Pull;
  try {
    observed = await readPull(fetchImpl, token, { repo: request.repo, number: created.number });
  } catch {
    return unverified(request, 'Created pull request could not be read back', leaveBehind);
  }
  const pr = prRecord(request.repo, observed);
  if (
    observed.title !== title ||
    (observed.body ?? '') !== request.body ||
    pr.head !== request.head ||
    pr.head_revision !== request.headRevision ||
    pr.head_repo === null ||
    !sameRepo(pr.head_repo, request.headRepo) ||
    pr.base !== request.base ||
    pr.is_draft !== request.draft ||
    pr.state !== 'open'
  ) {
    return unverified(request, 'Created pull request did not match requested fields', leaveBehind, {
      pr,
    });
  }
  return applied(request, { changed: true, pr });
}

async function editPullRequestBody(
  request: Extract<ForgeMutationRequest, { op: 'pr.edit-body' }>,
  fetchImpl: Fetch,
  token: string,
  submit: (phase: 'submitted' | 'acknowledged') => void
): Promise<ForgeResponse> {
  const before = await readPull(fetchImpl, token, request.ref);
  if ((before.body ?? '') === request.body) {
    return applied(request, {
      changed: false,
      pr: prRecord(request.ref.repo, before),
      bodyDigest: contentDigest(request.body),
    });
  }
  const { root, path } = location(request.ref.repo);
  // An empty body is a legitimate clear, not the absence of a field.
  submit('submitted');
  await giteaRequest(
    fetchImpl,
    token,
    `${root}/repos/${path}/pulls/${String(request.ref.number)}`,
    { method: 'PATCH', body: JSON.stringify({ body: request.body }) },
    () => {
      submit('acknowledged');
    }
  );
  const leaveBehind = 'the pull request body may have changed';
  let after: Pull;
  try {
    after = await readPull(fetchImpl, token, request.ref);
  } catch {
    return unverified(request, 'Updated pull request could not be read back', leaveBehind);
  }
  const pr = prRecord(request.ref.repo, after);
  return (after.body ?? '') === request.body
    ? applied(request, { changed: true, pr, bodyDigest: contentDigest(request.body) })
    : unverified(request, 'Pull request body read-back did not match', leaveBehind, { pr });
}

/**
 * Strip the draft prefix from a vendor-draft title, case-insensitively, longest
 * match first. The vendor ignores an empty title on edit, so a title that
 * strips to nothing cannot be made ready through this plugin; an unrecognized
 * prefix means the instance configured its own list, which no API exposes.
 */
function stripDraftTitle(
  title: string
): { title: string } | { empty: true } | { unrecognized: true } {
  const lower = title.toLowerCase();
  for (const prefix of DRAFT_PREFIXES) {
    if (lower.startsWith(prefix.toLowerCase())) {
      const rest = title.slice(prefix.length).replace(/^ /, '');
      return rest === '' ? { empty: true } : { title: rest };
    }
  }
  return { unrecognized: true };
}

async function markReady(
  request: Extract<ForgeMutationRequest, { op: 'pr.ready' }>,
  fetchImpl: Fetch,
  token: string,
  submit: (phase: 'submitted' | 'acknowledged') => void
): Promise<ForgeResponse> {
  const before = await readPull(fetchImpl, token, request.ref);
  const beforeRecord = prRecord(request.ref.repo, before);
  if (beforeRecord.state === 'merged') {
    return refused(
      request,
      { kind: 'conflict', message: 'A merged pull request cannot be marked ready' },
      beforeRecord
    );
  }
  if (beforeRecord.state === 'closed') {
    return refused(
      request,
      { kind: 'conflict', message: 'A closed pull request cannot be marked ready' },
      beforeRecord
    );
  }
  if (!beforeRecord.is_draft) return applied(request, { changed: false, pr: beforeRecord });

  const stripped = stripDraftTitle(before.title);
  if ('unrecognized' in stripped) {
    return refused(request, {
      kind: 'conflict',
      message:
        'This pull request is a draft without a recognized WIP title prefix; clear the draft state manually',
    });
  }
  if ('empty' in stripped) {
    return refused(request, {
      kind: 'conflict',
      message: 'The draft title strips to an empty title; set a title before marking ready',
    });
  }
  const { root, path } = location(request.ref.repo);
  submit('submitted');
  // Title editing is the only mechanism Gitea offers for clearing draft state.
  await giteaRequest(
    fetchImpl,
    token,
    `${root}/repos/${path}/pulls/${String(request.ref.number)}`,
    { method: 'PATCH', body: JSON.stringify({ title: stripped.title }) },
    () => {
      submit('acknowledged');
    }
  );
  const leaveBehind = 'the pull request draft state may have changed';
  let after: Pull;
  try {
    after = await readPull(fetchImpl, token, request.ref);
  } catch {
    return unverified(request, 'Ready pull request could not be read back', leaveBehind);
  }
  const pr = prRecord(request.ref.repo, after);
  return pr.state === 'open' && !pr.is_draft
    ? applied(request, { changed: true, pr })
    : unverified(request, 'Ready read-back did not match', leaveBehind, { pr });
}

function commentRecord(ref: PrRef, comment: Comment): ForgeCommentRecord {
  return {
    ref,
    id: String(comment.id),
    url: comment.html_url,
    bodyDigest: contentDigest(comment.body ?? ''),
  };
}

async function upsertComment(
  request: Extract<ForgeMutationRequest, { op: 'comment.upsert' }>,
  fetchImpl: Fetch,
  token: string,
  submit: (phase: 'submitted' | 'acknowledged') => void
): Promise<ForgeResponse> {
  // The marker is how the canonical comment is found again next round, so a body
  // that does not carry it would silently create a second report.
  if ((request.body.split(/\r?\n/, 1)[0] ?? '') !== request.marker) {
    return refused(request, {
      kind: 'invalid_request',
      message: 'Comment body must begin with the exact canonical marker',
    });
  }
  // Gitea serves pull-request threads through the issues endpoint, which also
  // accepts ordinary issue numbers. The pulls route is what proves the target
  // is a pull request; without it an ordinary issue becomes a comment target.
  try {
    await readPull(fetchImpl, token, request.ref);
  } catch (cause) {
    if (cause instanceof GiteaError && cause.detail.kind === 'not_found') {
      return refused(request, {
        kind: 'invalid_request',
        message: `The comment target ${String(request.ref.number)} is not a pull request`,
      });
    }
    throw cause;
  }
  const { root, path } = location(request.ref.repo);
  const issue = `${root}/repos/${path}/issues/${String(request.ref.number)}`;
  // Gitea serves pull-request threads through the issues endpoint.
  const comments = await giteaPages(
    fetchImpl,
    token,
    `${issue}/comments`,
    raw => z.array(commentSchema).parse(raw),
    row => String(row.id)
  );
  // The marker is public in the comment body, so a marker-only match would let
  // anyone who can comment impersonate the canonical comment and block its
  // updates; only a comment this token itself wrote can be canonical.
  const self = z
    .object({ login: z.string().min(1) })
    .parse(await giteaRequest(fetchImpl, token, `${root}/user`));
  const marked = comments.filter(
    comment =>
      (comment.body ?? '').split(/\r?\n/, 1)[0] === request.marker &&
      comment.user.login.toLowerCase() === self.login.toLowerCase()
  );
  if (marked.length > 1) {
    return refused(request, {
      kind: 'conflict',
      message: 'Multiple comments on this pull request carry the canonical marker',
    });
  }
  const previous = marked[0];
  if (previous && (previous.body ?? '') === request.body) {
    // The listing is the read-back: the canonical comment already carries this body.
    return applied(request, { changed: false, comment: commentRecord(request.ref, previous) });
  }
  submit('submitted');
  const raw = await giteaRequest(
    fetchImpl,
    token,
    previous ? `${root}/repos/${path}/issues/comments/${String(previous.id)}` : `${issue}/comments`,
    { method: previous ? 'PATCH' : 'POST', body: JSON.stringify({ body: request.body }) },
    () => {
      submit('acknowledged');
    }
  );
  let written: Comment;
  try {
    written = commentSchema.parse(raw);
  } catch {
    return unverified(
      request,
      'Comment write response was malformed',
      'a comment may have changed'
    );
  }
  const leaveBehind = `comment ${String(written.id)} may have changed`;
  let observed: Comment;
  try {
    observed = commentSchema.parse(
      await giteaRequest(
        fetchImpl,
        token,
        `${root}/repos/${path}/issues/comments/${String(written.id)}`
      )
    );
  } catch {
    return unverified(request, 'Comment could not be read back', leaveBehind);
  }
  const comment = commentRecord(request.ref, observed);
  if (String(observed.id) !== String(written.id) || (observed.body ?? '') !== request.body) {
    return unverified(request, 'Comment read-back did not match', leaveBehind, { comment });
  }
  return applied(request, { changed: true, comment });
}

export async function handleGiteaMutation(
  request: ForgeMutationRequest,
  fetchImpl: Fetch,
  token: string
): Promise<ForgeResponse> {
  const progress: { phase: 'not_submitted' | 'submitted' | 'acknowledged' } = {
    phase: 'not_submitted',
  };
  const submit = (next: 'submitted' | 'acknowledged'): void => {
    progress.phase = next;
  };
  try {
    switch (request.op) {
      case 'pr.create':
        return await createPullRequest(request, fetchImpl, token, submit);
      case 'pr.edit-body':
        return await editPullRequestBody(request, fetchImpl, token, submit);
      case 'pr.ready':
        return await markReady(request, fetchImpl, token, submit);
      case 'comment.upsert':
        return await upsertComment(request, fetchImpl, token, submit);
    }
  } catch (cause) {
    const error = giteaErrorDetail(cause);
    if (progress.phase === 'acknowledged')
      return unverified(request, error.message, 'the acknowledged write may remain');
    if (progress.phase === 'submitted' && !(cause instanceof GiteaError && cause.definitiveRefusal))
      return unknown(request, error);
    return refused(request, error);
  }
}

export async function handleGiteaPrView(
  request: Extract<ForgeRequest, { op: 'pr.view' }>,
  fetchImpl: Fetch,
  token: string
): Promise<ForgeResponse> {
  const view = (pull: Pull | undefined, repo: RepoRef): ForgeResponse => ({
    operationId: request.operationId,
    ok: true,
    result: {
      op: 'pr.view',
      value: pull ? { pr: prRecord(repo, pull), title: pull.title, body: pull.body ?? '' } : null,
    },
  });
  if (request.selector.kind === 'number') {
    return view(await readPull(fetchImpl, token, request.selector.ref), request.selector.ref.repo);
  }
  const selector = request.selector;
  const { root, path } = location(selector.repo);
  // Gitea's `head=` filter matches only a bare branch name — an owner-qualified
  // value matches nothing — so the head repository is matched client-side, and
  // the explicit `limit=30` keeps the single-fetch contract instance-independent.
  const query = `state=open&head=${encodeURIComponent(selector.head)}&limit=30`;
  const matches = z
    .array(pullSchema)
    .parse(await giteaRequest(fetchImpl, token, `${root}/repos/${path}/pulls?${query}`));
  const candidates = matches.filter(
    row => row.head.repo.full_name.toLowerCase() === selector.headRepo.path.toLowerCase()
  );
  if (candidates.length > 1) {
    return failure(request.operationId, {
      kind: 'conflict',
      message: 'Pull request head selector matched more than one pull request',
    });
  }
  return view(candidates[0], selector.repo);
}
