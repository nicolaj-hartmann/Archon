/**
 * Integration test: a run is found by its short id prefix on a REAL Postgres server.
 *
 * Run ids are UUID columns on Postgres, and Postgres has no LIKE operator for uuid, so
 * the prefix lookup behind approve/resume from the web failed with
 * "operator does not exist: uuid ~~ unknown" while SQLite (text ids) passed.
 *
 * Opt-in via ARCHON_TEST_PG_URL (postgres://user:pass@host:port/db). The test creates
 * and drops its own scratch database; the database named in the URL is only used to
 * reach the server.
 */
import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';
import type { Pool as PgPool } from 'pg';

mock.module('@archon/paths', () => ({
  BUNDLED_IS_BINARY: false,
  createLogger: () => ({
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
    fatal() {},
  }),
  captureApprovalResolved: () => undefined,
  isTelemetryDisabled: () => true,
  captureWorkflowTerminal: () => undefined,
}));

const baseUrl = process.env.ARCHON_TEST_PG_URL;
const SCRATCH_DB = 'archon_pg_run_id_prefix_test';

describe.skipIf(!baseUrl)('run lookup by id prefix — real Postgres behavior', () => {
  let admin: PgPool;
  let db: import('./adapters/postgres').PostgresAdapter;
  let workflows: typeof import('./workflows');
  let codebaseId: string;
  let runId: string;

  beforeAll(async () => {
    const { Pool } = await import('pg');
    admin = new Pool({ connectionString: baseUrl });
    await admin.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${SCRATCH_DB}"`);
    const scratchUrl = new URL(baseUrl!);
    scratchUrl.pathname = `/${SCRATCH_DB}`;

    const { PostgresAdapter, postgresDialect } = await import('./adapters/postgres');
    db = new PostgresAdapter(scratchUrl.toString());

    mock.module('./connection', () => ({
      pool: db,
      getDatabase: () => db,
      getDialect: () => postgresDialect,
      getDatabaseType: () => 'postgresql',
    }));

    workflows = await import('./workflows');
    const codebase = await db.query<{ id: string }>(
      `INSERT INTO remote_agent_codebases (name, default_cwd) VALUES ('prefix', '/tmp') RETURNING id`
    );
    codebaseId = codebase.rows[0].id;
    const conversation = await db.query<{ id: string }>(
      `INSERT INTO remote_agent_conversations (platform_type, platform_conversation_id)
       VALUES ('test', 'run-id-prefix') RETURNING id`
    );
    runId = '6125fa56-b48e-4502-bfb3-aafb30c29016';
    await db.query(
      `INSERT INTO remote_agent_workflow_runs
         (id, conversation_id, codebase_id, workflow_name, user_message, status, metadata)
       VALUES ($1, $2, $3, 'test', '', 'paused', '{}'::jsonb)`,
      [runId, conversation.rows[0].id, codebaseId]
    );
  });

  afterAll(async () => {
    await db?.close();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
      await admin.end();
    }
  });

  test('the short id shown in listings finds the run', async () => {
    const runs = await workflows.findWorkflowRunsByIdPrefix('6125fa56', codebaseId);

    expect(runs.map(r => r.id)).toEqual([runId]);
  });

  test('the full id finds the run', async () => {
    const runs = await workflows.findWorkflowRunsByIdPrefix(runId, codebaseId);

    expect(runs.map(r => r.id)).toEqual([runId]);
  });
});
