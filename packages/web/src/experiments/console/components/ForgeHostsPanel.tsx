import { useState, type ReactElement, type FormEvent } from 'react';
import {
  listForgeHosts,
  testForgeHost,
  saveForgeHost,
  removeForgeHost,
  forgeHostTestLine,
  type ForgeHostList,
  type ForgeHostMeta,
} from '../skills/forgeHosts';
import { useEntity, invalidate } from '../store/cache';
import { K } from '../store/keys';
import { HttpError, errorDetail } from '../lib/http';
import { useCancelledRef } from '../lib/use-cancelled-ref';
import { INPUT_CLASS } from './SettingsFormPrimitives';
import { SettingsSection } from './SettingsSection';

/** Pinned intro line: fallback precedence + test scope. */
const INTRO =
  'Self-hosted Gitea/Forgejo instances whose token is stored on this install. ' +
  'A stored token is a fallback: an environment credential named by the forge config ' +
  'always wins for its host. Test connection is Gitea/Forgejo-only.';

const GHOST_BUTTON =
  'shrink-0 rounded border border-border px-2.5 py-1 text-[11px] text-text-secondary transition-colors hover:border-border-bright hover:text-text-primary disabled:opacity-40';

/** One operator-facing line under the form: the probe outcome or an operation error. */
export interface ForgeHostsResultLine {
  kind: 'success' | 'failure';
  text: string;
}

/**
 * Settle one host's removal: the remaining hosts stay in flight — a single
 * shared "clear all" would void the second row's busy state mid-removal.
 */
export function settleRemoval(hosts: ReadonlySet<string>, host: string): ReadonlySet<string> {
  const next = new Set(hosts);
  next.delete(host);
  return next;
}

export interface ForgeHostsCardProps {
  hosts: readonly ForgeHostMeta[];
  host: string;
  token: string;
  testing: boolean;
  saving: boolean;
  removingHosts: ReadonlySet<string>;
  result: ForgeHostsResultLine | null;
  onHostChange: (value: string) => void;
  onTokenChange: (value: string) => void;
  onTest: () => void;
  onSave: (event: FormEvent) => void;
  onRemove: (host: string) => void;
}

/**
 * Presentational forge-hosts card. The stateful wrapper (below) owns the query
 * states and the async handlers; this view is exported so static-render tests
 * can drive the busy copy, result lines, and per-row remove state directly.
 */
export function ForgeHostsCard({
  hosts,
  host,
  token,
  testing,
  saving,
  removingHosts,
  result,
  onHostChange,
  onTokenChange,
  onTest,
  onSave,
  onRemove,
}: ForgeHostsCardProps): ReactElement {
  const trimmedHost = host.trim();
  // 'Empty' means empty after trim: a whitespace-only draft leaves the verbs disabled.
  const trimmedToken = token.trim();
  return (
    <SettingsSection title="Forge Hosts">
      <div className="flex flex-col gap-3 text-[12px]">
        <p className="text-text-secondary">{INTRO}</p>

        {hosts.length === 0 ? (
          <p className="font-mono text-[11px] text-text-tertiary">No forge hosts added.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {hosts.map(h => {
              const removing = removingHosts.has(h.host);
              return (
                <li key={h.host} className="flex items-center justify-between gap-3">
                  <span className="font-mono text-[11px] text-text-primary">{h.host}</span>
                  <button
                    type="button"
                    onClick={() => {
                      onRemove(h.host);
                    }}
                    aria-label={removing ? `Removing ${h.host}` : `Remove ${h.host}`}
                    disabled={removing}
                    className={GHOST_BUTTON}
                  >
                    {removing ? 'Removing…' : 'Remove'}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <form onSubmit={onSave} className="flex flex-col gap-2">
          <input
            aria-label="Forge host hostname"
            type="text"
            autoComplete="off"
            value={host}
            onChange={e => {
              onHostChange(e.target.value);
            }}
            placeholder="code.example.com"
            className={INPUT_CLASS}
          />
          <input
            aria-label="Forge host token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={e => {
              onTokenChange(e.target.value);
            }}
            placeholder="Paste the Gitea/Forgejo token"
            className={INPUT_CLASS}
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onTest}
              disabled={testing || !trimmedHost || !trimmedToken}
              className={GHOST_BUTTON}
            >
              {testing ? 'Checking…' : 'Test connection'}
            </button>
            <button
              type="submit"
              disabled={saving || !trimmedHost || !trimmedToken}
              className="brand-bar rounded px-3 py-0.5 text-[11px] font-medium text-white transition-all hover:brightness-110 disabled:opacity-40"
            >
              {saving ? 'Saving…' : 'Save host'}
            </button>
          </div>
        </form>

        {result !== null && (
          <p
            role="status"
            className={`font-mono text-[11px] ${result.kind === 'success' ? 'text-success' : 'text-error'}`}
          >
            {result.text}
          </p>
        )}
      </div>
    </SettingsSection>
  );
}

/**
 * Install-wide forge host credentials. The token travels only in the PUT/test
 * request body and is never shown back; a 401 renders the sign-in line instead
 * of the editor. Async handlers clear both form fields on a successful save and
 * guard post-await state writes with `useCancelledRef` (invalidate first — it
 * only touches the cache Map, so it is safe after unmount).
 */
export function ForgeHostsPanel(): ReactElement {
  const { data, error } = useEntity<ForgeHostList>(K.forgeHosts, listForgeHosts);
  const cancelledRef = useCancelledRef();
  const [host, setHost] = useState('');
  const [token, setToken] = useState('');
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [removingHosts, setRemovingHosts] = useState<ReadonlySet<string>>(new Set());
  const [result, setResult] = useState<ForgeHostsResultLine | null>(null);

  if (error instanceof HttpError && error.status === 401) {
    return (
      <SettingsSection title="Forge Hosts">
        <p className="font-mono text-[11px] text-text-tertiary">Sign in to manage forge hosts.</p>
      </SettingsSection>
    );
  }
  if (error !== undefined) {
    return (
      <SettingsSection title="Forge Hosts">
        <p className="font-mono text-[11px] text-error">{errorDetail(error)}</p>
      </SettingsSection>
    );
  }
  if (data === undefined) {
    return (
      <SettingsSection title="Forge Hosts">
        <p className="font-mono text-[11px] text-text-tertiary">Loading…</p>
      </SettingsSection>
    );
  }

  const runTest = async (): Promise<void> => {
    setTesting(true);
    setResult(null);
    try {
      const probe = await testForgeHost(host, token);
      if (cancelledRef.current) return;
      // The line renders the trimmed draft — the verb sends it trimmed, so the
      // operator never sees whitespace around the host.
      setResult({
        kind: probe.ok ? 'success' : 'failure',
        text: forgeHostTestLine(probe, host.trim()),
      });
      setTesting(false);
    } catch (err: unknown) {
      if (cancelledRef.current) return;
      setResult({ kind: 'failure', text: errorDetail(err) });
      setTesting(false);
    }
  };

  const save = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const trimmedHost = host.trim();
    if (!trimmedHost || !token.trim() || saving) return;
    setSaving(true);
    setResult(null);
    try {
      await saveForgeHost(trimmedHost, token);
      invalidate(K.forgeHosts);
      if (cancelledRef.current) return;
      // Both fields clear on success — the token must not linger in the DOM.
      setHost('');
      setToken('');
      setSaving(false);
    } catch (err: unknown) {
      if (cancelledRef.current) return;
      setResult({ kind: 'failure', text: errorDetail(err) });
      setSaving(false);
    }
  };

  const remove = async (h: string): Promise<void> => {
    if (removingHosts.has(h)) return;
    setRemovingHosts(prev => new Set(prev).add(h));
    setResult(null);
    try {
      await removeForgeHost(h);
      invalidate(K.forgeHosts);
      if (cancelledRef.current) return;
      setRemovingHosts(prev => settleRemoval(prev, h));
    } catch (err: unknown) {
      if (cancelledRef.current) return;
      setResult({ kind: 'failure', text: errorDetail(err) });
      setRemovingHosts(prev => settleRemoval(prev, h));
    }
  };

  return (
    <ForgeHostsCard
      hosts={data.hosts}
      host={host}
      token={token}
      testing={testing}
      saving={saving}
      removingHosts={removingHosts}
      result={result}
      onHostChange={value => {
        setHost(value);
        // A changed draft is no longer the verified one — drop the result line.
        setResult(null);
      }}
      onTokenChange={value => {
        setToken(value);
        setResult(null);
      }}
      onTest={runTest}
      onSave={save}
      onRemove={remove}
    />
  );
}
