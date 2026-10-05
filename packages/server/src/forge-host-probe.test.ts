/**
 * TDD spec (plan #14, test 17) — the vendor-agnostic forge-host connection
 * probe.
 *
 * GETs `https://<host>/api/v1/user` with the caller-supplied token
 * (`Authorization: token <token>`) and classifies the outcome:
 * - 200 JSON carrying a string `login` → `{ ok: true, login }`
 * - 401/403 → `{ ok: false, kind: 'bad_token', message: 'Token rejected by
 *   <host> (HTTP <status>).' }`
 * - fetch reject (DNS/conn refused) or the 10 s timeout →
 *   `{ ok: false, kind: 'unreachable', message }` stating the failure
 * - anything else (404 plain, 5xx, 200 without a usable login) →
 *   `{ ok: false, kind: 'not_gitea_api', message }`
 *
 * The token is caller-supplied and must never appear in any result. All
 * expectations are hand-written literals; the fetch is injected per test.
 */
import { describe, expect, mock, test } from 'bun:test';
import { testTimeout } from '@archon/paths/test-utils';
import { testForgeHostConnection, type ForgeHostProbeResult } from './forge-host-probe';

const HOST = 'code.core.ci';
const T = 'probe-token-xyz';

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function failKind(result: ForgeHostProbeResult): string {
  if (result.ok) throw new Error('expected a failed probe');
  return result.kind;
}

function failMessage(result: ForgeHostProbeResult): string {
  if (result.ok) throw new Error('expected a failed probe');
  return result.message;
}

describe('forge host connection probe', () => {
  test('200 JSON with a login → ok, and pins the exact request (URL, auth header, no query)', async () => {
    let seenUrl: string | undefined;
    let seenAuth: string | null | undefined;
    const fetchMock = mock(async (input: Request | string, init?: RequestInit) => {
      seenUrl = String(input);
      seenAuth = init?.headers ? new Headers(init.headers).get('authorization') : undefined;
      return jsonRes(200, { login: 'Hartmann', id: 7 });
    });
    const result = await testForgeHostConnection(HOST, T, {
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: true, login: 'Hartmann' });
    expect(seenUrl).toBe(`https://${HOST}/api/v1/user`);
    expect(seenAuth).toBe(`token ${T}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('401 → bad_token with the pinned message', async () => {
    const fetchMock = mock(async () => jsonRes(401, { message: 'bad credentials' }));
    const result = await testForgeHostConnection(HOST, T, {
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(result).toEqual({
      ok: false,
      kind: 'bad_token',
      message: `Token rejected by ${HOST} (HTTP 401).`,
    });
    expect(JSON.stringify(result)).not.toContain(T);
  });

  test('403 → bad_token with the pinned message', async () => {
    const fetchMock = mock(async () => jsonRes(403, { message: 'forbidden' }));
    const result = await testForgeHostConnection(HOST, T, {
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(result).toEqual({
      ok: false,
      kind: 'bad_token',
      message: `Token rejected by ${HOST} (HTTP 403).`,
    });
    expect(JSON.stringify(result)).not.toContain(T);
  });

  test('fetch reject (DNS/conn refused) → unreachable stating the connection failure', async () => {
    const fetchMock = mock(async () => {
      throw new TypeError('fetch failed');
    });
    const result = await testForgeHostConnection(HOST, T, {
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(failKind(result)).toBe('unreachable');
    expect(failMessage(result).toLowerCase()).toContain('unreachable');
    expect(JSON.stringify(result)).not.toContain(T);
  });

  test('timeout → unreachable stating the timeout', async () => {
    const fetchMock = mock(
      ((_input: Request | string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })) as unknown as typeof fetch
    );
    const result = await testForgeHostConnection(HOST, T, {
      fetch: fetchMock as unknown as typeof fetch,
      timeoutMs: 25,
    });
    expect(failKind(result)).toBe('unreachable');
    expect(failMessage(result).toLowerCase()).toContain('timeout');
    expect(JSON.stringify(result)).not.toContain(T);
  });

  test(
    'the default timeout is 10 s — the abort path carries 10000',
    async () => {
      // Hangs until the (default) 10 s abort fires; asserts the deadline through the
      // abort path instead of a test-only property on the signal.
      const fetchMock = mock(
        ((_input: Request | string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          })) as unknown as typeof fetch
      );
      const result = await testForgeHostConnection(HOST, T, {
        fetch: fetchMock as unknown as typeof fetch,
      });
      expect(failKind(result)).toBe('unreachable');
      expect(failMessage(result)).toBe(
        `Timeout: connection to ${HOST} did not complete within 10000 ms.`
      );
      expect(JSON.stringify(result)).not.toContain(T);
    },
    testTimeout(15_000)
  );

  test('404 plain text → not_gitea_api', async () => {
    const fetchMock = mock(async () => new Response('page not found', { status: 404 }));
    const result = await testForgeHostConnection(HOST, T, {
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(failKind(result)).toBe('not_gitea_api');
    expect(JSON.stringify(result)).not.toContain(T);
  });

  test('500 JSON → not_gitea_api with the status in the message', async () => {
    const fetchMock = mock(async () => jsonRes(500, { error: 'boom' }));
    const result = await testForgeHostConnection(HOST, T, {
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(failKind(result)).toBe('not_gitea_api');
    expect(failMessage(result)).toContain('500');
    expect(JSON.stringify(result)).not.toContain(T);
  });

  test('200 JSON without a usable login → not_gitea_api', async () => {
    const fetchMock = mock(async () => jsonRes(200, {}));
    const result = await testForgeHostConnection(HOST, T, {
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(failKind(result)).toBe('not_gitea_api');
    expect(JSON.stringify(result)).not.toContain(T);
  });
});
