import { describe, expect, spyOn, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { KNOWN_CONFIG_KEYS, KNOWN_CONFIG_KEY_PREFIXES } from '../src/core/config.ts';
import { runConfig } from '../src/commands/config.ts';
import { journalLimitKey, readJournalLimits } from '../src/core/persistence/limits.ts';
import { DEFAULT_JOURNAL_LIMITS, type JournalLimits } from '../src/core/persistence/model.ts';

function fixture() {
  const rows = new Map<string, string>();
  const engine = {
    getConfig: async (key: string) => rows.get(key) ?? null,
    setConfig: async (key: string, value: string) => { rows.set(key, value); },
    executeRaw: async () => [...rows].map(([key, value]) => ({ key, value })),
  } as unknown as BrainEngine;
  return { engine, rows };
}
async function capture(engine: BrainEngine, args: string[]) {
  const errors: string[] = [];
  let exit: number | undefined;
  const logs = spyOn(console, 'log').mockImplementation(() => {});
  const stderr = spyOn(console, 'error').mockImplementation((...values) => { errors.push(values.join(' ')); });
  const exiting = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exit = code ?? 0;
    throw new Error('test-config-exit');
  }) as never);
  try { await runConfig(engine, args); }
  catch (error) { if ((error as Error).message !== 'test-config-exit') throw error; }
  finally { logs.mockRestore(); stderr.mockRestore(); exiting.mockRestore(); }
  return { errors, exit };
}
const knobs = Object.keys(DEFAULT_JOURNAL_LIMITS) as Array<keyof JournalLimits>;
describe('native persistence capacity configuration', () => {
  test('registers exactly the ten consumed keys without a permissive prefix', () => {
    expect(KNOWN_CONFIG_KEYS.filter(key => key.startsWith('persistence.limits.')).sort())
      .toEqual(knobs.map(journalLimitKey).sort());
    expect(KNOWN_CONFIG_KEY_PREFIXES.some(prefix => 'persistence.limits.unread'.startsWith(prefix))).toBe(false);
  });
  test.each(knobs)('ordinary config set %s reaches the native reader without force', async knob => {
    const { engine, rows } = fixture();
    const value = DEFAULT_JOURNAL_LIMITS[knob] + 1;
    const result = await capture(engine, ['set', journalLimitKey(knob), String(value)]);
    expect(result).toEqual({ errors: [], exit: undefined });
    expect(rows.size).toBe(1);
    expect(await readJournalLimits(engine)).toEqual({ ...DEFAULT_JOURNAL_LIMITS, [knob]: value });
  });
  test('unknown capacity spelling remains rejected before a write', async () => {
    const { engine, rows } = fixture();
    const result = await capture(engine, ['set', 'persistence.limits.principal_lifetime_id', '200000']);
    expect(result.exit).toBe(1);
    expect(result.errors.join('\n')).toContain('Unknown config key');
    expect(rows.size).toBe(0);
  });
  test('the native reader still rejects malformed configured limits', async () => {
    const { engine, rows } = fixture();
    for (const bad of ['-1', '1.5', '01', 'NaN', '9007199254740992']) {
      rows.set(journalLimitKey('principalLifetimeIds'), bad);
      await expect(readJournalLimits(engine)).rejects.toThrow('expected a nonnegative integer');
    }
  });
});
