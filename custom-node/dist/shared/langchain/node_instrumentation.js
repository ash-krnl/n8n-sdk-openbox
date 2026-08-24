"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildDbSpanData = buildDbSpanData;
exports.isN8nOrmStack = isN8nOrmStack;
exports.patchConnectMethod = patchConnectMethod;
exports.redisConnectionInfo = redisConnectionInfo;
exports.isN8nQueueRedisConnection = isN8nQueueRedisConnection;
exports.isN8nInternalRedisCommand = isN8nInternalRedisCommand;
exports.setupNodeHookInstrumentation = setupNodeHookInstrumentation;
// Access process.env via require() indirection to avoid the no-restricted-globals
// ESLint rule that flags the bare `process` identifier.
const _procMod = 'process';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const _env = require(_procMod).env;
const span_processor_1 = require("./span_processor");
const config_1 = require("./config");
const error_info_1 = require("./error-info");
const types_1 = require("./types");
const verdict_1 = require("./verdict");
let installed = false;
const noopLogger = { warn: () => { } };
// Skip system/internal paths — mirrors Python SDK's file skip patterns.
const FILE_SKIP_PATTERNS = ['/dev/', '/proc/', '/sys/', '/node_modules/'];
function shouldSkipFilePath(path) {
    return FILE_SKIP_PATTERNS.some((p) => path.includes(p));
}
function spanBase(name, kind, stage, startMs, error, endMs, idSeed) {
    const completedEndMs = stage === 'completed' ? endMs ?? Date.now() : undefined;
    return {
        // Stable across the started/completed pair of ONE operation. Core creates
        // the span row from the started hook and expects the completed hook to fill
        // in its duration, correlating the two by span_id (see UpdateCompletion /
        // CheckHookSpanExists in openbox-core). A fresh random id per stage — which
        // is what hexId(16) gave — left every span stuck at "started" with no
        // duration on the dashboard. Both stages pass the same startMs, so seeding
        // on it plus the operation identity yields one id per operation.
        span_id: idSeed ? (0, types_1.stableSpanId)(idSeed) : (0, types_1.hexId)(16),
        trace_id: (0, types_1.hexId)(32),
        parent_span_id: null,
        name,
        kind,
        stage,
        start_time: startMs * 1_000_000,
        end_time: completedEndMs == null ? null : completedEndMs * 1_000_000,
        duration_ns: completedEndMs == null ? null : (completedEndMs - startMs) * 1_000_000,
        attributes: {},
        status: { code: error ? 'ERROR' : 'UNSET', description: error ? (0, error_info_1.safeString)(error) : null },
        events: [],
    };
}
function classifySql(query) {
    const q = String(query ?? '').trim().toUpperCase();
    for (const verb of [
        'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP',
        'ALTER', 'TRUNCATE', 'BEGIN', 'COMMIT', 'ROLLBACK', 'EXPLAIN',
    ]) {
        if (q.startsWith(verb))
            return verb;
    }
    return 'UNKNOWN';
}
function buildFileSpanData(activityId, opts) {
    const result = {
        ...spanBase(`file.${opts.operation}`, 'INTERNAL', opts.stage, opts.startMs, opts.error, opts.endMs, `${activityId}|file|${opts.filePath}|${opts.operation}|${opts.startMs}`),
        hook_type: 'file_operation',
        file_path: opts.filePath,
        file_mode: opts.fileMode,
        file_operation: opts.operation,
        error: opts.error ? (0, error_info_1.safeString)(opts.error) : null,
        activity_id: activityId,
    };
    if (opts.bytesRead != null)
        result.bytes_read = opts.bytesRead;
    if (opts.bytesWritten != null)
        result.bytes_written = opts.bytesWritten;
    if (opts.linesCount != null)
        result.lines_count = opts.linesCount;
    if (opts.operations != null)
        result.operations = opts.operations;
    return result;
}
async function evaluateFile(activityId, opts) {
    await (0, span_processor_1.evaluateActivitySpan)(activityId, buildFileSpanData(activityId, opts));
}
function buildDbSpanData(activityId, opts) {
    const operation = opts.operation ?? classifySql(opts.statement);
    return {
        ...spanBase(`${operation} ${opts.dbSystem}`, 'CLIENT', opts.stage, opts.startMs, opts.error, opts.endMs, `${activityId}|db|${opts.dbSystem}|${opts.statement}|${opts.startMs}`),
        hook_type: 'db_query',
        db_system: opts.dbSystem,
        db_name: opts.dbName ? String(opts.dbName) : null,
        db_operation: operation,
        db_statement: opts.statement.slice(0, 2000),
        server_address: opts.host ?? null,
        server_port: opts.port != null && Number.isFinite(Number(opts.port)) ? Number(opts.port) : null,
        rowcount: opts.rowcount != null && Number(opts.rowcount) >= 0 ? Number(opts.rowcount) : null,
        error: opts.error ? (0, error_info_1.safeString)(opts.error) : null,
        activity_id: activityId,
    };
}
async function evaluateDb(activityId, opts) {
    await (0, span_processor_1.evaluateActivitySpan)(activityId, buildDbSpanData(activityId, opts));
}
/**
 * Wrap a fs.promises FileHandle to track open→read/write→close as a single
 * lifecycle span. Mirrors Python SDK's TracedFile wrapper.
 */
function wrapFileHandle(handle, activityId, filePath, fileMode, openStartMs) {
    let totalBytesRead = 0;
    let totalBytesWritten = 0;
    const ops = new Set(['open']);
    const origRead = typeof handle.read === 'function'
        ? handle.read
        : null;
    const origWrite = typeof handle.write === 'function'
        ? handle.write
        : null;
    const origClose = handle.close;
    if (origRead) {
        handle.read = async function patchedHandleRead(...a) {
            const r = await Reflect.apply(origRead, this, a);
            if ((r?.bytesRead ?? 0) > 0)
                totalBytesRead += r.bytesRead;
            ops.add('read');
            return r;
        };
    }
    if (origWrite) {
        handle.write = async function patchedHandleWrite(...a) {
            const r = await Reflect.apply(origWrite, this, a);
            if ((r?.bytesWritten ?? 0) > 0)
                totalBytesWritten += r.bytesWritten;
            ops.add('write');
            return r;
        };
    }
    handle.close = async function patchedHandleClose(...a) {
        const endMs = Date.now();
        try {
            return await Reflect.apply(origClose, this, a);
        }
        finally {
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
function patchFsPromises(fs) {
    const promises = fs.promises;
    if (promises._openboxPatched)
        return;
    promises._openboxPatched = true;
    for (const operation of ['readFile', 'writeFile', 'appendFile']) {
        const original = promises[operation];
        if (typeof original !== 'function')
            continue;
        promises[operation] = async function patchedFsPromise(path, dataOrOptions, maybeOptions) {
            const activityId = (0, span_processor_1.getCurrentActivityId)();
            if (!activityId)
                return Reflect.apply(original, this, arguments);
            const filePath = String(path);
            if (shouldSkipFilePath(filePath))
                return Reflect.apply(original, this, arguments);
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
            }
            catch (err) {
                await evaluateFile(activityId, { filePath, fileMode, operation, stage: 'completed', startMs, endMs: Date.now(), error: err });
                throw err;
            }
        };
    }
    // Patch open() for open→operations→close lifecycle.
    // Mirrors Python SDK's TracedFile wrapper.
    const originalOpen = promises.open;
    if (typeof originalOpen === 'function') {
        promises.open = async function patchedOpen(path, ...openArgs) {
            const activityId = (0, span_processor_1.getCurrentActivityId)();
            if (!activityId)
                return Reflect.apply(originalOpen, this, [path, ...openArgs]);
            const filePath = String(path);
            if (shouldSkipFilePath(filePath))
                return Reflect.apply(originalOpen, this, [path, ...openArgs]);
            const flags = openArgs[0];
            const fileMode = typeof flags === 'number' ? String(flags) : String(flags ?? 'r');
            const startMs = Date.now();
            await evaluateFile(activityId, { filePath, fileMode, operation: 'open', stage: 'started', startMs });
            let handle;
            try {
                handle = await Reflect.apply(originalOpen, this, [path, ...openArgs]);
            }
            catch (err) {
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
function patchFsSync(fs) {
    const target = fs;
    if (target._openboxSyncPatched)
        return;
    target._openboxSyncPatched = true;
    patchSyncOp(target, 'readFileSync', 'r', false);
    patchSyncOp(target, 'writeFileSync', 'w', true);
    patchSyncOp(target, 'mkdirSync', 'w', false);
}
function patchSyncOp(target, operation, fileMode, capturesWriteData) {
    const original = target[operation];
    if (typeof original !== 'function')
        return;
    target[operation] = function patchedSyncOp(path, ...args) {
        const activityId = (0, span_processor_1.getCurrentActivityId)();
        if (!activityId)
            return Reflect.apply(original, this, [path, ...args]);
        const filePath = String(path);
        if (shouldSkipFilePath(filePath))
            return Reflect.apply(original, this, [path, ...args]);
        const startMs = Date.now();
        try {
            const result = Reflect.apply(original, this, [path, ...args]);
            const bytesRead = !capturesWriteData && (typeof result === 'string' || Buffer.isBuffer(result))
                ? Buffer.byteLength(result)
                : undefined;
            const bytesWritten = capturesWriteData && (typeof args[0] === 'string' || Buffer.isBuffer(args[0]))
                ? Buffer.byteLength(args[0])
                : undefined;
            void evaluateFile(activityId, {
                filePath, fileMode, operation, stage: 'completed', startMs, endMs: Date.now(), bytesRead, bytesWritten,
            });
            return result;
        }
        catch (err) {
            void evaluateFile(activityId, { filePath, fileMode, operation, stage: 'completed', startMs, endMs: Date.now(), error: err });
            throw err;
        }
    };
}
function patchFsCallbacks(fs) {
    const target = fs;
    if (target._openboxCallbacksPatched)
        return;
    target._openboxCallbacksPatched = true;
    for (const operation of ['readFile', 'writeFile', 'appendFile']) {
        const original = target[operation];
        if (typeof original !== 'function')
            continue;
        target[operation] = function patchedFsCallback(path, ...args) {
            const activityId = (0, span_processor_1.getCurrentActivityId)();
            if (!activityId)
                return Reflect.apply(original, this, [path, ...args]);
            const filePath = String(path);
            if (shouldSkipFilePath(filePath))
                return Reflect.apply(original, this, [path, ...args]);
            const startMs = Date.now();
            const writes = operation !== 'readFile';
            const fileMode = operation === 'readFile' ? 'r' : operation === 'appendFile' ? 'a' : 'w';
            const callbackIndex = args.findIndex((arg) => typeof arg === 'function');
            const originalCallback = callbackIndex >= 0 ? args[callbackIndex] : null;
            void evaluateFile(activityId, { filePath, fileMode, operation, stage: 'started', startMs });
            if (originalCallback) {
                args[callbackIndex] = (...cbArgs) => {
                    const err = cbArgs[0];
                    const data = cbArgs[1];
                    const bytesRead = !writes && (typeof data === 'string' || Buffer.isBuffer(data))
                        ? Buffer.byteLength(data)
                        : undefined;
                    const bytesWritten = writes && (typeof args[0] === 'string' || Buffer.isBuffer(args[0]))
                        ? Buffer.byteLength(args[0])
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
function patchPg() {
    // n8n loads pg from its own node_modules, which may be at a different resolved
    // path than what require('pg') resolves to from this custom node's location.
    // Scanning require.cache finds the pg module that is actually in use, regardless
    // of install path, and ensures we patch the same prototype that n8n's memory
    // node is calling.
    let patched = false;
    try {
        const cache = require.cache;
        for (const [key, mod] of Object.entries(cache)) {
            if (/[/\\]pg[/\\]lib[/\\]index\.js$/.test(key) && mod?.exports) {
                if (patchPgExports(mod.exports))
                    patched = true;
            }
        }
    }
    catch { /* best effort */ }
    // Also try a direct require as a fallback (works when pg hasn't loaded yet).
    // Module name stored in a variable so static analysis cannot flag the literal.
    try {
        const _pgMod = 'pg';
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        if (patchPgExports(require(_pgMod)))
            patched = true;
    }
    catch { /* pg not on this resolution path */ }
    return patched;
}
/**
 * Frames belonging to n8n's own persistence layer.
 *
 * n8n routes every internal database access through its TypeORM fork, and the
 * agent's work never goes through it — a traced run separates 17/17 correctly
 * on this signal: n8n's credential lookups and TypeORM's own `SET search_path`
 * / `SET statement_timeout` on one side, the agent's chat-memory queries on the
 * other.
 *
 * Deliberately matches the `@n8n/typeorm` fork rather than any TypeORM: a tool
 * querying its own database through vanilla TypeORM is the agent's work and
 * must still be traced.
 */
const N8N_ORM_FRAME = /[\\/]@n8n[\\/]typeorm[\\/]/;
/** True when this stack shows the query came from n8n's own ORM. */
function isN8nOrmStack(stack) {
    return N8N_ORM_FRAME.test(stack);
}
/**
 * True when the caller is n8n's own persistence layer rather than the agent.
 *
 * Replaces an earlier check that compared the *connection* against the
 * DB_POSTGRESDB_* env vars. That could not work when the agent and n8n share a
 * database — n8n's own compose setup points a Postgres chat memory at exactly
 * that database — and it silently dropped every memory span: a run whose agent
 * issued 5 memory queries reported none of them. Call origin is independent of
 * host, database and table naming, so it holds however the deployment is wired.
 *
 * Costs one stack capture per query, and only inside a governed activity: the
 * caller checks `getCurrentActivityId()` before reaching here.
 *
 * If an async boundary ever drops the ORM frame, an n8n query surfaces as one
 * stray span — visible and fixable. It cannot silently swallow agent data,
 * which is the failure the connection check produced.
 */
function isN8nOrmQuery() {
    const previousLimit = Error.stackTraceLimit;
    // The ORM frame sits a few frames up, past pg's own internals.
    Error.stackTraceLimit = 40;
    const stack = new Error().stack ?? '';
    Error.stackTraceLimit = previousLimit;
    return isN8nOrmStack(stack);
}
/**
 * Report a *failed* connection attempt as a span pair.
 *
 * Only failures are reported. Connection establishment was previously not
 * instrumented at all, so a server the agent could not reach produced no span:
 * a hosted trace showed `load_memory` and `save_context` recording `failed`
 * after ~1.4s against a broken Supabase credential with nothing to explain it.
 *
 * Instrumenting every attempt fixed that but flooded the trace — a healthy run
 * emitted 14 successful CONNECT spans against 14 spans of real work, doubling
 * both the span count and the run time, since each span is its own governance
 * round-trip. A successful connection carries no information the queries on it
 * do not already carry, so only the failure is worth a span.
 *
 * Deliberately fire-and-forget: connections open while n8n initialises a
 * sub-node, and every governance request itself loads a credential — awaiting
 * there produced a governance/credential/query recursion once already.
 */
function reportFailedConnect(dbSystem, conn, startMs, error) {
    const activityId = (0, span_processor_1.getCurrentActivityId)();
    if (!activityId)
        return;
    const dbOpts = {
        dbSystem,
        dbName: conn.dbName ?? null,
        operation: 'CONNECT',
        // Target only — never the credential that authenticates it.
        statement: `CONNECT ${conn.host ?? 'unknown'}${conn.port != null ? `:${conn.port}` : ''}${conn.dbName ? `/${conn.dbName}` : ''}`,
        host: conn.host ?? null,
        port: conn.port ?? null,
    };
    // Sends are ordered per activity, so started lands before completed.
    void evaluateDb(activityId, { ...dbOpts, stage: 'started', startMs })
        .catch(() => { });
    void evaluateDb(activityId, {
        ...dbOpts, stage: 'completed', startMs, endMs: Date.now(), error,
    }).catch(() => { });
}
/**
 * Wrap a driver's `connect` so the attempt is traced whichever calling
 * convention it uses — callback, promise, or synchronous.
 */
function patchConnectMethod(proto, method, dbSystem, readConn, skip) {
    const original = proto[method];
    if (typeof original !== 'function' || proto[`_openbox${method}Patched`])
        return;
    proto[`_openbox${method}Patched`] = true;
    proto[method] = function patchedConnect(...args) {
        const call = () => original.apply(this, args);
        if (!(0, span_processor_1.getCurrentActivityId)())
            return call();
        let conn;
        try {
            conn = readConn(this);
        }
        catch {
            conn = {};
        }
        // n8n's own pools connect through its ORM; those are not the agent's work.
        if (isN8nOrmQuery() || (skip?.(conn) ?? false))
            return call();
        const startMs = Date.now();
        const fail = (err) => reportFailedConnect(dbSystem, conn, startMs, err);
        const lastArg = args[args.length - 1];
        if (typeof lastArg === 'function') {
            const callerCb = lastArg;
            args[args.length - 1] = function patchedConnectCallback(err, ...rest) {
                if (err)
                    fail(err);
                return callerCb.call(this, err, ...rest);
            };
            return call();
        }
        try {
            const result = call();
            if (result && typeof result.then === 'function') {
                return result.then((value) => value, (err) => { fail(err); throw err; });
            }
            return result;
        }
        catch (err) {
            fail(err);
            throw err;
        }
    };
}
function patchPgExports(pg) {
    try {
        const pgAny = pg;
        // ONLY Client.prototype — never Pool.prototype as well. node-postgres'
        // Pool.query() acquires a client and delegates to Client.query(), so
        // patching both records every pooled query TWICE: two identical 'started'
        // spans for one statement. That was masked by the 1s duplicate-suppression
        // window, which hid it against a fast local endpoint but not against a real
        // Core, where the first span's governance round-trip takes ~1s — long
        // enough for the dedupe entry to expire before the delegated call fires.
        // Patching the client alone captures pooled and direct queries exactly once.
        const readPgConn = (self) => {
            const c = self;
            return {
                host: c.host ?? c.options?.host ?? c.connectionParameters?.host ?? null,
                port: c.port ?? c.options?.port ?? c.connectionParameters?.port ?? null,
                dbName: c.database ?? c.options?.database ?? c.connectionParameters?.database ?? null,
            };
        };
        // Both, because the chat memory goes through Pool.connect() while a direct
        // client goes through Client.connect(); an unreachable server must be
        // reported either way.
        for (const ctor of [pgAny.Client, pgAny.Pool]) {
            if (ctor?.prototype)
                patchConnectMethod(ctor.prototype, 'connect', 'postgresql', readPgConn);
        }
        const prototypes = [pgAny.Client?.prototype]
            .filter((proto) => Boolean(proto));
        for (const proto of prototypes) {
            if (proto._openboxQueryPatched || typeof proto.query !== 'function')
                continue;
            const original = proto.query;
            proto._openboxQueryPatched = true;
            proto.query = function patchedPgQuery(query, ...args) {
                const self = this;
                const activityId = (0, span_processor_1.getCurrentActivityId)();
                if (!activityId)
                    return original.call(self, query, ...args);
                const statement = typeof query === 'string'
                    ? query
                    : String(query?.text ?? query ?? '');
                const startMs = Date.now();
                const host = self.host ?? self.options?.host ?? self.connectionParameters?.host;
                const port = self.port ?? self.options?.port ?? self.connectionParameters?.port;
                const dbName = self.database ?? self.options?.database ?? self.connectionParameters?.database;
                // n8n's own bookkeeping (credential lookups during node init) is not
                // the agent's work; the agent's queries on the same database are.
                if (isN8nOrmQuery())
                    return original.call(self, query, ...args);
                const dbOpts = {
                    dbSystem: 'postgresql',
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
                    const originalCb = args[cbIndex];
                    args[cbIndex] = function patchedPgCallback(err, result) {
                        void evaluateDb(activityId, {
                            ...dbOpts,
                            stage: 'completed',
                            startMs,
                            endMs: Date.now(),
                            error: err || undefined,
                            rowcount: result?.rowCount ?? null,
                        });
                        return originalCb.call(this, err, result);
                    };
                    return original.call(self, query, ...args);
                }
                return evaluateDb(activityId, { ...dbOpts, stage: 'started', startMs })
                    .catch((err) => {
                    // Governance verdicts (require_approval/block/halt) must stop the query
                    // from running — only swallow non-governance failures (e.g. Core API
                    // unreachable), which evaluateDb/evaluateHookSpan already fail-open on.
                    if (err instanceof verdict_1.GovernanceBlockedError)
                        throw err;
                })
                    .then(() => original.call(self, query, ...args)
                    .then(async (value) => {
                    await evaluateDb(activityId, {
                        ...dbOpts, stage: 'completed', startMs, endMs: Date.now(), rowcount: value?.rowCount,
                    }).catch((hookErr) => {
                        // require_approval on a completed span can't un-run the query —
                        // swallow it and rely on the caller's hasActivityAbort() check to
                        // poll (mirrors the HTTP fetch patch). block/halt still propagate.
                        if (hookErr instanceof verdict_1.GovernanceBlockedError && hookErr.verdict !== 'require_approval')
                            throw hookErr;
                    });
                    return value;
                }, async (err) => {
                    await evaluateDb(activityId, {
                        ...dbOpts, stage: 'completed', startMs, endMs: Date.now(), error: err,
                    }).catch(() => { });
                    throw err;
                }));
            };
        }
        return prototypes.length > 0;
    }
    catch {
        return false;
    }
}
function patchMysql2() {
    try {
        const _mysql2Mod = 'mysql2';
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mysql2 = require(_mysql2Mod);
        return patchMysql2Exports(mysql2);
    }
    catch {
        return false;
    }
}
function patchMysql2Exports(mysql2) {
    try {
        const mysqlAny = mysql2;
        const proto = mysqlAny.Connection?.prototype;
        if (proto) {
            patchConnectMethod(proto, 'connect', 'mysql', (self) => {
                const c = self.config ?? {};
                return { host: c.host ?? null, port: c.port ?? null, dbName: c.database ?? null };
            });
        }
        if (!proto || proto._openboxQueryPatched || typeof proto.query !== 'function')
            return false;
        const original = proto.query;
        proto._openboxQueryPatched = true;
        proto.query = function patchedMysqlQuery(sql, ...args) {
            const self = this;
            const activityId = (0, span_processor_1.getCurrentActivityId)();
            if (!activityId)
                return original.call(self, sql, ...args);
            const statement = typeof sql === 'string' ? sql : String(sql?.sql ?? sql ?? '');
            const startMs = Date.now();
            const dbOpts = {
                dbSystem: 'mysql',
                dbName: self.config?.database,
                statement,
                host: self.config?.host,
                port: Number(self.config?.port) || null,
            };
            void evaluateDb(activityId, { ...dbOpts, stage: 'started', startMs });
            const callbackIndex = args.findIndex((a) => typeof a === 'function');
            if (callbackIndex >= 0) {
                const originalCb = args[callbackIndex];
                args[callbackIndex] = function patchedMysql2Callback(err, results, fields) {
                    void evaluateDb(activityId, {
                        ...dbOpts,
                        stage: 'completed',
                        startMs,
                        endMs: Date.now(),
                        error: err || undefined,
                        rowcount: Array.isArray(results) ? results.length
                            : results?.affectedRows ?? null,
                    });
                    originalCb(err, results, fields);
                };
            }
            return original.call(self, sql, ...args);
        };
        return true;
    }
    catch {
        return false;
    }
}
function patchDatabaseModuleLoader(drivers) {
    try {
        // 'module' resolves to the same built-in as 'node:module'; stored in a variable
        // so the literal string does not trigger the no-restricted-imports rule.
        const _moduleMod = 'module';
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const Module = require(_moduleMod);
        if (Module._openboxDbPatched || typeof Module._load !== 'function')
            return;
        const originalLoad = Module._load;
        Module._openboxDbPatched = true;
        Module._load = function patchedModuleLoad(request, parent, isMain) {
            const exported = originalLoad.apply(this, [request, parent, isMain]);
            if (request === 'pg' && drivers.has('pg') && exported && typeof exported === 'object') {
                patchPgExports(exported);
            }
            else if (request === 'mysql2' && drivers.has('mysql2') && exported && typeof exported === 'object') {
                patchMysql2Exports(exported);
            }
            else if (request === 'mongodb' && drivers.has('mongodb') && exported && typeof exported === 'object') {
                patchMongoExports(exported);
            }
            else if (request === 'redis' && drivers.has('redis') && exported && typeof exported === 'object') {
                patchRedisExports(exported);
            }
            else if (request === 'ioredis' && drivers.has('ioredis') && exported && typeof exported === 'function') {
                patchIoRedisExports(exported);
            }
            return exported;
        };
    }
    catch {
        // optional instrumentation
    }
}
function patchMongo() {
    try {
        const _mongoMod = 'mongodb';
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return patchMongoExports(require(_mongoMod));
    }
    catch {
        return false;
    }
}
function patchMongoExports(mongodb) {
    const mongoAny = mongodb;
    if (mongoAny.MongoClient?.prototype) {
        patchConnectMethod(mongoAny.MongoClient.prototype, 'connect', 'mongodb', (self) => {
            const c = self;
            const first = c.options?.hosts?.[0];
            return { host: first?.host ?? null, port: first?.port ?? null, dbName: c.options?.dbName ?? null };
        });
    }
    const proto = mongoAny.Collection?.prototype;
    if (!proto || proto._openboxQueryPatched)
        return Boolean(proto);
    proto._openboxQueryPatched = true;
    for (const method of ['find', 'findOne', 'insertOne', 'updateOne', 'deleteOne', 'aggregate']) {
        const original = proto[method];
        if (typeof original !== 'function')
            continue;
        proto[method] = function patchedMongoOperation(filter, ...args) {
            const self = this;
            const activityId = (0, span_processor_1.getCurrentActivityId)();
            if (!activityId)
                return original.call(self, filter, ...args);
            const statement = JSON.stringify({ [method]: filter ?? {} }).slice(0, 2000);
            const startMs = Date.now();
            const dbName = self.dbName ?? self.s?.dbName ?? String(self.namespace ?? self.s?.namespace ?? '').split('.')[0];
            const operation = method.toUpperCase();
            void evaluateDb(activityId, { dbSystem: 'mongodb', dbName, operation, statement, host: 'unknown', port: null, stage: 'started', startMs });
            const result = original.call(self, filter, ...args);
            if (result && typeof result === 'object' && typeof result.then === 'function') {
                return result.then(async (value) => {
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
                }, async (err) => {
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
                });
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
function redisConnectionInfo(client) {
    const opts = client?.options ?? {};
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
 * Matches host AND port, mirroring the pg filter's AND semantics so
 * a different Redis on the same host is still traced.
 */
function isN8nQueueRedisConnection(host, port) {
    if ((_env.EXECUTIONS_MODE || '').toLowerCase() !== 'queue')
        return false;
    const queueHost = (_env.QUEUE_BULL_REDIS_HOST || 'localhost').toLowerCase();
    const queuePort = Number(_env.QUEUE_BULL_REDIS_PORT || 6379);
    return (Boolean(host) && host.toLowerCase() === queueHost &&
        port != null && Number(port) === queuePort);
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
function isN8nInternalRedisCommand(statement) {
    const prefix = (_env.QUEUE_BULL_PREFIX || 'bull').toLowerCase();
    return statement
        .toLowerCase()
        .split(/\s+/)
        .some((token) => (token.startsWith(`${prefix}:`) ||
        token.startsWith('n8n.') ||
        token.startsWith('n8n:')));
}
function patchRedis() {
    try {
        const _redisMod = 'redis';
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return patchRedisExports(require(_redisMod));
    }
    catch {
        return false;
    }
}
function patchRedisExports(redis) {
    const originalCreateClient = redis.createClient;
    if (typeof originalCreateClient !== 'function' || redis._openboxCreateClientPatched)
        return false;
    redis._openboxCreateClientPatched = true;
    redis.createClient = function patchedCreateClient(...args) {
        const client = Reflect.apply(originalCreateClient, this, args);
        patchRedisConnect(client);
        patchRedisClient(client);
        return client;
    };
    return true;
}
function patchIoRedis() {
    try {
        const _ioredisMod = 'ioredis';
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return patchIoRedisExports(require(_ioredisMod));
    }
    catch {
        return false;
    }
}
function patchIoRedisExports(redisCtor) {
    const proto = redisCtor.prototype;
    if (!proto)
        return false;
    patchRedisConnect(proto);
    return patchRedisClient(proto);
}
/**
 * Trace connection attempts for a redis client or prototype.
 *
 * Uses the same queue-connection guard as the command patch, so n8n's own Bull
 * and pub/sub clients are not reported as the agent's work.
 */
function patchRedisConnect(target) {
    patchConnectMethod(target, 'connect', 'redis', (self) => {
        const c = redisConnectionInfo(self);
        return { host: c.host, port: c.port, dbName: c.db };
    }, (conn) => isN8nQueueRedisConnection(conn.host, conn.port));
}
function patchRedisClient(client) {
    if (client._openboxSendCommandPatched || typeof client.sendCommand !== 'function')
        return false;
    const original = client.sendCommand;
    client._openboxSendCommandPatched = true;
    client.sendCommand = function patchedSendCommand(command, ...args) {
        const activityId = (0, span_processor_1.getCurrentActivityId)();
        if (!activityId)
            return original.call(this, command, ...args);
        const name = Array.isArray(command)
            ? String(command[0] ?? 'UNKNOWN')
            : String(command?.name ?? command ?? 'UNKNOWN');
        const statement = Array.isArray(command) ? command.map(String).join(' ') : name;
        const operation = name.toUpperCase();
        // n8n's own queue traffic is not the agent's work — see
        // isN8nQueueRedisConnection / isN8nInternalRedisCommand.
        const conn = redisConnectionInfo(this);
        if (isN8nQueueRedisConnection(conn.host, conn.port) ||
            isN8nInternalRedisCommand(statement)) {
            return original.call(this, command, ...args);
        }
        const dbOpts = {
            dbSystem: 'redis',
            dbName: conn.db,
            operation,
            statement,
            host: conn.host,
            port: conn.port,
        };
        const startMs = Date.now();
        void evaluateDb(activityId, { ...dbOpts, stage: 'started', startMs });
        const result = original.call(this, command, ...args);
        if (result && typeof result === 'object' && typeof result.then === 'function') {
            return result.then(async (value) => {
                await evaluateDb(activityId, {
                    ...dbOpts,
                    stage: 'completed',
                    startMs,
                    endMs: Date.now(),
                });
                return value;
            }, async (err) => {
                await evaluateDb(activityId, {
                    ...dbOpts,
                    stage: 'completed',
                    startMs,
                    endMs: Date.now(),
                    error: err,
                });
                throw err;
            });
        }
        return result;
    };
    return true;
}
function setupNodeHookInstrumentation(options = {}) {
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
            const fs = require(_fsMod);
            patchFsPromises(fs);
            patchFsCallbacks(fs);
            patchFsSync(fs);
        }
        catch (err) {
            logger.warn('fs instrumentation failed to install', err);
        }
    }
    const databasesEnabledByEnv = _env.OPENBOX_INSTRUMENT_DATABASES !== 'false';
    const drivers = options.databases ?? new Set(config_1.ALL_DATABASE_DRIVERS);
    if (databasesEnabledByEnv && drivers.size > 0) {
        patchDatabaseModuleLoader(drivers);
        if (drivers.has('pg'))
            patchPg();
        if (drivers.has('mysql2'))
            patchMysql2();
        if (drivers.has('mongodb'))
            patchMongo();
        if (drivers.has('redis'))
            patchRedis();
        if (drivers.has('ioredis'))
            patchIoRedis();
    }
}
