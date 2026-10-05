// A fixture forge plugin that fingerprints the credential dispatch delivered.
//
// On the `op` command it writes the SHA-256 hex digest of ARCHON_FORGE_TOKEN
// (or the literal 'absent') to the path given by --digest-file, then answers
// the request. The digest is the test-visible fingerprint of the delivered
// credential: the test asserts WHICH value reached the child without the
// plaintext ever entering the child's stdout or the test's source.
//
// Run under bun: `bun token-fingerprint-plugin.ts metadata [--name …] [--host …]
// [--token-env …] [--digest-file …]` / `… op` (JSON request on stdin).
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

export {};

const args = process.argv.slice(2);
const at = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const name = at('--name') ?? 'fingerprint';
const hosts = args.flatMap((value, i) => (value === '--host' ? [args[i + 1]] : []));
const tokenEnv = at('--token-env');
const digestFile = at('--digest-file');

if (args.includes('metadata')) {
  process.stdout.write(
    JSON.stringify({
      protocol: 1,
      name,
      version: '1.0.0',
      forge: 'fingerprint',
      hosts: hosts.length > 0 ? hosts : ['forge.example'],
      capabilities: ['resolve', 'checks.state'],
      token_env: tokenEnv ? [tokenEnv] : [],
    })
  );
  process.exit(0);
}

const input = (await Bun.stdin.json()) as { operationId: string };
const token = process.env.ARCHON_FORGE_TOKEN;
if (digestFile) {
  writeFileSync(
    digestFile,
    token ? createHash('sha256').update(token, 'utf8').digest('hex') : 'absent'
  );
}

process.stdout.write(
  JSON.stringify({
    operationId: input.operationId,
    ok: true,
    result: { op: 'resolve', value: { kind: 'none', forge: 'none' } },
  })
);
