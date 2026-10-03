import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { installPageEmbeddings, readProjectionSnapshot } from '../src/core/page-state/projections.ts';

let engine: BrainEngine;
let closePostgres: (() => Promise<void>) | undefined;
const sourceId = 'defer-embedding-test';
const ctx = (deferEmbeds = false, remote = false): OperationContext => ({ engine, sourceId, remote,
  config: { engine: engine.kind, embedding_disabled: true }, dryRun: false, deferEmbeds,
  logger: { info() {}, warn() {}, error() {} } });
const params = () => {
  const slug = `example-${randomUUID()}`;
  return { slug, content: `---\ntype: note\ntitle: Example\n---\nSource prose ${slug}.`, request_id: randomUUID() };
};
const rows = (requestId: string) => engine.executeRaw<{ id: string; intent: Record<string, unknown>; outcome: Record<string, unknown> }>(
  'SELECT id,intent,outcome FROM persistence_requests WHERE request_id=$1::uuid AND source_id=$2', [requestId, sourceId]);
beforeAll(async () => {
  if (process.env.DATABASE_URL) ({ engine, close: closePostgres } = await isolatedPersistencePostgres(process.env.DATABASE_URL));
  else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
}, 120_000);
afterAll(async () => { if (engine) { await disposePersistenceConsumer(engine); await engine.disconnect(); } await closePostgres?.(); });

test('server deferral survives durable admission and commits readable chunks without embedding debt', async () => {
  const p = params(); const result = await submitPageMutation(ctx(true), { operation: 'put_page', params: p });
  expect(result.state).toBe('committed');
  const [row] = await rows(p.request_id);
  expect(row.intent.deferEmbeds).toBe(true);
  expect(row.outcome.embedding_state).toBe('deferred');
  expect(await engine.executeRaw("SELECT id FROM persistence_effects WHERE request_id=$1::uuid AND kind='embedding'", [row.id])).toHaveLength(0);
  expect((await engine.getPage(p.slug, { sourceId }))!.compiled_truth).toBe(`Source prose ${p.slug}.`);
  const chunks = await engine.getChunks(p.slug, { sourceId, includeEmbedding: true });
  expect(chunks.length).toBeGreaterThan(0); expect(chunks.every(c => c.embedding == null)).toBe(true);
});

test('replaying the same server policy preserves identity while changing it refuses', async () => {
  const p = params(); const first = await submitPageMutation(ctx(true), { operation: 'put_page', params: p });
  const replay = await submitPageMutation(ctx(true), { operation: 'put_page', params: p });
  expect(replay.revision).toBe(first.revision); expect(await rows(p.request_id)).toHaveLength(1);
  await expect(submitPageMutation(ctx(false), { operation: 'put_page', params: p })).rejects.toMatchObject({ code: 'idempotency_conflict' });
});

test('ordinary writes retain embedding debt and an untrusted wire field cannot defer it', async () => {
  const p = params(); await submitPageMutation(ctx(), { operation: 'put_page', params: p });
  const [row] = await rows(p.request_id);
  expect(row.intent.deferEmbeds).toBeUndefined(); expect(row.outcome.embedding_state).toBe('queued');
  expect(await engine.executeRaw("SELECT id FROM persistence_effects WHERE request_id=$1::uuid AND kind='embedding'", [row.id])).toHaveLength(1);
  for (const remote of [false, true]) {
    const forged = { ...params(), deferEmbeds: true };
    await expect(submitPageMutation(ctx(false, remote), { operation: 'put_page', params: forged })).rejects.toMatchObject({ code: 'invalid_params' });
    expect(await rows(forged.request_id)).toHaveLength(0);
  }
});

test('a server-set policy remains effective for delegated remote dispatch without entering the wire schema', async () => {
  const p = params(); await submitPageMutation(ctx(true, true), { operation: 'put_page', params: p });
  const [row] = await rows(p.request_id);
  expect(row.intent.deferEmbeds).toBe(true); expect(row.outcome.embedding_state).toBe('deferred');
  expect(await engine.executeRaw("SELECT id FROM persistence_effects WHERE request_id=$1::uuid AND kind='embedding'", [row.id])).toHaveLength(0);
});

test('conditional deferred replacement removes stale vectors and rejects a wrong revision without changing content', async () => {
  const p = params(); await submitPageMutation(ctx(true), { operation: 'put_page', params: p });
  const before = (await readProjectionSnapshot(engine, p.slug, sourceId))!;
  expect(await installPageEmbeddings(engine, before, before.chunks.map(c => ({
    chunk_index: c.chunk_index, chunk_source: c.chunk_source, chunk_text: c.chunk_text,
    embedding: new Float32Array(1536).fill(0.125), model: 'test:model',
  })), 'test:model:1536')).toBe(true);
  const original = (await engine.getChunks(p.slug, { sourceId, includeEmbedding: true }))[0];
  expect(original.embedding?.[0]).toBe(0.125);
  const replacement = { ...p, content: p.content.replace('Source prose', 'Changed source prose'), request_id: randomUUID() };
  await expect(submitPageMutation(ctx(true), { operation: 'put_page', params: {
    ...replacement, expected_revision: randomUUID(),
  } })).rejects.toMatchObject({ code: 'revision_conflict' });
  expect((await engine.getPage(p.slug, { sourceId }))!.knowledge_revision).toBe(before.snapshot.revision);
  const afterRefusal = (await engine.getChunks(p.slug, { sourceId, includeEmbedding: true }))[0];
  expect(afterRefusal.chunk_text).toBe(original.chunk_text); expect(afterRefusal.embedding?.[0]).toBe(0.125);
  const accepted = { ...replacement, request_id: randomUUID(), expected_revision: before.snapshot.revision };
  const result = await submitPageMutation(ctx(true), { operation: 'put_page', params: accepted });
  expect(result.state).toBe('committed'); expect(result.revision).not.toBe(before.snapshot.revision);
  const [row] = await rows(accepted.request_id); expect(row.outcome.embedding_state).toBe('deferred');
  expect(await engine.executeRaw("SELECT id FROM persistence_effects WHERE request_id=$1::uuid AND kind='embedding'", [row.id])).toHaveLength(0);
  const current = await engine.getChunks(p.slug, { sourceId, includeEmbedding: true });
  expect(current.length).toBeGreaterThan(0); expect(current.every(c => c.embedding == null && c.chunk_text.includes('Changed source prose'))).toBe(true);
  expect(await installPageEmbeddings(engine, before, [{ chunk_index: original.chunk_index,
    chunk_source: original.chunk_source, chunk_text: original.chunk_text, embedding: new Float32Array(1536).fill(0.125), model: 'test:model' }])).toBe(false);
  expect((await submitPageMutation(ctx(true), { operation: 'put_page', params: accepted })).revision).toBe(result.revision);
  await expect(submitPageMutation(ctx(false), { operation: 'put_page', params: accepted })).rejects.toMatchObject({ code: 'idempotency_conflict' });
});
