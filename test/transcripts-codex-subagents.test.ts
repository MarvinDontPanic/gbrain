import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverTranscriptFiles } from '../src/core/transcripts/discover.ts';
import { codexAdapter } from '../src/core/transcripts/codex.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('native Codex discovery excludes flat subagent metadata, not ordinary or unknown origins', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-codex-origins-'));
  dirs.push(root);
  const origins: Record<string, unknown> = {
    child: { subagent: { thread_spawn: { parent_thread_id: 'parent-example', depth: 1 } } },
    exec: 'exec', vscode: 'vscode', cli: 'cli', unknown: { future_origin: {} },
  };
  for (const [id, source] of Object.entries(origins)) {
    writeFileSync(join(root, `rollout-${id}.jsonl`), [
      { type: 'session_meta', payload: { id, source, timestamp: '2026-01-01T00:00:00Z' } },
      { type: 'event_msg', timestamp: '2026-01-01T00:01:00Z', payload: { type: 'user_message', message: 'A retained conversation turn.' } },
    ].map(row => JSON.stringify(row)).join('\n'));
  }
  expect(discoverTranscriptFiles([{ format: 'codex', root, extension: '.jsonl' }]).map(f => f.path.split('/').pop()).sort())
    .toEqual(['rollout-cli.jsonl', 'rollout-exec.jsonl', 'rollout-unknown.jsonl', 'rollout-vscode.jsonl']);
  // Explicit user-selected files retain the native adapter contract.
  const child = codexAdapter.parse(join(root, 'rollout-child.jsonl'));
  const first = await child.next();
  expect(first.done).toBe(false);
  if (!first.done) expect(first.value.meta.sessionId).toBe('child');
  await child.return(undefined as never);
});
