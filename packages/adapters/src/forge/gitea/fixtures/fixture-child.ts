/**
 * Dispatch-level fixture child standing in for the forge-gitea executable.
 *
 * It speaks the same `metadata` / `op <op>` protocol as the real plugin, so the
 * host-mapping, credential, and SAFE_ENV tests exercise the actual dispatch
 * boundary without needing the gitea plugin. The subcommand is the trailing
 * argument: the discovery and op boundaries append it after the configured args.
 *
 * In the `op` branch it writes its own environment observation to the file named
 * by `--report <path>` before answering:
 * - `archonFingerprint` — SHA-256 of `ARCHON_FORGE_TOKEN` (never the value).
 * - `coreCi` / `levior` — the raw per-host variables, which the SAFE_ENV
 *   whitelist must strip, so a correct boundary reports null for both.
 *
 * It answers the `checks.state` op with a valid observation for the echoed
 * request ref, so `matchesForgeOperationResponse` accepts the response.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const valueAt = (flag: string): string | undefined => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};

if (args.at(-1) === 'metadata') {
  process.stdout.write(
    JSON.stringify({
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
    })
  );
  process.exit(0);
}

if (!args.includes('op')) {
  process.stderr.write(`fixture-child: expected an op invocation, got ${args.join(' ')}\n`);
  process.exit(2);
}

const input = (await Bun.stdin.json()) as {
  operationId: string;
  op: string;
  ref?: unknown;
};

const reportPath = valueAt('--report');
if (reportPath !== undefined) {
  const token = process.env.ARCHON_FORGE_TOKEN;
  writeFileSync(
    reportPath,
    JSON.stringify({
      archonFingerprint:
        token === undefined ? null : createHash('sha256').update(token).digest('hex'),
      coreCi: process.env.CODE_CORE_CI_TOKEN ?? null,
      levior: process.env.CODE_LEVIOR_IO_TOKEN ?? null,
    })
  );
}

process.stdout.write(
  JSON.stringify({
    operationId: input.operationId,
    ok: true,
    result: {
      op: 'checks.state',
      value: {
        ref: input.ref,
        revision: 'fixture-revision',
        units: [],
        summary: {
          state: 'none',
          counts: { total: 0, green: 0, red: 0, pending: 0, gated: 0, unknown: 0 },
        },
        required: null,
      },
    },
  })
);
