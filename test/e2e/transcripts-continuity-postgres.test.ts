import { expect, spyOn, test } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hasDatabase } from './helpers.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { __setEmbedTransportForTests, configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from '../helpers/legacy-embedding-config.ts';
import { renderPartContent } from '../../src/core/transcripts/render.ts';
import { runTranscriptsIngest } from '../../src/core/transcripts/ingest.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { withEnv } from '../helpers/with-env.ts';
import { localHostId, registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { acquireWorktree, claimWorktree } from '../../src/core/persistence/ownership.ts';
import { runTranscripts } from '../../src/commands/transcripts.ts';
import { quoteIdentifier, resolveActiveEmbeddingColumnFromEngine } from '../../src/core/search/embedding-column.ts';
import { claimNextWrite, compactWriteReceipts, getWriteRequestById, prepareRecovery } from '../../src/core/persistence/journal.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { runManagedSourceLifecycle } from '../../src/core/persistence/source-lifecycle.ts';
import { disposePersistenceConsumer, registerMutationPreparer } from '../../src/core/persistence/service.ts';
import { preparePageMutation } from '../../src/core/persistence/page-prepare.ts';
import { prepareManagedImportMutation } from '../../src/core/persistence/import-prepare.ts';
import { publishPersistenceFile } from '../../src/core/persistence/coordinator.ts';
import { withFilesystemPublication } from '../../src/core/persistence/filesystem-guard.ts';
import { sha256 } from '../../src/core/persistence/digest.ts';
import type { WriteRequest } from '../../src/core/persistence/model.ts';
import { OperationError } from '../../src/core/ops/contract.ts';
import { waitForValue } from '../helpers/wait-for.ts';

const pgTest = hasDatabase() ? test : test.skip;
const prepareNativePage: Parameters<typeof registerMutationPreparer>[1] = (engine, row, config, signal) =>
  row.intent?.kind === 'managed_file_import' ? prepareManagedImportMutation(engine, row, config)
    : preparePageMutation(engine, row, config, undefined, signal);
const record = (timestamp: string, text: string) => JSON.stringify({
  timestamp, type: 'event_msg', payload: { type: 'user_message', message: text },
}) + '\n';
function start(path: string, id: string, text: string, timestamp = '2026-01-01T12:00:00Z') {
  writeFileSync(path, JSON.stringify({ type: 'session_meta', payload: { id, timestamp } }) + '\n' + record(timestamp, text));
}

pgTest('managed native PostgreSQL import preserves long text, resumed and older history, agent access and idempotency', async () => {
  const root = mkdtempSync(join(tmpdir(), 'transcripts-continuity-pg-'));
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
  const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
  try {
    await withEnv({ GBRAIN_HOME: join(root, 'home') }, async () => {
      const canonical = join(root, 'canonical');
      mkdirSync(canonical);
      await pg.engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2', [canonical, 'default']);
      await registerLocalWriter(pg.engine, 'cli');
      await claimWorktree(pg.engine, 'default', canonical);
      const otherCanonical = join(root, 'other-canonical');
      mkdirSync(otherCanonical);
      await pg.engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', ['other', otherCanonical]);
      await claimWorktree(pg.engine, 'other', otherCanonical);
      await pg.engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      expect((await pg.engine.executeRaw<{enabled:boolean}>('SELECT enabled FROM persistence_brain WHERE singleton=1'))[0].enabled).toBe(true);
      const path = join(root, 'rollout.jsonl');
      start(path, 'continuity-original', 'original request ' + 'paragraph '.repeat(700) + 'complete-ending-marker');
      const run = (paths = [path]) => runTranscriptsIngest(pg.engine, { paths, sourceId: 'default', userPatternsPath: join(root, 'patterns') });
      const first = await run();
      expect(first.cleanScan).toBe(true);
      expect(first.sessionsSeen).toBe(1);
      expect(first.pages.imported).toBe(1);
      const slug = first.files[0].sessions[0].baseSlug;
      const page = await pg.engine.getPage(slug, { sourceId: 'default' });
      expect(page?.compiled_truth).toContain('complete-ending-marker');
      expect(page?.frontmatter.visibility).toBeUndefined();
      expect(page).toMatchObject({ source_kind: 'transcript:codex', source_uri: path, ingested_via: 'cli:transcripts-ingest' });
      expect(existsSync(join(canonical, `${slug}.md`))).toBe(true);
      expect(readFileSync(join(canonical, `${slug}.md`), 'utf8')).toContain('complete-ending-marker');
      expect((await pg.engine.getRawData(slug, 'transcript:codex', { sourceId: 'default' })).length).toBe(1);
      expect((await pg.engine.executeRaw<{state:string}>('SELECT state FROM persistence_requests WHERE slug=$1', [slug])).map(r => r.state)).toEqual(['committed']);
      expect((await pg.engine.getChunks(slug, { sourceId: 'default' })).length).toBeGreaterThan(0);
      expect((await pg.engine.executeRaw<{ count: number }>(
        "SELECT count(*)::int AS count FROM persistence_effects WHERE source_id='default' AND kind='embedding'"))[0].count).toBe(0);

      // Hard purge returns to an absent snapshot but not the original absence
      // generation; replaying the first create receipt would lose the page.
      const initialSnapshot = await pg.engine.readPageSnapshot(slug, { sourceId: 'default' });
      await submitPageMutation({ engine: pg.engine, remote: false, dryRun: false,
        sourceId: 'default', config: { engine: 'postgres' }, deferEmbeds: true, logger: console }, {
        operation: 'delete_page', waitMs: 30_000, params: {
          slug, source_id: 'default', purge: true, acknowledge: true, expected_revision: initialSnapshot!.revision,
        },
      });
      expect(await pg.engine.getPage(slug, { sourceId: 'default' })).toBeNull();
      expect((await run()).pages.imported).toBe(1);
      expect((await pg.engine.getPage(slug, { sourceId: 'default' }))?.compiled_truth).toContain('complete-ending-marker');

      // Existing MCP access remains available; importing does not impose a new visibility policy.
      const context = { config: { engine: 'postgres' as const }, sourceId: 'default', logger: { info() {}, warn() {}, error() {} } };
      const remote = await dispatchToolCall(pg.engine, 'get_page', { slug }, { ...context, remote: true });
      expect(remote.isError).not.toBe(true);
      expect(JSON.stringify(remote.content)).toContain('complete-ending-marker');
      const local = await dispatchToolCall(pg.engine, 'get_page', { slug }, { ...context, remote: false });
      expect(local.isError).not.toBe(true);
      expect(JSON.stringify(local.content)).toContain('complete-ending-marker');

      appendFileSync(path, record('2026-02-01T12:00:00Z', 'resumed-conversation-marker'));
      expect((await run()).pages.imported).toBe(1);
      const resumed = await pg.engine.getPage(slug, { sourceId: 'default' });
      expect(resumed?.compiled_truth).toContain('original request');
      expect(resumed?.compiled_truth).toContain('resumed-conversation-marker');
      expect((await run()).pages.skipped).toBe(1);
      const counters = () => pg.engine.executeRaw<{key:string;lifetime_ids:string}>(
        'SELECT key,lifetime_ids::text FROM persistence_counters ORDER BY key');
      const settledCounters = await counters();
      for (let repeat = 0; repeat < 3; repeat++) expect((await run()).pages.skipped).toBe(1);
      expect(await counters()).toEqual(settledCounters);

      // Compaction drops intent, not replay identity or canonical integrity.
      expect(await compactWriteReceipts(pg.engine, 0)).toBeGreaterThan(0);
      expect((await pg.engine.executeRaw<{compacted:boolean}>(
        "SELECT compacted FROM persistence_requests WHERE slug=$1 AND outcome->>'status'='skipped'", [slug]))[0].compacted).toBe(true);
      expect((await run()).pages.skipped).toBe(1);
      expect(await counters()).toEqual(settledCounters);
      const canonicalPath = join(canonical, `${slug}.md`);
      const originalBytes = readFileSync(canonicalPath);
      writeFileSync(canonicalPath, originalBytes.toString('utf8').replace('resumed-conversation-marker', 'uncoordinated-edit-marker'));
      await expect(run()).rejects.toThrow('uncoordinated local edit');
      expect(await counters()).toEqual(settledCounters);
      writeFileSync(canonicalPath, originalBytes);
      expect((await run()).pages.skipped).toBe(1);
      rmSync(canonicalPath);
      await expect(run()).rejects.toThrow('removed outside coordinated publication');
      expect(await counters()).toEqual(settledCounters);
      writeFileSync(canonicalPath, originalBytes);
      expect((await run()).pages.skipped).toBe(1);

      // Exercise the actual command's closure after managed publication and on
      // hash skips; only the provider transport is synthetic, not persistence.
      const column = quoteIdentifier((await resolveActiveEmbeddingColumnFromEngine(pg.engine)).name);
      const missingSql = `SELECT count(*)::int AS count FROM content_chunks cc JOIN pages p ON p.id=cc.page_id
        WHERE p.source_id=$1 AND p.slug=$2 AND p.deleted_at IS NULL AND cc.${column} IS NULL`;
      expect((await pg.engine.executeRaw<{count:number}>(missingSql, ['default', slug]))[0].count).toBeGreaterThan(0);
      let providerCalls = 0;
      configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: { OPENAI_API_KEY: 'synthetic-managed-transcript-fixture' } });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
        providerCalls++;
        return { embeddings: values.map(() => [1, ...Array(1535).fill(0)]) };
      }) as never);
      const output: string[] = [];
      const logging = spyOn(console, 'log').mockImplementation(value => { output.push(String(value)); });
      try { await runTranscripts(pg.engine, ['ingest', path, '--source', 'default', '--embed', '--json', '--quiet']); }
      finally { logging.mockRestore(); }
      const report = JSON.parse(output.find(value => value.startsWith('{'))!);
      expect(report.cleanScan).toBe(true);
      expect(report.pages.skipped).toBe(1);
      expect(report.embeddings).toMatchObject({ status: 'complete', remainingChunks: 0 });
      expect(providerCalls).toBeGreaterThan(0);
      expect((await pg.engine.executeRaw<{count:number}>(missingSql, ['default', slug]))[0].count).toBe(0);

      const older = join(root, 'older.jsonl');
      start(older, 'continuity-older', 'late-arriving-older-marker', '2025-01-01T12:00:00Z');
      const discovered = await run([path, older]);
      expect(discovered.cleanScan).toBe(true);
      expect(discovered.sessionsSeen).toBe(2);
      expect(discovered.pages.imported).toBe(1);
      expect(discovered.pages.skipped).toBe(1);
      const olderSlug = discovered.files[1].sessions[0].baseSlug;
      // A changed older record must update even when its timestamp does not advance.
      start(older, 'continuity-older', 'corrected-older-marker', '2025-01-01T12:00:00Z');
      expect((await run([path, older])).pages.imported).toBe(1);
      expect((await pg.engine.getPage(olderSlug, { sourceId: 'default' }))?.compiled_truth).toContain('corrected-older-marker');
      start(older, 'continuity-older', 'corrected-start-date-marker', '2024-01-01T12:00:00Z');
      const correctedDate = await run([older]);
      expect(correctedDate.pages.imported).toBe(1);
      expect(correctedDate.files[0].sessions[0].baseSlug).toBe(olderSlug);
      expect((await pg.engine.getPage(olderSlug, { sourceId: 'default' }))?.compiled_truth).toContain('corrected-start-date-marker');
      const final = await run([path, older]);
      expect(final.cleanScan).toBe(true);
      expect(final.pages.imported).toBe(0);
      expect(final.pages.skipped).toBe(2);

      // Growth and shrink exercise actual coordinator deletes, not just puts.
      appendFileSync(path, record('2026-03-01T12:00:00Z', 'oversized-fragment '.repeat(20_000) + 'oversized-tail-marker'));
      const grown = await run();
      expect(grown.cleanScan).toBe(true);
      expect(grown.files[0].sessions[0].parts).toBeGreaterThan(1);
      const extraParts = grown.slugsTouched.filter(s => s !== slug);
      expect((await pg.engine.getPage(extraParts.at(-1)!, { sourceId: 'default' }))?.compiled_truth).toContain('oversized-tail-marker');
      expect(await pg.engine.getPage(extraParts.at(-1)!, { sourceId: 'default' }))
        .toMatchObject({ source_kind: 'transcript:codex', source_uri: path, ingested_via: 'cli:transcripts-ingest' });
      const other = await runTranscriptsIngest(pg.engine, { paths: [path], sourceId: 'other', userPatternsPath: join(root, 'patterns') });
      expect(other.cleanScan).toBe(true);
      start(path, 'continuity-original', 'revised-short-transcript');
      const shrunk = await run();
      expect(shrunk.cleanScan).toBe(true);
      expect(shrunk.partsDeleted).toBe(extraParts.length);
      for (const part of extraParts) {
        expect(await pg.engine.getPage(part, { sourceId: 'default' })).toBeNull();
        expect(existsSync(join(canonical, `${part}.md`))).toBe(false);
        expect(await pg.engine.getPage(part, { sourceId: 'other' })).not.toBeNull();
      }
      expect((await pg.engine.executeRaw<{state:string}>("SELECT state FROM persistence_requests WHERE operation='delete_page' AND source_id='default' AND slug=ANY($1::text[])", [extraParts])).map(r => r.state)).toEqual(extraParts.map(() => 'committed'));
      expect((await run()).pages.skipped).toBe(1);
      const shrunkCounters = await counters();
      expect((await run()).partsDeleted).toBe(0);
      expect(await counters()).toEqual(shrunkCounters);

      // A native tombstone is a new revision, never an old put receipt replay.
      const beforeDelete = await pg.engine.readPageSnapshot(slug, { sourceId: 'default' });
      await submitPageMutation({ engine: pg.engine, remote: false, dryRun: false,
        sourceId: 'default', config: { engine: 'postgres' }, deferEmbeds: true, logger: console }, {
        operation: 'delete_page', waitMs: 30_000, params: {
          slug, source_id: 'default', expected_revision: beforeDelete!.revision,
        },
      });
      expect(await pg.engine.getPage(slug, { sourceId: 'default' })).toBeNull();
      expect((await run()).pages.imported).toBe(1);
      expect((await pg.engine.getPage(slug, { sourceId: 'default' }))?.compiled_truth).toContain('revised-short-transcript');
      expect(existsSync(canonicalPath)).toBe(true);
      expect((await run()).pages.skipped).toBe(1);
      const restoredCounters = await counters();
      expect((await run()).pages.skipped).toBe(1);
      expect(await counters()).toEqual(restoredCounters);

      // Reusing the named source after native removal must not replay receipts
      // retained for its previous incarnation.
      const previousIncarnation = (await pg.engine.executeRaw<{incarnation:string}>(
        'SELECT incarnation FROM sources WHERE id=$1', ['other']))[0].incarnation;
      await runManagedSourceLifecycle(pg.engine, { operation: 'remove', sourceId: 'other', confirmDestructive: true });
      const replacementCanonical = join(root, 'replacement-canonical');
      mkdirSync(replacementCanonical);
      await runManagedSourceLifecycle(pg.engine, { operation: 'add', sourceId: 'other', path: replacementCanonical });
      const replacementIncarnation = (await pg.engine.executeRaw<{incarnation:string}>(
        'SELECT incarnation FROM sources WHERE id=$1', ['other']))[0].incarnation;
      expect(replacementIncarnation).not.toBe(previousIncarnation);
      const replaced = await runTranscriptsIngest(pg.engine, { paths: [path], sourceId: 'other', userPatternsPath: join(root, 'patterns') });
      expect(replaced.pages.imported).toBe(1);
      expect(readFileSync(join(replacementCanonical, `${slug}.md`), 'utf8')).toContain('revised-short-transcript');
      expect((await pg.engine.executeRaw<{source_incarnation:string}>(
        "SELECT DISTINCT source_incarnation FROM persistence_requests WHERE source_id='other' AND operation='put_page'",
      )).map(row => row.source_incarnation).sort()).toEqual([previousIncarnation, replacementIncarnation].sort());
    });
  } finally {
    await pg.close();
    __setEmbedTransportForTests(null);
    resetGateway();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

pgTest('managed transcript terminal failures require one explicit retry and preserve the accepted retry on ordinary rescans', async () => {
  const root = mkdtempSync(join(tmpdir(), 'transcripts-retry-pg-'));
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
  const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
  try {
    await withEnv({ GBRAIN_HOME: join(root, 'home') }, async () => {
      const canonical = join(root, 'canonical');
      mkdirSync(canonical);
      await pg.engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2', [canonical, 'default']);
      await registerLocalWriter(pg.engine, 'cli');
      await claimWorktree(pg.engine, 'default', canonical);
      await pg.engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const path = join(root, 'rollout.jsonl');
      start(path, 'continuity-retry', 'unchanged-retry-marker');
      const run = (retryFailed = false) => runTranscriptsIngest(pg.engine, {
        paths: [path], sourceId: 'default', retryFailed, userPatternsPath: join(root, 'patterns'),
      });
      const initial = await run();
      const slug = initial.slugsTouched[0];
      const revision = (await pg.engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision;
      const lifetimeIds = async () => Number((await pg.engine.executeRaw<{ids:string}>(
        "SELECT lifetime_ids::text AS ids FROM persistence_counters WHERE key='brain'"))[0].ids);
      registerMutationPreparer('put_page', async () => { throw new OperationError('storage_error', 'fixture preparer prerequisite unavailable'); });
      await expect(run()).rejects.toThrow('fixture preparer prerequisite unavailable');
      const failedIds = await lifetimeIds();
      await expect(run()).rejects.toThrow('fixture preparer prerequisite unavailable');
      expect(await lifetimeIds()).toBe(failedIds);
      // One explicit invocation permits one attempt, even if the fault remains.
      await expect(run(true)).rejects.toThrow('fixture preparer prerequisite unavailable');
      expect(await lifetimeIds()).toBe(failedIds + 1);
      registerMutationPreparer('put_page', prepareNativePage);
      await expect(run()).rejects.toThrow('fixture preparer prerequisite unavailable');
      expect(await lifetimeIds()).toBe(failedIds + 1);
      expect((await run(true)).pages.skipped).toBe(1);
      expect((await pg.engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision).toBe(revision);
      const retriedIds = await lifetimeIds();
      expect(await compactWriteReceipts(pg.engine, 0)).toBeGreaterThan(0);
      for (let repeat = 0; repeat < 3; repeat++) expect((await run()).pages.skipped).toBe(1);
      expect(await lifetimeIds()).toBe(retriedIds);
      expect((await pg.engine.executeRaw<{state:string}>(
        'SELECT state FROM persistence_requests WHERE slug=$1 ORDER BY sequence', [slug])).map(row => row.state))
        .toEqual(['committed', 'failed', 'failed', 'committed']);
    });
  } finally {
    registerMutationPreparer('put_page', prepareNativePage);
    await pg.close();
    resetGateway();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);


pgTest('managed re-ingest preserves operator fields from its guarded snapshot and refuses a later operator race', async () => {
  const root = mkdtempSync(join(tmpdir(), 'transcripts-snapshot-pg-'));
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
  const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
  try {
    await withEnv({ GBRAIN_HOME: join(root, 'home') }, async () => {
      const canonical = join(root, 'canonical');
      mkdirSync(canonical);
      await pg.engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2', [canonical, 'default']);
      await registerLocalWriter(pg.engine, 'cli');
      await claimWorktree(pg.engine, 'default', canonical);
      await pg.engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const path = join(root, 'rollout.jsonl');
      start(path, 'continuity-operator-snapshot', 'original-snapshot-marker');
      const run = () => runTranscriptsIngest(pg.engine, { paths: [path], sourceId: 'default', userPatternsPath: join(root, 'patterns') });
      const slug = (await run()).slugsTouched[0];
      const edit = async (snapshot: NonNullable<Awaited<ReturnType<typeof pg.engine.readPageSnapshot>>>, review: string) => {
        await submitPageMutation({ engine: pg.engine, remote: false, dryRun: false,
          sourceId: 'default', config: { engine: 'postgres' }, deferEmbeds: true, logger: console }, {
          operation: 'put_page', waitMs: 30_000, params: {
            slug, source_id: 'default', expected_revision: snapshot.revision,
            content: renderPartContent({ ...snapshot.page.frontmatter, review_flag: review, atoms_scan_hash: 'stale-phase-owned-marker' }, snapshot.page.compiled_truth),
          },
        });
      };
      await edit((await pg.engine.readPageSnapshot(slug, { sourceId: 'default' }))!, 'operator-first');
      appendFileSync(path, record('2026-02-01T12:00:00Z', 'updated-source-marker'));
      expect((await run()).pages.imported).toBe(1);
      const preserved = await pg.engine.getPage(slug, { sourceId: 'default' });
      expect(preserved!.frontmatter.review_flag).toBe('operator-first');
      expect(preserved!.frontmatter.atoms_scan_hash).toBeUndefined();
      expect(preserved!.compiled_truth).toContain('updated-source-marker');
      expect((preserved!.compiled_truth.match(/Message timestamps below are UTC/g) ?? []).length).toBe(1);

      const getConfig = pg.engine.getConfig.bind(pg.engine);
      let checks = 0;
      const configSpy = spyOn(pg.engine, 'getConfig').mockImplementation(async key => {
        const value = await getConfig(key);
        // The publisher has already sealed its snapshot and preflighted the
        // file; the native admission now reads write-through policy. A real
        // operator write here must invalidate that sealed caller revision.
        if (key === 'sync.write_through' && ++checks === 2) {
          await edit((await pg.engine.readPageSnapshot(slug, { sourceId: 'default' }))!, 'operator-concurrent');
        }
        return value;
      });
      appendFileSync(path, record('2026-03-01T12:00:00Z', 'race-source-marker'));
      try {
        const refusal = await run().then(() => null, error => error);
        expect(refusal).toMatchObject({
          message: expect.stringContaining('The canonical file changed after import admission.'),
          cause: { code: 'source_changed' },
        });
      }
      finally { configSpy.mockRestore(); }
      const raced = await pg.engine.getPage(slug, { sourceId: 'default' });
      expect(raced!.frontmatter.review_flag).toBe('operator-concurrent');
      expect(raced!.compiled_truth).not.toContain('race-source-marker');
      expect((await run()).pages.imported).toBe(1);
      const repaired = await pg.engine.getPage(slug, { sourceId: 'default' });
      expect(repaired!.frontmatter.review_flag).toBe('operator-concurrent');
      expect(repaired!.compiled_truth).toContain('race-source-marker');
      expect((await run()).pages.skipped).toBe(1);
    });
  } finally {
    await pg.close();
    resetGateway();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

for (const { retryChild, compactedParent } of [
  { retryChild: false, compactedParent: false },
  { retryChild: true, compactedParent: false },
  { retryChild: true, compactedParent: true },
]) pgTest(`managed transcript recovery reuses accepted import identity after native file publication before database commit (retry child=${retryChild}, compacted parent=${compactedParent})`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'transcripts-recovery-pg-'));
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
  const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
  const releasePreparation = Promise.withResolvers<void>();
  let interrupted: Promise<unknown> | undefined;
  try {
    await withEnv({ GBRAIN_HOME: join(root, 'home') }, async () => {
      const canonical = join(root, 'canonical'); mkdirSync(canonical);
      await pg.engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2', [canonical, 'default']);
      await registerLocalWriter(pg.engine, 'cli');
      const binding = await claimWorktree(pg.engine, 'default', canonical);
      await pg.engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      registerMutationPreparer('put_page', prepareNativePage);
      const path = join(root, 'rollout.jsonl');
      start(path, 'continuity-recovery', 'before-recovery-marker');
      const run = (retryFailed = false) => runTranscriptsIngest(pg.engine, { paths: [path], sourceId: 'default', retryFailed, userPatternsPath: join(root, 'patterns') });
      const slug = (await run()).slugsTouched[0];
      const before = (await pg.engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
      const canonicalPath = join(canonical, `${slug}.md`);
      const beforeBytes = readFileSync(canonicalPath);
      appendFileSync(path, record('2026-02-01T12:00:00Z', 'after-recovery-marker'));
      let failedRequest: string | undefined, failedId: string | undefined;
      if (retryChild) {
        registerMutationPreparer('put_page', async () => { throw new OperationError('storage_error', 'Fixture explicit retry prerequisite'); });
        await expect(run()).rejects.toThrow('Fixture explicit retry prerequisite');
        const [failed] = await pg.engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE state=$1 ORDER BY sequence DESC LIMIT 1', ['failed']);
        failedRequest = failed.request_id;
        failedId = failed.id;
        expect(readFileSync(canonicalPath)).toEqual(beforeBytes);
        if (compactedParent) {
          expect(await compactWriteReceipts(pg.engine, 0)).toBeGreaterThan(0);
          expect(await getWriteRequestById(pg.engine, failedId)).toMatchObject({ state: 'failed', compacted: true, intent: null });
        }
      }

      // Admit through the real importer, then stop its owner before prepare.
      // This retains the actual accepted request and private import input.
      let admitted: WriteRequest | undefined;
      registerMutationPreparer('put_page', async (_engine, row) => {
        admitted = row;
        await releasePreparation.promise;
        throw new DOMException('Fixture owner stopped before publication', 'AbortError');
      });
      interrupted = run(retryChild).then(() => { throw new Error('Interrupted import unexpectedly committed'); }, error => error);
      const accepted = await waitForValue(() => admitted, { label: 'native transcript admission' });
      expect(accepted.intent?.kind).toBe('managed_file_import');
      expect(accepted.intent?.retry_of).toBe(failedRequest);
      const stopped = disposePersistenceConsumer(pg.engine);
      releasePreparation.resolve(); await stopped;
      expect(await interrupted).toMatchObject({ message: expect.stringContaining('still pending') });
      registerMutationPreparer('put_page', prepareNativePage);
      expect((await getWriteRequestById(pg.engine, accepted.id))?.state).toBe('queued');

      // Same native journal/publication boundary used by recovery fixtures:
      // durable reservation first, actual atomic rename, no database apply.
      const claimed = (await claimNextWrite(pg.engine, localHostId()))!;
      expect(claimed.id).toBe(accepted.id);
      const prepared = await prepareManagedImportMutation(pg.engine, claimed, { engine: 'postgres' });
      expect(prepared.file?.path).toBe(canonicalPath);
      const file = prepared.file!;
      const afterHash = sha256(file.content!);
      const lock = await acquireWorktree(binding); expect(lock).not.toBeNull();
      try {
        const recovery = { version: 1 as const, path: canonicalPath, root: canonical,
          before: beforeBytes.toString('base64'), beforeHash: sha256(beforeBytes), afterHash,
          mode: statSync(canonicalPath).mode & 0o7777, ownerEpoch: String(binding.owner_epoch), attempt: claimed.execution_token! };
        await prepareRecovery(pg.engine, claimed, recovery, Buffer.byteLength(JSON.stringify(recovery)) + beforeBytes.length + Buffer.byteLength(file.content!) + 4096);
        await withFilesystemPublication([canonical], async () => publishPersistenceFile(file));
      } finally { await lock!.release(); }
      expect(readFileSync(canonicalPath, 'utf8')).toContain('after-recovery-marker');
      expect((await pg.engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision).toBe(before.revision);
      expect((await pg.engine.getPage(slug, { sourceId: 'default' }))!.compiled_truth).not.toContain('after-recovery-marker');
      expect((await getWriteRequestById(pg.engine, accepted.id))!.recovery).toMatchObject({ afterHash });
      if (compactedParent) {
        expect(await getWriteRequestById(pg.engine, failedId!)).toMatchObject({ state: 'failed', compacted: true, intent: null });
        expect((await getWriteRequestById(pg.engine, accepted.id))!.intent?.kind).toBe('managed_file_import');
      }
      const requests = () => pg.engine.executeRaw('SELECT id,request_id,digest FROM persistence_requests ORDER BY sequence');
      const counters = () => pg.engine.executeRaw('SELECT key,lifetime_ids::text FROM persistence_counters ORDER BY key');
      const acceptedRequests = await requests(), acceptedCounters = await counters();

      const resumed = await run();
      expect(resumed.cleanScan).toBe(true);
      expect(resumed.pages.imported).toBe(1);
      expect(await requests()).toEqual(acceptedRequests);
      expect(await counters()).toEqual(acceptedCounters);
      expect(await getWriteRequestById(pg.engine, accepted.id)).toMatchObject({ state: 'committed', recovery: null });
      const after = (await pg.engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
      expect(after.revision).not.toBe(before.revision);
      expect(after.page.compiled_truth).toContain('after-recovery-marker');
      expect(sha256(readFileSync(canonicalPath))).toBe(afterHash);
      expect(await pg.engine.executeRaw('SELECT id FROM persistence_requests WHERE recovery IS NOT NULL')).toHaveLength(0);
    });
  } finally {
    releasePreparation.resolve();
    registerMutationPreparer('put_page', prepareNativePage);
    await disposePersistenceConsumer(pg.engine);
    await interrupted;
    await pg.close();
    resetGateway(); rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

pgTest('automatic transcript refresh preserves owner quarantine until explicit native clear', async () => {
  const root = mkdtempSync(join(tmpdir(), 'transcripts-owner-quarantine-pg-'));
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
  const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
  try {
    await withEnv({ GBRAIN_HOME: join(root, 'home') }, async () => {
      const canonical = join(root, 'canonical'); mkdirSync(canonical);
      await pg.engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2', [canonical, 'default']);
      await registerLocalWriter(pg.engine, 'cli');
      await claimWorktree(pg.engine, 'default', canonical);
      await pg.engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const path = join(root, 'rollout.jsonl');
      start(path, 'operator-withheld-source', 'Original source remains preserved.');
      const run = () => runTranscriptsIngest(pg.engine, { paths: [path], sourceId: 'default', userPatternsPath: join(root, 'patterns') });
      const slug = (await run()).slugsTouched[0];
      const marker = { reason: 'literal_substring', detail: 'Owner reviewed this source and withheld it from ordinary retrieval.', assessed_at: '2026-01-01T12:00:00Z' };
      const ownerWrite = async (frontmatter: Record<string, unknown>, body: string, revision: string) => submitPageMutation({
        engine: pg.engine, remote: false, dryRun: false, sourceId: 'default', config: { engine: 'postgres' }, deferEmbeds: true, logger: console,
      }, { operation: 'put_page', waitMs: 30_000, params: {
        slug, source_id: 'default', expected_revision: revision, content: renderPartContent(frontmatter, body),
      } });
      const original = (await pg.engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
      await ownerWrite({ ...original.page.frontmatter, quarantine: marker, atoms_scan_hash: 'stale-completion' }, original.page.compiled_truth, original.revision);
      expect((await pg.engine.getPage(slug, { sourceId: 'default' }))!.frontmatter.quarantine).toEqual(marker);
      expect(await pg.engine.getChunks(slug, { sourceId: 'default' })).toHaveLength(0);

      const unchanged = await run();
      expect(unchanged.cleanScan).toBe(true);
      const afterUnchanged = (await pg.engine.getPage(slug, { sourceId: 'default' }))!;
      expect(afterUnchanged.frontmatter.quarantine).toEqual(marker);
      expect(afterUnchanged.frontmatter.atoms_scan_hash).toBeUndefined();
      expect(await pg.engine.getChunks(slug, { sourceId: 'default' })).toHaveLength(0);
      expect(readFileSync(join(canonical, `${slug}.md`), 'utf8')).toContain(marker.detail);

      appendFileSync(path, record('2026-02-01T12:00:00Z', 'A resumed source update is retained while withheld.'));
      const resumed = await run();
      expect(resumed.cleanScan).toBe(true);
      expect(resumed.pages.imported).toBe(1);
      const afterResumed = (await pg.engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
      expect(afterResumed.page.frontmatter.quarantine).toEqual(marker);
      expect(afterResumed.page.frontmatter.visibility).toBeUndefined();
      expect(afterResumed.page.compiled_truth).toContain('A resumed source update is retained while withheld.');
      expect(await pg.engine.getChunks(slug, { sourceId: 'default' })).toHaveLength(0);
      expect(readFileSync(join(canonical, `${slug}.md`), 'utf8')).toContain(marker.detail);

      // Explicit trusted-owner mutation is the native clear boundary. The
      // automatic collector never clears an existing owner's hold implicitly.
      const cleared = { ...afterResumed.page.frontmatter }; delete cleared.quarantine;
      await ownerWrite(cleared, afterResumed.page.compiled_truth, afterResumed.revision);
      expect((await pg.engine.getPage(slug, { sourceId: 'default' }))!.frontmatter.quarantine).toBeUndefined();
      expect((await pg.engine.getChunks(slug, { sourceId: 'default' })).length).toBeGreaterThan(0);
      // The explicit owner serialization may add a body-ending newline;
      // the first collector pass restores its source rendering, then skips.
      expect((await run()).cleanScan).toBe(true);
      expect((await run()).pages.skipped).toBe(1);
      expect((await pg.engine.getPage(slug, { sourceId: 'default' }))!.frontmatter.quarantine).toBeUndefined();
      expect((await pg.engine.getChunks(slug, { sourceId: 'default' })).length).toBeGreaterThan(0);
    });
  } finally { await pg.close(); resetGateway(); rmSync(root, { recursive: true, force: true }); }
}, 60_000);
