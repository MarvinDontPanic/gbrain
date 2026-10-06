import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

/** Read the complete captured byte range, retaining at most one JSONL record. */
export function* streamJsonlLines(path: string, bytes = statSync(path).size): Generator<string> {
  const fd = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let position = 0;
  try {
    while (position < bytes) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, bytes - position), position);
      if (count === 0) throw new Error('transcript shortened during streamed read');
      position += count;
      pending += decoder.write(buffer.subarray(0, count));
      let start = 0;
      let end: number;
      while ((end = pending.indexOf('\n', start)) !== -1) {
        yield pending.slice(start, end);
        start = end + 1;
      }
      pending = pending.slice(start);
    }
    pending += decoder.end();
    if (pending) yield pending;
  } finally {
    closeSync(fd);
  }
}
