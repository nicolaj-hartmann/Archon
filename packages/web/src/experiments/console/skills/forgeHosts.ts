/**
 * Forge-host credential verbs. The token travels only in request bodies — never
 * in a URL — and the list payload carries host metadata only.
 */
import { requestJson } from '../lib/http';

/** One stored forge host — no credential material. */
export interface ForgeHostMeta {
  host: string;
  created_at: string;
  updated_at: string;
}

/** GET /api/forge-hosts payload. */
export interface ForgeHostList {
  hosts: ForgeHostMeta[];
}

/** The server-side probe result (GET <host>/api/v1/user with the token). */
export type ForgeHostTestResult =
  | { ok: true; login: string }
  | { ok: false; kind: 'bad_token' | 'unreachable' | 'not_gitea_api'; message: string };

/**
 * The client-side bound on Test connection: 2× the server probe's bound
 * (10 s DEFAULT_TIMEOUT_MS in packages/server/src/forge-host-probe.ts). The
 * server bound is authoritative; the race only guards a stalled server
 * response (ux.md D9).
 */
export const FORGE_HOST_TEST_TIMEOUT_MS = 20_000;

/** The pinned failure line when the client-side bound wins the race (ux.md §4.3). */
export const FORGE_HOST_TEST_TIMEOUT_LINE =
  'The connection test timed out. The instance is unreachable from this install or did not answer in time.';

export function listForgeHosts(): Promise<ForgeHostList> {
  return requestJson<ForgeHostList>('/api/forge-hosts');
}

/**
 * Test the draft's connection. The host travels trimmed — the server rejects
 * whitespace in the test body, so the console trims at its own boundary before
 * the server normalizes. Bounded client-side (ux.md D9); a stalled request
 * settles with FORGE_HOST_TEST_TIMEOUT_LINE instead of hanging on Checking….
 */
export function testForgeHost(
  host: string,
  token: string,
  options: { timeoutMs?: number } = {}
): Promise<ForgeHostTestResult> {
  const request = requestJson<ForgeHostTestResult>('/api/forge-hosts/test', {
    method: 'POST',
    body: JSON.stringify({ host: host.trim(), token }),
  });
  const timeoutMs = options.timeoutMs ?? FORGE_HOST_TEST_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(FORGE_HOST_TEST_TIMEOUT_LINE));
    }, timeoutMs);
  });
  return Promise.race([request, bound]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export function saveForgeHost(
  host: string,
  token: string
): Promise<{ success: boolean; host: string }> {
  return requestJson<{ success: boolean; host: string }>(
    `/api/forge-hosts/${encodeURIComponent(host)}`,
    {
      method: 'PUT',
      body: JSON.stringify({ token }),
    }
  );
}

export function removeForgeHost(host: string): Promise<{ success: boolean }> {
  return requestJson<{ success: boolean }>(`/api/forge-hosts/${encodeURIComponent(host)}`, {
    method: 'DELETE',
  });
}

/** The operator-facing one-liner for a probe result. */
export function forgeHostTestLine(result: ForgeHostTestResult, host: string): string {
  if (result.ok) return `Connects as @${result.login} on ${host}.`;
  if (result.kind === 'bad_token') return result.message;
  if (result.kind === 'unreachable') {
    return `${host} is unreachable — check the hostname and that this server can reach it.`;
  }
  return `${host} is reachable but does not serve a Gitea/Forgejo API (expected /api/v1/user).`;
}
