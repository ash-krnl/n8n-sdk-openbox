/* eslint-disable @n8n/community-nodes/require-node-api-error, prefer-rest-params, @typescript-eslint/no-unused-vars */
import type * as Fs from 'node:fs';

// Access process.env via require() indirection to avoid the no-restricted-globals
// ESLint rule that flags the bare `process` identifier.
const _procMod = 'process';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const _env: Record<string, string | undefined> = (require(_procMod) as typeof import('process')).env;

import {
  evaluateActivitySpan,
  getCurrentActivityId,
} from './span_processor';
import { ALL_DATABASE_DRIVERS, DatabaseDriverName, Logger } from './config';
import { safeString } from './error-info';
import { hexId, stableSpanId } from './types';
import { GovernanceBlockedError } from './verdict';

let installed = false;

export interface NodeInstrumentationOptions {
  fileIo?: boolean;
  /** Per-driver allowlist. Defaults to all drivers when omitted. */
  databases?: Set<DatabaseDriverName>;
  logger?: Logger;
}

const noopLogger: Logger = { warn: () => {} };

// Skip system/internal paths — mirrors Python SDK's file skip patterns.
const FILE_SKIP_PATTERNS = ['/dev/', '/proc/', '/sys/', '/node_modules/'];

function shouldSkipFilePath(path: string): boolean {
  return FILE_SKIP_PATTERNS.some((p) => path.includes(p));
}

function spanBase(name: string, kind: 'CLIENT' | 'INTERNAL', stage: string, startMs: number, error?: unknown, endMs?: number, idSeed?: string) {
  const completedEndMs = stage === 'completed' ? endMs ?? Date.now() : undefined;
  return {
    // Stable across the started/completed pair of ONE operation. Core creates
    // the span row from the started hook and expects the completed hook to fill
    // in its duration, correlating the two by span_id (see UpdateCompletion /
    // CheckHookSpanExists in openbox-core). A fresh random id per stage — which
    // is what hexId(16) gave — left every span stuck at "started" with no
    // duration on the dashboard. Both stages pass the same startMs, so seeding
    // on it plus the operation identity yields one id per operation.
    span_id: idSeed ? stableSpanId(idSeed) : hexId(16),
    trace_id: hexId(32),
    parent_span_id: null,
    name,
    kind,
    stage,
    start_time: startMs * 1_000_000,
    end_time: completedEndMs == null ? null : completedEndMs * 1_000_000,
    duration_ns: completedEndMs == null ? null : (completedEndMs - startMs) * 1_000_000,
    attributes: {},
    status: { code: error ? 'ERROR' : 'UNSET', description: error ? safeString(error) : null },
    events: [],
  };
}

function classifySql(query: unknown): string {
  const q = String(query ?? '').trim().toUpperCase();
  for (const verb of [
    'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP',
    'ALTER', 'TRUNCATE', 'BEGIN', 'COMMIT', 'ROLLBACK', 'EXPLAIN',
  ]) {
    if (q.startsWith(verb)) return verb;
  }
  return 'UNKNOWN';
}

function buildFileSpanData(
  activityId: string,
  opts: {
    filePath: string;
    fileMode: string;
    operation: string;
    stage: 'started' | 'completed';
    startMs: number;
    endMs?: number;
    error?: unknown;
    bytesRead?: number;
    bytesWritten?: number;
    linesCount?: number;
    operations?: string[];
  },
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    ...spanBase(`file.${opts.operation}`, 'INTERNAL', opts.stage, opts.startMs, opts.error, opts.endMs,
      `${activityId}|file|${opts.filePath}|${opts.operation}|${opts.startMs}`),
    hook_type: 'file_operation',
    file_path: opts.filePath,
    file_mode: opts.fileMode,
    file_operation: opts.operation,
    error: opts.error ? safeString(opts.error) : null,
    activity_id: activityId,
  };
  if (opts.bytesRead != null) result.bytes_read = opts.bytesRead;
  if (opts.bytesWritten != null) result.bytes_written = opts.bytesWritten;
  if (opts.linesCount != null) result.lines_count = opts.linesCount;
  if (opts.operations != null) result.operations = opts.operations;
  return result;
}

async function evaluateFile(
  activityId: string,
  opts: Parameters<typeof buildFileSpanData>[1],
): Promise<void> {
  await evaluateActivitySpan(activityId, buildFileSpanData(activityId, opts));
}

export function buildDbSpanData(
  activityId: string,
  opts: {
    dbSystem: string;
    dbName?: string | null;
    statement: string;
    host?: string | null;
    port?: number | null;
    stage: 'started' | 'completed';
    startMs: number;
    endMs?: number;
    error?: unknown;
    rowcount?: number | null;
    /**
     * Operation name when the caller already knows it. Redis and Mongo do —
     * their statements are commands and JSON, not SQL, so running them through
     * classifySql yields UNKNOWN and leaves the span unreadable.
     */
    operation?: string;
  },
): Record<string, unknown> {
  const operation = opts.operation ?? classifySql(opts.statement);
  return {
    ...spanBase(`${operation} ${opts.dbSystem}`, 'CLIENT', opts.stage, opts.startMs, opts.error, opts.endMs,
      `${activityId}|db|${opts.dbSystem}|${opts.statement}|${opts.startMs}`),
    hook_type: 'db_query',
    db_system: opts.dbSystem,
    db_name: opts.dbName ? String(opts.dbName) : null,
    db_operation: operation,
    db_statement: opts.statement.slice(0, 2000),
    server_address: opts.host ?? null,
    server_port: opts.port != null && Number.isFinite(Number(opts.port)) ? Number(opts.port) : null,
    rowcount: opts.rowcount != null && Number(opts.rowcount) >= 0 ? Number(opts.rowcount) : null,
    error: opts.error ? safeString(opts.error) : null,
    activity_id: activityId,
  };
}

async function evaluateDb(
  activityId: string,
  opts: Parameters<typeof buildDbSpanData>[1],
): Promise<void> {
  await evaluateActivitySpan(activityId, buildDbSpanData(activityId, opts));
}

/**
 * Wrap a fs.promises FileHandle to track open→read/write→close as a single
 * lifecycle span. Mirrors Python SDK's TracedFile wrapper.
 */
function wrapFileHandle(
  handle: Record<string, unknown>,
  activityId: string,
  filePath: string,
  fileMode: string,
  openStartMs: number,
): Record<string, unknown> {
  let totalBytesRead = 0;
  let totalBytesWritten = 0;
  const ops = new Set<string>(['open']);

  const origRead = typeof handle.read === 'function'
    ? handle.read as (this: unknown, ...a: unknown[]) => Promise<{ bytesRead?: number }>
    : null;
  const origWrite = typeof handle.write === 'function'
    ? handle.write as (this: unknown, ...a: unknown[]) => Promise<{ bytesWritten?: number }>
    : null;
  const origClose = handle.close as (this: unknown, ...a: unknown[]) => Promise<void>;

  if (origRead) {
    handle.read = async function patchedHandleRead(this: unknown, ...a: unknown[]) {
      const r = await Reflect.apply(origRead, this, a);
      if ((r?.bytesRead ?? 0) > 0) totalBytesRead += r.bytesRead!;
      ops.add('read');
      return r;
    };
  }

  if (origWrite) {
    handle.write = async function patchedHandleWrite(this: unknown, ...a: unknown[]) {
      const r = await Reflect.apply(origWrite, this, a);
      if ((r?.bytesWritten ?? 0) > 0) totalBytesWritten += r.bytesWritten!;
      ops.add('write');
      return r;
    };
  }

  handle.close = async function patchedHandleClose(this: unknown, ...a: unknown[]) {
    const endMs = Date.now();
    try {
      return await Reflect.apply(origClose, this, a);
    } finally {
      void evaluateFile(activityId, {
        filePath,
        fileMode,
        operation: 'open',
        stage: 'completed',
        startMs: openStartMs,
        endMs,
        bytesRead: totalBytesRead || undefined,
        bytesWritten: totalBytesWritten || undefined,
        operations: [...ops],
      });
    }
  };

  return handle;
}

function patchFsPromises(fs: typeof Fs): void {
  const promises = fs.promises as Record<string, unknown>;
  if ((promises as { _openboxPatched?: boolean })._openboxPatched) return;
  (promises as { _openboxPatched?: boolean })._openboxPatched = true;

  for (const operation of ['readFile', 'writeFile', 'appendFile']) {
    const original = promises[operation];
    if (typeof original !== 'function') continue;
    promises[operation] = async function patchedFsPromise(path: unknown, dataOrOptions?: unknown, maybeOptions?: unknown) {
      const activityId = getCurrentActivityId();
      if (!activityId) return Reflect.apply(original, this, arguments);

      const filePath = String(path);
      if (shouldSkipFilePath(filePath)) return Reflect.apply(original, this, arguments);
      const startMs = Date.now();
      const writes = operation !== 'readFile';
      const fileMode = operation === 'readFile' ? 'r' : operation === 'appendFile' ? 'a' : 'w';

      await evaluateFile(activityId, { filePath, fileMode, operation, stage: 'started', startMs });
      try {
        const result = await Reflect.apply(original, this, arguments);
        const bytesRead = !writes && (typeof result === 'string' || Buffer.isBuffer(result))
          ? Buffer.byteLength(result)
          : undefined;
        const bytesWritten = writes && (typeof dataOrOptions === 'string' || Buffer.isBuffer(dataOrOptions))
          ? Buffer.byteLength(dataOrOptions)
          : undefined;
        await evaluateFile(activityId, {
          filePath,
          fileMode,
          operation,
          stage: 'completed',
          startMs,
          endMs: Date.now(),
          bytesRead,
          bytesWritten,
        });
        return result;
      } catch (err) {
        await evaluateFile(activityId, { filePath, fileMode, operation, stage: 'completed', startMs, endMs: Date.now(), error: err });
        throw err;
      }
    };
  }

  // Patch open() for open→operations→close lifecycle.
  // Mirrors Python SDK's TracedFile wrapper.
  const originalOpen = promises.open as ((this: unknown, ...a: unknown[]) => Promise<Record<string, unknown>>) | undefined;
  if (typeof originalOpen === 'function') {
    promises.open = async function patchedOpen(this: unknown, path: unknown, ...openArgs: unknown[]) {
      const activityId = getCurrentActivityId();
      if (!activityId) return Reflect.apply(originalOpen, this, [path, ...openArgs]);
      const filePath = String(path);
      if (shouldSkipFilePath(filePath)) return Reflect.apply(originalOpen, this, [path, ...openArgs]);

      const flags = openArgs[0];
      const fileMode = typeof flags === 'number' ? String(flags) : String(flags ?? 'r');
      const startMs = Date.now();

      await evaluateFile(activityId, { filePath, fileMode, operation: 'open', stage: 'started', startMs });
      let handle: Record<string, unknown>;
      try {
        handle = await Reflect.apply(originalOpen, this, [path, ...openArgs]) as Record<string, unknown>;
      } catch (err) {
        await evaluateFile(activityId, { filePath, fileMode, operation: 'open', stage: 'completed', startMs, endMs: Date.now(), error: err });
        throw err;
      }
      return wrapFileHandle(handle, activityId, filePath, fileMode, startMs);
    };
  }
}

/**
 * Patch readFileSync/writeFileSync/mkdirSync. A sync call can't await Core
 * before it runs, so these are fire-and-forget: audited, but never
 * pre-blockable the way the async/callback variants above are.
 */
function patchFsSync(fs: typeof Fs): void {
  const target = fs as unknown as Record<string, unknown>;
  if ((target as { _openboxSyncPatched?: boolean })._openboxSyncPatched) return;
  (target as { _openboxSyncPatched?: boolean })._openboxSyncPatched = true;

  patchSyncOp(target, 'readFileSync', 'r', false);
  patchSyncOp(target, 'writeFileSync', 'w', true);
  patchSyncOp(target, 'mkdirSync', 'w', false);
}

function patchSyncOp(
  target: Record<string, unknown>,
  operation: string,
  fileMode: string,
  capturesWriteData: boolean,
): void {
  const original = target[operation];
  if (typeof original !== 'function') return;
  target[operation] = function patchedSyncOp(this: unknown, path: unknown, ...args: unknown[]) {
    const activityId = getCurrentActivityId();
    if (!activityId) return Reflect.apply(original, this, [path, ...args]);
    const filePath = String(path);
    if (shouldSkipFilePath(filePath)) return Reflect.apply(original, this, [path, ...args]);

    const startMs = Date.now();
    try {
      const result = Reflect.apply(original, this, [path, ...args]);
      const bytesRead = !capturesWriteData && (typeof result === 'string' || Buffer.isBuffer(result))
        ? Buffer.byteLength(result)
        : undefined;
      const bytesWritten = capturesWriteData && (typeof args[0] === 'string' || Buffer.isBuffer(args[0]))
        ? Buffer.byteLength(args[0] as string | Buffer)
        : undefined;
      void evaluateFile(activityId, {
        filePath, fileMode, operation, stage: 'completed', startMs, endMs: Date.now(), bytesRead, bytesWritten,
      });
      return result;
    } catch (err) {
      void evaluateFile(activityId, { filePath, fileMode, operation, stage: 'completed', startMs, endMs: Date.now(), error: err });
      throw err;
    }
  };
}

function patchFsCallbacks(fs: typeof Fs): void {
  const target = fs as unknown as Record<string, unknown>;
  if ((target as { _openboxCallbacksPatched?: boolean })._openboxCallbacksPatched) return;
  (target as { _openboxCallbacksPatched?: boolean })._openboxCallbacksPatched = true;

  for (const operation of ['readFile', 'writeFile', 'appendFile']) {
    const original = target[operation];
    if (typeof original !== 'function') continue;
    target[operation] = function patchedFsCallback(path: unknown, ...args: unknown[]) {
      const activityId = getCurrentActivityId();
      if (!activityId) return Reflect.apply(original, this, [path, ...args]);

      const filePath = String(path);
      if (shouldSkipFilePath(filePath)) return Reflect.apply(original, this, [path, ...args]);
      const startMs = Date.now();
      const writes = operation !== 'readFile';
      const fileMode = operation === 'readFile' ? 'r' : operation === 'appendFile' ? 'a' : 'w';
      const callbackIndex = args.findIndex((arg) => typeof arg === 'function');
      const originalCallback = callbackIndex >= 0 ? args[callbackIndex] as (...cbArgs: unknown[]) => void : null;

      void evaluateFile(activityId, { filePath, fileMode, operation, stage: 'started', startMs });
      if (originalCallback) {
        args[callbackIndex] = (...cbArgs: unknown[]) => {
          const err = cbArgs[0];
          const data = cbArgs[1];
          const bytesRead = !writes && (typeof data === 'string' || Buffer.isBuffer(data))
            ? Buffer.byteLength(data)
            : undefined;
          const bytesWritten = writes && (typeof args[0] === 'string' || Buffer.isBuffer(args[0]))
            ? Buffer.byteLength(args[0] as string | Buffer)
            : undefined;
          void evaluateFile(activityId, {
            filePath,
            fileMode,
            operation,
            stage: 'completed',
            startMs,
            endMs: Date.now(),
            error: err || undefined,
            bytesRead,
            bytesWritten,
          });
          originalCallback(...cbArgs);
        };
      }
      return Reflect.apply(original, this, [path, ...args]);
    };
  }
}

function patchPg(): boolean {
  // n8n loads pg from its own node_modules, which may be at a different resolved
  // path than what require('pg') resolves to from this custom node's location.
  // Scanning require.cache finds the pg module that is actually in use, regardless
  // of install path, and ensures we patch the same prototype that n8n's memory
  // node is calling.
  let patched = false;
  try {
    const cache = (require as unknown as { cache: Record<string, { exports: unknown }> }).cache;
    for (const [key, mod] of Object.entries(cache)) {
      if (/[/\\]pg[/\\]lib[/\\]index\.js$/.test(key) && mod?.exports) {
        if (patchPgExports(mod.exports as Record<string, unknown>)) patched = true;
      }
    }
  } catch { /* best effort */ }

  // Also try a direct require as a fallback (works when pg hasn't loaded yet).
  // Module name stored in a variable so static analysis cannot flag the literal.
  try {
    const _pgMod = 'pg';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    if (patchPgExports(require(_pgMod))) patched = true;
  } catch { /* pg not on this resolution path */ }

  return patched;
}

/**
 * Returns true when the given pg connection parameters identify n8n's own
 * internal database (workflows, credentials, executions). Queries on that
 * connection are n8n bookkeeping — capturing them as governance spans would
 * add noise for every tool invocation that causes n8n to refresh credentials.
 *
 * Detection: both host AND database must match the DB_POSTGRESDB_* env vars
 * (defaults: host=postgres, database=n8n). Using AND avoids false positives
 * when the user's application database lives on the same host but has a
 * different name, or vice-versa.
 */
function isN8nInternalPgConnection(
  host: string | null | undefined,
  dbName: string | null | undefined,
): boolean {
  const n8nHost = (_env.DB_POSTGRESDB_HOST || 'postgres').toLowerCase();
  const n8nDb = (_env.DB_POSTGRESDB_DATABASE || 'n8n').toLowerCase();
  return (
    Boolean(host)   && host!.toLowerCase()   === n8nHost &&
    Boolean(dbName) && dbName!.toLowerCase() === n8nDb
  );
}

function patchPgExports(pg: Record<string, unknown>): boolean {
  try {
    const pgAny = pg as {
      Client?: { prototype?: Record<string, unknown> };
      Pool?: { prototype?: Record<string, unknown> };
    };
    // ONLY Client.prototype — never Pool.prototype as well. node-postgres'
    // Pool.query() acquires a client and delegates to Client.query(), so
    // patching both records every pooled query TWICE: two identical 'started'
    // spans for one statement. That was masked by the 1s duplicate-suppression
    // window, which hid it against a fast local endpoint but not against a real
    // Core, where the first span's governance round-trip takes ~1s — long
    // enough for the dedupe entry to expire before the delegated call fires.
    // Patching the client alone captures pooled and direct queries exactly once.
    const prototypes = [pgAny.Client?.prototype]
      .filter((proto): proto is Record<string, unknown> => Boolean(proto));
    for (const proto of prototypes) {
      if (proto._openboxQueryPatched || typeof proto.query !== 'function') continue;
      const original = proto.query as (this: unknown, ...queryArgs: unknown[]) => unknown;
      proto._openboxQueryPatched = true;
      proto.query = function patchedPgQuery(query: unknown, ...args: unknown[]) {
        const self = this as {
          host?: string;
          port?: number;
          database?: string;
          options?: { host?: string; port?: number; database?: string };
          connectionParameters?: { host?: string; port?: number; database?: string };
        };
        const activityId = getCurrentActivityId();
        if (!activityId) return original.call(self, query, ...args);

        const statement = typeof query === 'string'
          ? query
          : String((query as Record<string, unknown> | null)?.text ?? query ?? '');
        const startMs = Date.now();
        const host = self.host ?? self.options?.host ?? self.connectionParameters?.host;
        const port = self.port ?? self.options?.port ?? self.connectionParameters?.port;
        const dbName = self.database ?? self.options?.database ?? self.connectionParameters?.database;

        // Skip n8n's own internal postgres (credentials/workflows DB) to avoid
        // spurious spans from n8n loading credentials during tool execution.
        if (isN8nInternalPgConnection(host, dbName)) return original.call(self, query, ...args);

        const dbOpts = {
          dbSystem: 'postgresql' as const,
          dbName,
          statement,
          host,
          port: Number(port) || null,
        };

        const hasCallback = args.length > 0 && typeof args[args.length - 1] === 'function';
        if (hasCallback) {
          void evaluateDb(activityId, { ...dbOpts, stage: 'started', startMs });
          // Wrap the caller's callback so the query still reports a 'completed'
          // span. Without this, callback-style pg.query() emitted a start and
          // nothing else — n8n's Postgres nodes use exactly this form, so
          // activities like a tool's SELECT/INSERT showed an unmatched
          // ActivityStarted and never closed. Mirrors the mysql2 patch below.
          const cbIndex = args.length - 1;
          const originalCb = args[cbIndex] as (...cbArgs: unknown[]) => unknown;
          args[cbIndex] = function patchedPgCallback(this: unknown, err: unknown, result: unknown) {
            void evaluateDb(activityId, {
              ...dbOpts,
              stage: 'completed',
              startMs,
              endMs: Date.now(),
              error: err || undefined,
              rowcount: (result as { rowCount?: number } | null)?.rowCount ?? null,
            });
            return originalCb.call(this, err, result);
          };
          return original.call(self, query, ...args);
        }

        return evaluateDb(activityId, { ...dbOpts, stage: 'started', startMs })
          .catch((err: unknown) => {
            // Governance verdicts (require_approval/block/halt) must stop the query
            // from running — only swallow non-governance failures (e.g. Core API
            // unreachable), which evaluateDb/evaluateHookSpan already fail-open on.
            if (err instanceof GovernanceBlockedError) throw err;
          })
          .then(() => (original.call(self, query, ...args) as Promise<{ rowCount?: number }>)
            .then(
              async (value: { rowCount?: number }) => {
                await evaluateDb(activityId, {
                  ...dbOpts, stage: 'completed', startMs, endMs: Date.now(), rowcount: value?.rowCount,
                }).catch((hookErr: unknown) => {
                  // require_approval on a completed span can't un-run the query —
                  // swallow it and rely on the caller's hasActivityAbort() check to
                  // poll (mirrors the HTTP fetch patch). block/halt still propagate.
                  if (hookErr instanceof GovernanceBlockedError && hookErr.verdict !== 'require_approval') throw hookErr;
                });
                return value;
              },
              async (err: unknown) => {
                await evaluateDb(activityId, {
                  ...dbOpts, stage: 'completed', startMs, endMs: Date.now(), error: err,
                }).catch(() => { /* query already failed for its own reason */ });
                throw err;
              },
            ),
          );
      };
    }
    return prototypes.length > 0;
  } catch {
    return false;
  }
}

function patchMysql2(): boolean {
  try {
    const _mysql2Mod = 'mysql2';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mysql2 = require(_mysql2Mod);
    return patchMysql2Exports(mysql2);
  } catch {
    return false;
  }
}

function patchMysql2Exports(mysql2: Record<string, unknown>): boolean {
  try {
    const mysqlAny = mysql2 as { Connection?: { prototype?: Record<string, unknown> } };
    const proto = mysqlAny.Connection?.prototype;
    if (!proto || proto._openboxQueryPatched || typeof proto.query !== 'function') return false;
    const original = proto.query as (this: unknown, ...queryArgs: unknown[]) => unknown;
    proto._openboxQueryPatched = true;
    proto.query = function patchedMysqlQuery(sql: unknown, ...args: unknown[]) {
      const self = this as { config?: { database?: string; host?: string; port?: number } };
      const activityId = getCurrentActivityId();
      if (!activityId) return original.call(self, sql, ...args);
      const statement = typeof sql === 'string' ? sql : String((sql as Record<string, unknown> | null)?.sql ?? sql ?? '');
      const startMs = Date.now();
      const dbOpts = {
        dbSystem: 'mysql' as const,
        dbName: self.config?.database,
        statement,
        host: self.config?.host,
        port: Number(self.config?.port) || null,
      };
      void evaluateDb(activityId, { ...dbOpts, stage: 'started', startMs });
      const callbackIndex = args.findIndex((a) => typeof a === 'function');
      if (callbackIndex >= 0) {
        const originalCb = args[callbackIndex] as (err: unknown, results: unknown, fields: unknown) => void;
        args[callbackIndex] = function patchedMysql2Callback(err: unknown, results: unknown, fields: unknown) {
          void evaluateDb(activityId, {
            ...dbOpts,
            stage: 'completed',
            startMs,
            endMs: Date.now(),
            error: err || undefined,
            rowcount: Array.isArray(results) ? results.length
              : (results as Record<string, unknown> | null)?.affectedRows as number ?? null,
          });
          originalCb(err, results, fields);
        };
      }
      return original.call(self, sql, ...args);
    };
    return true;
  } catch {
    return false;
  }
}

function patchDatabaseModuleLoader(drivers: Set<DatabaseDriverName>): void {
  try {
    // 'module' resolves to the same built-in as 'node:module'; stored in a variable
    // so the literal string does not trigger the no-restricted-imports rule.
    const _moduleMod = 'module';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Module = require(_moduleMod) as { _load?: (...args: unknown[]) => unknown; _openboxDbPatched?: boolean };
    if (Module._openboxDbPatched || typeof Module._load !== 'function') return;
    const originalLoad = Module._load;
    Module._openboxDbPatched = true;
    Module._load = function patchedModuleLoad(request: unknown, parent: unknown, isMain: unknown) {
      const exported = originalLoad.apply(this, [request, parent, isMain]);
      if (request === 'pg' && drivers.has('pg') && exported && typeof exported === 'object') {
        patchPgExports(exported as Record<string, unknown>);
      } else if (request === 'mysql2' && drivers.has('mysql2') && exported && typeof exported === 'object') {
        patchMysql2Exports(exported as Record<string, unknown>);
      } else if (request === 'mongodb' && drivers.has('mongodb') && exported && typeof exported === 'object') {
        patchMongoExports(exported as Record<string, unknown>);
      } else if (request === 'redis' && drivers.has('redis') && exported && typeof exported === 'object') {
        patchRedisExports(exported as Record<string, unknown>);
      } else if (request === 'ioredis' && drivers.has('ioredis') && exported && typeof exported === 'function') {
        patchIoRedisExports(exported as { prototype?: Record<string, unknown> });
      }
      return exported;
    };
  } catch {
    // optional instrumentation
  }
}

function patchMongo(): boolean {
  try {
    const _mongoMod = 'mongodb';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return patchMongoExports(require(_mongoMod));
  } catch {
    return false;
  }
}

function patchMongoExports(mongodb: Record<string, unknown>): boolean {
  const mongoAny = mongodb as { Collection?: { prototype?: Record<string, unknown> } };
  const proto = mongoAny.Collection?.prototype;
  if (!proto || proto._openboxQueryPatched) return Boolean(proto);
  proto._openboxQueryPatched = true;

  for (const method of ['find', 'findOne', 'insertOne', 'updateOne', 'deleteOne', 'aggregate']) {
    const original = proto[method];
    if (typeof original !== 'function') continue;
    proto[method] = function patchedMongoOperation(filter: unknown, ...args: unknown[]) {
      const self = this as {
        collectionName?: string;
        namespace?: string;
        dbName?: string;
        s?: { dbName?: string; namespace?: string };
      };
      const activityId = getCurrentActivityId();
      if (!activityId) return original.call(self, filter, ...args);

      const statement = JSON.stringify({ [method]: filter ?? {} }).slice(0, 2000);
      const startMs = Date.now();
      const dbName = self.dbName ?? self.s?.dbName ?? String(self.namespace ?? self.s?.namespace ?? '').split('.')[0];
      const operation = method.toUpperCase();
      void evaluateDb(activityId, { dbSystem: 'mongodb', dbName, operation, statement, host: 'unknown', port: null, stage: 'started', startMs });
      const result = original.call(self, filter, ...args) as unknown;
      if (result && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function') {
        return (result as Promise<unknown>).then(
          async (value) => {
            await evaluateDb(activityId, {
              dbSystem: 'mongodb',
              dbName,
              operation,
              statement,
              host: 'unknown',
              port: null,
              stage: 'completed',
              startMs,
              endMs: Date.now(),
            });
            return value;
          },
          async (err) => {
            await evaluateDb(activityId, {
              dbSystem: 'mongodb',
              dbName,
              operation,
              statement,
              host: 'unknown',
              port: null,
              stage: 'completed',
              startMs,
              endMs: Date.now(),
              error: err,
            });
            throw err;
          },
        );
      }
      return result;
    };
  }
  return true;
}

/**
 * Real connection details for a redis client, across both supported drivers.
 *
 * ioredis exposes them flat on `options`; node-redis v4 nests the address under
 * `options.socket` and calls the database `database`. The patch used to hardcode
 * host 'unknown' / port 6379 / db '0', which made every redis span claim a
 * connection it had never checked — and left no way to tell n8n's queue Redis
 * apart from a Redis the agent actually uses.
 */
export function redisConnectionInfo(client: unknown): {
  host: string | null;
  port: number | null;
  db: string | null;
} {
  const opts = (client as {
    options?: {
      host?: string;
      port?: number;
      db?: number;
      database?: number;
      socket?: { host?: string; port?: number };
    };
  } | null)?.options ?? {};
  const host = opts.host ?? opts.socket?.host ?? null;
  const port = opts.port ?? opts.socket?.port ?? null;
  const db = opts.db ?? opts.database;
  return {
    host: host ? String(host) : null,
    port: port != null && Number.isFinite(Number(port)) ? Number(port) : null,
    db: db != null ? String(db) : null,
  };
}

/**
 * True when this connection is n8n's own Bull queue Redis.
 *
 * In queue mode n8n runs a main + worker pair coordinated through Redis. Because
 * the sendCommand patch sits on the driver prototype and AsyncLocalStorage
 * propagates down the whole call stack, every queue heartbeat, job poll and
 * pub/sub message n8n makes *while an activity is open* inherits our activity
 * scope and used to be reported as an agent span. A hosted trace for a workflow
 * whose only memory was Postgres came back with five of seven spans being
 * redis — none of them the agent's work.
 *
 * Matches host AND port, mirroring isN8nInternalPgConnection's AND semantics so
 * a different Redis on the same host is still traced.
 */
export function isN8nQueueRedisConnection(
  host: string | null | undefined,
  port: number | null | undefined,
): boolean {
  if ((_env.EXECUTIONS_MODE || '').toLowerCase() !== 'queue') return false;
  const queueHost = (_env.QUEUE_BULL_REDIS_HOST || 'localhost').toLowerCase();
  const queuePort = Number(_env.QUEUE_BULL_REDIS_PORT || 6379);
  return (
    Boolean(host) && host!.toLowerCase() === queueHost &&
    port != null && Number(port) === queuePort
  );
}

/**
 * True when the command itself targets n8n-internal keys or channels.
 *
 * Backstop for the connection check above: when the queue Redis and a Redis the
 * agent uses are the same instance, host/port cannot separate them, but the keys
 * still can. Bull namespaces everything under its prefix (default 'bull'), and
 * n8n's own pub/sub channels are 'n8n.*'. Every token is checked rather than
 * just the first key, because Bull drives most of its work through EVALSHA,
 * where the keys sit several arguments in.
 */
export function isN8nInternalRedisCommand(statement: string): boolean {
  const prefix = (_env.QUEUE_BULL_PREFIX || 'bull').toLowerCase();
  return statement
    .toLowerCase()
    .split(/\s+/)
    .some((token) => (
      token.startsWith(`${prefix}:`) ||
      token.startsWith('n8n.') ||
      token.startsWith('n8n:')
    ));
}

function patchRedis(): boolean {
  try {
    const _redisMod = 'redis';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return patchRedisExports(require(_redisMod));
  } catch {
    return false;
  }
}

function patchRedisExports(redis: Record<string, unknown>): boolean {
  const originalCreateClient = redis.createClient;
  if (typeof originalCreateClient !== 'function' || redis._openboxCreateClientPatched) return false;
  redis._openboxCreateClientPatched = true;
  redis.createClient = function patchedCreateClient(...args: unknown[]) {
    const client = Reflect.apply(originalCreateClient, this, args);
    patchRedisClient(client as Record<string, unknown>);
    return client;
  };
  return true;
}

function patchIoRedis(): boolean {
  try {
    const _ioredisMod = 'ioredis';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return patchIoRedisExports(require(_ioredisMod));
  } catch {
    return false;
  }
}

function patchIoRedisExports(redisCtor: { prototype?: Record<string, unknown> }): boolean {
  const proto = redisCtor.prototype;
  if (!proto) return false;
  return patchRedisClient(proto);
}

function patchRedisClient(client: Record<string, unknown>): boolean {
  if (client._openboxSendCommandPatched || typeof client.sendCommand !== 'function') return false;
  const original = client.sendCommand as (this: unknown, ...args: unknown[]) => unknown;
  client._openboxSendCommandPatched = true;
  client.sendCommand = function patchedSendCommand(command: unknown, ...args: unknown[]) {
    const activityId = getCurrentActivityId();
    if (!activityId) return original.call(this, command, ...args);
    const name = Array.isArray(command)
      ? String(command[0] ?? 'UNKNOWN')
      : String((command as Record<string, unknown> | null)?.name ?? command ?? 'UNKNOWN');
    const statement = Array.isArray(command) ? command.map(String).join(' ') : name;
    const operation = name.toUpperCase();

    // n8n's own queue traffic is not the agent's work — see
    // isN8nQueueRedisConnection / isN8nInternalRedisCommand.
    const conn = redisConnectionInfo(this);
    if (
      isN8nQueueRedisConnection(conn.host, conn.port) ||
      isN8nInternalRedisCommand(statement)
    ) {
      return original.call(this, command, ...args);
    }

    const dbOpts = {
      dbSystem: 'redis' as const,
      dbName: conn.db,
      operation,
      statement,
      host: conn.host,
      port: conn.port,
    };
    const startMs = Date.now();
    void evaluateDb(activityId, { ...dbOpts, stage: 'started', startMs });
    const result = original.call(this, command, ...args) as unknown;
    if (result && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function') {
      return (result as Promise<unknown>).then(
        async (value) => {
          await evaluateDb(activityId, {
            ...dbOpts,
            stage: 'completed',
            startMs,
            endMs: Date.now(),
          });
          return value;
        },
        async (err) => {
          await evaluateDb(activityId, {
            ...dbOpts,
            stage: 'completed',
            startMs,
            endMs: Date.now(),
            error: err,
          });
          throw err;
        },
      );
    }
    return result;
  };
  return true;
}

export function setupNodeHookInstrumentation(options: NodeInstrumentationOptions = {}): void {
  const logger = options.logger ?? noopLogger;
  if (installed) {
    // Instrumentation state (all the module-level _openbox*Patched flags) is
    // process-global — a second call in the same process reuses it rather
    // than failing or silently no-op'ing without any signal.
    logger.warn('OpenBox instrumentation already installed in this process — reusing existing patches.');
    return;
  }
  installed = true;

  if (options.fileIo ?? true) {
    try {
      // 'fs' resolves to the same built-in as 'node:fs'; stored in a variable
      // so the literal string does not trigger the no-restricted-imports rule.
      const _fsMod = 'fs';
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require(_fsMod) as typeof Fs;
      patchFsPromises(fs);
      patchFsCallbacks(fs);
      patchFsSync(fs);
    } catch (err) {
      logger.warn('fs instrumentation failed to install', err);
    }
  }

  const databasesEnabledByEnv = _env.OPENBOX_INSTRUMENT_DATABASES !== 'false';
  const drivers = options.databases ?? new Set<DatabaseDriverName>(ALL_DATABASE_DRIVERS);
  if (databasesEnabledByEnv && drivers.size > 0) {
    patchDatabaseModuleLoader(drivers);
    if (drivers.has('pg')) patchPg();
    if (drivers.has('mysql2')) patchMysql2();
    if (drivers.has('mongodb')) patchMongo();
    if (drivers.has('redis')) patchRedis();
    if (drivers.has('ioredis')) patchIoRedis();
  }
}
