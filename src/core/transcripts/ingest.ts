/**
 * ingest.ts — the transcripts-import core (cathedral-4).
 *
 * Engine-facing, CLI-free: `gbrain transcripts ingest` parses flags and
 * calls runTranscriptsIngest; e2e tests call it directly. Pipeline per
 * session (ATOMICITY = SESSION, never file — a multi-session file commits
 * the sessions that pass and skips the ones that fail; idempotent re-runs
 * complete the rest):
 *
 *   detect → adapter.parse (AsyncGenerator, per-session) → since/limit
 *   filters → redactSession (fail-closed) → renderSessionParts →
 *   native page persistence per part (embed OFF unless opted in) →
 *   putRawData(baseSlug) → stale-part reconciliation (delete part > of).
 *
 * Error taxonomy:
 *   - per-FILE: unreadable / unknown format / symlink → counted, run continues.
 *   - per-SESSION: scan failure, oversize part, adapter throw → counted,
 *     file continues.
 *   - RUN-LEVEL (fail-closed integrity): importFromContent duplicate-lookup
 *     or read-back failures and putRawData misses rethrow and abort the run.
 *     Heuristic seam: import errors matching /too large|invalid byte
 *     sequence/ stay per-session.
 *
 * Watermark: the RESULT carries `cleanScan` (no errors anywhere, no limit
 * truncation) + `maxSessionTs`; the COMMAND advances the `--since last`
 * checkpoint only on a clean scan — a truncated or partially-failed run
 * must never skip work permanently.
 */

import { existsSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { atomicWriteFileSync, mkdirPrivate } from '../atomic-write.ts';
import { ensureGbrainHome } from '../gbrain-home.ts';
import { localHostId } from '../persistence/identity.ts';
import { resolveSourceLocalFilePath } from '../markdown.ts';
import { recordedPathFromFileUri, scannerSlugRootMode } from '../write-through.ts';
import { managedImportContent, readImportBytes } from '../persistence/import-prepare.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { QUARANTINE_KEY } from '../quarantine.ts';
import type { BrainEngine } from '../engine.ts';
import type { Page } from '../types.ts';
import { importFromContent } from '../import-file.ts';
import { canonicalJson } from '../remediation-step.ts';
import { loadConfig } from '../config.ts';
import { OperationError, type OperationContext } from '../ops/contract.ts';
import { currentSubmissionAuthority } from '../minions/submission-authority.ts';
import { currentVerifiedLocalWriter } from '../persistence/identity.ts';
import { initializeLocalPersistence, requestPrincipalForContext, submitPageMutation } from '../persistence/page-mutations.ts';
import { assertReplayIntent, getWriteRequest, intentDigest } from '../persistence/journal.ts';
import { digest, sha256 } from '../persistence/digest.ts';
import { isTerminal } from '../persistence/model.ts';
import { prepareFileTarget } from '../persistence/page-prepare.ts';
import { getWorktreeBinding } from '../persistence/ownership.ts';
import { authorizeStoredRequest } from '../persistence/authority.ts';
import type { TranscriptAdapter, TranscriptFormat } from './types.ts';
import { detectAdapter } from './detect.ts';
import {
  loadImportRedactionPatterns,
  redactSession,
  renderPartContent,
  renderSessionParts,
  type RenderedPart,
  type RenderSessionResult,
} from './render.ts';
import { RECONCILE_SAFETY_KEYS } from '../persistence/reconcile-safety.ts';
import { ATOMS_SCAN_HASH_KEY } from '../utils.ts';

export interface IngestActivePack {
  page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string> }>;
}

export interface TranscriptsIngestOpts {
  /** Files to import (post-glob, pre-detection). */
  paths: string[];
  /** Explicit format wins over detection. */
  format?: TranscriptFormat;
  /** Parse + redact + render + report; ZERO engine writes. */
  dryRun?: boolean;
  /** Max sessions imported this run (session granularity; truncation ⇒ not a clean scan). */
  limit?: number;
  /** Only sessions whose LAST message is strictly newer than this ISO. */
  sinceIso?: string;
  /** Resolved source id — threads through import, raw-data, reconciliation. */
  sourceId: string;
  /** Embedding opt-in (default OFF: bulk imports defer to the embed backfill). */
  embed?: boolean;
  /** After repairing a terminal native failure, explicitly permit one new attempt. */
  retryFailed?: boolean;
  /**
   * gbrain#4149: explicit byte-cap OVERRIDE threaded to every adapter's
   * parse. Undefined = each adapter keeps its own format-specific default
   * (native indexed SQLite and complete streamed JSONL imports, ...) — the override exists
   * for legitimate oversized stores, not to replace the defaults.
   */
  maxBytes?: number;
  /** Optional exact source-native session origins (distinct from brain sources). */
  sessionSources?: string[];
  activePack?: IngestActivePack;
  /** Test seam for the redaction user-pattern file. */
  userPatternsPath?: string;
  /** Adapter registry override (tests). */
  adapters?: TranscriptAdapter[];
  /** Called once per processed file (progress ticks). */
  onFileDone?: (done: number, total: number, path: string) => void;
  /**
   * Called once per SESSION — the liveness signal for multi-session stores
   * (one hermes state.db can hold thousands of sessions between file ticks).
   */
  onSession?: (sessionId: string) => void;
}

export interface IngestSessionOutcome {
  sessionId: string;
  harness: TranscriptFormat;
  baseSlug: string;
  parts: number;
  /** Per-part import statuses (dry-run: 'planned'). */
  statuses: Array<'imported' | 'skipped' | 'error' | 'planned'>;
  redactions: number;
  imperatives: number;
  error?: string;
  /** C-19: a session with no timestamps is skipped (never fabricated), not errored. */
  skipped?: 'no_timestamp';
}

export interface IngestFileOutcome {
  path: string;
  format?: TranscriptFormat;
  sessions: IngestSessionOutcome[];
  skippedLines: number;
  drift: boolean;
  /** Adapter degraded to a bounded read (e.g. codex head+tail) — part of the file was never scanned. */
  truncated: boolean;
  error?: string;
}

export interface TranscriptsIngestResult {
  files: IngestFileOutcome[];
  pages: { imported: number; skipped: number; errored: number; planned: number };
  sessionsSeen: number;
  sessionsImported: number;
  sessionsFiltered: number;
  sessionsErrored: number;
  /** Sessions with no timestamps at all: reported, not imported, not an error (C-19). */
  sessionsSkippedNoTimestamp: number;
  redactions: number;
  imperatives: number;
  partsDeleted: number;
  driftFiles: number;
  /** Files whose adapter reported a truncated (partially-unscanned) read. */
  truncatedFiles: number;
  erroredFiles: number;
  /** EVERY slug the run touched — imported AND hash-skipped (--facts targets all). */
  slugsTouched: string[];
  /** True ⇔ no file/session errors and no limit truncation: watermark may advance. */
  cleanScan: boolean;
  /** Newest session last-message ISO seen (imported or filtered). */
  maxSessionTs: string;
}

/**
 * Session's last message timestamp, NORMALIZED to Z-form ISO ('' when none
 * carry one). Normalization matters because since/watermark comparisons are
 * lexicographic: an offset-form ISO (+07:00) string-sorts after a real-time
 * newer Z-form and would poison the watermark. UNPARSEABLE timestamps are
 * SKIPPED, never passed through — a single hostile/corrupt value like a
 * letter-leading string would otherwise become the watermark and since-filter
 * every real session forever.
 */
function lastMessageTs(messages: Array<{ timestamp: string }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const raw = messages[i].timestamp;
    if (!raw) continue;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) continue;
    return d.toISOString();
  }
  return '';
}

const RUN_ABORT_MARKER = 'transcripts-ingest run abort';

/** Native transcript identity is scoped to its brain source, never a slug date. */
async function readTranscriptParts(engine: BrainEngine, sourceId: string, harness: TranscriptFormat, sessionId: string) {
  try {
    return await engine.executeRaw<{ slug: string; part: string }>(
      `SELECT slug, frontmatter->'transcript_import'->>'part' AS part FROM pages
       WHERE source_id = $1 AND deleted_at IS NULL
         AND frontmatter->'transcript_import'->>'harness' = $2
         AND frontmatter->'transcript_import'->>'session_id' = $3`,
      [sourceId, harness, sessionId],
    );
  } catch (error) {
    throw new Error(`${RUN_ABORT_MARKER}: canonical transcript identity lookup failed: ${
      error instanceof Error ? error.message : String(error)
    }`, { cause: error });
  }
}

function isPerSessionImportError(err: unknown): boolean {
  // 'invalid byte sequence' is Postgres rejecting the DATA (e.g. a U+0000 a
  // sanitizer missed, #4392) — one bad session, never a DB-down signal.
  return err instanceof Error && /too large|invalid byte sequence/i.test(err.message);
}

export async function runTranscriptsIngest(
  engine: BrainEngine,
  opts: TranscriptsIngestOpts,
): Promise<TranscriptsIngestResult> {
  const result: TranscriptsIngestResult = {
    files: [],
    pages: { imported: 0, skipped: 0, errored: 0, planned: 0 },
    sessionsSeen: 0,
    sessionsImported: 0,
    sessionsFiltered: 0,
    sessionsErrored: 0,
    sessionsSkippedNoTimestamp: 0,
    redactions: 0,
    imperatives: 0,
    partsDeleted: 0,
    driftFiles: 0,
    truncatedFiles: 0,
    erroredFiles: 0,
    slugsTouched: [],
    cleanScan: true,
    maxSessionTs: '',
  };
  let limitTruncated = false;

  // Redaction patterns compile ONCE per run — loadPatterns re-reads and
  // recompiles the pattern file on every call, which a bulk import would
  // otherwise repeat thousands of times.
  const redactionPatterns = loadImportRedactionPatterns(opts.userPatternsPath);

  const total = opts.paths.length;
  let done = 0;
  let newWorkSessions = 0;

  const mutate = await transcriptMutationPublisher(engine, opts);
  const managed = mutate !== undefined;

  for (const path of opts.paths) {
    if (limitTruncated) break;
    const fileOutcome: IngestFileOutcome = {
      path,
      sessions: [],
      skippedLines: 0,
      drift: false,
      truncated: false,
    };
    result.files.push(fileOutcome);

    const detected = detectAdapter(path, {
      explicitFormat: opts.format,
      adapters: opts.adapters,
    });
    if (!detected.ok) {
      fileOutcome.error =
        detected.reason === 'unknown_format'
          ? `unknown format (tried: ${detected.tried.join(', ')}); pass an explicit format flag`
          : detected.reason;
      result.erroredFiles++;
      result.cleanScan = false;
      done++;
      opts.onFileDone?.(done, total, path);
      continue;
    }
    fileOutcome.format = detected.adapter.format;

    // gbrain#4149: thread the explicit cap override; omit the opts object
    // entirely when unset so adapters keep their native defaults.
    const gen = opts.maxBytes != null || opts.sessionSources !== undefined
      ? detected.adapter.parse(path, {
          ...(opts.maxBytes != null ? { maxBytes: opts.maxBytes } : {}),
          ...(opts.sessionSources !== undefined ? { sessionSources: opts.sessionSources } : {}),
        })
      : detected.adapter.parse(path);
    let initiatingError: unknown;
    try {
      let step = await gen.next();
      while (!step.done) {
        if (limitTruncated) {
          // The unconditional close below runs the generator's finally.
          break;
        }
        const session = step.value;
        result.sessionsSeen++;
        opts.onSession?.(session.meta.sessionId);
        const lastTs = lastMessageTs(session.messages);
        if (lastTs && lastTs > result.maxSessionTs) result.maxSessionTs = lastTs;

        if (opts.sinceIso && lastTs && lastTs <= opts.sinceIso) {
          result.sessionsFiltered++;
          step = await gen.next();
          continue;
        }
        // The limit counts NEW WORK only (sessions with a non-skipped part).
        // Counting hash-skipped re-scans would make batched backfill loop
        // over the same already-imported prefix forever: every run would
        // burn the limit on free re-scans and truncate before new sessions.
        if (opts.limit !== undefined && newWorkSessions >= opts.limit) {
          limitTruncated = true;
          result.cleanScan = false;
          break;
        }

        const outcome: IngestSessionOutcome = {
          sessionId: session.meta.sessionId,
          harness: session.meta.harness,
          baseSlug: '',
          parts: 0,
          statuses: [],
          redactions: 0,
          imperatives: 0,
        };
        fileOutcome.sessions.push(outcome);

        // C-19: a session with no timestamps can never render (provenance is
        // never fabricated), so retrying it is pointless; report the skip and
        // keep the scan clean instead of freezing the --since checkpoint.
        if (!session.meta.startedAt && !session.messages.some(m => m.timestamp)) {
          outcome.skipped = 'no_timestamp';
          result.sessionsSkippedNoTimestamp++;
          step = await gen.next();
          continue;
        }

        try {
          const redacted = redactSession(session, {
            userPatternsPath: opts.userPatternsPath,
            patterns: redactionPatterns,
          });
          outcome.redactions = redacted.redactionCount;
          outcome.imperatives = redacted.imperativesFlagged;
          const rendered = renderSessionParts(redacted, { sourcePath: path });
          outcome.baseSlug = rendered.baseSlug;
          outcome.parts = rendered.parts.length;

          if (opts.dryRun) {
            outcome.statuses = rendered.parts.map(() => 'planned' as const);
            result.pages.planned += rendered.parts.length;
            // #4762: a planned session is new work too, so the --limit gate
            // above truncates the preview like the real run. A dry run cannot
            // see hash-skips (no engine reads), so `--dry-run --limit N` shows
            // the first N eligible sessions — an upper bound on what the write
            // path would import.
            newWorkSessions++;
          } else {
            // Resolve native identities BEFORE importing. The general importer
            // intentionally skips cross-slug external-ID duplicates, even when
            // their bodies changed; asking it to discover our canonical slug
            // would therefore silently keep stale transcript text.
            const { partSlugs, resolvedBaseSlug } = await resolveTranscriptIdentity(engine, opts.sourceId,
              redacted.session.meta.harness, redacted.session.meta.sessionId, rendered);
            outcome.baseSlug = resolvedBaseSlug;
            for (const part of rendered.parts) {
              const partSlug = partSlugs.get(part.part) ??
                (part.part === 1 ? resolvedBaseSlug : `${resolvedBaseSlug}-p${part.part}`);
              try {
                part.slug = partSlug;
                if (!managed) await preserveForeignFrontmatter(engine, opts.sourceId, part);
                const provenance = {
                  source_kind: `transcript:${session.meta.harness}`,
                  source_uri: path,
                  ingested_via: 'cli:transcripts-ingest',
                };
                const receipt = managed ? await mutate!('put_page', partSlug, {
                  content: part.content, ...provenance,
                }, part) : undefined;
                const r = receipt ? {
                  slug: String(receipt.slug),
                  status: receipt.status === 'skipped' ? 'skipped' as const : 'imported' as const,
                } : await importFromContent(engine, partSlug, part.content, {
                  noEmbed: !opts.embed,
                  sourceId: opts.sourceId,
                  activePack: opts.activePack,
                  ...provenance,
                });
                outcome.statuses.push(r.status);
                if (r.status === 'imported') result.pages.imported++;
                else if (r.status === 'skipped') result.pages.skipped++;
                else result.pages.errored++;
                const actualSlug = r.slug || partSlug;
                if (actualSlug !== partSlug) {
                  throw new Error('canonical transcript identity changed during import');
                }
                result.slugsTouched.push(actualSlug);
              } catch (err) {
                if (isPerSessionImportError(err)) throw err; // → per-session catch
                const e = new Error(
                  `${RUN_ABORT_MARKER}: import integrity failure on ${partSlug}: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                );
                (e as { cause?: unknown }).cause = err;
                throw e;
              }
            }

            // importFromContent RETURNS status 'error' (it does not throw)
            // for e.g. frontmatter-parse failures. A page that never landed
            // is a session error and must freeze the watermark — otherwise
            // a since-last run permanently skips content that never imported.
            if (outcome.statuses.includes('error')) {
              throw new Error(
                `page import returned error status for session ${session.meta.sessionId}`,
              );
            }

            const allSkipped =
              outcome.statuses.length > 0 && outcome.statuses.every((s) => s === 'skipped');
            if (!allSkipped) newWorkSessions++;

            // Session metadata rides the base page's raw_data — the REDACTED
            // copy, never the original (secrets in titles/cwd would otherwise
            // bypass the page-body redaction). On all-skipped re-runs the
            // write is HEALED, not assumed: a prior run can have committed
            // the pages and then died before putRawData, and hash-skips
            // would otherwise make that hole permanent.
            await healTranscriptRawData(engine, opts.sourceId, resolvedBaseSlug, session.meta.harness, redacted.session.meta.raw, allSkipped);

            // Stale-part reconciliation: a session that shrank or re-split
            // leaves higher-numbered part pages behind — delete them, or a
            // stale part stays searchable forever. ENUMERATED via one SQL
            // query (never a sequential probe: a crash mid-delete leaves
            // holes that a first-miss or bounded-miss probe walks past) and
            // run on EVERY pass including all-skipped re-runs, because a
            // prior run can have died between the page writes and this step.
            const partRows = await readTranscriptParts(
              engine, opts.sourceId, redacted.session.meta.harness, redacted.session.meta.sessionId,
            );
            for (const row of partRows) {
              const num = Number(row.part);
              if (Number.isInteger(num) && num > rendered.parts.length) {
                if (managed) await mutate!('delete_page', row.slug);
                else await engine.deletePage(row.slug, { sourceId: opts.sourceId });
                result.partsDeleted++;
              }
            }
          }
          result.sessionsImported++;
          result.redactions += outcome.redactions;
          result.imperatives += outcome.imperatives;
        } catch (err) {
          if (err instanceof Error && err.message.startsWith(RUN_ABORT_MARKER)) throw err;
          outcome.error = err instanceof Error ? err.message : String(err);
          result.sessionsErrored++;
          result.cleanScan = false;
        }

        step = await gen.next();
      }
      if (step.done && step.value) {
        const diag = step.value;
        fileOutcome.skippedLines = diag.skippedLines;
        if (diag.bytesRead > 0 && diag.sessions === 0 && !diag.expectedEmpty) {
          fileOutcome.drift = true;
          result.driftFiles++;
          // A drifting file may hold sessions a fixed parser will surface
          // later (native store schema drift, transient format break) — the shared
          // watermark must not advance past it. expectedEmpty (a grok
          // tool/reasoning-only session) is understood, not drifted.
          result.cleanScan = false;
        }
        if (diag.skippedLines > 0) {
          // Malformed lines can be DROPPED RECORDS (an actively-appended
          // file read mid-write, corruption) — freeze the watermark so a
          // later repair with an older timestamp is still picked up.
          // Re-scans stay cheap via content-hash skip.
          result.cleanScan = false;
        }
        if (diag.truncated) {
          // A bounded read (codex head+tail over an over-budget rollout)
          // skipped a window of the file — advancing the since-watermark
          // over that unscanned window would drop its sessions permanently.
          fileOutcome.truncated = true;
          result.truncatedFiles++;
          result.cleanScan = false;
        }
      }
    } catch (err) {
      initiatingError = err;
      if (err instanceof Error && err.message.startsWith(RUN_ABORT_MARKER)) throw err;
      fileOutcome.error = err instanceof Error ? err.message : String(err);
      result.erroredFiles++;
      result.cleanScan = false;
    } finally {
      // Manual next() consumption does not provide for-await's IteratorClose.
      // Release native resources after success, cancellation AND downstream
      // engine errors, including run-level aborts which rethrow above.
      try {
        await gen.return?.(undefined as never);
      } catch (cleanupError) {
        const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        if (initiatingError !== undefined) {
          const originalMessage = initiatingError instanceof Error ? initiatingError.message : String(initiatingError);
          throw new AggregateError([initiatingError, cleanupError],
            `${RUN_ABORT_MARKER}: ${originalMessage}; adapter cleanup also failed: ${cleanupMessage}`,
            { cause: initiatingError });
        }
        throw new Error(`${RUN_ABORT_MARKER}: adapter cleanup failed: ${cleanupMessage}`, { cause: cleanupError });
      }
    }

    done++;
    opts.onFileDone?.(done, total, path);
  }

  if (opts.dryRun) result.cleanScan = false; // dry-runs never advance watermarks
  return result;
}

/**
 * The slug embeds the title (and start day) for export formats, so a rename
 * renders a new slug for the same session. Import at the slug the session's
 * pages already live at: the content is then an in-place update. At a new
 * slug, the importer's cross-slug identity dedup skipped it as a duplicate
 * and every message added since the last import was silently dropped.
 */
/**
 * Re-ingest replaces only what the collector renders (#5431): keys another
 * tool or the operator added to an imported conversation page (a review flag,
 * say) are carried onto the re-rendered part. Gate- and phase-owned markers
 * are re-derived from the new content, so they are never carried.
 */
async function preserveForeignFrontmatter(engine: BrainEngine, sourceId: string, part: RenderedPart, snapshotPage?: Page | null): Promise<void> {
  const existing = snapshotPage === undefined ? await engine.getPage(part.slug, { sourceId }) : snapshotPage;
  const foreign = Object.entries(existing?.frontmatter ?? {})
    .filter(([key]) => !Object.hasOwn(part.frontmatter, key) && !RE_DERIVED_KEYS.has(key));
  if (foreign.length === 0) return;
  part.content = renderPartContent({ ...part.frontmatter, ...Object.fromEntries(foreign) }, part.body);
}

// Automatic refresh cannot release a trusted owner's quarantine. Preserve
// that hold from the guarded snapshot; clearing requires an explicit owner write.
const RE_DERIVED_KEYS = new Set([...RECONCILE_SAFETY_KEYS.filter(key => key !== QUARANTINE_KEY), ATOMS_SCAN_HASH_KEY]);

async function adoptExistingBaseSlug(engine: BrainEngine, sourceId: string, rendered: RenderSessionResult): Promise<void> {
  const [existing] = await engine.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND frontmatter->>'id' = $2 ORDER BY id LIMIT 1`,
    [sourceId, rendered.parts[0].frontmatterId],
  );
  if (!existing || existing.slug === rendered.baseSlug) return;
  rendered.baseSlug = existing.slug;
  for (const part of rendered.parts) part.slug = part.part === 1 ? existing.slug : `${existing.slug}-p${part.part}`;
}

/** Native publication is one cohesive admission/replay lane, not a second importer. */
async function transcriptMutationPublisher(engine: BrainEngine, opts: TranscriptsIngestOpts) {
  // Managed brains publish through the same native coordinator as put/delete.
  // A committed receipt includes canonical-file publication and text projection;
  // pending/failed receipts must abort before metadata, embedding or checkpoints.
  const managed = !opts.dryRun && (await engine.executeRaw<{ enabled: boolean }>(
    'SELECT enabled FROM persistence_brain WHERE singleton=1',
  ))[0]?.enabled === true;
  if (!managed) return undefined;
  const caller = currentSubmissionAuthority();
  if (caller && caller.kind !== 'application' || currentVerifiedLocalWriter()?.remote) {
    throw new OperationError('permission_denied', 'Managed transcript import requires the trusted local CLI.', 'Run transcripts ingest on the brain host through its trusted local CLI; remote clients cannot import owner-private archives.');
  }
  const context: OperationContext = {
    engine, remote: false, dryRun: false, sourceId: opts.sourceId,
    config: loadConfig() ?? { engine: engine.kind },
    logger: console,
  };
  return async (operation: 'put_page' | 'delete_page', slug: string, params: Record<string, unknown> = {}, part?: RenderedPart) => {
    const [source] = await engine.executeRaw<{ incarnation: string; archived: boolean }>(
      'SELECT incarnation,archived FROM sources WHERE id=$1', [opts.sourceId]);
    if (!source || source.archived) throw new OperationError('source_changed', 'The write source is not active.', 'Inspect gbrain sources list and select an active registered source before importing.');
    const snapshot = await engine.readPageSnapshot(slug, { sourceId: opts.sourceId, includeDeleted: true });
    if (part) {
      await preserveForeignFrontmatter(engine, opts.sourceId, part, snapshot?.page ?? null);
      params = { ...params, content: part.content };
    }
    let intent: Record<string, unknown> = {
      ...params, slug, source_id: opts.sourceId,
      ...(snapshot ? { expected_revision: snapshot.revision } : {}),
    };
    const binding = await getWorktreeBinding(engine, opts.sourceId);
    const writeThrough = !/^(false|0|off|no)$/i.test(await engine.getConfig('sync.write_through') ?? 'true');
    let target: string | undefined;
    if (operation === 'put_page') {
      if (!writeThrough || !binding || binding.state !== 'active' || binding.owner_host_id !== localHostId() || !binding.local_path) {
        throw new OperationError('owner_unavailable', 'Managed transcript import requires its active canonical file owner.',
          'Run gbrain sources writer status --json and import on the active canonical owner with write-through enabled. Database-only transcript publication is not supported.');
      }
      const root = join(binding.local_path, binding.relative_path);
      const mode = snapshot?.page.source_path ? await scannerSlugRootMode(engine, opts.sourceId, root) : undefined;
      const recorded = recordedPathFromFileUri(snapshot?.page.source_uri, root);
      target = resolveSourceLocalFilePath(root, snapshot?.page.source_path, slug, mode)
        ?? (recorded ? join(root, recorded) : join(root, `${slug}.md`));
      intent = { ...intent, ...managedTranscriptIntent(slug, String(params.content), snapshot, binding, target, !opts.embed, opts.activePack) };
    }
    // A hard purge returns to an absent snapshot, not the first-create
    // generation. Native committed target history survives page deletion and
    // receipt compaction; pending requests do not advance this absence anchor.
    const absence = snapshot ? undefined : (await engine.executeRaw<{ id: string }>(
      `SELECT id FROM persistence_requests WHERE source_id=$1 AND source_incarnation=$2::uuid
       AND slug=$3 AND state='committed' ORDER BY sequence DESC LIMIT 1`,
      [opts.sourceId, source.incarnation, slug]))[0]?.id ?? null;
    // Repeated full scans reuse native receipts, even after journal compaction.
    // A changed source/page incarnation, observed revision or exact intent is
    // new work; generated timestamps never enter this identity.
    const identity = { namespace: 'transcripts-ingest:v1', operation, sourceIncarnation: source.incarnation,
      pageId: snapshot?.page.id ?? null, absence, intent,
      writeThrough, worktreeId: binding?.worktree_id ?? null, topologyGeneration: binding?.topology_generation ?? null };
    const requestIdFor = (value: unknown) => {
      const hash = digest(value);
      return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
    };
    let requestId = requestIdFor(identity);
    await initializeLocalPersistence(context);
    const principal = await requestPrincipalForContext(context);
    let prior = await getWriteRequest(engine, principal, requestId);
    let selectedIntent: Record<string, unknown> = intent;
    const failures: Array<{ row: NonNullable<typeof prior>; callerIntent: Record<string, unknown> }> = [];
    // Follow retained accepted retries before touching a possibly published
    // artifact. Compacted parents retain digests, while the active child keeps
    // the original frozen target hash needed to verify those parent intents.
    let acceptedTarget: unknown;
    let hasAcceptedTarget = false;
    while (prior) {
      if (prior.intent && Object.hasOwn(prior.intent, 'targetHash')) {
        acceptedTarget = prior.intent.targetHash;
        hasAcceptedTarget = true;
      }
      if (!isTerminal(prior) || prior.state === 'committed' || prior.recovery) break;
      await authorizeStoredRequest(engine, prior);
      failures.push({ row: prior, callerIntent: selectedIntent });
      const retryId = requestIdFor({ ...identity, retryOf: prior.request_id });
      const acceptedRetry = await getWriteRequest(engine, principal, retryId);
      if (!acceptedRetry && !opts.retryFailed) break;
      selectedIntent = { ...intent, retry_of: prior.request_id };
      requestId = retryId;
      prior = acceptedRetry;
    }
    if (operation === 'put_page') {
      const targetHash = hasAcceptedTarget ? acceptedTarget : existsSync(target!) ? sha256(readImportBytes(target!)) : null;
      selectedIntent = { ...selectedIntent, targetHash };
      for (const failure of failures) failure.callerIntent = { ...failure.callerIntent, targetHash };
    }
    for (const failure of failures) {
      assertReplayIntent(failure.row, intentDigest({ operation, sourceId: opts.sourceId, slug, callerIntent: failure.callerIntent }));
    }
    // Settled scans retain stock canonical-file checks. A pending recovery
    // owns its partial artifact: its accepted target hash is immutable, whereas
    // current file bytes may already be the replacement and DB still old.
    if ((!prior || isTerminal(prior) && !prior.recovery) && writeThrough && binding) {
      const file = await prepareFileTarget(engine, { source_id: opts.sourceId, worktree_id: binding.worktree_id, slug },
        snapshot, operation === 'put_page' ? String(selectedIntent.content) : null);
      if (operation === 'put_page' && !file) throw new OperationError('source_changed', 'Transcript import cannot replace a database-only or read-only mirror page.',
        'Select a writable canonical archive source; the existing page and mirror remain unchanged.');
    }
    try {
      return await submitPageMutation(context, { operation, ...(operation === 'put_page' ? { managedFileImport: true as const } : {}), waitMs: 30_000, params: { ...selectedIntent, request_id: requestId } });
    } catch (error) {
      if (error instanceof OperationError && error.writeRequest && ['failed', 'conflict', 'cancelled'].includes(error.writeRequest.state)) {
        error.message += ` Inspect native request ${error.writeRequest.request_id}; after repairing its cause, rerun transcripts ingest with --retry-failed to authorize one new attempt.`;
      }
      throw error;
    }
  };
}

async function resolveTranscriptIdentity(engine: BrainEngine, sourceId: string, harness: TranscriptFormat, sessionId: string, rendered: RenderSessionResult) {
  const existingParts = await readTranscriptParts(
    engine, sourceId, harness, sessionId,
  );
  // Retain upstream's external-ID adoption for legacy pages without
  // transcript_import metadata; native identities remain authoritative.
  if (existingParts.length === 0) await adoptExistingBaseSlug(engine, sourceId, rendered);
  const partSlugs = new Map<number, string>();
  for (const row of existingParts) {
    const number = Number(row.part);
    if (!Number.isInteger(number) || number < 1 || partSlugs.has(number)) {
      throw new Error(`${RUN_ABORT_MARKER}: ambiguous canonical transcript part identity`);
    }
    partSlugs.set(number, row.slug);
  }
  let resolvedBaseSlug = rendered.baseSlug;
  if (partSlugs.has(1)) resolvedBaseSlug = partSlugs.get(1)!;
  else if (partSlugs.size) {
    // A crash/deletion may leave later parts but no base. Their
    // native suffix preserves the original base for resurrection.
    const [number, slug] = [...partSlugs.entries()].sort(([a], [b]) => a - b)[0];
    const suffix = `-p${number}`;
    if (!slug.endsWith(suffix)) throw new Error(`${RUN_ABORT_MARKER}: missing canonical transcript base identity`);
    resolvedBaseSlug = slug.slice(0, -suffix.length);
  }
  return { partSlugs, resolvedBaseSlug };
}

/** Heal interrupted metadata writes even when every canonical part hash-skips. */
async function healTranscriptRawData(engine: BrainEngine, sourceId: string, resolvedBaseSlug: string, harness: TranscriptFormat, raw: Record<string, unknown> | undefined, allSkipped: boolean) {
  if (raw) {
    try {
      const rawSource = `transcript:${harness}`;
      // Skipped re-runs COMPARE, never assume: existence alone is
      // not freshness — a private pattern added AFTER the first
      // import must refresh the stored copy, and a prior run can
      // have died before this write. Content-equal rows skip the
      // write so healthy re-runs stay write-free.
      let needsRaw = true;
      if (allSkipped) {
        // Active rows only: `allSkipped` means the import hash check
        // (which reads ACTIVE rows) just matched every page, so the
        // base page is alive here by construction — a tombstoned
        // page never reaches this branch (it reads as missing and is
        // re-imported, see the "resurrects the page" e2e). No
        // includeDeleted flag: the probe must never read through a
        // soft-delete the hash check did not.
        const existing = await engine.getRawData(resolvedBaseSlug, rawSource, {
          sourceId,
        });
        // Key-order-insensitive compare: JSONB hands keys back in
        // its own canonical order, so a plain JSON.stringify never
        // matched the freshly built object and every healthy re-run
        // rewrote the row.
        needsRaw =
          existing.length === 0 ||
          canonicalJson(existing[0].data) !==
            canonicalJson(JSON.parse(JSON.stringify(raw)));
      }
      if (needsRaw) {
        await engine.putRawData(resolvedBaseSlug, rawSource, raw, {
          sourceId,
        });
      }
    } catch (err) {
      const e = new Error(
        `${RUN_ABORT_MARKER}: putRawData failed for ${resolvedBaseSlug}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      (e as { cause?: unknown }).cause = err;
      throw e;
    }
  }
}

/** Stock native managed import owns noEmbed, immutable input and target checks. */
function managedTranscriptIntent(slug: string, content: string, snapshot: PageSnapshot | null,
  binding: NonNullable<Awaited<ReturnType<typeof getWorktreeBinding>>>, target: string,
  noEmbed: boolean, activePack?: IngestActivePack) {
  const root = join(binding.local_path!, binding.relative_path);
  const path = relative(root, target);
  const sourcePath = snapshot?.page.source_path ?? path;
  const normalized = managedImportContent(sourcePath, Buffer.from(content), activePack);
  if (normalized.slug !== slug) throw new OperationError('source_changed', 'The transcript canonical path no longer names its session slug.',
    'Inspect the existing page and canonical path before importing; neither identity is replaced by a different slug.');
  const inputHash = sha256(content);
  const home = ensureGbrainHome();
  const stagingRoot = join(home, 'cache', 'transcript-import');
  mkdirPrivate(stagingRoot, home);
  const inputPath = join(realpathSync(stagingRoot), `${inputHash}.md`);
  // Immutable private preparation survives pending native recovery and replay.
  // A crash cannot create a partial artifact under the accepted hash name.
  if (!existsSync(inputPath)) atomicWriteFileSync(inputPath, content, { mode: 0o600, durable: true });
  if (sha256(readImportBytes(inputPath)) !== inputHash) throw new OperationError('source_changed', 'Prepared transcript input does not match its immutable hash.',
    'Inspect the private transcript-import cache and repair the changed artifact before retrying; no canonical page was changed.');
  return { kind: 'managed_file_import', content: normalized.content, sourcePath, path, inputPath, inputHash,
    ownerEpoch: String(binding.owner_epoch), noEmbed, ...(activePack ? { activePack } : {}) };
}
