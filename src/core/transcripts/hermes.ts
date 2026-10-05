/**
 * hermes.ts — Hermes state.db (SQLite) adapter (cathedral-4).
 *
 * ONE store file holds MANY sessions (hermes-agent DEFAULT_DB_PATH =
 * <hermes home>/state.db). A native read-only connection holds one SQLite
 * read transaction across session and message queries. WAL writers may
 * continue committing while SQLite retains the reader's consistent snapshot.
 * Completion, cancellation and errors close the connection and its transaction;
 * no database/sidecar filesystem copies or external snapshot store are used.
 *
 * Schema verified against the INSTALLED hermes-agent v0.20.0 source
 * (hermes_state_common.py SCHEMA_SQL) — sessions(id, source, display_name,
 * title, started_at REAL epoch-seconds, cwd, model) and messages(session_id,
 * role, content, timestamp REAL). No populated sample DB existed on the dev
 * machine, so the SPEC_TARGET stays PROVISIONAL and the fixture is built
 * from the same schema by test code; the bytes>0/sessions==0 drift signal is
 * the runtime backstop.
 */

import { existsSync, statSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import type { HostSpecTarget } from '../bootstrap/host-specs.ts';
import type {
  FileDiagnostics,
  ParsedSession,
  ParseSessionsOpts,
  TranscriptAdapter,
  TranscriptMessage,
} from './types.ts';

export const HERMES_SPEC_TARGET: HostSpecTarget = {
  id: 'hermes-state-db-2026-08',
  status: 'provisional',
  verifiedAt: '2026-08-14',
  references: [
    'installed hermes-agent v0.20.0 hermes_state_common.py SCHEMA_SQL (schema source of truth)',
    'hermes-agent hermes_state.py DEFAULT_DB_PATH = <hermes home>/state.db',
    'test/fixtures/transcripts/hermes-fixture-builder.ts (synthetic, schema-matched)',
  ],
  note:
    'SQLite store, WAL mode. sessions: id TEXT PK, source, display_name, ' +
    'title, started_at REAL (epoch seconds), ended_at, cwd, model. messages: ' +
    'session_id, role, content TEXT, timestamp REAL. The import keeps role ' +
    "user/assistant rows with non-empty content; content that looks like a " +
    'JSON block array is unwrapped to its text blocks. active/compacted ' +
    'flags are IGNORED (the archive wants full history, not the live ' +
    'context window). PROVISIONAL: no populated production sample verified.',
};

/** Legacy whole-store diagnostic budget; indexed native imports have no default cap. */
export const HERMES_DB_HARD_CAP = 512 * 1024 * 1024;

const SQLITE_MAGIC = 'SQLite format 3\u0000';

function epochToIso(v: unknown): string {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return '';
  return new Date(Math.round(v * 1000)).toISOString();
}

/** Unwrap content that is a JSON block array; pass plain text through. */
function contentToText(content: unknown): string {
  if (typeof content !== 'string') return '';
  const t = content.trim();
  if (!t) return '';
  if (t.startsWith('[')) {
    try {
      const blocks = JSON.parse(t) as unknown;
      if (Array.isArray(blocks)) {
        const parts: string[] = [];
        for (const block of blocks) {
          if (typeof block === 'string' && block.trim()) parts.push(block);
          else if (typeof block === 'object' && block !== null) {
            const b = block as Record<string, unknown>;
            if (typeof b.text === 'string' && b.text.trim()) parts.push(b.text);
          }
        }
        return parts.join('\n').trim();
      }
    } catch {
      // Not JSON after all — fall through to plain text.
    }
  }
  return t;
}

interface SessionRow {
  id: string;
  title: string | null;
  display_name: string | null;
  started_at: number | null;
  cwd: string | null;
  model: string | null;
  source: string | null;
}

interface MessageRow {
  role: string;
  content: string | null;
  timestamp: number | null;
}

export const hermesAdapter: TranscriptAdapter = {
  format: 'hermes',
  specTarget: HERMES_SPEC_TARGET,

  detect(path: string, sample: Buffer): boolean {
    if (!path.endsWith('.db')) return false;
    return sample.toString('latin1', 0, 16) === SQLITE_MAGIC;
  },

  async *parse(path: string, opts: ParseSessionsOpts = {}): AsyncGenerator<ParsedSession, FileDiagnostics> {
    const cap = opts.maxBytes;
    const size = statSync(path).size;
    // An explicitly requested store budget includes uncheckpointed WAL data.
    // Default native SQLite reads do not load/copy the whole store, so its FTS
    // indexes and unrelated conversations must not block an indexed selection.
    let totalBytes = size;
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(path + suffix)) totalBytes += statSync(path + suffix).size;
    }
    if (cap !== undefined && totalBytes > cap) {
      throw new Error(
        `hermes store too large for import: ${totalBytes} bytes incl. sidecars (cap ${cap})`,
      );
    }

    let sessions = 0;
    let selectedRows = 0;
    const db = new Database(path, { readonly: true });
    try {
      // BEGIN is deferred: the sessions SELECT below establishes the snapshot,
      // retained across async yields until this reader closes. Never copy WAL files.
      db.exec('BEGIN');
      let sessionRows: SessionRow[];
      try {
        sessionRows = db
          .query<SessionRow, string[]>(
            'SELECT id, title, display_name, started_at, cwd, model, source ' +
              'FROM sessions' +
              (opts.sessionSources === undefined ? '' : opts.sessionSources.length
                ? ` WHERE source IN (${opts.sessionSources.map(() => '?').join(',')})`
                : ' WHERE 0') +
              ' ORDER BY started_at',
          )
          .all(...(opts.sessionSources ?? []));
        selectedRows = sessionRows.length;
      } catch (err) {
        // Missing/renamed tables = host schema drift, not a crash.
        return {
          bytesRead: size,
          skippedLines: 0,
          truncated: false,
          sessions: 0,
          zeroSessionsReason: `schema mismatch reading sessions table: ${String(err)}`,
        };
      }

      const msgQuery = db.query<MessageRow, [string]>(
        "SELECT role, content, timestamp FROM messages WHERE session_id = ? " +
          "AND role IN ('user','assistant') ORDER BY timestamp, id",
      );
      for (const row of sessionRows) {
        if (typeof row.id !== 'string' || !row.id) continue;
        const messages: TranscriptMessage[] = [];
        for (const m of msgQuery.all(row.id)) {
          const role = m.role === 'user' || m.role === 'assistant' ? m.role : null;
          if (!role) continue;
          const text = contentToText(m.content);
          if (!text) continue;
          messages.push({ role, timestamp: epochToIso(m.timestamp), text });
        }
        if (!messages.length) continue;
        sessions++;
        yield {
          meta: {
            harness: 'hermes',
            sessionId: row.id,
            title: row.title ?? row.display_name ?? undefined,
            cwd: row.cwd ?? undefined,
            model: row.model ?? undefined,
            startedAt: epochToIso(row.started_at) || messages[0].timestamp || undefined,
            raw: {
              session_id: row.id,
              source: row.source ?? null,
              cwd: row.cwd ?? null,
              source_path: path,
            },
          },
          messages,
        };
      }
    } finally {
      db.close();
    }

    return {
      bytesRead: size,
      skippedLines: 0,
      truncated: false,
      sessions,
      expectedEmpty: opts.sessionSources !== undefined && selectedRows === 0 ? true : undefined,
      zeroSessionsReason:
        sessions === 0
          ? opts.sessionSources !== undefined && selectedRows === 0
            ? 'no sessions match the selected native session sources'
            : 'no sessions with user/assistant text messages in store'
          : undefined,
    };
  },
};
