import { z } from 'zod';
import {
  type CheckObservation,
  type ForgeError,
  type ForgeRequest,
  type ForgeResponse,
  type PluginMetadata,
  isMutationRequest,
  mutationTarget,
  summarizeChecks,
} from '@archon/forge/operations';
import {
  giteaErrorDetail,
  giteaPages,
  giteaRequest,
  location,
  parseRemote,
  type Fetch,
} from './api';
import { handleGiteaMutation, handleGiteaPrView } from './lifecycle';

export const giteaPluginMetadata = {
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
} satisfies PluginMetadata;

export interface GiteaOperationOptions {
  readonly token: string | undefined;
  readonly fetch?: Fetch;
}

const pullHeadSchema = z.object({ head: z.object({ sha: z.string().min(1) }) });
// Gitea's commit-status row carries `status`, never `state`; `id` is numeric.
const statusRowSchema = z.object({
  id: z.number().int(),
  context: z.string().min(1),
  status: z.string().min(1),
});
const statusesPageSchema = z.array(statusRowSchema);

function failure(operationId: string, error: ForgeError): ForgeResponse {
  return { operationId, ok: false, error };
}

function statusObservation(row: z.infer<typeof statusRowSchema>): CheckObservation {
  const status = row.status;
  const state =
    status === 'pending'
      ? 'pending'
      : status === 'success'
        ? 'green'
        : status === 'failure' || status === 'error'
          ? 'red'
          : 'unknown';
  return {
    unit: { kind: 'commit_status', id: String(row.id), name: row.context },
    nativeState: status,
    phase: status === 'pending' ? 'pending' : state === 'unknown' ? 'unknown' : 'completed',
    nativeResult: status,
    result:
      status === 'pending'
        ? null
        : status === 'success'
          ? 'success'
          : state === 'red'
            ? 'failure'
            : 'unknown',
    state,
  };
}

export async function handleGiteaOperation(
  request: ForgeRequest,
  options: GiteaOperationOptions
): Promise<ForgeResponse> {
  try {
    if (request.op === 'resolve') {
      const repo = parseRemote(request.remote);
      return {
        operationId: request.operationId,
        ok: true,
        result: {
          op: 'resolve',
          value: repo
            ? { kind: 'resolved', forge: 'gitea', repo, plugin: giteaPluginMetadata }
            : { kind: 'none', forge: 'none' },
        },
      };
    }

    if (!options.token) {
      const error = {
        kind: 'no_credential' as const,
        message: 'ARCHON_FORGE_TOKEN is required for Gitea operations',
      };
      // One token per host, never a fallback: an ambient clone-time token is not
      // a credential for this instance. A mutation refused for want of a
      // credential never reached Gitea.
      return isMutationRequest(request)
        ? {
            operationId: request.operationId,
            ok: false,
            error,
            mutation: { op: request.op, target: mutationTarget(request), outcome: 'refused' },
          }
        : failure(request.operationId, error);
    }
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const token = options.token;
    if (isMutationRequest(request)) return await handleGiteaMutation(request, fetchImpl, token);
    if (request.op === 'pr.view') return await handleGiteaPrView(request, fetchImpl, token);
    // Unreachable via dispatch (capability gate); fail-loud for direct executable calls, not dead code.
    if (request.op === 'workitem.view')
      return failure(request.operationId, {
        kind: 'unsupported_op',
        message: 'plugin gitea does not support workitem.view',
      });

    const { root, path } = location(request.ref.repo);
    const pull = pullHeadSchema.parse(
      await giteaRequest(
        fetchImpl,
        token,
        `${root}/repos/${path}/pulls/${String(request.ref.number)}`
      )
    );
    const revision = pull.head.sha;
    const rows = statusesPageSchema.parse(
      await giteaPages(
        fetchImpl,
        token,
        `${root}/repos/${path}/commits/${encodeURIComponent(revision)}/statuses`,
        value => statusesPageSchema.parse(value),
        row => String(row.id)
      )
    );
    // Ordering is not a vendor guarantee: the newest status per context is the
    // highest id, so dedup runs after an id-descending sort, never on delivery
    // order. Context names are case-insensitive.
    const newestFirst = [...rows].sort((left, right) => right.id - left.id);
    const seen = new Set<string>();
    const units = newestFirst.filter(row => {
      const context = row.context.toLowerCase();
      if (seen.has(context)) return false;
      seen.add(context);
      return true;
    });
    const observations = units.map(statusObservation);
    return {
      operationId: request.operationId,
      ok: true,
      result: {
        op: 'checks.state',
        value: {
          ref: request.ref,
          revision,
          units: observations,
          summary: summarizeChecks(observations),
          // The statuses API enumerates observations but does not say which
          // branch protection requires. Returning null keeps that absence explicit.
          required: null,
        },
      },
    };
  } catch (cause) {
    return failure(request.operationId, giteaErrorDetail(cause));
  }
}
