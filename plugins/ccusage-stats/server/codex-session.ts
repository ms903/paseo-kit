import { open, opendir } from "node:fs/promises";
import path from "node:path";
import type { SessionUsage } from "../shared/usage";
import { codexHomes, rolloutSource, usageFrom } from "./codex-prices";

const DAY_MS = 86_400_000;
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 512 * 1024;
const CACHE_SIZE = 32;
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

interface LogRecord {
  type?: string;
  timestamp?: string;
  payload?: {
    id?: string;
    forked_from_id?: string | null;
    type?: string;
    info?: { total_token_usage?: Record<string, unknown> };
    thread_token_usage?: Record<string, unknown>;
  };
}

function parse(line: string): LogRecord | undefined {
  try { return JSON.parse(line) ?? undefined; } catch { return undefined; }
}

function dayFolders(id: string, createdAt?: string) {
  const dates = new Set<string>();
  const threadTime = id[14] === "7" ? Number.parseInt(id.slice(0, 13).replace("-", ""), 16) : NaN;
  for (const time of [threadTime, Date.parse(createdAt ?? "")]) {
    if (!Number.isFinite(time)) continue;
    // The UUID time is UTC, while the rollout's directory follows the CLI clock.
    for (const delta of [0, -DAY_MS, DAY_MS]) {
      const date = new Date(time + delta);
      if (!Number.isFinite(date.valueOf())) continue;
      dates.add(date.toISOString().slice(0, 10).replace(/-/g, "/"));
    }
  }
  return dates;
}

async function findRollout(id: string, createdAt: string | undefined, indexedId: string | undefined) {
  const homes = codexHomes();
  if (indexedId && indexedId !== id) {
    const source = await rolloutSource(indexedId, homes);
    if (source?.file.endsWith(".jsonl")) return source.file;
  }
  const days = dayFolders(id, createdAt);
  for (const home of homes) {
    for (const day of days) {
      const directory = path.join(home, "sessions", day);
      const entries = await opendir(directory).catch(() => undefined);
      if (!entries) continue;
      for await (const entry of entries) {
        if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith("-" + id + ".jsonl")) {
          return path.join(directory, entry.name);
        }
      }
    }
  }
}

export function createCodexSessionReader() {
  const cache = new Map<string, { file: string; signature: string; usage: SessionUsage | undefined }>();

  return async (id: string, createdAt?: string, indexedId?: string): Promise<SessionUsage | undefined> => {
    if (!UUID.test(id)) return;
    const previous = cache.get(id);
    const handleOf = (file: string) => open(file, "r").catch(() => undefined);
    let file = previous?.file;
    let handle = file ? await handleOf(file) : undefined;
    if (!handle) {
      file = await findRollout(id, createdAt, indexedId);
      if (!file) return;
      handle = await handleOf(file);
    }
    if (!handle || !file) return;
    try {
      const { size, mtimeMs, ino } = await handle.stat();
      const signature = `${size}:${mtimeMs}:${ino}`;
      if (file === previous?.file && signature === previous.signature) return previous.usage;

      const head = Buffer.alloc(Math.min(size, HEAD_BYTES));
      const { bytesRead: headerBytes } = await handle.read(head, 0, head.length, 0);
      const first = head.toString("utf8", 0, headerBytes).split("\n", 1)[0];
      const meta = parse(first);
      // A fork can carry its parent's cumulative counters, so only use native totals for independent threads.
      if (meta?.type !== "session_meta" || meta.payload?.id !== id || meta.payload.forked_from_id) return;

      const tail = Buffer.alloc(Math.min(size, TAIL_BYTES));
      const offset = size - tail.length;
      const { bytesRead } = await handle.read(tail, 0, tail.length, offset);
      const lines = tail.toString("utf8", 0, bytesRead).split("\n");
      let usage: SessionUsage | undefined;
      for (let i = lines.length - 1; i >= (offset ? 1 : 0); i--) {
        const line = lines[i];
        if (!line.includes('"total_token_usage"') && !line.includes('"thread_token_usage"')) continue;
        const entry = parse(line);
        const counts = entry?.type === "event_msg" && entry.payload?.type === "token_count"
          ? entry.payload.info?.total_token_usage : entry?.type === "token_usage_record"
            ? entry.payload?.thread_token_usage : undefined;
        if (!counts || typeof counts !== "object") continue;
        const { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens } = usageFrom(counts);
        const totalTokens = inputTokens + outputTokens;
        if (!totalTokens) continue;
        const read = Math.min(cacheReadTokens, inputTokens);
        const write = Math.min(cacheCreationTokens, inputTokens - read);
        usage = {
          id, agent: "codex", models: [], recorded: true,
          lastActivity: typeof entry?.timestamp === "string" && Number.isFinite(Date.parse(entry.timestamp))
            ? entry.timestamp : null,
          usage: {
            inputTokens: inputTokens - read - write, outputTokens,
            cacheReadTokens: read, cacheCreationTokens: write, totalTokens, cost: null,
          },
        };
        break;
      }
      cache.delete(id);
      cache.set(id, { file, signature, usage });
      if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
      return usage;
    } finally {
      await handle.close();
    }
  };
}
