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

export function listForgeHosts(): Promise<ForgeHostList> {
  return requestJson<ForgeHostList>('/api/forge-hosts');
}

export function testForgeHost(host: string, token: string): Promise<ForgeHostTestResult> {
  return requestJson<ForgeHostTestResult>('/api/forge-hosts/test', {
    method: 'POST',
    body: JSON.stringify({ host, token }),
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
