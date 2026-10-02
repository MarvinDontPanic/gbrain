import { hnswEfSearchFor, HNSW_EF_SEARCH_DEFAULT } from '../vector-index.ts';
import { remainingVectorBudget } from './vector-pool.ts';

export async function withVectorSettings<T>(
  query: (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>,
  iterative: boolean,
  candidateLimit: number,
  maxScanTuples: number,
  run: () => Promise<T>,
  deadline?: number,
): Promise<T> {
  // Iterative scans can discover closer neighbors after the initial list.
  // Preserve pgvector's configured ef_search instead of sizing that list to
  // the SQL pool, which can end the scan before those discoveries occur.
  const settings: Record<string, string> = iterative ? {} : { 'hnsw.ef_search': String(hnswEfSearchFor(candidateLimit)) };
  const defaults: Record<string, string> = { 'hnsw.ef_search': String(HNSW_EF_SEARCH_DEFAULT), 'hnsw.iterative_scan': 'off', 'hnsw.max_scan_tuples': '20000' };
  if (iterative) {
    // Both engines re-sort weighted scores after per-page pooling. Relaxed
    // iteration retains late, closer candidates that strict order discards.
    settings['hnsw.iterative_scan'] = 'relaxed_order';
    settings['hnsw.max_scan_tuples'] = String(maxScanTuples);
  }
  if (deadline !== undefined) settings.statement_timeout = String(remainingVectorBudget(deadline));
  const names = Object.keys(settings);
  const previous = await query(`SELECT name, current_setting(name, true) AS value FROM unnest($1::text[]) AS settings(name)`, [names]);
  const setSql = `SELECT set_config(name, value, true) FROM unnest($1::text[], $2::text[]) AS settings(name, value)`;
  if (deadline !== undefined) settings.statement_timeout = String(remainingVectorBudget(deadline));
  await query(setSql, [names, names.map(name => settings[name])]);
  const result = await run();
  await query(setSql, [previous.map(row => row.name), previous.map(row => row.value ?? defaults[String(row.name)])]);
  return result;
}
