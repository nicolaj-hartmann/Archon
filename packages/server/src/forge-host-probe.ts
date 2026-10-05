/**
 * Vendor-neutral forge-host connection probe behind `POST /api/forge-hosts/test`,
 * not a plugin's wire protocol: `GET https://<host>/api/v1/user` with
 * `Authorization: token <token>`, classified into ok / bad_token / unreachable /
 * not_gitea_api. The token appears in the request header only.
 */

export type ForgeHostProbeResult =
  | { ok: true; login: string }
  | {
      ok: false;
      kind: 'bad_token' | 'unreachable' | 'not_gitea_api';
      message: string;
    };

export interface TestForgeHostOptions {
  /** Injectable fetch (tests drive canned responses); defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Default 10 s. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function testForgeHostConnection(
  host: string,
  token: string,
  options: TestForgeHostOptions = {}
): Promise<ForgeHostProbeResult> {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await doFetch(`https://${host}/api/v1/user`, {
      headers: { authorization: `token ${token}` },
      signal,
    });
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        kind: 'bad_token',
        message: `Token rejected by ${host} (HTTP ${String(response.status)}).`,
      };
    }
    if (response.status === 200) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return {
          ok: false,
          kind: 'not_gitea_api',
          message: `${host} answered but not with a Gitea/Forgejo JSON API.`,
        };
      }
      if (
        typeof body === 'object' &&
        body !== null &&
        typeof (body as { login?: unknown }).login === 'string'
      ) {
        return { ok: true, login: (body as { login: string }).login };
      }
      return {
        ok: false,
        kind: 'not_gitea_api',
        message: `${host} answered but not with a Gitea/Forgejo JSON API.`,
      };
    }
    return {
      ok: false,
      kind: 'not_gitea_api',
      message: `Unexpected response from ${host}: HTTP ${String(response.status)}.`,
    };
  } catch (error) {
    if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      return {
        ok: false,
        kind: 'unreachable',
        message: `Timeout: connection to ${host} did not complete within ${String(timeoutMs)} ms.`,
      };
    }
    return {
      ok: false,
      kind: 'unreachable',
      message: `Host ${host} is unreachable (connection failed).`,
    };
  }
}
