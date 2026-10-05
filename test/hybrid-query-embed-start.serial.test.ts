// Serial: module mocks, gateway and clock state are process-global.
import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import * as realEmbedding from '../src/core/embedding.ts';
import * as realCache from '../src/core/search/query-cache.ts';

let cacheEnabled = false;
let clockOffset = 0;
let clockBase = 0;
let lexicalElapsed = 0;
let failCacheEmbed = false;
let embedBudgets: number[] = [];
let signalBudgets = new WeakMap<AbortSignal, number>();
const nativeNow = Date.now;
const nativeTimeout = AbortSignal.timeout;
mock.module('../src/core/embedding.ts', () => ({
  ...realEmbedding,
  embedQuery: async (_text: string, opts: { abortSignal: AbortSignal }) => {
    embedBudgets.push(signalBudgets.get(opts.abortSignal)!);
    if (failCacheEmbed && embedBudgets.length === 1) {
      clockOffset += 6_000;
      throw new Error('Synthetic cache embedding failure');
    }
    // A cold but healthy reader needs more than the erroneously allocated 2s.
    await new Promise(resolve => setTimeout(resolve, 2_500));
    return new Float32Array(1536);
  },
}));
mock.module('../src/core/search/query-cache.ts', () => ({
  ...realCache,
  semanticResultCacheAvailable: () => cacheEnabled,
  SemanticQueryCache: class {
    isEnabled() { return true; }
    async lookup() { return { hit: false }; }
    async store() {}
  },
}));
const { hybridSearchCached } = await import('../src/core/search/hybrid.ts');
const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
const { configureGateway, resetGateway } = await import('../src/core/ai/gateway.ts');
let engine: InstanceType<typeof PGLiteEngine>;
let nowSpy: ReturnType<typeof spyOn>;
let timeoutSpy: ReturnType<typeof spyOn>;
let keywordSpy: ReturnType<typeof spyOn>;
let titleSpy: ReturnType<typeof spyOn>;
let vectorSpy: ReturnType<typeof spyOn>;

beforeAll(async () => {
  resetGateway();
  configureGateway({ embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'synthetic-key' } });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
beforeEach(() => {
  cacheEnabled = false; clockOffset = 0; lexicalElapsed = 0; failCacheEmbed = false;
  embedBudgets = []; signalBudgets = new WeakMap();
  clockBase = nativeNow();
  nowSpy = spyOn(Date, 'now').mockImplementation(() => clockBase + clockOffset);
  timeoutSpy = spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const signal = nativeTimeout(ms); signalBudgets.set(signal, ms); return signal;
  });
  keywordSpy = spyOn(engine, 'searchKeyword').mockImplementation(async () => {
    clockOffset += lexicalElapsed; return [];
  });
  titleSpy = spyOn(engine, 'searchTitles').mockResolvedValue([]);
  vectorSpy = spyOn(engine, 'searchVector').mockResolvedValue([]);
});
afterEach(() => {
  nowSpy.mockRestore(); timeoutSpy.mockRestore(); keywordSpy.mockRestore();
  titleSpy.mockRestore(); vectorSpy.mockRestore();
});
afterAll(async () => { resetGateway(); await engine.disconnect(); });

test('cache-disabled slow lexical work leaves the first embedding its unchanged six-second budget', async () => {
  lexicalElapsed = 8_000;
  await hybridSearchCached(engine, 'synthetic widget', { expandFn: async query => [query], relationalRetrieval: false });
  expect(embedBudgets).toEqual([6_000]);
  expect(vectorSpy).toHaveBeenCalledTimes(1);
});

test('an actual failed cache embedding keeps its elapsed budget shared with the inner embedding', async () => {
  cacheEnabled = true; failCacheEmbed = true;
  await hybridSearchCached(engine, 'synthetic widget', { expandFn: async query => [query], relationalRetrieval: false });
  expect(embedBudgets).toEqual([6_000, 2_000]);
  expect(vectorSpy).not.toHaveBeenCalled();
});
