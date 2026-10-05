/** The Gitea REST boundary shared by this plugin's read and write operations. */

import { z } from 'zod';
import type { ForgeError } from '@archon/forge/operations';
import type { RepoRef } from '@archon/forge';

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class GiteaError extends Error {
  constructor(
    readonly detail: ForgeError,
    /**
     * Whether Gitea decided against the request rather than losing it. A 4xx is
     * Gitea's own answer, so nothing was written; anything else leaves a
     * submitted write's fate unknown.
     */
    readonly definitiveRefusal = false,
    options?: ErrorOptions
  ) {
    super(detail.message, options);
  }
}

export function repositoryPath(path: string): { owner: string; repo: string } | null {
  const parts = path.replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length !== 2 || parts.some(part => part === '' || part === '.' || part === '..')) {
    return null;
  }
  const owner = parts[0];
  const repo = parts[1].endsWith('.git') ? parts[1].slice(0, -4) : parts[1];
  return owner && repo ? { owner, repo } : null;
}

/**
 * Gitea serves its API under `/api/v1` on its own host — no vendor special cases.
 * The host may carry a port; the port is transport and stays in the root.
 */
export function apiRoot(host: string): string {
  let parsed: URL;
  try {
    parsed = new URL(`https://${host}`);
  } catch (cause) {
    throw new GiteaError(
      { kind: 'invalid_request', message: `Invalid Gitea host: ${host}` },
      true,
      { cause }
    );
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new GiteaError({ kind: 'invalid_request', message: `Invalid Gitea host: ${host}` }, true);
  }
  return `https://${parsed.host}/api/v1`;
}

/** The API root and encoded `owner/repo` segment for one qualified repository. */
export function location(repo: RepoRef): { root: string; path: string } {
  const parsed = repositoryPath(repo.path);
  if (!parsed) {
    throw new GiteaError(
      { kind: 'invalid_request', message: `Invalid Gitea repository path: ${repo.path}` },
      true
    );
  }
  return {
    root: apiRoot(repo.host),
    path: `${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`,
  };
}

/**
 * One Gitea API call.
 *
 * A 404 is decided on the status before the body is parsed: Gitea answers an
 * unmatched route with plain text and a missing resource with JSON, and both are
 * the same `not_found`. `acknowledge` runs once Gitea has answered with a
 * success status, the moment a write stops being merely submitted and becomes
 * one whose effect must be verified rather than guessed at.
 */
export async function giteaRequest(
  fetchImpl: Fetch,
  token: string,
  url: string,
  init: RequestInit = {},
  acknowledge?: () => void
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      headers: {
        accept: 'application/json',
        authorization: `token ${token}`,
        'content-type': 'application/json',
        'user-agent': 'archon-forge-gitea',
      },
    });
  } catch (cause) {
    throw new GiteaError({ kind: 'forge_error', message: 'Gitea API request failed' }, false, {
      cause,
    });
  }
  if (!response.ok) {
    throw new GiteaError(
      {
        kind:
          response.status === 404
            ? 'not_found'
            : response.status === 401 || response.status === 403
              ? 'authorization'
              : response.status === 409 || response.status === 422
                ? 'conflict'
                : 'forge_error',
        message: `Gitea API request failed with HTTP ${String(response.status)}`,
        status: response.status,
      },
      response.status >= 400 && response.status < 500
    );
  }
  acknowledge?.();
  try {
    return await response.json();
  } catch (cause) {
    throw new GiteaError(
      { kind: 'forge_error', message: 'Gitea API returned invalid JSON' },
      false,
      { cause }
    );
  }
}

/**
 * Gitea list pagination.
 *
 * The instance silently caps `limit` to its `max_response_items` (observed 50),
 * and a short page is not the end of the list: an empty page is. The
 * `x-total-count` header is sent and never trusted. A second stop is needed
 * because Forgejo 16.0.1's issue-comments listing answers out-of-range pages
 * with the first page again (D14 smoke, code.core.ci) and never serves the
 * empty page: a page without a new item id ends the walk. The caller names
 * the per-row identity; only new rows are collected, so a repeated page
 * neither hangs the walk nor duplicates a row.
 */
export async function giteaPages<T>(
  fetchImpl: Fetch,
  token: string,
  baseUrl: string,
  readPage: (value: unknown) => readonly T[],
  key: (row: T) => string
): Promise<T[]> {
  const values: T[] = [];
  const seen = new Set<string>();
  for (let page = 1; ; page++) {
    const rows = readPage(
      await giteaRequest(fetchImpl, token, `${baseUrl}?limit=30&page=${String(page)}`)
    );
    if (rows.length === 0) return values;
    const fresh = rows.filter(row => {
      const id = key(row);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    values.push(...fresh);
    if (fresh.length === 0) return values;
  }
}

export function parseRemote(remote: string | null): RepoRef | null {
  if (remote === null || remote.trim() === '') return null;
  const value = remote.trim();

  if (value.includes('://')) {
    let url: URL;
    try {
      url = new URL(value);
    } catch (cause) {
      throw new GiteaError(
        { kind: 'invalid_request', message: 'Gitea remote is not a valid URL' },
        true,
        { cause }
      );
    }
    if (!['https:', 'ssh:'].includes(url.protocol)) return null;
    if (url.password !== '' || (url.protocol === 'https:' && url.username !== '')) {
      throw new GiteaError(
        { kind: 'invalid_request', message: 'Gitea remote must not contain credentials' },
        true
      );
    }
    if (url.search !== '' || url.hash !== '') {
      throw new GiteaError(
        {
          kind: 'invalid_request',
          message: 'Gitea remote must not contain a query or fragment',
        },
        true
      );
    }
    const repository = repositoryPath(decodeURIComponent(url.pathname));
    if (!repository) return null;
    return { host: url.host.toLowerCase(), path: `${repository.owner}/${repository.repo}` };
  }

  // Git's SCP-like SSH form has no URL scheme. Its optional user is transport identity,
  // not an HTTP credential, and is deliberately discarded at this normalization boundary.
  const match = /^(?:[^@/:\s]+@)?([^/:\s]+):(.+)$/.exec(value);
  if (!match) return null;
  const repository = repositoryPath(match[2]);
  if (!repository) return null;
  return { host: match[1].toLowerCase(), path: `${repository.owner}/${repository.repo}` };
}

/** Translate a thrown cause into the wire error a caller can act on. */
export function giteaErrorDetail(cause: unknown): ForgeError {
  if (cause instanceof GiteaError) return cause.detail;
  if (cause instanceof z.ZodError) {
    return {
      kind: 'forge_error',
      message: `Gitea API response did not match its documented shape: ${cause.issues[0]?.message ?? 'invalid response'}`,
    };
  }
  return {
    kind: 'forge_error',
    message: cause instanceof Error ? cause.message : String(cause),
  };
}
