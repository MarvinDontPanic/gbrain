import { describe, expect, test } from 'bun:test';
import { safeLoad } from 'js-yaml';
import { parseConversation } from '../src/core/conversation-parser/parse.ts';
import { MESSAGE_CHAR_CAP, PART_TARGET_BYTES, redactSession, renderSessionParts } from '../src/core/transcripts/render.ts';
import type { ParsedSession } from '../src/core/transcripts/types.ts';

function render(text: string) {
  const session: ParsedSession = {
    meta: { harness: 'codex', sessionId: 'full-text-fixture', startedAt: '2026-01-01T10:00:00Z' },
    messages: [{ role: 'user', timestamp: '2026-01-01T10:00:00Z', text }],
  };
  return renderSessionParts(redactSession(session, { userPatternsPath: '/nonexistent' }));
}

function body(content: string) {
  return content.slice(content.indexOf('\n---\n', 4) + 5).trim();
}

describe('complete private conversation rendering', () => {
  test('a long message preserves text beyond the former clipping boundary', () => {
    const text = 'A'.repeat(MESSAGE_CHAR_CAP + 50) + 'THE_FINAL_DECISION';
    const result = render(text);
    const fragments = result.parts.flatMap(part => parseConversation(body(part.content)).messages);
    expect(fragments.map(message => message.text).join('')).toBe(text);
  });

  test('a single oversized message splits into searchable pages without losing its end', () => {
    const text = 'B'.repeat(PART_TARGET_BYTES * 2) + 'END_OF_COMPLETE_MESSAGE';
    const result = render(text);
    expect(result.parts.length).toBeGreaterThan(1);
    expect(result.parts.at(-1)!.content).toContain('END_OF_COMPLETE_MESSAGE');
    for (const part of result.parts) {
      expect(Buffer.byteLength(body(part.content))).toBeLessThanOrEqual(PART_TARGET_BYTES);
      expect(part.content.isWellFormed()).toBe(true);
    }
  });

  test('multibyte characters survive a fragment boundary', () => {
    const text = 'X'.repeat(MESSAGE_CHAR_CAP - 1) + '🚀' + 'Y'.repeat(50);
    const result = render(text);
    const fragments = result.parts.flatMap(part => parseConversation(body(part.content)).messages);
    expect(fragments.map(message => message.text).join('')).toBe(text);
    expect(result.parts.every(part => part.content.isWellFormed())).toBe(true);
  });

  test('fragment boundaries keep ordinary search terms intact', () => {
    const result = render('X'.repeat(MESSAGE_CHAR_CAP - 10) + ' recoverychannel ' + 'Y'.repeat(100));
    expect(result.parts.map(part => part.content).join('\n')).toContain('recoverychannel');
  });

  test('personal transcript pages default to private visibility', () => {
    const part = render('A harmless fixture decision.').parts[0];
    const end = part.content.indexOf('\n---\n', 4);
    expect((safeLoad(part.content.slice(4, end)) as Record<string, unknown>).visibility).toBe('private');
  });

  test('UTC clock labels are explicit in every part, not ambiguous local times', () => {
    const result = render('B'.repeat(PART_TARGET_BYTES * 2));
    for (const part of result.parts) {
      const end = part.content.indexOf('\n---\n', 4);
      expect((safeLoad(part.content.slice(4, end)) as Record<string, unknown>).timezone).toBe('UTC');
      expect(body(part.content)).toContain('timestamps below are UTC, shown at minute precision');
      expect(parseConversation(body(part.content)).messages[0].timestamp).toBe('2026-01-01T10:00:00Z');
    }
  });
});

test('offset-bearing source times retain the correct UTC day at midnight', () => {
  const original: ParsedSession = {
    meta: { harness: 'codex', sessionId: 'offset-midnight-example', startedAt: '2026-01-01T23:50:00-05:00' },
    messages: [{ role: 'user', timestamp: '2026-01-01T23:50:00-05:00', text: 'A dated recovery decision.' }],
  };
  const part = renderSessionParts(redactSession(original, { userPatternsPath: '/nonexistent' })).parts[0];
  expect(parseConversation(body(part.content)).messages[0].timestamp).toBe('2026-01-02T04:50:00Z');
});
