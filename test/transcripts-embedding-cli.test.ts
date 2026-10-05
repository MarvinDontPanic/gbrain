import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** Real command/engine/gateway in a child: no CLI verdict or provider globals leak. */
async function exercise(fail = false, initialEmbed = false) {
  const dir = mkdtempSync(join(tmpdir(), 'transcripts-embedding-cli-'));
  dirs.push(dir);
  const path = join(dir, 'rollout.jsonl');
  const unrelated = join(dir, 'unrelated.jsonl');
  for (const [file, id] of [[path, 'embedding-session'], [unrelated, 'unrelated-session']]) {
    writeFileSync(file, [
      { type: 'session_meta', payload: { id, session_id: id, timestamp: '2026-09-01T12:00:00Z' } },
      { type: 'event_msg', timestamp: '2026-09-01T12:00:01Z', payload: { type: 'user_message', message: 'Retain this native embedding decision.' } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
  }
  const runner = join(import.meta.dir, 'fixtures/transcripts/embedding-cli-runner.ts');
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, GBRAIN_HOME: dir, GBRAIN_SKIP_STARTUP_HOOKS: '1', NODE_ENV: 'test' };
  delete env.DATABASE_URL;
  delete env.GBRAIN_DATABASE_URL;
  delete env.GBRAIN_SOURCE;
  const child = Bun.spawn({ cmd: [process.execPath, '--no-env-file', runner, path, unrelated, fail ? 'fail' : 'success', initialEmbed ? 'embed' : 'defer'], env, stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill(9), 30_000);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const lastLine = stdout.trim().split('\n').at(-1)!;
    if (!lastLine) throw new Error(`Native command produced no result (exit ${exit}): ${stderr}`);
    return { result: JSON.parse(lastLine), stderr, exit };
  } finally { clearTimeout(timer); }
}

test('native embed opt-in fills hash-skipped pages without sweeping unrelated chunks', async () => {
  const { result: r, exit } = await exercise();
  expect(exit).toBe(0);
  expect(r.first.pages.imported).toBe(1);
  expect(r.first.embeddings).toBeNull();
  expect(r.second.pages.skipped).toBe(1);
  expect(r.before).toHaveLength(3);
  expect(r.after).toHaveLength(2);
  expect(r.after.some((row: { source_id: string; slug: string }) => row.source_id === 'default' && row.slug === r.first.slugsTouched[0])).toBe(false);
  expect(r.second.embeddings).toEqual({ embedded: 1, remainingChunks: 0, status: 'complete' });
  expect(r.third.embeddings).toEqual({ embedded: 0, remainingChunks: 0, status: 'complete' });
  expect(r.calls).toBe(r.callsAfterSecond);
  expect(r.calls).toBe(1);
  expect(r.facts).toEqual([{ count: 0 }]);
  expect(r.legacy).toEqual([{ count: 3 }]);
}, 40_000);

test('native initial embed opt-in closes vectors after the importer finishes', async () => {
  const { result: r, exit } = await exercise(false, true);
  expect(exit).toBe(0);
  expect(r.first.pages.imported).toBe(1);
  expect(r.first.embeddings).toEqual({ embedded: 1, remainingChunks: 0, status: 'complete' });
  expect(r.second.embeddings).toEqual({ embedded: 0, remainingChunks: 0, status: 'complete' });
  expect(r.calls).toBe(1);
}, 40_000);

test('native embedding failure freezes the checkpoint and reports an incomplete command', async () => {
  const { result: r, exit, stderr } = await exercise(true);
  expect(exit).toBe(1);
  expect(r.second.cleanScan).toBe(false);
  expect(r.second.embeddings).toEqual({ embedded: 0, remainingChunks: 1, status: 'incomplete' });
  expect(r.after).toEqual(r.before);
  expect(r.checkpointAfter).toEqual(r.checkpointBefore);
  expect(r.calls).toBeGreaterThan(0);
  expect(stderr).toContain('deliberate non-transient provider failure');
  expect(stderr).toContain('still lack active embeddings');
  expect(r.facts).toEqual([{ count: 0 }]);
}, 40_000);
