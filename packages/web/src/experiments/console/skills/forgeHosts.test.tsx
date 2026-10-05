/**
 * TDD spec (plan #14, tests 18–19) — the forge-hosts skill verbs and the
 * ForgeHostsPanel / SettingsPage mount.
 *
 * The panel reads a caller-supplied token, so the only credentials that ever
 * travel are in request bodies — never in a URL — and the list payload carries
 * host metadata only. Static markup renders: the pinned success/failure lines,
 * the populated / empty / 401 / loading / list-error states, the
 * presentational card's per-affordance busy copy, result-line colors, and the
 * SettingsPage mount beside GithubIdentityPanel.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import {
  forgeHostTestLine,
  listForgeHosts,
  removeForgeHost,
  saveForgeHost,
  testForgeHost,
  type ForgeHostTestResult,
} from './forgeHosts';
import {
  ForgeHostsCard,
  ForgeHostsPanel,
  type ForgeHostsCardProps,
} from '../components/ForgeHostsPanel';
import { SettingsPage } from '../routes/SettingsPage';
import { K } from '../store/keys';
import { invalidate, set, subscribeKey } from '../store/cache';
import { HttpError } from '../lib/http';
import { INPUT_CLASS } from '../components/SettingsFormPrimitives';

const TOKEN = 'ostentatious-fixture-token';

// ---------------------------------------------------------------------------
// Skill verbs
// ---------------------------------------------------------------------------

interface Captured {
  url: string;
  method: string;
  body: string | undefined;
}

const originalFetch = globalThis.fetch;
let calls: Captured[];

function stubFetch(
  listPayload: unknown,
  testPayload: unknown,
  putPayload: unknown,
  deletePayload: unknown
): void {
  calls = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input.href : input instanceof Request ? input.url : input;
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });
    const payload = url.includes('/api/forge-hosts/test')
      ? testPayload
      : url === '/api/forge-hosts' || method === 'GET'
        ? listPayload
        : method === 'PUT'
          ? putPayload
          : deletePayload;
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  }) as typeof fetch;
}

describe('forge-hosts skill verbs', () => {
  beforeEach(() => {
    stubFetch(
      { hosts: [] },
      { ok: true, login: 'Hartmann' },
      { success: true, host: 'code.core.ci' },
      { success: true }
    );
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('listForgeHosts → GET /api/forge-hosts', async () => {
    const list = await listForgeHosts();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/forge-hosts');
    expect(calls[0].method).toBe('GET');
    // The list response carries metadata only — the token never appears in it.
    expect(JSON.stringify(list)).not.toContain(TOKEN);
  });

  test('testForgeHost → POST /api/forge-hosts/test with the token in the body, never the URL', async () => {
    const result = await testForgeHost('code.core.ci', TOKEN);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/forge-hosts/test');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).not.toContain(TOKEN);
    expect(calls[0].body).toBe(JSON.stringify({ host: 'code.core.ci', token: TOKEN }));
    expect(result).toEqual({ ok: true, login: 'Hartmann' });
  });

  test('saveForgeHost → PUT /api/forge-hosts/:host with a percent-encoded host', async () => {
    await saveForgeHost('code.core.ci', TOKEN);
    expect(calls[0].url).toBe('/api/forge-hosts/code.core.ci');
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].url).not.toContain(TOKEN);
    expect(calls[0].body).toBe(JSON.stringify({ token: TOKEN }));

    calls = [];
    await saveForgeHost('code.core.ci:3000', TOKEN);
    expect(calls[0].url).toBe('/api/forge-hosts/code.core.ci%3A3000');
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].url).not.toContain(TOKEN);
  });

  test('removeForgeHost → DELETE /api/forge-hosts/:host with no body', async () => {
    await removeForgeHost('code.core.ci');
    expect(calls[0].url).toBe('/api/forge-hosts/code.core.ci');
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).not.toContain(TOKEN);
    expect(calls[0].body ?? null).toBeNull();
  });

  test('the token never appears in any request URL', async () => {
    await listForgeHosts();
    await testForgeHost('code.core.ci', TOKEN);
    await saveForgeHost('code.core.ci', TOKEN);
    await removeForgeHost('code.core.ci');
    for (const call of calls) expect(call.url).not.toContain(TOKEN);
  });
});

// ---------------------------------------------------------------------------
// Test-line mapping (pinned operator-facing lines)
// ---------------------------------------------------------------------------

describe('forgeHostTestLine', () => {
  test('pins the success and every failure line verbatim', () => {
    const ok: ForgeHostTestResult = { ok: true, login: 'Hartmann' };
    expect(forgeHostTestLine(ok, 'code.core.ci')).toBe('Connects as @Hartmann on code.core.ci.');

    const badToken: ForgeHostTestResult = {
      ok: false,
      kind: 'bad_token',
      message: 'Token rejected by code.core.ci (HTTP 401).',
    };
    expect(forgeHostTestLine(badToken, 'code.core.ci')).toBe(
      'Token rejected by code.core.ci (HTTP 401).'
    );

    const unreachable: ForgeHostTestResult = {
      ok: false,
      kind: 'unreachable',
      message: 'dns lookup failed',
    };
    expect(forgeHostTestLine(unreachable, 'code.core.ci')).toBe(
      'code.core.ci is unreachable — check the hostname and that this server can reach it.'
    );

    const notGitea: ForgeHostTestResult = {
      ok: false,
      kind: 'not_gitea_api',
      message: 'plain 404',
    };
    expect(forgeHostTestLine(notGitea, 'code.core.ci')).toBe(
      'code.core.ci is reachable but does not serve a Gitea/Forgejo API (expected /api/v1/user).'
    );
  });
});

// ---------------------------------------------------------------------------
// Panel + mount
// ---------------------------------------------------------------------------

describe('ForgeHostsPanel and SettingsPage mount', () => {
  test('populated list: host rendered mono with a Remove button, no token-claim text, no token value', () => {
    set(K.forgeHosts, {
      hosts: [
        {
          host: 'code.core.ci',
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-02-02T00:00:00Z',
        },
      ],
    });
    const html = renderToStaticMarkup(<ForgeHostsPanel />);
    expect(html).toContain('Forge Hosts');
    expect(html).toContain('code.core.ci');
    expect(html).toContain('Remove');
    // No "token stored" claim text, and no credential material in the markup.
    expect(html).not.toContain('token stored');
    expect(html).not.toContain(TOKEN);
    expect(html).not.toContain('secret-token-value');
  });

  test('pinned intro line, aria-labelled inputs, the secret input, and the Test connection verb', () => {
    set(K.forgeHosts, { hosts: [] });
    const html = renderToStaticMarkup(<ForgeHostsPanel />);
    // The pinned intro line: fallback precedence, stated, plus the test scope.
    expect(html).toContain(
      'Self-hosted Gitea/Forgejo instances whose token is stored on this install. A stored token is a fallback: an environment credential named by the forge config always wins for its host. Test connection is Gitea/Forgejo-only.'
    );
    // Inputs are aria-labelled (no visible <label> per the deviation-9 fix).
    expect(html).toContain('aria-label="Forge host hostname"');
    expect(html).toContain('aria-label="Forge host token"');
    // The token input is a secret field: type=password, no autofill.
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain('Test connection');
    expect(html).toContain('Save host');
  });

  test('empty list renders the pinned empty line', () => {
    set(K.forgeHosts, { hosts: [] });
    const html = renderToStaticMarkup(<ForgeHostsPanel />);
    expect(html).toContain('No forge hosts added.');
    expect(html).not.toContain('Remove');
  });

  test('401 (no signed-in web user) renders the pinned sign-in line', async () => {
    invalidate(K.forgeHosts);
    const unsubscribe = subscribeKey(
      K.forgeHosts,
      () => undefined,
      () =>
        Promise.reject(
          new HttpError(401, '/api/forge-hosts', '{"error":"Web authentication required"}')
        )
    );
    try {
      // Let the rejecting loader settle into the cache's error slot.
      await new Promise(resolve => setTimeout(resolve, 0));
      const html = renderToStaticMarkup(<ForgeHostsPanel />);
      expect(html).toContain('Sign in to manage forge hosts.');
      expect(html).not.toContain('Remove');
    } finally {
      unsubscribe();
      invalidate(K.forgeHosts);
    }
  });

  test('SettingsPage mounts the panel beside GitHub Identity', () => {
    // Every panel's first render is its static title; no loader needs to settle.
    const original = globalThis.fetch;
    // Never settles: the static mount renders before any loader resolves.
    const pending = new Promise<Response>(() => undefined);
    globalThis.fetch = (() => pending) as unknown as typeof fetch;
    try {
      const html = renderToStaticMarkup(
        <MemoryRouter>
          <SettingsPage />
        </MemoryRouter>
      );
      expect(html).toContain('GitHub Identity');
      expect(html).toContain('Forge Hosts');
      // Mounted after GitHub Identity (the panel's scope in SettingsPage).
      expect(html.indexOf('Forge Hosts')).toBeGreaterThan(html.indexOf('GitHub Identity'));
    } finally {
      globalThis.fetch = original;
    }
  });

  test('list loading renders the loading line, not the empty list', () => {
    invalidate(K.forgeHosts);
    const unsubscribe = subscribeKey(
      K.forgeHosts,
      () => undefined,
      () => new Promise<Response>(() => undefined)
    );
    try {
      const html = renderToStaticMarkup(<ForgeHostsPanel />);
      expect(html).toContain('Loading…');
      expect(html).not.toContain('No forge hosts added.');
    } finally {
      unsubscribe();
      invalidate(K.forgeHosts);
    }
  });

  test('list error (non-401) surfaces errorDetail in the error slot', async () => {
    invalidate(K.forgeHosts);
    const unsubscribe = subscribeKey(
      K.forgeHosts,
      () => undefined,
      () => Promise.reject(new HttpError(500, '/api/forge-hosts', '{"error":"boom-500"}'))
    );
    try {
      // Let the rejecting loader settle into the cache's error slot.
      await new Promise(resolve => setTimeout(resolve, 0));
      const html = renderToStaticMarkup(<ForgeHostsPanel />);
      expect(html).toContain('boom-500');
      expect(html).toContain('text-error');
      expect(html).not.toContain('Sign in to manage forge hosts.');
      expect(html).not.toContain('Loading…');
    } finally {
      unsubscribe();
      invalidate(K.forgeHosts);
    }
  });
});

// ---------------------------------------------------------------------------
// Presentational card — per-affordance busy state and result lines
// ---------------------------------------------------------------------------

describe('ForgeHostsCard (presentational)', () => {
  const cardHosts = [
    {
      host: 'code.core.ci',
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    },
    {
      host: 'gitea.example.dev',
      created_at: '2025-01-02T00:00:00Z',
      updated_at: '2025-01-02T00:00:00Z',
    },
  ];

  function cardHtml(overrides: Partial<ForgeHostsCardProps> = {}): string {
    return renderToStaticMarkup(
      <ForgeHostsCard
        hosts={cardHosts}
        host=""
        token=""
        testing={false}
        saving={false}
        removingHost={null}
        result={null}
        onHostChange={() => undefined}
        onTokenChange={() => undefined}
        onTest={() => undefined}
        onSave={() => undefined}
        onRemove={() => undefined}
        {...overrides}
      />
    );
  }

  test('busy copy is per-affordance: each in-flight state renames only its own button', () => {
    const checking = cardHtml({ testing: true });
    expect(checking).toContain('Checking…');
    expect(checking).toContain('Save host'); // save is not in flight
    expect(checking).toContain('Remove'); // rows are not in flight

    const saving = cardHtml({ saving: true });
    expect(saving).toContain('Saving…');
    expect(saving).toContain('Test connection'); // test is not in flight
    expect(saving).toContain('Remove');
  });

  test('per-row remove: the in-flight row renames, the other row stays removable', () => {
    const html = cardHtml({ removingHost: 'code.core.ci' });
    expect(html).toContain('Removing…');
    expect(html).toContain('code.core.ci');
    expect(html).toContain('gitea.example.dev');
    // The untouched row still offers Remove — the affordance is per row.
    expect(html).toContain('Remove');
    // No cross-affordance effect: the form buttons are idle.
    expect(html).toContain('Test connection');
    expect(html).toContain('Save host');
  });

  test('result line: pinned strings under role=status with success/error color', () => {
    const ok = cardHtml({
      result: { kind: 'success', text: 'Connects as @Hartmann on code.core.ci.' },
    });
    expect(ok).toContain('Connects as @Hartmann on code.core.ci.');
    expect(ok).toContain('role="status"');
    expect(ok).toContain('text-success');
    expect(ok).not.toContain('text-error');

    const fail = cardHtml({
      result: {
        kind: 'failure',
        text: 'code.core.ci is unreachable — check the hostname and that this server can reach it.',
      },
    });
    expect(fail).toContain(
      'code.core.ci is unreachable — check the hostname and that this server can reach it.'
    );
    expect(fail).toContain('role="status"');
    expect(fail).toContain('text-error');
    expect(fail).not.toContain('text-success');
  });

  test('pinned placeholders and the house INPUT_CLASS on both inputs', () => {
    const html = cardHtml();
    expect(html).toContain('placeholder="code.example.com"');
    expect(html).toContain('placeholder="Paste the Gitea/Forgejo token"');
    // Both the hostname and the token input use the shared input class, verbatim.
    expect(html.split(INPUT_CLASS).length - 1).toBe(2);
  });

  test('empty fields disable both form buttons; filled fields re-enable them', () => {
    const disabledButtons = (html: string): number => (html.match(/disabled=""/g) ?? []).length;

    const idle = cardHtml();
    expect(idle).toContain('Test connection');
    expect(idle).toContain('Save host');
    expect(disabledButtons(idle)).toBe(2);

    const active = cardHtml({ host: 'code.core.ci', token: 'typed-token' });
    expect(disabledButtons(active)).toBe(0);
    // The typed token sits only in the controlled input's value, which an
    // operator expects — and nowhere else in the card.
    expect(active.split('typed-token').length - 1).toBe(1);
  });
});
