import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hasDatabase } from './helpers.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from '../helpers/legacy-embedding-config.ts';
import { runTranscriptsIngest } from '../../src/core/transcripts/ingest.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { withEnv } from '../helpers/with-env.ts';

const pgTest = hasDatabase() ? test : test.skip;
const record = (timestamp: string, text: string) => JSON.stringify({
  timestamp, type: 'event_msg', payload: { type: 'user_message', message: text },
}) + '\n';
function start(path: string, id: string, text: string, timestamp = '2026-01-01T12:00:00Z') {
  writeFileSync(path, JSON.stringify({ type: 'session_meta', payload: { id, timestamp } }) + '\n' + record(timestamp, text));
}

pgTest('native PostgreSQL import preserves long text, resumed and older history, privacy and idempotency', async () => {
  const root = mkdtempSync(join(tmpdir(), 'transcripts-continuity-pg-'));
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
  const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
  try {
    await withEnv({ GBRAIN_HOME: join(root, 'home') }, async () => {
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
      expect(page?.frontmatter.visibility).toBe('private');
      expect((await pg.engine.getChunks(slug, { sourceId: 'default' })).length).toBeGreaterThan(0);

      // Actual MCP dispatch uses the untrusted read boundary; owner CLI remains readable.
      const context = { config: { engine: 'postgres' as const }, sourceId: 'default', logger: { info() {}, warn() {}, error() {} } };
      const remote = await dispatchToolCall(pg.engine, 'get_page', { slug }, { ...context, remote: true });
      expect(remote.isError).toBe(true);
      const local = await dispatchToolCall(pg.engine, 'get_page', { slug }, { ...context, remote: false });
      expect(local.isError).not.toBe(true);
      expect(JSON.stringify(local.content)).toContain('complete-ending-marker');

      appendFileSync(path, record('2026-02-01T12:00:00Z', 'resumed-conversation-marker'));
      expect((await run()).pages.imported).toBe(1);
      const resumed = await pg.engine.getPage(slug, { sourceId: 'default' });
      expect(resumed?.compiled_truth).toContain('original request');
      expect(resumed?.compiled_truth).toContain('resumed-conversation-marker');
      expect((await run()).pages.skipped).toBe(1);

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
    });
  } finally {
    await pg.close();
    resetGateway();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
