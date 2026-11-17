import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RawAgentRow, RawModel, RawReport, RawRow } from "./ccusage";
import { ANTIGRAVITY_READER } from "./antigravity-reader";
import {
  BUILTIN_CONTEXT_BOUNDS,
  generationCost,
  modelName,
} from "./antigravity-prices";
import { EMPTY_CATALOG, type PriceCatalog } from "./price-catalog";

interface Bucket {
  day: string;
  priceDay: string;
  contextSize: number;
  modelId: string;
  label: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}
interface Conversation {
  file: string;
  buckets: Bucket[];
  lastActivity: number;
  error?: string;
}
const cached = new Map<
  string,
  { signature: string; conversation: Conversation }
>();
const MAX_DATABASES = 5000;

export async function conversationFiles(
  root: string,
): Promise<Map<string, { file: string; signature: string; size: number }>> {
  const found = new Map<
    string,
    { file: string; signature: string; size: number }
  >();
  const stores = await fs
    .readdir(root, { withFileTypes: true })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
  for (const store of stores) {
    if (
      !store.isDirectory() ||
      !/^antigravity(?:$|-)/.test(store.name) ||
      /backup|browser|scratch/i.test(store.name)
    )
      continue;
    const dir = path.join(root, store.name, "conversations");
    const handle = await fs.opendir(dir).catch(() => null);
    if (!handle) continue;
    try {
      for (;;) {
        const entry = await handle.read();
        if (!entry) break;
        if (!entry.name.endsWith(".db") || !entry.isFile()) continue;
        const file = path.join(dir, entry.name);
        const [stat, wal] = await Promise.all([
          fs.stat(file),
          fs.stat(`${file}-wal`).catch(() => null),
        ]);
        const id = entry.name.slice(0, -3);
        const candidate = {
          file,
          signature: JSON.stringify([
            stat.size,
            stat.mtimeMs,
            wal?.size,
            wal?.mtimeMs,
          ]),
          size: stat.size + (wal?.size ?? 0),
        };
        if (!found.has(id) || found.get(id)!.size < candidate.size)
          found.set(id, candidate);
        if (found.size > MAX_DATABASES)
          throw new Error("Antigravity conversation limit exceeded");
      }
    } finally {
      await handle.close();
    }
  }
  return found;
}

export function readConversations(
  files: string[],
  timezone: string,
  signal?: AbortSignal,
  contextBounds: readonly number[] = BUILTIN_CONTEXT_BOUNDS,
): Promise<Conversation[]> {
  if (files.length === 0) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      ["--input-type=module", "-e", ANTIGRAVITY_READER],
      {
        signal,
        timeout: 60_000,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error)
          return reject(
            new Error(`Antigravity usage read failed: ${error.message}`),
          );
        try {
          resolve(JSON.parse(stdout));
        } catch (error) {
          reject(error);
        }
      },
    );
    child.stdin!.end(JSON.stringify({ files, timezone, contextBounds }));
  });
}

function empty(period: string): RawRow {
  return {
    period,
    agent: "antigravity",
    totalTokens: 0,
    totalCost: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    modelBreakdowns: [],
  };
}
function append(row: RawAgentRow, model: RawModel): void {
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cacheCreationTokens",
    "cacheReadTokens",
  ] as const)
    row[key] += model[key];
  row.totalTokens +=
    model.inputTokens + model.outputTokens + model.cacheReadTokens;
  row.totalCost += model.cost;
  const existing = row.modelBreakdowns.find(
    (entry) => entry.modelName === model.modelName,
  );
  if (!existing) row.modelBreakdowns.push({ ...model });
  else
    for (const key of [
      "inputTokens",
      "outputTokens",
      "cacheCreationTokens",
      "cacheReadTokens",
      "cost",
    ] as const)
      existing[key] += model[key];
}

export async function antigravityReport(
  timezone: string,
  signal?: AbortSignal,
  root = process.env.GEMINI_DIR || path.join(os.homedir(), ".gemini"),
  prices: PriceCatalog | Promise<PriceCatalog> = EMPTY_CATALOG,
): Promise<RawReport> {
  const files = await conversationFiles(root);
  const catalog = files.size ? await prices : EMPTY_CATALOG;
  const bounds = new Set<number>(BUILTIN_CONTEXT_BOUNDS);
  for (const [name, price] of catalog) {
    if (/^(?:gemini-|claude-)/.test(name))
      for (const tier of price.context) bounds.add(tier.above);
  }
  const contextBounds = [...bounds].sort((a, b) => a - b);
  for (const entry of files.values())
    entry.signature = `${timezone}:${contextBounds.join(",")}:${entry.signature}`;
  const live = new Set([...files.values()].map((entry) => entry.file));
  for (const file of cached.keys()) if (!live.has(file)) cached.delete(file);
  const changed = [...files.values()].filter(
    (entry) => cached.get(entry.file)?.signature !== entry.signature,
  );
  const refreshed = await readConversations(
    changed.map((entry) => entry.file),
    timezone,
    signal,
    contextBounds,
  );
  for (const conversation of refreshed) {
    if (conversation.error) {
      console.error(
        `Antigravity database read failed (${path.basename(conversation.file)}): ${conversation.error}`,
      );
      continue;
    }
    const signature = changed.find(
      (entry) => entry.file === conversation.file,
    )!.signature;
    cached.set(conversation.file, { signature, conversation });
  }
  const periods = {
    daily: new Map<string, RawRow>(),
    weekly: new Map<string, RawRow>(),
    monthly: new Map<string, RawRow>(),
  };
  const session: RawRow[] = [];
  for (const [id, entry] of files) {
    const conversation = cached.get(entry.file)?.conversation;
    if (!conversation?.buckets.length) continue;
    const total = empty(id);
    total.metadata = {
      lastActivity: new Date(conversation.lastActivity).toISOString(),
    };
    for (const bucket of conversation.buckets) {
      const name = modelName(bucket.modelId, bucket.label, catalog);
      const model = {
        modelName: name,
        inputTokens: bucket.inputTokens,
        outputTokens: bucket.outputTokens,
        cacheCreationTokens: 0,
        cacheReadTokens: bucket.cacheReadTokens,
        cost: generationCost(
          name,
          bucket.inputTokens,
          bucket.outputTokens,
          bucket.cacheReadTokens,
          bucket.contextSize,
          bucket.priceDay,
          catalog,
        ),
      };
      append(total, model);
      const date = new Date(`${bucket.day}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
      const keys = {
        daily: bucket.day,
        weekly: date.toISOString().slice(0, 10),
        monthly: bucket.day.slice(0, 7),
      };
      for (const kind of ["daily", "weekly", "monthly"] as const) {
        const key = keys[kind];
        const row = periods[kind].get(key) ?? empty(key);
        append(row, model);
        periods[kind].set(key, row);
      }
    }
    session.push(total);
  }
  return {
    daily: [...periods.daily.values()],
    weekly: [...periods.weekly.values()],
    monthly: [...periods.monthly.values()],
    session,
  };
}

/** Replace upstream Antigravity rows, then merge periods without duplicate agent/session totals. */
export function mergeAntigravity(base: RawReport, extra: RawReport): RawReport {
  const result: RawReport = {
    daily: [],
    weekly: [],
    monthly: [],
    session: base.session
      .filter((row) => !/antigravity/i.test(row.agent))
      .concat(extra.session),
  };
  for (const kind of ["daily", "weekly", "monthly"] as const) {
    const grouped = new Map<string, RawRow>();
    for (const row of base[kind]) {
      const agents = (row.agents ?? [row]).filter(
        (agent) => !/antigravity/i.test(agent.agent),
      );
      const clean = { ...empty(row.period), agent: "all", agents: [...agents] };
      for (const agent of agents) {
        for (const key of [
          "totalTokens",
          "totalCost",
          "inputTokens",
          "outputTokens",
          "cacheCreationTokens",
          "cacheReadTokens",
        ] as const)
          clean[key] += agent[key];
      }
      grouped.set(row.period, clean);
    }
    for (const row of extra[kind]) {
      const total = grouped.get(row.period) ?? {
        ...empty(row.period),
        agent: "all",
        agents: [],
      };
      total.agents!.push(row);
      for (const key of [
        "totalTokens",
        "totalCost",
        "inputTokens",
        "outputTokens",
        "cacheCreationTokens",
        "cacheReadTokens",
      ] as const)
        total[key] += row[key];
      grouped.set(row.period, total);
    }
    result[kind] = [...grouped.values()];
  }
  return result;
}
