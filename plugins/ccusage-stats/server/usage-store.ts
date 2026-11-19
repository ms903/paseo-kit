import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gzip, gunzip } from "node:zlib";
import { z } from "zod";
import { usageReportSchema, type UsageReport } from "../shared/usage";
import { paseoHome, reportRows, type ScanKind } from "./ccusage";

const MIB = 1024 * 1024;
const compress = promisify(gzip);
const expand = promisify(gunzip);
const REPORT_LIMIT = MIB;
const HISTORY_LIMIT = 4 * MIB;
const INDEX_LIMIT = MIB / 4;
const SHARDS = 8;
const SOURCE_PATHS = [
  "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
  "AMP_DATA_DIR", "CLAUDE_CONFIG_DIR", "CLINE_DATA_DIR", "CODEBUFF_DATA_DIR", "CODEX_HOME",
  "COPILOT_HOME", "COPILOT_OTEL_FILE_EXPORTER_PATH", "DROID_SESSIONS_DIR", "GEMINI_DATA_DIR",
  "GEMINI_DIR", "GROK_HOME", "HERMES_HOME", "KILO_DATA_DIR", "KIMI_DATA_DIR", "OPENCLAW_DIR",
  "OPENCODE_DATA_DIR", "PI_AGENT_DIR", "QWEN_DATA_DIR", "ZCODE_HOME", "CCUSAGE_PRICING_JSON_PATH",
];
const historySchema = z.object({
  since: z.iso.date(),
  checkedAt: z.number().nonnegative(),
  older: reportRows,
});
export type SavedHistory = z.infer<typeof historySchema>;

export function createUsageStore(timezone: string, directory = path.join(paseoHome(), "cache", "ccusage-stats"), signal?: AbortSignal) {
  const sources = SOURCE_PATHS.map((name) => process.env[name]);
  const scope = createHash("sha256").update(JSON.stringify([1, os.hostname(), timezone, sources])).digest("hex");
  let lastContent = "";
  let prepared: Promise<void> | undefined;

  async function prepare() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const name of await readdir(directory)) {
      if (!/\.json\.gz\.[a-f0-9-]{36}\.tmp$/.test(name)) continue;
      const file = path.join(directory, name);
      const info = await stat(file).catch(() => null);
      if (info && Date.now() - info.mtimeMs > 86_400_000) await rm(file, { force: true });
    }
  }

  async function read<T>(name: string, limit: number, schema: z.ZodType<T>): Promise<T | undefined> {
    try {
      const file = await open(path.join(directory, name), "r");
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > limit) return;
        const body = await expand(await file.readFile(), { maxOutputLength: limit * 8 });
        const envelope = JSON.parse(body.toString("utf8"));
        if (envelope.scope === scope) return schema.parse(envelope.value);
      } finally {
        await file.close();
      }
    } catch {
      // A missing or incompatible cache is rebuilt from the usage sources.
    }
  }

  async function write(name: string, value: unknown, limit: number): Promise<boolean> {
    const body = JSON.stringify({ scope, value });
    if (Buffer.byteLength(body) > limit * 8) return false;
    const target = path.join(directory, name);
    const temporary = target + "." + randomUUID() + ".tmp";
    try {
      const compressed = await compress(body, { level: 1 });
      if (compressed.length > limit) return false;
      prepared ??= prepare().catch((error) => {
        prepared = undefined;
        throw error;
      });
      await prepared;
      if (signal?.aborted) return false;
      await writeFile(temporary, compressed, { mode: 0o600, flag: "wx" });
      if (signal?.aborted) return false;
      await rename(temporary, target);
      return true;
    } catch (error) {
      console.error(`[ccusage-stats] Could not save ${name}: ${(error as Error).message}`);
      return false;
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  function contentOf(report: UsageReport): string {
    const { today, timezone, agents, daily, weekly, monthly, recentSessions, sessionRefreshError } = report;
    const values = [today, timezone, agents, daily, weekly, monthly, recentSessions, sessionRefreshError, report.historyPending, report.sessionsPending];
    return createHash("sha256").update(JSON.stringify(values)).digest("hex");
  }

  return {
    fileIndex<T>(source: "antigravity" | "codex", schema: z.ZodType<T>) {
      type Item = [id: string, signature: string, value: T];
      const items = z.array(z.tuple([z.string(), z.string(), schema]));
      type Shard = { entries: Map<string, { item: Item; bytes: number }>; bytes: number };
      const shards = new Map<number, Promise<Shard>>();
      const dirty = new Set<number>();
      const filename = (slot: number) => `${source}-${slot}.json.gz`;

      function put(shard: Shard, item: Item) {
        const bytes = Buffer.byteLength(JSON.stringify(item)) + 1;
        const previous = shard.entries.get(item[0]);
        if (previous) {
          shard.bytes -= previous.bytes;
          shard.entries.delete(item[0]);
        }
        if (bytes > MIB) return;
        shard.entries.set(item[0], { item, bytes });
        shard.bytes += bytes;
        while (shard.bytes > MIB) {
          const [oldId, old] = shard.entries.entries().next().value!;
          shard.entries.delete(oldId);
          shard.bytes -= old.bytes;
        }
      }
      async function locate(file: string) {
        const id = createHash("sha256").update(file).digest("hex");
        const slot = parseInt(id.slice(0, 2), 16) % SHARDS;
        let loading = shards.get(slot);
        if (!loading) {
          loading = read(filename(slot), INDEX_LIMIT, items).then((saved) => {
            const shard: Shard = { entries: new Map(), bytes: 0 };
            for (const item of saved ?? []) put(shard, item);
            return shard;
          });
          shards.set(slot, loading);
        }
        return { shard: await loading, id, slot };
      }
      return {
        async get(file: string, signature: string) {
          const { shard, id } = await locate(file);
          const entry = shard.entries.get(id);
          if (entry?.item[1] === signature) return entry.item[2];
        },
        async set(file: string, signature: string, value: T) {
          const { shard, id, slot } = await locate(file);
          put(shard, [id, signature, value]);
          dirty.add(slot);
        },
        async flush() {
          for (const slot of dirty) {
            dirty.delete(slot);
            const shard = await shards.get(slot)!;
            await write(filename(slot), Array.from(shard.entries.values(), ({ item }) => item), INDEX_LIMIT);
          }
        },
      };
    },
    async readReport() {
      const report = await read("report.json.gz", REPORT_LIMIT, usageReportSchema);
      if (!report || report.timezone !== timezone || !report.daily.length) return;
      if (!report.historyPending && (!report.weekly.length || !report.monthly.length)) return;
      lastContent = contentOf(report);
      return report;
    },
    async saveReport(report: UsageReport) {
      const content = contentOf(report);
      if (content !== lastContent && await write("report.json.gz", report, REPORT_LIMIT)) lastContent = content;
    },
    readHistory(kind: ScanKind) {
      return read(`history-${kind}.json.gz`, HISTORY_LIMIT, historySchema);
    },
    saveHistory(kind: ScanKind, history: SavedHistory) {
      return write(`history-${kind}.json.gz`, history, HISTORY_LIMIT);
    },
  };
}

export type UsageStore = ReturnType<typeof createUsageStore>;
