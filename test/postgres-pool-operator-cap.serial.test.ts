import { describe, expect, mock, test } from 'bun:test';
import postgres from '#postgres';
import { withEnv } from './helpers/with-env.ts';

// Keep postgres.js's real constructor/options normalization, but intercept all
// queries so PostgresEngine.connect() cannot open a socket. Module mocking is
// confined to this serial file's own process (see docs/TESTING.md).
const realPostgres = postgres;
let constructors = 0;
let probes = 0;
mock.module('#postgres', () => ({
  default: Object.assign((url: string, options: Parameters<typeof postgres>[1]) => {
    constructors++;
    const pool = realPostgres(url, options);
    return new Proxy(pool, {
      apply(_target, _thisArg, args) {
        expect(args[0]).toEqual(['SELECT 1']);
        probes++;
        return Promise.resolve([]);
      },
    });
  }, { BigInt: realPostgres.BigInt }),
}));

const { resolvePoolSize } = await import('../src/core/db.ts');
const { PostgresEngine } = await import('../src/core/postgres-engine.ts');

// name, env, default resolver, native fallback 5, pools requested at 5/1/20
const cases: Array<[string, string | undefined, number, number, number[]]> = [
  ['cap 2', '2', 2, 2, [2, 1, 2]],
  ['larger cap', '20', 20, 20, [5, 1, 20]],
  ['absent cap', undefined, 10, 5, [5, 1, 20]],
  ['empty cap', '', 10, 5, [5, 1, 20]],
  ['invalid cap', 'not-a-number', 10, 5, [5, 1, 20]],
  ['zero cap', '0', 10, 5, [5, 1, 20]],
  ['negative cap', '-1', 10, 5, [5, 1, 20]],
  ['non-finite cap', 'Infinity', 10, 5, [5, 1, 20]],
  ['fraction below one', '0.5', 10, 5, [5, 1, 20]],
  // Preserve the existing parseInt contract; this patch does not tighten it.
  ['fraction with positive integer prefix', '2.5', 2, 2, [2, 1, 2]],
  ['malformed suffix with positive integer prefix', '2junk', 2, 2, [2, 1, 2]],
  ['exponent notation integer prefix', '1e2', 1, 1, [1, 1, 1]],
];

describe('pool size resolver boundaries', () => {
  for (const [name, cap, defaultSize, fallbackSize] of cases) {
    test(name, async () => {
      await withEnv({ GBRAIN_POOL_SIZE: cap }, () => {
        expect(resolvePoolSize()).toBe(defaultSize);
        // Existing explicit overrides (including worker-budget callers) keep
        // their precedence; native callers need an env-aware fallback instead.
        expect(resolvePoolSize(5)).toBe(5);
        expect(resolvePoolSize(undefined, 5)).toBe(fallbackSize);
      });
    });
  }
});

describe('PostgresEngine constructor operator cap', () => {
  for (const requested of [5, 1, 20, undefined]) {
    for (const [name, cap, defaultSize, _fallbackSize, sizes] of cases) {
      test(`requested ${requested ?? 'unset'} / ${name}`, async () => {
        await withEnv({ GBRAIN_POOL_SIZE: cap, GBRAIN_DISABLE_DIRECT_POOL: '1' }, async () => {
          const engine = new PostgresEngine();
          const beforeConstructors = constructors;
          const beforeProbes = probes;
          try {
            await engine.connect({
              database_url: 'postgresql://user@127.0.0.1:5/never-connected',
              poolSize: requested,
            });
            const expected = requested === undefined ? defaultSize : sizes[[5, 1, 20].indexOf(requested)];
            expect(engine.sql.options.max).toBe(expected);
            expect(constructors - beforeConstructors).toBe(1);
            expect(probes - beforeProbes).toBe(1);
            expect(await engine.connectionManager!.getReadPool()).toBe(engine.sql);
          } finally {
            await engine.disconnect();
          }
        });
      });
    }
  }
});
