/** Node subprocess source: SQLite and protobuf decoding stay off the plugin event loop. */
export const ANTIGRAVITY_READER = String.raw`
import { DatabaseSync } from 'node:sqlite';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const { files, timezone, contextBounds } = JSON.parse(input);
const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
function varint(buf, cursor) {
  let value = 0n;
  for (let n = 0; n < 10; n++) {
    if (cursor.offset >= buf.length) throw Error('truncated');
    const byte = buf[cursor.offset++];
    value |= BigInt(byte & 127) << BigInt(7 * n);
    if (!(byte & 128)) {
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('overflow');
      return Number(value);
    }
  }
  throw Error('varint');
}
function* fields(buf, wanted) {
  if (!(buf instanceof Uint8Array)) return;
  const cursor = { offset: 0 };
  try {
    while (cursor.offset < buf.length) {
      const tag = varint(buf, cursor), number = Math.floor(tag / 8), wire = tag % 8;
      if (!number) return;
      let value;
      if (wire === 0) value = varint(buf, cursor);
      else if (wire === 2) {
        const length = varint(buf, cursor);
        if (length > buf.length - cursor.offset) return;
        if (number === wanted) value = buf.subarray(cursor.offset, cursor.offset + length);
        cursor.offset += length;
      } else if (wire === 1 || wire === 5) {
        cursor.offset += wire === 1 ? 8 : 4;
        if (cursor.offset > buf.length) return;
      } else return;
      if (number === wanted && value !== undefined) yield value;
    }
  } catch {}
}
function field(buf, wanted) { return fields(buf, wanted).next().value ?? null; }
function count(buf, n) { const v = field(buf, n); return typeof v === 'number' ? v : 0; }
function text(buf, n) { const v = field(buf, n); return v instanceof Uint8Array ? new TextDecoder('utf-8', { fatal: true }).decode(v).trim() : ''; }
function timestamp(buf) { const v = count(buf, 1); return v > 0 && v < 4102444800 ? v : 0; }
function* stepIndices(data) {
  for (const value of fields(data, 2)) {
    if (typeof value === 'number') yield value;
    else {
      const cursor = { offset: 0 };
      try {
        while (cursor.offset < value.length) yield varint(value, cursor);
      } catch {}
    }
  }
}
function stepTimestamp(metadata) { return timestamp(field(metadata, 8)) || timestamp(field(metadata, 1)); }
function generationTimestamp(data, idx, event, step) {
  const generatedAt = timestamp(field(field(event, 9), 4));
  if (generatedAt || !step) return generatedAt;
  // Newer generation records can link to steps with different indexes from gen_metadata.idx.
  for (const index of stepIndices(data)) {
    const seconds = stepTimestamp(step.get(index)?.metadata);
    if (seconds) return seconds;
  }
  return stepTimestamp(step.get(idx)?.metadata);
}
const results = [];
for (const file of files) {
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN DEFERRED;');
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gen_metadata'").get()) {
      results.push({ file, buckets: [], lastActivity: 0 });
      continue;
    }
    const hasSteps = db.prepare("SELECT 1 FROM pragma_table_info('steps') WHERE name='metadata'").get();
    const step = hasSteps ? db.prepare('SELECT CASE WHEN length(metadata)<=1048576 THEN metadata END AS metadata FROM steps WHERE idx=?') : null;
    const query = db.prepare('SELECT idx, CASE WHEN length(data)<=1048576 THEN data END AS data FROM gen_metadata WHERE data IS NOT NULL ORDER BY idx');
    const buckets = new Map();
    let lastActivity = 0;
    for (const row of query.iterate()) {
      try {
        const event = field(row.data, 1), usage = field(event, 4);
        if (!(usage instanceof Uint8Array)) continue;
        const modelId = text(event, 19), label = text(event, 21);
        const inputTokens = count(usage, 1) + count(usage, 2);
        const outputTokens = count(usage, 3), cacheReadTokens = count(usage, 5);
        if (!modelId && !label && !outputTokens && !cacheReadTokens && !count(usage, 2)) continue;
        if (!(inputTokens + outputTokens + cacheReadTokens)) continue;
        const seconds = generationTimestamp(row.data, row.idx, event, step);
        if (!seconds) continue;
        const day = formatter.format(new Date(seconds * 1000));
        const priceDay = new Date(seconds * 1000).toISOString().slice(0, 10);
        const prompt = inputTokens + cacheReadTokens;
        // One representative size for all requests in the same pricing bands.
        const boundary = contextBounds.findLast(value => prompt > value);
        const contextSize = boundary === undefined ? 0 : boundary + 1;
        const key = JSON.stringify([day, priceDay, modelId, label, contextSize]);
        const bucket = buckets.get(key) || { day, priceDay, modelId, label, contextSize, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
        bucket.inputTokens += inputTokens; bucket.outputTokens += outputTokens; bucket.cacheReadTokens += cacheReadTokens;
        buckets.set(key, bucket); lastActivity = Math.max(lastActivity, seconds * 1000);
      } catch {}
    }
    results.push({ file, buckets: [...buckets.values()], lastActivity });
  } catch (error) {
    results.push({ file, error: error.message });
  } finally { db?.close(); }
}
process.stdout.write(JSON.stringify(results));
`;
