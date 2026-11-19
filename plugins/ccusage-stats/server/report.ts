import { antigravityReport, mergeAntigravity } from "./antigravity";
import type { RpcOutput } from "@getpaseo/plugin";
import {
  EMPTY_USAGE,
  type AgentUsage,
  type ModelUsage,
  type SessionUsage,
  type Usage,
  type UsagePeriod,
  type usageReportRpc,
} from "../shared/usage";
import {
  runCcusage,
  type RawAgentRow,
  type RawModel,
  type RawReport,
  type RawRow,
} from "./ccusage";
import { createReportPricer } from "./codex-prices";
import { createPriceCatalog } from "./price-catalog";
import { createUsageHistory } from "./usage-history";
import { rollupDays } from "./usage-rows";

export type UsageReport = RpcOutput<typeof usageReportRpc>;

// Minimum interval between automatic report scans.
const FRESH_MS = 60_000;
// Coalesce bursts of finished turns into one refresh.
const INVALIDATE_DEBOUNCE_MS = 4_000;
// Only refresh eagerly after a turn when someone looked at the numbers recently.
const ACTIVE_READER_MS = 15 * 60_000;
const SERIES_LENGTH = { daily: 30, weekly: 12, monthly: 12 } as const;
const RECENT_SESSIONS = 12;
const DAY_MS = 86_400_000;

function usageOf(row: RawAgentRow | RawModel, total?: number, cost?: number): Usage {
  const sum = row.inputTokens + row.outputTokens + row.cacheCreationTokens + row.cacheReadTokens;
  return {
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheCreationTokens: row.cacheCreationTokens,
    cacheReadTokens: row.cacheReadTokens,
    totalTokens: total ?? sum,
    cost: cost ?? ("cost" in row ? row.cost : 0),
  };
}

function modelsOf(row: RawAgentRow): ModelUsage[] {
  return row.modelBreakdowns
    .map((model) => ({ model: model.modelName, usage: usageOf(model) }))
    .sort((a, b) => b.usage.totalTokens - a.usage.totalTokens);
}

function agentsOf(row: RawRow): AgentUsage[] {
  // Without per-agent rows (older ccusage), the row itself belongs to one agent.
  const rows = row.agents ?? [row];
  return rows
    .map((agent) => ({
      agent: agent.agent,
      usage: usageOf(agent, agent.totalTokens, agent.totalCost),
      models: modelsOf(agent),
    }))
    .filter((agent) => agent.usage.totalTokens > 0)
    .sort((a, b) => b.usage.totalTokens - a.usage.totalTokens);
}

function periodOf(row: RawRow): UsagePeriod {
  return {
    period: row.period,
    usage: usageOf(row, row.totalTokens, row.totalCost),
    agents: agentsOf(row),
  };
}

function sessionOf(row: RawRow): SessionUsage {
  return {
    id: row.period,
    agent: row.agent,
    usage: usageOf(row, row.totalTokens, row.totalCost),
    models: modelsOf(row),
    lastActivity: row.metadata?.lastActivity ?? null,
  };
}

// Calendar keys are handled as UTC midnights so arithmetic never crosses a DST change.
function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function keyMs(key: string): number {
  const [year = 1970, month = 1, day = 1] = key.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

export function localToday(timezone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** The last `length` period keys ending at the one containing `today`, oldest first. */
function periodKeys(kind: keyof typeof SERIES_LENGTH, today: string): string[] {
  const length = SERIES_LENGTH[kind];
  const todayMs = keyMs(today);
  const keys: string[] = [];
  if (kind === "monthly") {
    const date = new Date(todayMs);
    for (let back = length - 1; back >= 0; back -= 1) {
      const month = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - back, 1));
      keys.push(month.toISOString().slice(0, 7));
    }
    return keys;
  }
  // ccusage weeks start on Monday and are keyed by that date.
  const step = kind === "weekly" ? 7 * DAY_MS : DAY_MS;
  const end =
    kind === "weekly" ? todayMs - ((new Date(todayMs).getUTCDay() + 6) % 7) * DAY_MS : todayMs;
  for (let back = length - 1; back >= 0; back -= 1) keys.push(dayKey(end - back * step));
  return keys;
}

function series(kind: keyof typeof SERIES_LENGTH, rows: RawRow[], today: string): UsagePeriod[] {
  const byPeriod = new Map(rows.map((row) => [row.period, row]));
  return periodKeys(kind, today).map((key) => {
    const row = byPeriod.get(key);
    return row ? periodOf(row) : { period: key, usage: EMPTY_USAGE, agents: [] };
  });
}

function agentOrder(raw: RawReport): string[] {
  const totals = new Map<string, number>();
  for (const row of raw.monthly) {
    for (const agent of row.agents ?? [row]) {
      totals.set(agent.agent, (totals.get(agent.agent) ?? 0) + agent.totalTokens);
    }
  }
  return [...totals.entries()]
    .filter(([, total]) => total > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([agent]) => agent);
}

function buildReport(raw: RawReport, timezone: string, today: string, generatedAt: number, sessions: SessionUsage[]): UsageReport {
  return {
    generatedAt,
    today,
    timezone,
    agents: agentOrder(raw),
    daily: series("daily", raw.daily, today),
    weekly: series("weekly", raw.weekly, today),
    monthly: series("monthly", raw.monthly, today),
    recentSessions: [...sessions]
      .sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""))
      .slice(0, RECENT_SESSIONS),
    refreshError: null,
  };
}

interface Snapshot {
  report: UsageReport;
  sessions: SessionUsage[];
}

export interface ReportCache {
  read(): Promise<UsageReport>;
  updatePrices(): Promise<UsageReport>;
  /** Every session ccusage knows, for matching Paseo agents. */
  sessions(): Promise<SessionUsage[]>;
  /** Refreshes a due report after a turn if anyone is watching. */
  invalidate(): void;
  stop(): void;
}

export function createReportCache(scan = runCcusage): ReportCache {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const lifetime = new AbortController();
  const priceCatalog = createPriceCatalog(lifetime.signal);
  const applyPrices = createReportPricer();
  const history = createUsageHistory(timezone, lifetime.signal, scan);
  let snapshot: Snapshot | null = null;
  let nextRefreshAt = 0;
  let failures = 0;
  let refreshError: string | null = null;
  let inflight: Promise<Snapshot> | null = null;
  let lastReadAt = 0;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let priceUpdate: Promise<UsageReport> | null = null;

  const refresh = (): Promise<Snapshot> => {
    inflight ??= (async () => {
      const start = Date.now();
      try {
        const prices = priceCatalog.read();
        const scans = [
          history.readDays(localToday(timezone)),
          antigravityReport(timezone, lifetime.signal, undefined, prices),
          prices,
        ] as const;
        const [daily, antigravity, catalog] = await Promise.all(scans).finally(
          () => Promise.allSettled(scans),
        );
        const generatedAt = Date.now();
        const today = localToday(timezone);
        const session = await history.readSessions();
        const base: RawReport = { daily, weekly: [], monthly: [], session: session.rows };
        await applyPrices(base, timezone, catalog, lifetime.signal);
        base.weekly = rollupDays(base.daily, "weekly");
        base.monthly = rollupDays(base.daily, "monthly");
        const raw = mergeAntigravity(base, antigravity);
        const sessions = raw.session.map(sessionOf);
        const next = {
          report: { ...buildReport(raw, timezone, today, generatedAt, sessions), sessionRefreshError: session.error },
          sessions,
        };
        snapshot = next;
        nextRefreshAt = Date.now() + Math.min(15 * FRESH_MS, Math.max(FRESH_MS, (generatedAt - start) * 2));
        failures = 0;
        refreshError = null;
        return next;
      } catch (error) {
        failures = Math.min(failures + 1, 5);
        const delay = Math.max(FRESH_MS * 2 ** (failures - 1), (Date.now() - start) * 2);
        nextRefreshAt = Date.now() + Math.min(15 * FRESH_MS, delay);
        refreshError = (error as Error).message;
        if (!lifetime.signal.aborted) console.error(`[ccusage-stats] ${refreshError}`);
        throw error;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };

  const current = async (): Promise<Snapshot> => {
    lastReadAt = Date.now();
    if (!snapshot) {
      if (!inflight && refreshError && Date.now() < nextRefreshAt) throw new Error(refreshError);
      return refresh();
    }
    if (Date.now() >= nextRefreshAt) {
      refresh().catch(() => {
        // Logged in refresh; the stale snapshot below carries the error.
      });
    }
    return snapshot;
  };

  return {
    async read() {
      const { report } = await current();
      return { ...report, refreshError };
    },
    updatePrices() {
      priceUpdate ??= (async () => {
        await priceCatalog.update();
        // Let a report started with the previous prices finish before replacing it.
        await inflight?.catch(() => undefined);
        const { report } = await refresh().catch((error) => {
          if (!snapshot) throw error;
          return snapshot;
        });
        return { ...report, refreshError };
      })().finally(() => {
        priceUpdate = null;
      });
      return priceUpdate;
    },
    async sessions() {
      return (await current()).sessions;
    },
    invalidate() {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        if (Date.now() - lastReadAt < ACTIVE_READER_MS && Date.now() >= nextRefreshAt) refresh().catch(() => {});
      }, INVALIDATE_DEBOUNCE_MS);
    },
    stop() {
      if (debounce) clearTimeout(debounce);
      lifetime.abort();
    },
  };
}
