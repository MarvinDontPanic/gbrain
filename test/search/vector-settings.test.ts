import { describe, expect, test } from 'bun:test';
import { withVectorSettings } from '../../src/core/search/vector-settings.ts';

function session() {
  const values = new Map([
    ['hnsw.ef_search', '40'], ['hnsw.iterative_scan', 'off'],
    ['hnsw.max_scan_tuples', '20000'], ['statement_timeout', '20s'],
  ]);
  const query = async (sql: string, params: unknown[]) => {
    const names = params[0] as string[];
    if (sql.includes('current_setting')) return names.map(name => ({ name, value: values.get(name) }));
    const settings = params[1] as string[];
    for (let i = 0; i < names.length; i++) values.set(names[i], settings[i]);
    return [];
  };
  return { values, query };
}

describe('native vector scan settings', () => {
  test('iterative discovery is independent of SQL pool size and respects the configured initial list', async () => {
    for (const ef of ['40', '75']) for (const pool of [100, 250, 1100]) {
      const { values, query } = session();
      values.set('hnsw.ef_search', ef);
      const before = new Map(values);
      const result = await withVectorSettings(query, true, pool, 2000, async () => {
        expect(values.get('hnsw.ef_search')).toBe(ef);
        expect(values.get('hnsw.iterative_scan')).toBe('relaxed_order');
        expect(values.get('hnsw.max_scan_tuples')).toBe('2000');
        return 'complete';
      });
      expect(result).toBe('complete');
      expect(values).toEqual(before);
    }
  });

  test('extensions without iteration keep sufficient initial candidates and avoid unsupported settings', async () => {
    const { values, query } = session();
    const before = new Map(values);
    await withVectorSettings(query, false, 250, 2000, async () => {
      expect(values.get('hnsw.ef_search')).toBe('250');
      expect(values.get('hnsw.iterative_scan')).toBe('off');
      expect(values.get('hnsw.max_scan_tuples')).toBe('20000');
    });
    expect(values).toEqual(before);
  });

  test('a rejected settings statement never runs the search', async () => {
    const { query } = session();
    const rejected = new Error('synthetic settings failure');
    let searches = 0;
    await expect(withVectorSettings(async (sql, params) => {
      if (sql.includes('set_config')) throw rejected;
      return query(sql, params);
    }, true, 250, 2000, async () => { searches++; })).rejects.toBe(rejected);
    expect(searches).toBe(0);
  });
});
