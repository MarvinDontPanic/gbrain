import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runTranscriptsIngest } from '../src/core/transcripts/ingest.ts';
import { hermesAdapter } from '../src/core/transcripts/hermes.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { buildHermesFixture } from './fixtures/transcripts/hermes-fixture-builder.ts';

let engine: PGLiteEngine;
let dir: string;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  dir = mkdtempSync(join(tmpdir(), 'transcripts-lifecycle-'));
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function write(path: string, start: string, text: string): void {
  writeFileSync(path, [
    JSON.stringify({ type: 'session_meta', payload: { id: 'stable-session', timestamp: start } }),
    JSON.stringify({ type: 'event_msg', timestamp: start, payload: { type: 'user_message', message: text } }),
  ].join('\n') + '\n');
}
function opts(path: string) {
  return { paths: [path], sourceId: 'default', userPatternsPath: join(dir, 'no-patterns') };
}

test('a corrected session date updates text and retains existing visibility under the original canonical base', async () => {
  const path = join(dir, 'rollout.jsonl');
  write(path, '2026-01-02T10:00:00Z', 'original decision');
  const first = await runTranscriptsIngest(engine, opts(path));
  const base = first.slugsTouched[0];
  await engine.executeRaw(`UPDATE pages SET frontmatter = jsonb_set(frontmatter, '{visibility}', '"world"'::jsonb)
    WHERE source_id = $1 AND slug = $2`, ['default', base]);
  write(path, '2026-01-01T10:00:00Z', 'corrected decision ' + 'updated detail '.repeat(25_000));
  const updated = await runTranscriptsIngest(engine, opts(path));
  expect(updated.cleanScan).toBe(true);
  expect(updated.pages.imported).toBeGreaterThan(1);
  expect(updated.files[0].sessions[0].baseSlug).toBe(base);
  const pages = await engine.listPages({ type: 'conversation', sourceId: 'default', limit: 20 });
  expect(pages.every(p => p.slug === base || p.slug.startsWith(base + '-p'))).toBe(true);
  expect(pages.find(p => p.slug === base)!.frontmatter.visibility).toBe('world');
  expect(pages.filter(p => p.slug !== base).every(p => p.frontmatter.visibility === undefined)).toBe(true);
  const page = await engine.getPage(base, { sourceId: 'default' });
  expect(page!.compiled_truth).toContain('corrected decision');
  expect(page!.compiled_truth).not.toContain('original decision');
  expect(page!.frontmatter.date).toBe('2026-01-01');
  expect((await runTranscriptsIngest(engine, opts(path))).pages.imported).toBe(0);
  write(path, '2026-01-03T10:00:00Z', 'final shortened decision');
  const shrunk = await runTranscriptsIngest(engine, opts(path));
  expect(shrunk.partsDeleted).toBe(pages.length - 1);
  expect((await engine.listPages({ type: 'conversation', sourceId: 'default', limit: 20 })).map(p => p.slug)).toEqual([base]);
  expect((await engine.getPage(base, { sourceId: 'default' }))!.compiled_truth).toContain('final shortened decision');
});

test('a downstream run abort closes the native Hermes WAL snapshot reader', async () => {
  const path = buildHermesFixture(dir);
  const writer = new Database(path);
  writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA busy_timeout=0');
  const getPage = engine.getPage;
  try {
    writer.query('UPDATE messages SET content=? WHERE id=1').run('Before failed import');
    engine.getPage = async () => { throw new Error('injected downstream engine failure'); };
    await expect(runTranscriptsIngest(engine, opts(path))).rejects.toThrow('injected downstream engine failure');
    engine.getPage = getPage;
    writer.query('UPDATE messages SET content=? WHERE id=1').run('After failed import');
    expect(writer.query<{ busy: number }, []>('PRAGMA wal_checkpoint(TRUNCATE)').get()!.busy).toBe(0);
  } finally {
    engine.getPage = getPage;
    writer.close();
  }
});

test('adapter cleanup failure preserves the initiating engine failure and closes its native reader', async () => {
  const path = buildHermesFixture(dir);
  const writer = new Database(path);
  writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA busy_timeout=0');
  const cleanupError = new Error('injected adapter cleanup failure');
  const getPage = engine.getPage;
  try {
    writer.query('UPDATE messages SET content=? WHERE id=1').run('Before double failure');
    engine.getPage = async () => { throw new Error('injected initiating engine failure'); };
    let caught: unknown;
    try {
      await runTranscriptsIngest(engine, {
        ...opts(path),
        adapters: [{ ...hermesAdapter, parse: async function* (path, options) {
          try { return yield* hermesAdapter.parse(path, options); }
          finally { throw cleanupError; }
        } }],
      });
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors[0].message).toContain('injected initiating engine failure');
    expect((caught as AggregateError).errors[1]).toBe(cleanupError);
    writer.query('UPDATE messages SET content=? WHERE id=1').run('After double failure');
    expect(writer.query<{ busy: number }, []>('PRAGMA wal_checkpoint(TRUNCATE)').get()!.busy).toBe(0);
  } finally {
    engine.getPage = getPage;
    writer.close();
  }
});

test('canonical identity lookup failure aborts instead of treating identity as absent', async () => {
  const path = join(dir, 'rollout.jsonl');
  write(path, '2026-01-02T10:00:00Z', 'decision requiring identity verification');
  const executeRaw = engine.executeRaw;
  try {
    engine.executeRaw = async <T = Record<string, unknown>>(query: string, params?: unknown[]) => {
      if (query.includes("frontmatter->'transcript_import'")) throw new Error('injected identity lookup failure');
      return executeRaw.call(engine, query, params) as Promise<T[]>;
    };
    await expect(runTranscriptsIngest(engine, opts(path))).rejects.toThrow('transcripts-ingest run abort');
  } finally { engine.executeRaw = executeRaw; }
});

test('canonical identity resolution stays confined to the selected brain source', async () => {
  const path = join(dir, 'rollout.jsonl');
  write(path, '2026-01-02T10:00:00Z', 'private default-source decision');
  const original = await runTranscriptsIngest(engine, opts(path));
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('other', 'other')`);
  write(path, '2026-01-01T10:00:00Z', 'other-source decision');
  const other = await runTranscriptsIngest(engine, { ...opts(path), sourceId: 'other' });
  expect(other.slugsTouched[0]).not.toBe(original.slugsTouched[0]);
  expect((await engine.getPage(original.slugsTouched[0], { sourceId: 'default' }))!.compiled_truth).toContain('private default-source decision');
  expect((await engine.getPage(other.slugsTouched[0], { sourceId: 'other' }))!.compiled_truth).toContain('other-source decision');
});

test('legacy mixed-prefix parts retain their identities but are reconciled on shrink', async () => {
  const path = join(dir, 'rollout.jsonl');
  const text = 'long decision ' + 'updated detail '.repeat(25_000);
  write(path, '2026-01-02T10:00:00Z', text);
  const original = await runTranscriptsIngest(engine, opts(path));
  const base = original.files[0].sessions[0].baseSlug;
  const mixedPart = base.replace('2026-01-02', '2026-01-01') + '-p2';
  await engine.executeRaw('UPDATE pages SET slug = $1 WHERE source_id = $2 AND slug = $3', [mixedPart, 'default', base + '-p2']);
  write(path, '2026-01-01T10:00:00Z', text + ' newest ending');
  const updated = await runTranscriptsIngest(engine, opts(path));
  expect(updated.cleanScan).toBe(true);
  expect(updated.slugsTouched).toContain(mixedPart);
  const updatedParts = await engine.listPages({ type: 'conversation', sourceId: 'default', limit: 100 });
  expect(updatedParts.some(p => p.compiled_truth.includes('newest ending'))).toBe(true);
  expect((await engine.getPage(mixedPart, { sourceId: 'default' }))!.frontmatter.date).toBe('2026-01-01');
  write(path, '2026-01-03T10:00:00Z', 'shortened again');
  const shrunk = await runTranscriptsIngest(engine, opts(path));
  expect(shrunk.partsDeleted).toBe(updatedParts.length - 1);
  expect(await engine.getPage(mixedPart, { sourceId: 'default' })).toBeNull();
});
