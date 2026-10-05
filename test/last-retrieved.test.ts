/**
 * v0.41.8.0 — drain helper for fire-and-forget last_retrieved_at writes.
 *
 * Closes #1247, #1269, #1290: PGLite CLI commands printed search /
 * query / get_page output then hung at ~95-98% CPU until SIGKILL.
 * The drain helper here is the structural fix paired with the
 * cli.ts narrow timeout-only force-exit guard.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  awaitPendingLastRetrievedWrites,
  bumpLastRetrievedAt,
  _resetTrackRetrievalCacheForTests,
  _resetPendingLastRetrievedWritesForTests,
  _peekPendingLastRetrievedWritesForTests,
} from '../src/core/last-retrieved.ts';

// Minimal BrainEngine stub. The drain helper itself doesn't touch
// the engine — only bumpLastRetrievedAt does — so we control behavior
// through what `executeRaw` does.
function makeStubEngine(opts?: {
  executeRaw?: (sql: string, params?: unknown[]) => Promise<unknown[]>;
  getConfig?: (key: string) => Promise<string | null>;
}): BrainEngine {
  const engine = {
    kind: 'pglite' as const,
    executeRaw:
      opts?.executeRaw ??
      (async () => {
        return [];
      }),
    getConfig:
      opts?.getConfig ??
      (async () => {
        return null;
      }),
  };
  return engine as unknown as BrainEngine;
}

describe('awaitPendingLastRetrievedWrites', () => {
  beforeEach(() => {
    _resetPendingLastRetrievedWritesForTests();
    _resetTrackRetrievalCacheForTests();
  });

  afterEach(() => {
    _resetPendingLastRetrievedWritesForTests();
    _resetTrackRetrievalCacheForTests();
  });

  test('empty set returns drained:0 immediately (fast-path)', async () => {
    const t0 = Date.now();
    const result = await awaitPendingLastRetrievedWrites();
    const dt = Date.now() - t0;
    expect(result).toEqual({ outcome: 'drained', pending: 0 });
    expect(dt).toBeLessThan(50);
  });

  test('single tracked write completes, drain resolves cleanly', async () => {
    let resolved = false;
    const engine = makeStubEngine({
      executeRaw: async () => {
        await new Promise((r) => setTimeout(r, 30));
        resolved = true;
        return [];
      },
    });
    bumpLastRetrievedAt(engine, [1, 2, 3]);
    expect(_peekPendingLastRetrievedWritesForTests()).toBe(1);
    const result = await awaitPendingLastRetrievedWrites();
    expect(result).toEqual({ outcome: 'drained', pending: 0 });
    expect(resolved).toBe(true);
    // Promise removed from set on settle
    expect(_peekPendingLastRetrievedWritesForTests()).toBe(0);
  });

  test('multiple tracked writes all settled via allSettled', async () => {
    let count = 0;
    const engine = makeStubEngine({
      executeRaw: async () => {
        await new Promise((r) => setTimeout(r, 20));
        count++;
        return [];
      },
    });
    bumpLastRetrievedAt(engine, [1]);
    bumpLastRetrievedAt(engine, [2]);
    bumpLastRetrievedAt(engine, [3]);
    expect(_peekPendingLastRetrievedWritesForTests()).toBe(3);
    const result = await awaitPendingLastRetrievedWrites();
    expect(result.outcome).toBe('drained');
    expect(count).toBe(3);
    expect(_peekPendingLastRetrievedWritesForTests()).toBe(0);
  });

  test('throw inside IIFE still settles the promise; drain completes', async () => {
    const engine = makeStubEngine({
      executeRaw: async () => {
        throw new Error('synthetic-failure');
      },
    });
    bumpLastRetrievedAt(engine, [1]);
    // Brief tick so the IIFE has a chance to run and reject
    await new Promise((r) => setTimeout(r, 10));
    const result = await awaitPendingLastRetrievedWrites();
    expect(result.outcome).toBe('drained');
    expect(_peekPendingLastRetrievedWritesForTests()).toBe(0);
  });

  test('permanently-pending promise returns timeout outcome with pending count', async () => {
    // Stage a manually-tracked promise that never resolves so the
    // drain hits the timeout path. We can't use bumpLastRetrievedAt
    // for this (its IIFE always settles via try/catch) — we need
    // the raw track API. Use the public API and a never-resolving
    // executeRaw stub.
    const neverEngine = makeStubEngine({
      executeRaw: () => new Promise<unknown[]>(() => {
        /* never */
      }),
    });
    bumpLastRetrievedAt(neverEngine, [1]);
    await new Promise((r) => setTimeout(r, 10));
    expect(_peekPendingLastRetrievedWritesForTests()).toBe(1);

    const t0 = performance.now();
    const result = await awaitPendingLastRetrievedWrites(100); // 100ms test timeout
    const dt = performance.now() - t0;

    expect(result.outcome).toBe('timeout');
    expect(result.pending).toBe(1);
    // Should return within timeout + small buffer; not block forever. Timers
    // are scheduled at whole-millisecond granularity, so a 100ms timer can be
    // observed at 99.x ms (CI saw 99 with Date.now()).
    expect(dt).toBeGreaterThanOrEqual(99);
    expect(dt).toBeLessThan(300);
    // The timeout bounds this wait; it does not cancel the UPDATE.
    expect(_peekPendingLastRetrievedWritesForTests()).toBe(1);
  });

  test('bumpLastRetrievedAt with empty pageIds does not track a promise', async () => {
    const engine = makeStubEngine();
    bumpLastRetrievedAt(engine, []);
    expect(_peekPendingLastRetrievedWritesForTests()).toBe(0);
    const result = await awaitPendingLastRetrievedWrites();
    expect(result).toEqual({ outcome: 'drained', pending: 0 });
  });

  test('a timed-out write remains owned until a later drain observes settlement', async () => {
    let completeWrite!: (value: unknown[]) => void;
    let writeStarted!: () => void;
    const started = new Promise<void>((resolve) => { writeStarted = resolve; });
    const engine = makeStubEngine({
      executeRaw: () => {
        writeStarted();
        return new Promise<unknown[]>((resolve) => { completeWrite = resolve; });
      },
    });
    bumpLastRetrievedAt(engine, [1]);
    await started;
    expect(await awaitPendingLastRetrievedWrites(10)).toEqual({ outcome: 'timeout', pending: 1 });
    expect(_peekPendingLastRetrievedWritesForTests()).toBe(1);

    // The engine-disconnect pass must still see the same in-flight UPDATE.
    const second = awaitPendingLastRetrievedWrites(100);
    completeWrite([]);
    expect(await second).toEqual({ outcome: 'drained', pending: 0 });
    expect(_peekPendingLastRetrievedWritesForTests()).toBe(0);
  });
});
