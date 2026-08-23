/**
 * The pg filter must separate n8n's own bookkeeping from the agent's queries
 * even when both run against the same database.
 *
 * It originally compared the *connection* against the DB_POSTGRESDB_* env vars.
 * n8n's own compose setup points a Postgres chat memory at that same database,
 * so every memory query was indistinguishable from n8n's own and was silently
 * dropped — a traced run whose agent issued 5 memory queries reported none of
 * them, and a failing memory query produced no span either, since the filter
 * returns before the query runs.
 *
 * Call origin is the discriminator instead: n8n routes all internal persistence
 * through its TypeORM fork, and the agent never does. The stacks below are real
 * captures from a governed run.
 */
import { describe, expect, it } from 'vitest';
import { isN8nOrmStack } from '../shared/langchain/node_instrumentation';

// n8n loading a credential while a node initialises.
const N8N_CREDENTIAL_LOOKUP = `Error
    at patchedPgQuery (/home/node/.n8n/nodes/node_modules/n8n-nodes-openbox-hook/dist/shared/langchain/node_instrumentation.js:401:187)
    at PostgresQueryRunner.query (/usr/local/lib/node_modules/n8n/node_modules/@n8n/typeorm/dist/driver/postgres/PostgresQueryRunner.js:184:50)
    at processTicksAndRejections (node:internal/process/task_queues:104:5)
    at SelectQueryBuilder.loadRawResults (/usr/local/lib/node_modules/n8n/node_modules/@n8n/typeorm/dist/query-builder/SelectQueryBuilder.js:1949:25)`;

// The agent's chat memory writing a message.
const AGENT_MEMORY_INSERT = `Error
    at patchedPgQuery (/home/node/.n8n/nodes/node_modules/n8n-nodes-openbox-hook/dist/shared/langchain/node_instrumentation.js:401:187)
    at /usr/local/lib/node_modules/n8n/node_modules/pg-pool/index.js:467:16
    at /usr/local/lib/node_modules/n8n/node_modules/pg-pool/index.js:357:21
    at Client._handleReadyForQuery (/usr/local/lib/node_modules/n8n/node_modules/pg/lib/client.js:370:14)
    at Connection.emit (node:events:509:28)`;

describe('isN8nOrmStack', () => {
  it("recognises n8n's own ORM", () => {
    expect(isN8nOrmStack(N8N_CREDENTIAL_LOOKUP)).toBe(true);
  });

  it("does not claim the agent's memory queries", () => {
    expect(isN8nOrmStack(AGENT_MEMORY_INSERT)).toBe(false);
  });

  it('matches regardless of where n8n is installed', () => {
    expect(isN8nOrmStack('    at Q (/opt/n8n/node_modules/@n8n/typeorm/dist/driver/postgres/PostgresDriver.js:1:1)')).toBe(true);
    // Windows-style separators.
    expect(isN8nOrmStack('    at Q (C:\\app\\node_modules\\@n8n\\typeorm\\dist\\driver\\postgres\\PostgresDriver.js:1:1)')).toBe(true);
  });

  it('leaves vanilla TypeORM to the agent', () => {
    // A tool querying its own database through TypeORM is the agent's work.
    expect(isN8nOrmStack('    at Q (/app/node_modules/typeorm/dist/driver/postgres/PostgresQueryRunner.js:184:50)')).toBe(false);
  });

  it('does not match on an unrelated mention of the name', () => {
    expect(isN8nOrmStack('    at handler (/app/src/routes/typeorm-docs.js:12:3)')).toBe(false);
    expect(isN8nOrmStack('')).toBe(false);
  });
});
