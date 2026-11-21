import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { UsageStore } from "./usage-store";
import type { RawModel, RawReport, RawRow } from "./ccusage";
import { addModelUsage, addTotals, emptyRow, weekOf } from "./usage-rows";
import { ANTIGRAVITY_READER } from "./antigravity-reader";
import {
  BUILTIN_CONTEXT_BOUNDS,
  generationCost,
  modelName,
} from "./antigravity-prices";
import { EMPTY_CATALOG, type PriceCatalog } from "./price-catalog";

const conversationSchema = z.object({
  lastActivity: z.number(),
  buckets: z.array(z.object({
    day: z.iso.date(), priceDay: z.iso.date(), contextSize: z.number(),
    modelId: z.string(), label: z.string(),
    inputTokens: z.number(), outputTokens: z.number(), cacheReadTokens: z.number(),
  })),
});
type Totals = z.infer<typeof conversationSchema>;
type Conversation = Totals & { file: string; error?: string };
const MAX_DATABASES = 5000;
const MAX_OPENED_SESSIONS = 32;

function geminiDirectory() {
  return process.env.GEMINI_DIR || path.join(os.homedir(), ".gemini");
}

export async function conversationFiles(
  root: string,
  sessionId?: string,
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
    if (sessionId) {
      // Check the known filename without enumerating the store's conversations.
      await inspect(path.join(dir, sessionId + ".db"), sessionId);
      continue;
    }
    const handle = await fs.opendir(dir).catch(() => null);
    if (!handle) continue;
    try {
      for (;;) {
        const entry = await handle.read();
        if (!entry) break;
        if (!entry.name.endsWith(".db") || !entry.isFile()) continue;
        await inspect(path.join(dir, entry.name), entry.name.slice(0, -3));
        if (found.size > MAX_DATABASES)
          throw new Error("Antigravity conversation limit exceeded");
      }
    } finally {
      await handle.close();
    }
  }
  return found;

  async function inspect(file: string, id: string) {
    const [stat, wal] = await Promise.all([
      fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      }),
      fs.stat(file + "-wal").catch(() => null),
    ]);
    if (!stat?.isFile()) return;
    const candidate = {
      file,
      signature: JSON.stringify([
        stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino,
        wal?.size, wal?.mtimeMs, wal?.ctimeMs, wal?.ino,
      ]),
      size: stat.size + (wal?.size ?? 0),
    };
    if (!found.has(id) || found.get(id)!.size < candidate.size) found.set(id, candidate);
  }
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

export function createAntigravityReport(store?: UsageStore, readBatch = readConversations) {
  const cached = new Map<string, { signature: string; totals: Totals }>();
  const opened = new Map<string, { signature: string; totals: Totals }>();
  const index = store?.fileIndex("antigravity", conversationSchema);
  let previous: { catalog: PriceCatalog; timezone: string; report: RawReport } | undefined;

  async function report(
    timezone: string, signal?: AbortSignal,
    root = geminiDirectory(),
    prices: PriceCatalog | Promise<PriceCatalog> = EMPTY_CATALOG,
  ): Promise<RawReport> {
    const files = await conversationFiles(root);
    const catalog = files.size ? await prices : EMPTY_CATALOG;
    const contextBounds = pricingBounds(catalog);
    const prefix = cachePrefix(timezone, contextBounds);
    const paths = new Map([...files.values()].map((entry) => [entry.file, prefix + entry.signature]));
    for (const file of cached.keys()) {
      if (!paths.has(file)) { cached.delete(file); previous = undefined; }
    }
    const changed: string[] = [];
    for (const [file, signature] of paths) {
      if (cached.get(file)?.signature === signature) continue;
      previous = undefined;
      const local = opened.get(file);
      const totals = local?.signature === signature ? local.totals : await index?.get(file, signature);
      if (local?.signature === signature) {
        opened.delete(file);
        await index?.set(file, signature, local.totals);
      }
      if (totals) cached.set(file, { signature, totals });
      else changed.push(file);
    }
    if (previous?.catalog === catalog && previous.timezone === timezone) return previous.report;
    try {
      for (let start = 0; start < changed.length; start += 32) {
        const batch = await readBatch(changed.slice(start, start + 32), timezone, signal, contextBounds);
        for (const { file, lastActivity, buckets, error } of batch) {
          if (error) {
            console.error(`[ccusage-stats] Could not read ${path.basename(file)}: ${error}`);
            continue;
          }
          const signature = paths.get(file)!;
          const totals = { lastActivity, buckets };
          cached.set(file, { signature, totals });
          await index?.set(file, signature, totals);
        }
      }
    } finally {
      if (!signal?.aborted) await index?.flush();
    }
    const report = summarize(files, cached, catalog);
    previous = { timezone, catalog, report };
    return report;
  }

  return Object.assign(report, {
    async readSession(
      id: string, timezone: string, signal: AbortSignal,
      root = geminiDirectory(), catalog = EMPTY_CATALOG,
    ) {
      if (!/^[a-z0-9_-]{1,128}$/i.test(id)) return;
      const entry = (await conversationFiles(root, id)).get(id);
      if (signal.aborted) throw new Error("Session usage read timed out");
      if (!entry) return;
      const bounds = pricingBounds(catalog);
      const signature = cachePrefix(timezone, bounds) + entry.signature;
      const local = opened.get(entry.file);
      const indexed = cached.get(entry.file);
      let totals = indexed?.signature === signature ? indexed.totals
        : local?.signature === signature ? local.totals : await index?.get(entry.file, signature);
      if (!totals) {
        const [result] = await readBatch([entry.file], timezone, signal, bounds);
        if (!result || result.error) throw new Error("Could not read the Antigravity session");
        totals = result;
        opened.delete(entry.file);
        opened.set(entry.file, { signature, totals });
        if (opened.size > MAX_OPENED_SESSIONS) opened.delete(opened.keys().next().value!);
      }
      return sessionRow(id, totals, catalog);
    },
  });
}

export const antigravityReport = createAntigravityReport();

function pricingBounds(catalog: PriceCatalog) {
  const bounds = new Set<number>(BUILTIN_CONTEXT_BOUNDS);
  for (const [name, price] of catalog) {
    if (/^(?:gemini-|claude-)/.test(name)) for (const tier of price.context) bounds.add(tier.above);
  }
  return [...bounds].sort((a, b) => a - b);
}

function cachePrefix(timezone: string, bounds: readonly number[]) {
  return timezone + ":" + bounds.join(",") + ":";
}

function sessionRow(
  id: string, conversation: Totals | undefined, catalog: PriceCatalog,
  byDay?: (day: string, model: RawModel) => void,
): RawRow | undefined {
  if (!conversation?.buckets.length) return;
  const total = emptyRow(id, "antigravity");
  total.metadata = { lastActivity: new Date(conversation.lastActivity).toISOString() };
  for (const bucket of conversation.buckets) {
    const name = modelName(bucket.modelId, bucket.label, catalog);
    const model: RawModel = {
      modelName: name,
      inputTokens: bucket.inputTokens,
      outputTokens: bucket.outputTokens,
      cacheCreationTokens: 0,
      cacheReadTokens: bucket.cacheReadTokens,
      cost: generationCost(name, bucket.inputTokens, bucket.outputTokens, bucket.cacheReadTokens,
        bucket.contextSize, bucket.priceDay, catalog),
    };
    addModelUsage(total, model);
    byDay?.(bucket.day, model);
  }
  return total;
}

function summarize(
  files: Awaited<ReturnType<typeof conversationFiles>>,
  cached: ReadonlyMap<string, { totals: Totals }>,
  catalog: PriceCatalog,
): RawReport {
  const periods = {
    daily: new Map<string, RawRow>(),
    weekly: new Map<string, RawRow>(),
    monthly: new Map<string, RawRow>(),
  };
  const session: RawRow[] = [];
  for (const [id, entry] of files) {
    const total = sessionRow(id, cached.get(entry.file)?.totals, catalog, (day, model) => {
      const keys = {
        daily: day,
        weekly: weekOf(day),
        monthly: day.slice(0, 7),
      };
      for (const kind of ["daily", "weekly", "monthly"] as const) {
        const key = keys[kind];
        const row = periods[kind].get(key) ?? emptyRow(key, "antigravity");
        addModelUsage(row, model);
        periods[kind].set(key, row);
      }
    });
    if (total) session.push(total);
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
      const clean = { ...emptyRow(row.period, "all"), agents };
      for (const agent of agents) addTotals(clean, agent);
      grouped.set(row.period, clean);
    }
    for (const row of extra[kind]) {
      const total = grouped.get(row.period) ?? {
        ...emptyRow(row.period, "all"),
        agents: [],
      };
      total.agents!.push(row);
      addTotals(total, row);
      grouped.set(row.period, total);
    }
    result[kind] = [...grouped.values()];
  }
  return result;
}
