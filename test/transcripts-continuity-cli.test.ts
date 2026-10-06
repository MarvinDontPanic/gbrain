import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseIngestArgs, ingestCheckpointFingerprintInput, runTranscripts } from '../src/commands/transcripts.ts';
import { fingerprint } from '../src/core/op-checkpoint.ts';
import { buildHermesFixture } from './fixtures/transcripts/hermes-fixture-builder.ts';
import type { TranscriptsIngestResult } from '../src/core/transcripts/ingest.ts';

const dirs: string[] = [];
test('all nested transcript help is engine-free, including status', async () => {
  const output: string[] = [];
  const logging = spyOn(console, 'log').mockImplementation(value => { output.push(String(value)); });
  try {
    for (const sub of ['status', 'ingest', 'recent']) {
      for (const flag of ['--help', '-h']) await runTranscripts(null as never, [sub, flag]);
    }
  } finally { logging.mockRestore(); }
  expect(output).toHaveLength(6);
  expect(output.every(value => value.startsWith('Usage:'))).toBe(true);
});
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'transcripts-cli-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** Isolate the CLI-owned process verdict and configuration from other tests. */
async function runRaw(args: string[], home: string) {
  const modulePath = join(import.meta.dir, '../src/commands/transcripts.ts');
  const script = `
    import { runTranscripts } from ${JSON.stringify(modulePath)};
    const engine = { executeRaw: async () => [{ id: 'default' }], getConfig: async () => null };
    await runTranscripts(engine, ${JSON.stringify(['ingest', ...args, '--source-id', 'default', '--json', '--quiet'])});
  `;
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, GBRAIN_HOME: home, GBRAIN_SKIP_STARTUP_HOOKS: '1', NODE_ENV: 'test' };
  delete env.DATABASE_URL;
  delete env.GBRAIN_DATABASE_URL;
  delete env.GBRAIN_REMOTE_CLIENT_SECRET;
  delete env.GBRAIN_SOURCE;
  const child = Bun.spawn({ cmd: [process.execPath, '--no-env-file', '-e', script], env, stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill(9), 10_000);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, exit, stderr };
  } finally { clearTimeout(timer); }
}

async function run(args: string[], home: string) {
  const { stdout, ...outcome } = await runRaw(args, home);
  return { ...outcome, result: JSON.parse(stdout) as TranscriptsIngestResult };
}

test('repeated session-source options select native origins independently of the brain source', () => {
  expect(parseIngestArgs(['state.db', '--session-source', 'slack', '--session-source', 'cli', '--source-id', 'archive']))
    .toMatchObject({ paths: ['state.db'], sessionSources: ['slack', 'cli'], source: 'archive' });
  expect(parseIngestArgs(['--session-source'])).toHaveProperty('error');
  expect(parseIngestArgs(['--session-source', '--all'])).toHaveProperty('error');
  expect(parseIngestArgs(['--session-source', '  '])).toHaveProperty('error');
  expect(parseIngestArgs(['--all'])).not.toHaveProperty('sessionSources');
});

test('explicit native source selection has a sorted checkpoint scope while omission preserves the old fingerprint', () => {
  const base = { sourceId: 'archive', pathspec: '/sessions/state.db', format: 'hermes', version: 4 };
  expect(ingestCheckpointFingerprintInput(base)).toEqual(base);
  const selected = ingestCheckpointFingerprintInput({ ...base, sessionSources: ['slack', 'cli', 'slack'] });
  expect(selected).toEqual({ ...base, sessionSources: ['cli', 'slack'] });
  expect(fingerprint(selected)).not.toBe(fingerprint(ingestCheckpointFingerprintInput(base)));
  expect(fingerprint(selected)).toBe(fingerprint(ingestCheckpointFingerprintInput({ ...base, sessionSources: ['cli', 'slack'] })));
  expect(fingerprint(selected)).not.toBe(fingerprint(ingestCheckpointFingerprintInput({ ...base, sessionSources: ['cli'] })));
});

test('the real command threads native origin selection to the Hermes adapter', async () => {
  const dir = scratch();
  const path = buildHermesFixture(dir);
  const { result, exit } = await run([path, '--dry-run', '--session-source', 'cli'], dir);
  expect(result.files[0].sessions.map(s => s.sessionId)).toEqual(['hermes-fixture-1']);
  expect(result.driftFiles).toBe(0);
  expect(exit).toBe(0);
});

test('a partial file failure makes the native command fail even when another session succeeds', async () => {
  const dir = scratch();
  const path = buildHermesFixture(dir);
  const { result, exit } = await run([path, join(dir, 'missing.db'), '--dry-run'], dir);
  expect(result.sessionsImported).toBe(2);
  expect(result.erroredFiles).toBe(1);
  expect(exit).toBe(1);
});

test('a session-limited preview reports incomplete coverage instead of a successful dry-run', async () => {
  const dir = scratch();
  const path = buildHermesFixture(dir);
  const { result, exit } = await run([path, '--dry-run', '--limit', '1'], dir);
  expect(result.sessionsImported).toBe(1);
  expect(result.sessionsSeen).toBe(2);
  expect(exit).toBe(1);
});

function codex(path: string, malformed = false): void {
  writeFileSync(path, [
    JSON.stringify({ type: 'session_meta', payload: { id: 'native-session', timestamp: '2026-09-01T12:00:00Z' } }),
    ...(malformed ? ['{broken record'] : []),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-09-01T12:00:01Z', payload: { type: 'user_message', message: 'Retain this decision.' } }),
  ].join('\n') + '\n');
}

test('a malformed record fails a preview even though its intact conversation was planned', async () => {
  const dir = scratch();
  const path = join(dir, 'rollout.jsonl');
  codex(path, true);
  const { result, exit } = await run([path, '--format', 'codex', '--dry-run'], dir);
  expect(result.pages.planned).toBe(1);
  expect(result.files[0].skippedLines).toBe(1);
  expect(exit).toBe(1);
});

test('an explicit bounded preview reports truncation and a failing verdict', async () => {
  const dir = scratch();
  const path = join(dir, 'rollout.jsonl');
  codex(path);
  const { result, exit } = await run([path, '--format', 'codex', '--dry-run', '--max-bytes', '150'], dir);
  expect(result.truncatedFiles).toBe(1);
  expect(exit).toBe(1);
});

test('partial native schema drift cannot hide behind a successful file', async () => {
  const dir = scratch();
  const healthy = buildHermesFixture(dir);
  const drifted = join(dir, 'drift.jsonl');
  writeFileSync(drifted, JSON.stringify({ type: 'session_meta', payload: { id: 'no-text' } }) + '\n');
  const { result, exit } = await run([healthy, drifted, '--dry-run'], dir);
  expect(result.sessionsImported).toBe(2);
  expect(result.driftFiles).toBe(1);
  expect(exit).toBe(1);
});

test('an explicitly empty origin selection is understood, not parser drift', async () => {
  const dir = scratch();
  const path = buildHermesFixture(dir);
  const { result, exit } = await run([path, '--dry-run', '--session-source', 'slack'], dir);
  expect(result.sessionsSeen).toBe(0);
  expect(result.driftFiles).toBe(0);
  expect(exit).toBe(0);
});

test('a requested directory with zero importable files fails instead of silently succeeding', async () => {
  const dir = scratch();
  writeFileSync(join(dir, 'README.txt'), 'Not a conversation.');
  const { stderr, exit } = await runRaw([dir, '--dry-run'], dir);
  expect(stderr).toContain('0 files matched');
  expect(exit).toBe(1);
});

test('managed failed-write retry is an explicit native CLI option', () => {
  expect(parseIngestArgs(['ingest-fixture.jsonl', '--retry-failed'])).toMatchObject({ retryFailed: true });
  expect(parseIngestArgs(['ingest-fixture.jsonl'])).not.toHaveProperty('retryFailed');
});
