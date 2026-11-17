/** Node subprocess source: SQLite and protobuf decoding stay off the plugin event loop. */
export const ANTIGRAVITY_READER = String.raw`
import { DatabaseSync } from 'node:sqlite';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const { files, timezone, contextBounds } = JSON.parse(input);
const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
function field(buf, wanted) {
  if (!(buf instanceof Uint8Array)) return null;
  let i = 0;
  function varint() {
    let value = 0n;
    for (let n = 0; n < 10; n++) {
      if (i >= buf.length) throw Error('truncated');
      const byte = buf[i++];
      value |= BigInt(byte & 127) << BigInt(7 * n);
      if (!(byte & 128)) {
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('overflow');
        return Number(value);
      }
    }
    throw Error('varint');
  }
  try {
    while (i < buf.length) {
      const tag = varint(), number = Math.floor(tag / 8), wire = tag % 8;
      if (!number) return null;
      let value;
      if (wire === 0) value = varint();
      else if (wire === 2) {
        const length = varint();
        if (length > buf.length - i) return null;
        value = buf.subarray(i, i + length); i += length;
      } else if (wire === 1 || wire === 5) {
        i += wire === 1 ? 8 : 4;
        if (i > buf.length) return null;
      } else return null;
      if (number === wanted) return value ?? null;
    }
  } catch {}
  return null;
}
function count(buf, n) { const v = field(buf, n); return typeof v === 'number' ? v : 0; }
function text(buf, n) { const v = field(buf, n); return v instanceof Uint8Array ? new TextDecoder('utf-8', { fatal: true }).decode(v).trim() : ''; }
function timestamp(buf) { const v = count(buf, 1); return v > 0 && v < 4102444800 ? v : 0; }
const results = [];
for (const file of files) {
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000;');
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gen_metadata'").get()) {
      results.push({ file, buckets: [], lastActivity: 0 });
      continue;
    }
    const hasSteps = db.prepare("SELECT 1 FROM pragma_table_info('steps') WHERE name='metadata'").get();
    const step = hasSteps ? ', (SELECT CASE WHEN length(metadata)<=1048576 THEN metadata END FROM steps WHERE steps.idx=g.idx) AS step' : ', NULL AS step';
    const query = db.prepare('SELECT CASE WHEN length(g.data)<=1048576 THEN g.data END AS data' + step + ' FROM gen_metadata g WHERE g.data IS NOT NULL ORDER BY g.idx');
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
        const seconds = timestamp(field(field(event, 9), 4)) || timestamp(field(row.step, 1));
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
