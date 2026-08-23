/**
 * n8n's own Redis traffic must not be reported as agent spans.
 *
 * The sendCommand patch sits on the driver prototype and AsyncLocalStorage
 * propagates down the entire call stack, so every queue heartbeat, job poll and
 * pub/sub message n8n makes while an activity is open inherits our activity
 * scope. A hosted trace for a workflow whose only memory was Postgres came back
 * with five of seven spans being redis — none of them the agent's work.
 *
 * Two independent filters, because either alone has a blind spot: host/port
 * cannot separate a shared instance, and key prefixes cannot catch keyless
 * commands like PING or CLIENT SETNAME.
 */
import { describe, expect, it, afterEach } from 'vitest';
import {
  redisConnectionInfo,
  isN8nQueueRedisConnection,
  isN8nInternalRedisCommand,
} from '../shared/langchain/node_instrumentation';

const saved = { ...process.env };
afterEach(() => {
  for (const k of ['EXECUTIONS_MODE', 'QUEUE_BULL_REDIS_HOST', 'QUEUE_BULL_REDIS_PORT', 'QUEUE_BULL_PREFIX']) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('redisConnectionInfo', () => {
  it('reads the flat ioredis shape', () => {
    expect(redisConnectionInfo({ options: { host: 'redis', port: 6379, db: 2 } }))
      .toEqual({ host: 'redis', port: 6379, db: '2' });
  });

  it('reads the nested node-redis v4 shape', () => {
    expect(redisConnectionInfo({ options: { socket: { host: 'cache', port: 6380 }, database: 1 } }))
      .toEqual({ host: 'cache', port: 6380, db: '1' });
  });

  it('reports nulls rather than inventing a connection', () => {
    // The patch used to hardcode host 'unknown' / port 6379 / db '0' on every span.
    expect(redisConnectionInfo({})).toEqual({ host: null, port: null, db: null });
    expect(redisConnectionInfo(null)).toEqual({ host: null, port: null, db: null });
  });
});

describe('isN8nQueueRedisConnection', () => {
  it('matches the queue redis in queue mode', () => {
    process.env.EXECUTIONS_MODE = 'queue';
    process.env.QUEUE_BULL_REDIS_HOST = 'redis';
    process.env.QUEUE_BULL_REDIS_PORT = '6379';
    expect(isN8nQueueRedisConnection('redis', 6379)).toBe(true);
  });

  it('does not match a different redis on the same host', () => {
    process.env.EXECUTIONS_MODE = 'queue';
    process.env.QUEUE_BULL_REDIS_HOST = 'redis';
    process.env.QUEUE_BULL_REDIS_PORT = '6379';
    // AND semantics, mirroring isN8nInternalPgConnection: an agent's own Redis
    // alongside the queue must still be traced.
    expect(isN8nQueueRedisConnection('redis', 6380)).toBe(false);
    expect(isN8nQueueRedisConnection('memory-redis', 6379)).toBe(false);
  });

  it('never suppresses anything outside queue mode', () => {
    delete process.env.EXECUTIONS_MODE;
    process.env.QUEUE_BULL_REDIS_HOST = 'redis';
    expect(isN8nQueueRedisConnection('redis', 6379)).toBe(false);
  });

  it('does not match an unknown connection', () => {
    process.env.EXECUTIONS_MODE = 'queue';
    expect(isN8nQueueRedisConnection(null, null)).toBe(false);
  });
});

describe('isN8nInternalRedisCommand', () => {
  it('catches bull keys wherever they sit in the command', () => {
    expect(isN8nInternalRedisCommand('BRPOPLPUSH bull:jobs:wait bull:jobs:active 5')).toBe(true);
    // Bull drives most work through EVALSHA, where keys are several args in.
    expect(isN8nInternalRedisCommand('EVALSHA abc123 2 bull:jobs:id bull:jobs:delayed 0')).toBe(true);
  });

  it("catches n8n's own pub/sub channels", () => {
    expect(isN8nInternalRedisCommand('SUBSCRIBE n8n.commands')).toBe(true);
    expect(isN8nInternalRedisCommand('PUBLISH n8n.worker-response {}')).toBe(true);
  });

  it('honours a custom queue prefix', () => {
    process.env.QUEUE_BULL_PREFIX = 'myqueue';
    expect(isN8nInternalRedisCommand('LLEN myqueue:jobs:wait')).toBe(true);
    expect(isN8nInternalRedisCommand('LLEN bull:jobs:wait')).toBe(false);
  });

  it("leaves the agent's own commands alone", () => {
    expect(isN8nInternalRedisCommand('GET chat:session:42')).toBe(false);
    expect(isN8nInternalRedisCommand('HGETALL memory:user-7')).toBe(false);
    // A key that merely contains the word must not be mistaken for a prefix.
    expect(isN8nInternalRedisCommand('GET my-bullish-key')).toBe(false);
  });
});
