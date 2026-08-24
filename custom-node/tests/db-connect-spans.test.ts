/**
 * A *failed* connection must be traced, and the wrapper must not change how
 * `connect` behaves for any driver.
 *
 * Only query execution was instrumented, so a server the agent could not reach
 * produced no span at all. A hosted trace showed `load_memory` and
 * `save_context` each recording `failed` after ~1.4s against a broken Supabase
 * credential with nothing to explain either: the driver rejected at connect,
 * `query` was never called, and the query patch had nothing to intercept.
 *
 * Successful connections are deliberately NOT reported: instrumenting every
 * attempt flooded a healthy trace with 14 successful CONNECT spans against 14
 * spans of real work, doubling the run time since each span is its own
 * governance round-trip.
 *
 * These cover the wrapper itself — the part that would break every workflow if
 * it got a calling convention wrong. Drivers use all three: callback (mysql2),
 * promise (pg, mongodb, ioredis) and synchronous throw. With no activity in
 * scope the span path is inert, which is exactly the pass-through case.
 */
import { describe, expect, it } from 'vitest';
import { patchConnectMethod } from '../shared/langchain/node_instrumentation';

const readConn = () => ({ host: 'db.supabase.co', port: 5432, dbName: 'postgres' });

describe('patchConnectMethod', () => {
  it('passes a promise resolution through untouched', async () => {
    const proto: Record<string, unknown> = { connect: () => Promise.resolve('connected') };
    patchConnectMethod(proto, 'connect', 'postgresql', readConn);
    await expect((proto.connect as () => Promise<string>)()).resolves.toBe('connected');
  });

  it('still rejects when the driver rejects', async () => {
    const proto: Record<string, unknown> = {
      connect: () => Promise.reject(new Error('getaddrinfo ENOTFOUND db.supabase.co')),
    };
    patchConnectMethod(proto, 'connect', 'postgresql', readConn);
    await expect((proto.connect as () => Promise<never>)()).rejects.toThrow('ENOTFOUND');
  });

  it('still throws when the driver throws synchronously', () => {
    const proto: Record<string, unknown> = {
      connect: () => { throw new Error('bad config'); },
    };
    patchConnectMethod(proto, 'connect', 'postgresql', readConn);
    expect(() => (proto.connect as () => unknown)()).toThrow('bad config');
  });

  it('delivers the callback with its original arguments', () => {
    const seen: unknown[] = [];
    const proto: Record<string, unknown> = {
      connect: (cb: (e: unknown, v: unknown) => void) => cb(null, 'handle'),
    };
    patchConnectMethod(proto, 'connect', 'mysql', readConn);
    (proto.connect as (cb: (e: unknown, v: unknown) => void) => void)((err, value) => seen.push(err, value));
    expect(seen).toEqual([null, 'handle']);
  });

  it('delivers a callback error to the caller', () => {
    const err = new Error('ECONNREFUSED');
    const seen: unknown[] = [];
    const proto: Record<string, unknown> = {
      connect: (cb: (e: unknown) => void) => cb(err),
    };
    patchConnectMethod(proto, 'connect', 'mysql', readConn);
    (proto.connect as (cb: (e: unknown) => void) => void)((e) => seen.push(e));
    expect(seen).toEqual([err]);
  });

  it('patches a given method only once', () => {
    let depth = 0;
    const proto: Record<string, unknown> = { connect: () => { depth += 1; return Promise.resolve(); } };
    patchConnectMethod(proto, 'connect', 'postgresql', readConn);
    const afterFirst = proto.connect;
    patchConnectMethod(proto, 'connect', 'postgresql', readConn);
    expect(proto.connect).toBe(afterFirst);
    void (proto.connect as () => Promise<void>)();
    expect(depth).toBe(1);
  });

  it('leaves a driver without the method alone', () => {
    const proto: Record<string, unknown> = {};
    expect(() => patchConnectMethod(proto, 'connect', 'postgresql', readConn)).not.toThrow();
    expect(proto.connect).toBeUndefined();
  });

  it('survives a reader that throws', async () => {
    const proto: Record<string, unknown> = { connect: () => Promise.resolve('ok') };
    patchConnectMethod(proto, 'connect', 'postgresql', () => { throw new Error('no options'); });
    await expect((proto.connect as () => Promise<string>)()).resolves.toBe('ok');
  });
});
