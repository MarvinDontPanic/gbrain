import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hermesAdapter } from '../src/core/transcripts/hermes.ts';
import { buildHermesFixture } from './fixtures/transcripts/hermes-fixture-builder.ts';
import type { ParsedSession, ParseSessionsOpts } from '../src/core/transcripts/types.ts';

const dirs: string[] = [];
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-hermes-native-'));
  dirs.push(dir);
  return buildHermesFixture(dir);
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function drain(path: string, opts: ParseSessionsOpts = {}) {
  const parser = hermesAdapter.parse(path, opts);
  const sessions: ParsedSession[] = [];
  for (;;) {
    const next = await parser.next();
    if (next.done) return { sessions, diag: next.value };
    sessions.push(next.value);
  }
}

describe('Hermes deliberate session-source selection', () => {
  test('selects native human sources without importing cron or generated sessions', async () => {
    const path = fixture();
    const writer = new Database(path);
    try {
      writer.query('UPDATE sessions SET source=? WHERE id=?').run('slack', 'hermes-fixture-1');
      writer.query('UPDATE sessions SET source=? WHERE id=?').run('cron', 'hermes-fixture-2');
      const { sessions, diag } = await drain(path, { sessionSources: ['slack', 'cli'] } as ParseSessionsOpts);
      expect(sessions.map(s => s.meta.sessionId)).toEqual(['hermes-fixture-1']);
      expect(sessions[0].meta.raw!.source).toBe('slack');
      expect(diag.sessions).toBe(1);
      // Existing default behavior remains an archive of all importable sources.
      expect((await drain(path)).sessions).toHaveLength(2);
    } finally {
      writer.close();
    }
  });

  test('binds literal source selectors and reports an intentional empty selection', async () => {
    const path = fixture();
    for (const sources of [[], ['slack'], ["cli') OR 1=1 --"]]) {
      const { sessions, diag } = await drain(path, { sessionSources: sources } as ParseSessionsOpts);
      expect(sessions).toEqual([]);
      expect(diag.expectedEmpty).toBe(true);
      expect(diag.zeroSessionsReason).toBe('no sessions match the selected native session sources');
    }
  });
});

describe('Hermes native SQLite read consistency', () => {
  test('indexed default reads are not limited by unused whole-store bytes', async () => {
    const path = fixture();
    truncateSync(path, 512 * 1024 * 1024 + 1);
    expect((await drain(path)).sessions).toHaveLength(2);
    await expect(drain(path, { maxBytes: 512 * 1024 * 1024 })).rejects.toThrow('store too large');
  });

  test('pins one WAL read snapshot while a live writer commits and checkpoints', async () => {
    const path = fixture();
    const writer = new Database(path);
    writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA busy_timeout=0');
    // Preserve an uncheckpointed commit before the reader starts.
    writer.query('UPDATE messages SET content=? WHERE session_id=? AND role=?')
      .run('Before snapshot', 'hermes-fixture-2', 'user');
    const parser = hermesAdapter.parse(path);
    try {
      const first = await parser.next();
      expect(first.done).toBe(false);
      if (first.done) throw new Error('Expected the first snapshot session');
      expect(first.value.meta.sessionId).toBe('hermes-fixture-1');
      writer.transaction(() => {
        writer.query('UPDATE messages SET content=? WHERE session_id=? AND role=?')
          .run('After snapshot', 'hermes-fixture-2', 'user');
        writer.query('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
          .run('hermes-fixture-2', 'assistant', 'Later committed turn', 1786003220);
      })();
      // SQLite must retain the WAL frames used by this native read transaction.
      const checkpoint = writer.query<{ busy: number }, []>('PRAGMA wal_checkpoint(TRUNCATE)').get();
      expect(checkpoint!.busy).toBe(1);
      const second = await parser.next();
      expect(second.done).toBe(false);
      if (second.done) throw new Error('Expected the second snapshot session');
      expect(second.value.messages.map(m => m.text)).toEqual([
        'Before snapshot', 'acme-seed closes at the end of the month.',
      ]);
      expect((await parser.next()).done).toBe(true);
      expect(writer.query<{ busy: number }, []>('PRAGMA wal_checkpoint(TRUNCATE)').get()!.busy).toBe(0);
      const nextRun = [];
      for await (const session of hermesAdapter.parse(path)) nextRun.push(session);
      expect(nextRun[1].messages.map(m => m.text)).toEqual([
        'After snapshot', 'acme-seed closes at the end of the month.', 'Later committed turn',
      ]);
      expect(writer.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get()!.integrity_check).toBe('ok');
    } finally {
      await parser.return({ bytesRead: 0, skippedLines: 0, truncated: false, sessions: 0 });
      writer.close();
    }
  });

  test('releases the native reader when its async consumer cancels early', async () => {
    const path = fixture();
    const writer = new Database(path);
    writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA busy_timeout=0');
    writer.query('UPDATE messages SET content=? WHERE id=1').run('Uncheckpointed turn');
    const parser = hermesAdapter.parse(path);
    try {
      await parser.next();
      writer.query('UPDATE messages SET content=? WHERE id=1').run('Later turn');
      expect(writer.query<{ busy: number }, []>('PRAGMA wal_checkpoint(TRUNCATE)').get()!.busy).toBe(1);
      await parser.return({ bytesRead: 0, skippedLines: 0, truncated: false, sessions: 0 });
      expect(writer.query<{ busy: number }, []>('PRAGMA wal_checkpoint(TRUNCATE)').get()!.busy).toBe(0);
    } finally {
      await parser.return({ bytesRead: 0, skippedLines: 0, truncated: false, sessions: 0 });
      writer.close();
    }
  });

  test('leaves source database contents unchanged and preserves explicit size budgets', async () => {
    const path = fixture();
    const original = readFileSync(path);
    expect((await drain(path)).sessions).toHaveLength(2);
    expect(readFileSync(path)).toEqual(original);
    await expect(drain(path, { maxBytes: 1 })).rejects.toThrow('hermes store too large for import');
  });

  test('reports a missing sessions schema as drift rather than selected-source emptiness', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-hermes-native-'));
    dirs.push(dir);
    const path = join(dir, 'state.db');
    const writer = new Database(path);
    writer.exec('CREATE TABLE unrelated (id INTEGER)');
    writer.close();
    const { sessions, diag } = await drain(path, { sessionSources: ['slack'] } as ParseSessionsOpts);
    expect(sessions).toEqual([]);
    expect(diag.expectedEmpty).not.toBe(true);
    expect(diag.zeroSessionsReason).toContain('schema mismatch reading sessions table');
  });
});
