/**
 * codex.ts — Codex rollout (.jsonl) adapter (cathedral-4).
 *
 * One rollout file = one session. Line shape: {timestamp, type, payload}.
 * Verified against live local rollouts 2026-08-14 and 2026-10-04 (see SPEC_TARGET).
 *
 * TURN SELECTION IS STRUCTURAL, not heuristic: the human's typed text is
 * recorded as `event_msg` payload.type='user_message' (payload.message), or
 * completed `UserMessage` items (item.content text blocks). Native origin
 * metadata distinguishes delegated child logs from ordinary conversations;
 * `response_item` rows with role user/developer are INJECTED context
 * (app-context, plugin lists, instruction preambles) and are skipped
 * wholesale. Assistant text comes from `response_item` payload.type='message'
 * role='assistant' output_text blocks, or completed AgentMessage Text blocks. Paired encodings share a native message ID and are archived once. reasoning / tool calls / token_count
 * and every other event kind are skipped — the archive records conversation
 * text only (lossy by design).
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import type { HostSpecTarget } from '../bootstrap/host-specs.ts';
import type {
  FileDiagnostics,
  ParsedSession,
  ParseSessionsOpts,
  TranscriptAdapter,
  TranscriptMessage,
} from './types.ts';
import { utcTimestamp } from './types.ts';
import { streamJsonlLines } from './jsonl-lines.ts';

/**
 * Head window kept when a rollout exceeds the parse budget. Only needs to
 * cover `session_meta` (the first record) plus slack; capped at a quarter of
 * the budget so a small --max-bytes cannot spend everything on the head.
 */
const CODEX_HEAD_WINDOW_BYTES = 256 * 1024;

export const CODEX_SPEC_TARGET: HostSpecTarget = {
  id: 'codex-rollout-2026-08',
  status: 'verified',
  verifiedAt: '2026-10-04',
  references: [
    'local ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (codex CLI, live sample 2026-08-14)',
    'local Codex rollout corpus (native UserMessage items and subagent origins, verified 2026-10-04)',
    'test/fixtures/transcripts/codex-rollout.jsonl',
  ],
  note:
    'One JSON object per line: {timestamp: ISO, type, payload}. type ' +
    "'session_meta' header carries payload.{id, session_id, cwd, timestamp, " +
    "cli_version}; identity = payload.id (per-thread; session_id is the root " +
    "session shared by forked/subagent threads), first header wins. User turns: type 'event_msg' with payload.type " +
    "'user_message' (payload.message = typed text), or 'item_completed' with " +
    "item.{type:'UserMessage',content:[{type:'text',text}]}. Native source " +
    "objects with a subagent property are excluded by automatic discovery. Assistant turns: completed AgentMessage Text blocks or type " +
    "'response_item' with payload.{type:'message', role:'assistant', " +
    "content:[{type:'output_text', text}]}. response_item rows with role " +
    'user/developer are injected context and are skipped. reasoning, ' +
    'custom_tool_call*, function_call*, token_count, world_state, ' +
    'turn_context, compacted: all skipped. Unknown fields tolerated.',
};

function textFromBlocks(content: unknown, blockType: string): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === blockType && typeof b.text === 'string' && b.text.trim()) parts.push(b.text);
  }
  return parts.join('\n').trim();
}

/**
 * One parsed codex rollout line, classified (mirrors openclaw.ts's
 * mapOpenclawLine precedent: the hook lane's tail-capable parser reuses the
 * SAME line→row mapping as the import adapter, so the dated CODEX_SPEC_TARGET
 * stays the single source of truth).
 *
 * `tool_call` covers `custom_tool_call` (args in payload.`input`,
 * fixture-verified) and `function_call` (args in payload.`arguments`,
 * source-verified at openai/codex tag rust-v0.147.0) — both OBSERVED keys,
 * never guessed. Args arrive as a JSON document serialized into a string;
 * parsed tolerantly (a non-JSON string stays the raw string). `*_output`
 * rows are classified `skip`: 0.147.0 persists no success/error flag on
 * them, so there is no honest `result.ok` to join — calls ship without
 * result rather than with an inferred one.
 */
export type CodexLineResult =
  | { kind: 'session'; sessionId?: string; cwd?: string; startedAt?: string; cliVersion?: string; modelProvider?: string; source?: unknown }
  | { kind: 'user'; message: TranscriptMessage }
  | { kind: 'assistant'; message: TranscriptMessage; messageId?: string }
  | { kind: 'tool_call'; name: string; input: unknown }
  | { kind: 'boundary' }
  | { kind: 'skip' };

/** Paired native encodings share an ID, not a text-dedup heuristic. Each
 * parser owns one map so archive and hook turn indexes use the same identity. */
export function acceptCodexAssistantMessage(
  mapped: Extract<CodexLineResult, { kind: 'assistant' }>, ids: Map<string, string>,
): boolean {
  if (!mapped.messageId) return true;
  const prior = ids.get(mapped.messageId);
  if (prior !== undefined) {
    if (prior !== mapped.message.text) throw new Error('conflicting native assistant message identity');
    return false;
  }
  ids.set(mapped.messageId, mapped.message.text);
  return true;
}

function tolerantJson(v: unknown): unknown {
  if (typeof v !== 'string') return v ?? null;
  try {
    return JSON.parse(v);
  } catch {
    return v; // a non-JSON args string is still the honest payload
  }
}

/** Map one ALREADY-JSON-PARSED codex rollout line. */
export function mapCodexLine(entry: unknown): CodexLineResult {
  if (typeof entry !== 'object' || entry === null) return { kind: 'skip' };
  const e = entry as Record<string, unknown>;
  const payload = (typeof e.payload === 'object' && e.payload !== null ? e.payload : {}) as Record<string, unknown>;
  const lineTs = utcTimestamp(e.timestamp);
  if (e.type === 'session_meta') {
    return {
      kind: 'session',
      // #4981: payload.id is the per-thread identity (present in every real rollout
      // and embedded in its filename); payload.session_id is the ROOT session shared
      // by every forked/subagent thread. Keying on session_id collapsed children onto
      // the parent's page. session_id stays as the legacy/fixture fallback.
      sessionId:
        (typeof payload.id === 'string' && payload.id) ||
        (typeof payload.session_id === 'string' && payload.session_id) ||
        undefined,
      cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined,
      startedAt: typeof payload.timestamp === 'string' ? utcTimestamp(payload.timestamp) : lineTs || undefined,
      cliVersion: typeof payload.cli_version === 'string' ? payload.cli_version : undefined,
      modelProvider: typeof payload.model_provider === 'string' ? payload.model_provider : undefined,
      source: payload.source,
    };
  }
  if (e.type === 'compacted') return { kind: 'boundary' };
  if (e.type === 'event_msg' && payload.type === 'user_message') {
    const text = typeof payload.message === 'string' ? payload.message.trim() : '';
    return text ? { kind: 'user', message: { role: 'user', timestamp: lineTs, text } } : { kind: 'skip' };
  }
  if (e.type === 'event_msg' && payload.type === 'item_completed') {
    const item = payload.item as Record<string, unknown> | undefined;
    if (item?.type === 'UserMessage') {
      const text = textFromBlocks(item.content, 'text');
      return text ? { kind: 'user', message: { role: 'user', timestamp: lineTs, text } } : { kind: 'skip' };
    }
    if (item?.type === 'AgentMessage') {
      const text = textFromBlocks(item.content, 'Text');
      return text ? { kind: 'assistant', message: { role: 'assistant', timestamp: lineTs, text },
        messageId: typeof item.id === 'string' ? item.id : undefined } : { kind: 'skip' };
    }
  }
  if (e.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
    const text = textFromBlocks(payload.content, 'output_text');
    return text ? { kind: 'assistant', message: { role: 'assistant', timestamp: lineTs, text },
      messageId: typeof payload.id === 'string' ? payload.id : undefined } : { kind: 'skip' };
  }
  if (e.type === 'response_item' && (payload.type === 'custom_tool_call' || payload.type === 'function_call')) {
    const name = typeof payload.name === 'string' && payload.name ? payload.name : null;
    if (!name) return { kind: 'skip' };
    const rawArgs = payload.type === 'custom_tool_call' ? payload.input : payload.arguments;
    return { kind: 'tool_call', name, input: tolerantJson(rawArgs) };
  }
  // reasoning, *_output rows, injected user/developer response_items,
  // telemetry events: skipped by design.
  return { kind: 'skip' };
}

/** Native rollout origin tag; automatic archives omit delegated child traffic. */
export function isCodexSubagentFile(path: string): boolean {
  try {
    // Only the first record owns rollout identity/origin. Breaking closes the
    // streaming reader; large conversation bodies are never read for discovery.
    for (const line of streamJsonlLines(path)) {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry?.type !== 'session_meta') return false;
      const payload = entry.payload as Record<string, unknown> | undefined;
      const source = payload?.source;
      return typeof source === 'object' && source !== null &&
        Object.prototype.hasOwnProperty.call(source, 'subagent');
    }
  } catch {
    // An unreadable/malformed header is NOT a known child: retain it so native
    // detection/parsing surfaces the error rather than silently excluding it.
  }
  return false;
}

export const codexAdapter: TranscriptAdapter = {
  format: 'codex',
  specTarget: CODEX_SPEC_TARGET,

  detect(path: string, sample: Buffer): boolean {
    if (!path.endsWith('.jsonl')) return false;
    const firstLine = sample.toString('utf8').split('\n', 1)[0]?.trim();
    if (!firstLine || !firstLine.startsWith('{')) return false;
    try {
      const obj = JSON.parse(firstLine) as Record<string, unknown>;
      // STRUCTURAL check — a substring sniff misdetects any transcript whose
      // first message merely QUOTES rollout text (realistic for this repo's
      // own users) and would strand it in the drift lane.
      return obj !== null && typeof obj === 'object' && obj.type === 'session_meta';
    } catch {
      // First line truncated by the sample window (oversized session_meta):
      // fall back to the key sniff for exactly that case.
      return firstLine.includes('"session_meta"') && firstLine.includes('"payload"');
    }
  },

  async *parse(path: string, opts: ParseSessionsOpts = {}): AsyncGenerator<ParsedSession, FileDiagnostics> {
    const budget = opts.maxBytes === undefined ? undefined : Math.max(1, Math.floor(opts.maxBytes));
    const size = statSync(path).size;
    let lines: Iterable<string>;
    let bytesRead: number;
    let truncated = false;
    if (budget === undefined || size <= budget) {
      lines = streamJsonlLines(path, size);
      bytesRead = size;
    } else {
      // An EXPLICIT preview budget retains bounded head+tail semantics. Default
      // imports stream every record; this preview is reported as incomplete.
      //
      // HEAD + TAIL, not tail alone: `session_meta` — session_id, cwd,
      // cli_version, provenance — is the FIRST record of a rollout (verified:
      // line 0, byte 0). A pure tail read imports the newest turns with no
      // identity, so the head window is what keeps the session attributable.
      truncated = true;
      const head = Math.min(CODEX_HEAD_WINDOW_BYTES, Math.floor(budget / 4));
      const tail = budget - head;
      const fd = openSync(path, 'r');
      try {
        const hbuf = Buffer.alloc(head);
        const hn = readSync(fd, hbuf, 0, head, 0);
        const tbuf = Buffer.alloc(tail);
        const tn = readSync(fd, tbuf, 0, tail, size - tail);
        // The join is a line boundary neither side owns; both partials fail
        // JSON.parse and land in skippedLines, which is the honest accounting.
        lines = (hbuf.subarray(0, hn).toString('utf8') + '\n' + tbuf.subarray(0, tn).toString('utf8')).split('\n');
        bytesRead = hn + tn;
      } finally {
        closeSync(fd);
      }
    }
    let skippedLines = 0;
    let sessionId = '';
    let cwd: string | undefined;
    let startedAt = '';
    const messages: TranscriptMessage[] = [];
    const assistantIds = new Map<string, string>();
    let rawMeta: Record<string, unknown> | undefined;
    let emptyLifecycleOnly = true;
    let startedTurn: string | undefined;
    let abortedTurn: string | undefined;
    let threadSettingsSeen = false;

    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(t);
      } catch {
        skippedLines++;
        continue;
      }
      const mapped = mapCodexLine(entry);
      const record = entry as { type?: string; payload?: Record<string, unknown> } | null;
      const payload = record?.payload;
      if (record?.type === 'event_msg' && payload?.type === 'thread_settings_applied' && rawMeta !== undefined && sessionId.trim().length > 0 &&
        payload.thread_id === sessionId && payload.thread_settings !== null && typeof payload.thread_settings === 'object' && !Array.isArray(payload.thread_settings)) {
        threadSettingsSeen = true;
      } else if (record?.type === 'event_msg' && payload?.type === 'task_started' && typeof payload.turn_id === 'string') {
        if (startedTurn) emptyLifecycleOnly = false;
        startedTurn = payload.turn_id;
      } else if (record?.type === 'event_msg' && payload?.type === 'turn_aborted' && typeof payload.turn_id === 'string') {
        if (abortedTurn || startedTurn !== payload.turn_id) emptyLifecycleOnly = false;
        abortedTurn = payload.turn_id;
      } else if (!(mapped.kind === 'session' && mapped.sessionId !== undefined && mapped.sessionId.trim().length > 0) && !(record?.type === 'response_item' && payload?.type === 'message' &&
        (payload.role === 'developer' || payload.role === 'user'))) {
        emptyLifecycleOnly = false;
      }
      if (mapped.kind === 'session') {
        // #4981: first header wins — a child rollout carries its inherited parent
        // session_meta later in the file; it must not rewrite identity/cwd/start.
        if (rawMeta) continue;
        if (mapped.sessionId) sessionId = mapped.sessionId;
        if (mapped.cwd) cwd = mapped.cwd;
        if (mapped.startedAt) startedAt = mapped.startedAt;
        rawMeta = {
          session_id: sessionId,
          cwd: cwd ?? null,
          cli_version: mapped.cliVersion ?? null,
          model_provider: mapped.modelProvider ?? null,
          source: mapped.source ?? null,
          source_path: path,
        };
        continue;
      }
      if (mapped.kind === 'user' || mapped.kind === 'assistant') {
        // Completed native items and response rows can encode the same message.
        // Native IDs, not equal text, identify that pair; distinct messages with
        // identical words remain distinct, including asynchronous questions.
        if (mapped.kind === 'assistant' && !acceptCodexAssistantMessage(mapped, assistantIds)) continue;
        messages.push(mapped.message);
        continue;
      }
      // tool_call / boundary / skip: the ARCHIVE records conversation text
      // only (lossy by design) — the hook lane's parseCodexHookTranscript is
      // the consumer that keeps calls and boundary positions.
    }

    let sessions = 0;
    if (messages.length > 0) {
      sessions = 1;
      const sid = sessionId || basename(path, '.jsonl');
      yield {
        meta: {
          harness: 'codex',
          sessionId: sid,
          cwd,
          startedAt: startedAt || messages[0].timestamp || undefined,
          raw: rawMeta ?? { session_id: sid, source_path: path },
        },
        messages,
      };
    }
    // Verified settings on an unsent thread or an aborted turn contain no
    // conversation. Unknown records, malformed lines and previews remain drift.
    const idleThread = threadSettingsSeen && startedTurn === undefined && abortedTurn === undefined;
    const expectedEmpty = sessions === 0 && skippedLines === 0 && !truncated && rawMeta !== undefined &&
      emptyLifecycleOnly && (idleThread || startedTurn !== undefined && abortedTurn === startedTurn);
    return {
      bytesRead,
      skippedLines,
      truncated,
      sessions,
      expectedEmpty: expectedEmpty || undefined,
      zeroSessionsReason:
        sessions === 0 ? (expectedEmpty ? (idleThread ? 'native thread settings without a conversation turn' : 'native turn aborted before conversation text') :
          'no typed user events or assistant message items in rollout') : undefined,
    };
  },
};
