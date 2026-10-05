import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexAdapter } from '../src/core/transcripts/codex.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const row = (type: string, payload: unknown) => ({ type, timestamp: '2026-09-29T19:10:35Z', payload });
const header = row('session_meta', { id: 'native-example', source: 'vscode' });
const start = (turn_id: string) => row('event_msg', { type: 'task_started', turn_id });
const modern = (turn_id: string, id: string, text: string) => row('event_msg', {
  type: 'item_completed', turn_id, item: { type: 'UserMessage', id, content: [{ type: 'text', text }] },
});
async function parse(rows: unknown[], opts: { maxBytes?: number; suffix?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-native-codex-')); dirs.push(dir);
  const path = join(dir, 'rollout-native.jsonl');
  writeFileSync(path, rows.map(r => JSON.stringify(r)).join('\n') + (opts.suffix ?? ''));
  const gen = codexAdapter.parse(path, { maxBytes: opts.maxBytes }); const sessions = [];
  let next = await gen.next();
  while (!next.done) { sessions.push(next.value); next = await gen.next(); }
  return { sessions, diag: next.value, path };
}

test('an unsent native thread with matching settings has no conversation to import', async () => {
  const settings = row('event_msg', { type: 'thread_settings_applied', thread_id: 'native-example', thread_settings: { model: 'example-model' } });
  const idle = await parse([header, settings]);
  expect(idle.sessions).toHaveLength(0);
  expect(idle.diag.expectedEmpty).toBe(true);
  expect(idle.diag.zeroSessionsReason).toBe('native thread settings without a conversation turn');
});

test.each([
  [header],
  [header, row('event_msg', { type: 'thread_settings_applied', thread_id: 'another-thread', thread_settings: {} })],
  [header, row('event_msg', { type: 'thread_settings_applied', thread_id: 'native-example' })],
  [header, row('event_msg', { type: 'thread_settings_applied', thread_id: 'native-example', thread_settings: null })],
  [header, row('event_msg', { type: 'thread_settings_applied', thread_id: 'native-example', thread_settings: [] })],
  [row('event_msg', { type: 'thread_settings_applied', thread_id: 'native-example', thread_settings: {} }), header],
  [header, row('event_msg', { type: 'thread_settings_applied', thread_id: 'native-example', thread_settings: {} }), row('event_msg', { type: 'future_user_turn', text: 'Unrecognized text.' })],
  [header, row('event_msg', { type: 'thread_settings_applied', thread_id: 'native-example', thread_settings: {} }), start('unfinished-turn')],
  [row('session_meta', {}), row('event_msg', { type: 'thread_settings_applied', thread_id: '', thread_settings: {} })],
  [row('session_meta', { id: '' }), row('event_msg', { type: 'thread_settings_applied', thread_id: '', thread_settings: {} })],
  [row('session_meta', { id: ' ' }), row('event_msg', { type: 'thread_settings_applied', thread_id: ' ', thread_settings: {} })],
  [header, row('event_msg', { type: 'thread_settings_applied', thread_id: 'native-example', thread_settings: {} }), row('session_meta', null)],
  [header, row('event_msg', { type: 'thread_settings_applied', thread_id: 'native-example', thread_settings: {} }), row('session_meta', {})],
])('incomplete or unknown native lifecycle remains drift (%#)', async (...rows) => {
  expect((await parse(rows)).diag.expectedEmpty).toBeUndefined();
});

test('a settings event never excludes a real typed conversation', async () => {
  const result = await parse([header,
    row('event_msg', { type: 'thread_settings_applied', thread_id: 'native-example', thread_settings: {} }),
    row('event_msg', { type: 'user_message', message: 'Preserve this real conversation.' }),
  ]);
  expect(result.sessions[0].messages.map(m => m.text)).toEqual(['Preserve this real conversation.']);
  expect(result.diag.expectedEmpty).toBeUndefined();
});

test('settings do not excuse malformed lines or a truncated preview', async () => {
  const settings = row('event_msg', { type: 'thread_settings_applied', thread_id: 'native-example', thread_settings: {} });
  const malformed = await parse([header, settings], { suffix: '\n{malformed' });
  expect(malformed.diag.skippedLines).toBe(1);
  expect(malformed.diag.expectedEmpty).toBeUndefined();
  const preview = await parse([header, settings], { maxBytes: 100 });
  expect(preview.diag.truncated).toBe(true);
  expect(preview.diag.expectedEmpty).toBeUndefined();
});

test('native completed UserMessage records archive text without injected context or tool traffic', async () => {
  const result = await parse([
    header, start('turn-one'),
    row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Injected instructions.' }] }),
    modern('turn-one', 'user-one', 'A native runner prompt, not attributed to a named person.'),
    row('event_msg', { type: 'item_completed', turn_id: 'turn-one', item: { type: 'CommandExecution', id: 'tool-one', command: 'secret-shaped tool traffic excluded' } }),
    row('event_msg', { type: 'task_complete', turn_id: 'turn-one', error: { codex_error_info: 'other' } }),
  ]);
  expect(result.sessions).toHaveLength(1);
  expect(result.sessions[0].messages.map(m => [m.role, m.text])).toEqual([
    ['user', 'A native runner prompt, not attributed to a named person.'],
  ]);
  expect(result.sessions[0].meta.raw?.source).toBe('vscode');
  expect(result.diag.skippedLines).toBe(0);
});

test('aborted native turn without conversation text is an explicit empty exclusion, unknown records remain drift', async () => {
  const injected = row('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Injected context only.' }] });
  const aborted = row('event_msg', { type: 'turn_aborted', turn_id: 'empty-turn' });
  const empty = await parse([header, start('empty-turn'), injected, aborted]);
  expect(empty.sessions).toHaveLength(0);
  expect(empty.diag.expectedEmpty).toBe(true);
  expect(empty.diag.zeroSessionsReason).toBe('native turn aborted before conversation text');
  const unknown = await parse([header, start('empty-turn'), injected, row('event_msg', { type: 'future_user_turn', text: 'Unknown source text.' }), aborted]);
  expect(unknown.diag.expectedEmpty).toBeUndefined();
  const differentTurn = await parse([header, start('other-turn'), injected, aborted]);
  expect(differentTurn.diag.expectedEmpty).toBeUndefined();
});

test('legacy and completed native user records from distinct turns preserve both messages', async () => {
  const result = await parse([header, start('legacy-turn'),
    row('event_msg', { type: 'user_message', message: 'Legacy typed turn.' }),
    start('modern-turn'), modern('modern-turn', 'modern-message', 'Completed native turn.'),
  ]);
  expect(result.sessions[0].messages.map(m => m.text)).toEqual(['Legacy typed turn.', 'Completed native turn.']);
});

test('an aborted turn is expected empty only after its matching native start', async () => {
  const result = await parse([header,
    row('event_msg', { type: 'turn_aborted', turn_id: 'reversed-turn' }),
    start('reversed-turn'),
  ]);
  expect(result.sessions).toHaveLength(0);
  expect(result.diag.expectedEmpty).toBeUndefined();
});

test('completed native turns preserve stable UTC timestamp normalization', async () => {
  const result = await parse([header,
    { ...modern('offset-turn', 'offset-user', 'Offset user turn.'), timestamp: '2026-09-29T15:10:35-04:00' },
    { ...row('event_msg', { type: 'item_completed', item: { type: 'AgentMessage', id: 'offset-assistant', content: [{ type: 'Text', text: 'Offset answer.' }] } }), timestamp: '2026-09-29T21:10:36+02:00' },
  ]);
  expect(result.sessions[0].messages.map(message => message.timestamp)).toEqual(['2026-09-29T19:10:35.000Z', '2026-09-29T19:10:36.000Z']);
});

const completedAssistant = (id: string, text: string) => row('event_msg', {
  type: 'item_completed', item: { type: 'AgentMessage', id, content: [{ type: 'Text', text }] },
});
const responseAssistant = (id: string, text: string) => row('response_item', {
  type: 'message', role: 'assistant', id, content: [{ type: 'output_text', text }],
});

test('native assistant items preserve async-only text and pair response copies by native identity', async () => {
  const result = await parse([header,
    completedAssistant('paired-one', 'A paired answer.'), responseAssistant('paired-one', 'A paired answer.'),
    responseAssistant('paired-two', 'A paired answer.'), completedAssistant('paired-two', 'A paired answer.'),
    completedAssistant('async-question', 'An asynchronous clarifying question.'),
  ]);
  expect(result.sessions[0].messages.map(m => m.text)).toEqual([
    'A paired answer.', 'A paired answer.', 'An asynchronous clarifying question.',
  ]);
});

test('contradictory native copies fail rather than silently choosing text', async () => {
  await expect(parse([header, completedAssistant('contradictory', 'First text.'),
    responseAssistant('contradictory', 'Changed text.')])).rejects.toThrow('conflicting native assistant message identity');
});
