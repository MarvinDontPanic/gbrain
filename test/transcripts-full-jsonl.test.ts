import { afterEach, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { codexAdapter } from '../src/core/transcripts/codex.ts';
import { claudeCodeAdapter } from '../src/core/transcripts/claude-code.ts';
import { parseClaudeSessionFile } from '../src/core/transcripts/claude-code-jsonl.ts';
import { streamJsonlLines } from '../src/core/transcripts/jsonl-lines.ts';
import type { FileDiagnostics, ParsedSession } from '../src/core/transcripts/types.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function file(): string {
  const root = mkdtempSync(join(tmpdir(), 'full-jsonl-'));
  roots.push(root);
  return join(root, 'session.jsonl');
}
function append(path: string, entry: unknown): void { appendFileSync(path, JSON.stringify(entry) + '\n'); }
async function drain(gen: AsyncGenerator<ParsedSession, FileDiagnostics>) {
  const sessions: ParsedSession[] = [];
  let next = await gen.next();
  while (!next.done) { sessions.push(next.value); next = await gen.next(); }
  return { sessions, diag: next.value };
}

test('streaming retains Unicode crossing a read boundary and the final unterminated record', () => {
  const path = file();
  const line = 'x'.repeat(64 * 1024 - 1) + '🦔';
  writeFileSync(path, line + '\nlast record');
  expect([...streamJsonlLines(path)]).toEqual([line, 'last record']);
});

test('streaming uses the captured byte range rather than subsequent appended records', () => {
  const path = file();
  writeFileSync(path, 'first\n');
  const lines = streamJsonlLines(path);
  expect(lines.next().value).toBe('first');
  appendFileSync(path, 'appended later\n');
  expect(lines.next().done).toBe(true);
});

test('streaming fails loudly if the captured source becomes shorter during its read', () => {
  const path = file();
  writeFileSync(path, 'first\n' + 'x'.repeat(64 * 1024));
  const lines = streamJsonlLines(path);
  expect(lines.next().value).toBe('first');
  truncateSync(path, 0);
  expect(() => lines.next()).toThrow('transcript shortened during streamed read');
});

test('default Codex import preserves a decision outside the old oversized head/tail window', async () => {
  const path = file();
  writeFileSync(path, '');
  append(path, { type: 'session_meta', payload: { id: 'child-session', session_id: 'root-session', timestamp: '2026-09-01T12:00:00Z' } });
  append(path, { type: 'event_msg', timestamp: '2026-09-01T12:00:01Z', payload: { type: 'user_message', message: 'oldest request' } });
  const padding = JSON.stringify({ type: 'token_count', padding: 'x'.repeat(1024 * 1024) }) + '\n';
  for (let i = 0; i < 3; i++) appendFileSync(path, padding);
  append(path, { type: 'event_msg', timestamp: '2026-09-01T12:00:02Z', payload: { type: 'user_message', message: 'middle decision 🦔' } });
  append(path, { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'injected system material' }] } });
  append(path, { type: 'session_meta', payload: { id: 'inherited-parent', timestamp: '2026-08-01T12:00:00Z' } });
  for (let i = 0; i < 51; i++) appendFileSync(path, padding);
  appendFileSync(path, JSON.stringify({ type: 'response_item', timestamp: '2026-09-01T12:00:03Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'newest answer' }] } }));
  const { sessions, diag } = await drain(codexAdapter.parse(path));
  expect(sessions[0]?.messages.map((m) => m.text)).toEqual(['oldest request', 'middle decision 🦔', 'newest answer']);
  expect(sessions[0]?.meta.sessionId).toBe('child-session');
  expect(diag).toMatchObject({ bytesRead: statSync(path).size, truncated: false, skippedLines: 0, sessions: 1 });
});

test('default Claude import streams oversized history with original identity and exclusions', async () => {
  const path = file();
  writeFileSync(path, '');
  append(path, { type: 'last-prompt', sessionId: 'claude-session', cwd: '/project' });
  const turn = (type: string, text: string, timestamp: string) => ({ type, sessionId: 'claude-session', timestamp, message: { role: type, content: text } });
  append(path, turn('user', 'oldest request', '2026-09-01T12:00:01Z'));
  const padding = JSON.stringify({ type: 'progress', padding: 'x'.repeat(1024 * 1024) }) + '\n';
  for (let i = 0; i < 27; i++) appendFileSync(path, padding);
  append(path, turn('assistant', 'middle decision 🦔', '2026-09-01T12:00:02Z'));
  append(path, { ...turn('user', 'sidechain must not leak', '2026-09-01T12:00:02Z'), isSidechain: true });
  append(path, { type: 'system', subtype: 'compact_boundary', message: { content: 'system must not leak' } });
  append(path, { type: 'attachment', attachment: { type: 'hook_additional_context', content: ['injected must not leak'] } });
  for (let i = 0; i < 27; i++) appendFileSync(path, padding);
  appendFileSync(path, JSON.stringify(turn('assistant', 'newest answer', '2026-09-01T12:00:03Z')));
  const direct = parseClaudeSessionFile(path);
  expect(direct.turns.map((m) => m.text)).toEqual(['oldest request', 'middle decision 🦔', 'newest answer']);
  const { sessions, diag } = await drain(claudeCodeAdapter.parse(path));
  expect(sessions[0]?.meta).toMatchObject({ sessionId: 'claude-session', cwd: '/project', startedAt: '2026-09-01T12:00:01Z' });
  expect(sessions[0]?.messages.map((m) => m.text)).toEqual(direct.turns.map((m) => m.text));
  expect(diag).toMatchObject({ bytesRead: statSync(path).size, truncated: false, skippedLines: 0, sessions: 1 });
});
