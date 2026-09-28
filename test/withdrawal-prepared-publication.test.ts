import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import { recordFactWithdrawal } from '../src/core/facts/withdrawal.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { activatePersistence } from '../src/core/persistence/activation.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { claimWorktree, type WorktreeBinding } from '../src/core/persistence/ownership.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { admitWrite, claimNextWrite } from '../src/core/persistence/journal.ts';
import { preparePageMutation } from '../src/core/persistence/page-prepare.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const stores: Array<{ engine: BrainEngine; close: () => Promise<void> }> = [];
const fixtures: Array<{ engine: BrainEngine; sourceId: string; path: string; before: string;
  factId: number; claim: string; timeline: boolean; binding: WorktreeBinding }> = [];
let home: string;
let hostId: string;
beforeAll(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-withdrawal-publication-')));
  await withEnv({ GBRAIN_HOME: home }, async () => {
    hostId = localHostId();
    const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema();
    stores.push({ engine: lite, close: () => lite.disconnect() });
    if (process.env.DATABASE_URL) stores.push(await isolatedPersistencePostgres(process.env.DATABASE_URL));
    for (const { engine } of stores) {
      for (const timeline of [false, true]) {
        const sourceId = `withdrawal-race-${timeline ? 'timeline' : 'body'}`;
        const root = join(home, engine.kind, sourceId); mkdirSync(root, { recursive: true });
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await engine.putPage('example', { type: 'note', title: 'Synthetic example', compiled_truth: 'Preserve this original page.', timeline: '', frontmatter: {} }, { sourceId });
        const snapshot = (await engine.readPageSnapshot('example', { sourceId }))!;
        const before = serializePageToMarkdown(snapshot.page, snapshot.tags);
        const path = join(root, 'example.md'); writeFileSync(path, before);
        const claim = `synthetic withdrawal ${engine.kind} ${timeline ? 'timeline' : 'body'} sentinel`;
        const fact = await engine.insertFact({ fact: claim, source: 'synthetic test', visibility: 'world' }, { source_id: sourceId });
        const binding = await claimWorktree(engine, sourceId, root, hostId);
        fixtures.push({ engine, sourceId, path, before, factId: fact.id, claim, timeline, binding });
      }
      await registerLocalWriter(engine, 'cli');
      await activatePersistence(engine, { confirmQuiesced: true });
    }
  });
}, 120_000);
afterAll(async () => { for (const store of stores) await store.close(); if (home) rmSync(home, { recursive: true, force: true }); });

for (const kind of process.env.DATABASE_URL ? ['pglite', 'postgres'] : ['pglite'])
for (const timeline of [false, true]) test(`${kind}: withdrawal blocks prepared ${timeline ? 'timeline' : 'body'} publication before file replacement`, async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const f of fixtures.filter(f => f.timeline === timeline && f.engine.kind === kind)) {
    const { engine, sourceId, binding } = f;
    const fence = renderFactsTable([{ rowNum: 1, claim: f.claim, kind: 'fact', confidence: 1, visibility: 'world', notability: 'medium', active: true }]);
    const content = f.before + (timeline ? '\n<!-- timeline -->\n' : '\n') + fence;
    const snapshot = (await engine.readPageSnapshot('example', { sourceId }))!;
    const authority = await submissionAuthority({ engine, remote: false, sourceId } as OperationContext,
      'put_page', sourceId, binding.source_incarnation, 'example');
    const intent = { content, expected_revision: snapshot.revision };
    const accepted = await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page',
      sourceId, sourceIncarnation: binding.source_incarnation, slug: 'example', worktreeId: binding.worktree_id,
      topologyGeneration: binding.topology_generation, pageId: snapshot.page.id, requestId: randomUUID(), callerIntent: intent, intent });
    const row = (await claimNextWrite(engine, hostId))!; expect(row.id).toBe(accepted.id);
    const prepared = await preparePageMutation(engine, row, { engine: engine.kind, embedding_disabled: true });
    expect((await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => recordFactWithdrawal(tx, f.factId, sourceId, true)))).pages).toEqual([]);
    expect((await engine.readPageSnapshot('example', { sourceId }))!.revision).toBe(snapshot.revision);
    let published = false;
    const done = await publishMutation(engine, row, prepared, hostId, { fileBoundary: () => { published = true; } });
    expect(done.state).toBe('conflict');
    expect(done.error_code).toBe('revision_conflict');
    expect(published).toBe(false);
    expect(readFileSync(f.path, 'utf8')).toBe(f.before);
    expect((await engine.readPageSnapshot('example', { sourceId }))!.page.compiled_truth).toBe(snapshot.page.compiled_truth);
    expect(await engine.searchKeyword(f.claim, { sourceId })).toEqual([]);
    expect(await engine.executeRaw('SELECT chunk_text FROM content_chunks WHERE page_id=$1', [snapshot.page.id])).toEqual([]);
  }
}), 120_000);
