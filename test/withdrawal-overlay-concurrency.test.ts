import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { renderFactsTable, type ParsedFact } from '../src/core/facts-fence.ts';
import { recordFactWithdrawal, preserveWithdrawnFenceRows } from '../src/core/facts/withdrawal.ts';
import { withdrawalFenceBlocks } from '../src/core/facts/withdrawal-overlay.ts';
import { sanitizeRemoteBody } from '../src/core/remote-body.ts';
import { rebuildPendingPageProjections } from '../src/core/page-state/projections.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { importFromContent } from '../src/core/import-file.ts';
import type { PreparedContentImport } from '../src/core/persistence/prepared-import.ts';

const engines: BrainEngine[] = [];
let disposePostgres: (() => Promise<void>) | undefined;
const sourceId = 'withdrawal-overlay-test';
beforeAll(async () => {
  const lite = new PGLiteEngine();
  await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) {
    const fixture = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(fixture.engine); disposePostgres = fixture.close;
  }
  for (const engine of engines) await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [sourceId]);
}, 120_000);
afterAll(async () => {
  for (const engine of engines) await engine.disconnect();
  await disposePostgres?.();
}, 60_000);

function fact(claim: string, extra: Partial<ParsedFact> = {}): ParsedFact {
  return { rowNum: 1, claim, kind: 'fact', confidence: 1, visibility: 'world', notability: 'medium',
    active: true, context: 'Original evidence context', ...extra };
}

test('withdrawal covers prior context, inactive history and every legacy fence by fingerprint', async () => {
  const active = 'withdrawalcontextsentinel active claim';
  const expired = 'withdrawalhistorysentinel expired claim';
  const body = `Safe prose\n${renderFactsTable([fact(active), fact(active, { rowNum: 2, visibility: 'private' })])}
Historical section\n${renderFactsTable([fact(expired, { active: false, validUntil: '2020-01-01', context: 'superseded by #9' })])}`;
  for (const engine of engines) {
    await engine.putPage('legacy-withdrawal', { type: 'note', title: 'Synthetic legacy facts', compiled_truth: body }, { sourceId });
    for (const claim of [active, expired]) {
      const stored = await engine.insertFact({ fact: claim, source: 'test', visibility: 'world' }, { source_id: sourceId });
      expect((await recordFactWithdrawal(engine, stored.id, sourceId, true)).withdrawn).toBe(true);
    }
    const snapshot = (await engine.readPageSnapshot('legacy-withdrawal', { sourceId }))!;
    const rows = withdrawalFenceBlocks(snapshot.page.compiled_truth).flatMap(block => block.parsed.facts);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ active: false, forgotten: true });
    expect(rows[0].context).toStartWith('forgotten:');
    expect(rows[0].context).toContain('Original evidence context');
    expect(rows[1]).toMatchObject({ active: true, visibility: 'private', forgotten: false });
    expect(rows[2]).toMatchObject({ active: false, forgotten: true, validUntil: '2020-01-01' });
    expect(rows[2].context).toContain('superseded by #9');
    expect(sanitizeRemoteBody(snapshot.page.compiled_truth)).not.toContain(active);
    expect(sanitizeRemoteBody(snapshot.page.compiled_truth)).not.toContain(expired);
    const imported = await preserveWithdrawnFenceRows(engine, sourceId, body);
    expect(imported).toBe(snapshot.page.compiled_truth);
    expect(await preserveWithdrawnFenceRows(engine, sourceId, imported)).toBe(imported);
    await rebuildPendingPageProjections(engine, 100);
    const chunks = await engine.getChunks('legacy-withdrawal', { sourceId });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.map(chunk => chunk.chunk_text).join('\n')).not.toContain('withdrawal');
    expect(await engine.searchKeyword('withdrawalcontextsentinel', { sourceId })).toEqual([]);
    expect(await engine.searchKeyword('withdrawalhistorysentinel', { sourceId })).toEqual([]);
  }
});

test('subjectless withdrawal preserves unrelated revisions and vectors; missing-index legacy fences remain covered', async () => {
  for (const engine of engines) {
    const id = `bounded-${engine.kind}`;
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [id]);
    await engine.putPage('unrelated', { type: 'note', title: 'Unrelated', compiled_truth: 'Safe unrelated text' }, { sourceId: id });
    await engine.upsertChunks('unrelated', [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Safe unrelated text', token_count: 5,
      embedding: new Float32Array(1536).fill(0.125), model: 'synthetic' }], { sourceId: id });
    const before = await engine.readPageSnapshot('unrelated', { sourceId: id });
    const chunks = await engine.getChunks('unrelated', { sourceId: id });
    const standalone = await engine.insertFact({ fact: 'Synthetic standalone lifecycle', source: 'test', visibility: 'world' }, { source_id: id });
    expect(await recordFactWithdrawal(engine, standalone.id, id, true)).toEqual({ withdrawn: true, pages: [] });
    expect(await engine.readPageSnapshot('unrelated', { sourceId: id })).toEqual({ ...before!, withdrawals: expect.any(Array) });
    expect(await engine.getChunks('unrelated', { sourceId: id })).toEqual(chunks);
    const claim = 'Case normalized legacy claim';
    const body = renderFactsTable([fact('CASE   NORMALIZED legacy claim')]);
    const timeline = renderFactsTable([fact(claim)]);
    await engine.putPage('missing-index', { type: 'note', title: 'Legacy', compiled_truth: body, timeline }, { sourceId: id });
    await engine.putPage('other-visibility', { type: 'note', title: 'Private', compiled_truth: renderFactsTable([fact(claim, { visibility: 'private' })]) }, { sourceId: id });
    const privateBefore = await engine.readPageSnapshot('other-visibility', { sourceId: id });
    const legacy = await engine.insertFact({ fact: claim, source: 'test', visibility: 'world' }, { source_id: id });
    const result = await recordFactWithdrawal(engine, legacy.id, id, true);
    expect(result.pages.map(page => page.slug)).toEqual(['missing-index']);
    const after = (await engine.readPageSnapshot('missing-index', { sourceId: id }))!;
    expect(withdrawalFenceBlocks(after.page.compiled_truth)[0].parsed.facts[0].forgotten).toBe(true);
    expect(withdrawalFenceBlocks(after.page.timeline)[0].parsed.facts[0].forgotten).toBe(true);
    expect((await engine.readPageSnapshot('other-visibility', { sourceId: id }))!.revision).toBe(privateBefore!.revision);
    expect((await engine.readPageSnapshot('unrelated', { sourceId: id }))!.revision).toBe(before!.revision);
    expect(await engine.getChunks('unrelated', { sourceId: id })).toEqual(chunks);
    const reimport = await engine.insertFact({ fact: 'CASE normalized LEGACY claim', source: 'stale import', visibility: 'world' }, { source_id: id });
    expect((await engine.executeRaw('SELECT expired_at IS NOT NULL AS expired FROM facts WHERE id=$1', [reimport.id]))[0].expired).toBe(true);
  }
}, 120_000);


test('prepared imports recheck withdrawals even when called without the publication coordinator', async () => {
  for (const engine of engines) {
    const id = `apply-race-${engine.kind}`;
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [id]);
    for (const timeline of [false, true]) {
      const slug = timeline ? 'timeline' : 'body';
      const claim = `prepared apply ${slug} sentinel`;
      const content = `---\ntitle: Synthetic import\ntype: note\n---\nSafe text\n${timeline ? '<!-- timeline -->\n' : ''}${renderFactsTable([fact(claim)])}`;
      let prepared: PreparedContentImport | undefined;
      await importFromContent(engine, slug, content, { sourceId: id, noEmbed: true,
        prepare: async value => { prepared = value; return value.result; } });
      expect(prepared).toBeDefined();
      const stored = await engine.insertFact({ fact: claim, source: 'test', visibility: 'world' }, { source_id: id });
      expect((await recordFactWithdrawal(engine, stored.id, id, true)).pages).toEqual([]);
      await expect(engine.transaction(async tx => {
        await tx.lockPageKeys([{ sourceId: id, slug }]);
        await prepared!.validate(tx);
      })).rejects.toMatchObject({ code: 'revision_conflict' });
      await expect(engine.transaction(tx => prepared!.apply(tx))).rejects.toMatchObject({ code: 'revision_conflict' });
      expect(await engine.getPage(slug, { sourceId: id })).toBeNull();
      expect(await engine.searchKeyword(claim, { sourceId: id })).toEqual([]);
    }
  }
}, 120_000);

test('malformed and already-forgotten fences retain native diagnostics and never publish withdrawn searchable text', async () => {
  for (const engine of engines) {
    const id = `nonsearchable-fences-${engine.kind}`;
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [id]);
    for (const malformed of [false, true]) {
      const slug = malformed ? 'malformed' : 'forgotten';
      const claim = `${slug} withdrawal boundary sentinel`;
      const fence = malformed
        ? renderFactsTable([fact(claim)]).replace('| fact |', '| invalid-kind |')
        : renderFactsTable([fact(claim, { active: false, forgotten: true, validUntil: '2020-01-01', context: 'forgotten: synthetic prior request' })]);
      const content = `---\ntitle: Synthetic protected fence\ntype: note\n---\nSafe prose\n${fence}`;
      let prepared: PreparedContentImport | undefined;
      await importFromContent(engine, slug, content, { sourceId: id, noEmbed: true,
        prepare: async value => { prepared = value; return value.result; } });
      expect(prepared).toBeDefined();
      const stored = await engine.insertFact({ fact: claim, source: 'test', visibility: 'world' }, { source_id: id });
      expect((await recordFactWithdrawal(engine, stored.id, id, true)).pages).toEqual([]);
      await engine.transaction(async tx => {
        await tx.lockPageKeys([{ sourceId: id, slug }]);
        await prepared!.validate(tx);
        await prepared!.apply(tx);
      });
      const snapshot = (await engine.readPageSnapshot(slug, { sourceId: id }))!;
      expect(snapshot.page.compiled_truth).toContain(fence);
      expect(sanitizeRemoteBody(snapshot.page.compiled_truth)).not.toContain(claim);
      const chunks = await engine.getChunks(slug, { sourceId: id });
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.map(chunk => chunk.chunk_text).join('\n')).not.toContain(claim);
      expect(await engine.searchKeyword(claim, { sourceId: id })).toEqual([]);
    }
  }
}, 120_000);
