import { createAntigravityReport, mergeAntigravity } from "./antigravity";
import {
  EMPTY_USAGE,
  type AgentUsage,
  type ModelUsage,
  type SessionUsage,
  type Usage,
  type UsagePeriod,
  type UsageReport,
  type ReportResponse,
  type TodayPreview,
} from "../shared/usage";
import {
  runCcusage,
  type RawAgentRow,
  type RawModel,
  type RawReport,
  type RawRow,
} from "./ccusage";
import { createReportPricer } from "./codex-prices";
import { createPriceCatalog, type PriceCatalog } from "./price-catalog";
import { createUsageHistory } from "./usage-history";
import { rollupDays } from "./usage-rows";
import { createUsageStore } from "./usage-store";

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
  read(retry?: boolean): Promise<ReportResponse>;
  updatePrices(): Promise<ReportResponse>;
  sessions(): Promise<SessionUsage[]>;
  invalidate(): void;
  stop(): void;
}

export function createReportCache(scan = runCcusage, cacheDirectory?: string): ReportCache {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const lifetime = new AbortController();
  const { signal } = lifetime;
  const store = createUsageStore(timezone, cacheDirectory, signal);
  const priceCatalog = createPriceCatalog(signal);
  const applyPrices = createReportPricer(undefined, store);
  const readAntigravity = createAntigravityReport(store);
  const history = createUsageHistory(timezone, signal, scan, store);
  let snapshot: Snapshot | undefined;
  let preview: TodayPreview | undefined;
  let rendered: { history: string; antigravity: RawReport; catalog: PriceCatalog } | undefined;
  let startup: Promise<void> | undefined;
  let restored = false;
  let running = false;
  let nextRefreshAt = 0;
  let failures = 0;
  let refreshError: string | null = null;
  let lastReadAt = 0;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let priceUpdate: Promise<ReportResponse> | null = null;
  let pricesChanged = false;

  async function refresh(reprice: boolean) {
    const start = Date.now();
    const today = localToday(timezone);
    try {
      const prices = priceCatalog.read();
      let nativeToday: number | undefined;
      let agyToday: number | undefined;
      function publishToday() {
        if (!snapshot && nativeToday !== undefined && agyToday !== undefined && !signal.aborted) {
          preview = { status: "today", today, totalTokens: nativeToday + agyToday, refreshError: null };
        }
      }
      const scans = [
        history.readDays(today, (recent) => {
          const row = recent.find((day) => day.period === today);
          nativeToday = (row?.agents ?? (row ? [row] : []))
            .reduce((total, agent) => total + (/antigravity/i.test(agent.agent) ? 0 : agent.totalTokens), 0);
          publishToday();
        }, reprice),
        readAntigravity(timezone, signal, undefined, prices).then((data) => {
          agyToday = data.daily.find((day) => day.period === today)?.totalTokens ?? 0;
          publishToday();
          return data;
        }),
        prices,
      ] as const;
      let [daily, antigravity, catalog] = await Promise.all(scans).finally(() => Promise.allSettled(scans));
      const session = await history.readSessions(today, reprice);
      if (pricesChanged) {
        pricesChanged = false;
        catalog = await priceCatalog.read();
        antigravity = await readAntigravity(timezone, signal, undefined, catalog);
      }
      const unchanged = rendered?.history === history.revision && rendered.antigravity === antigravity
        && rendered.catalog === catalog && snapshot?.report.today === today;
      if (unchanged && snapshot) {
        snapshot.report = { ...snapshot.report, generatedAt: Date.now() };
      } else {
        const base: RawReport = { daily, weekly: [], monthly: [], session: session.rows };
        await applyPrices(base, timezone, catalog, signal);
        if (signal.aborted) throw new Error("Usage scan cancelled");
        base.weekly = rollupDays(base.daily, "weekly");
        base.monthly = rollupDays(base.daily, "monthly");
        const raw = mergeAntigravity(base, antigravity);
        const sessions = raw.session.map(sessionOf);
        if (session.error && !base.session.length && snapshot) {
          sessions.push(...snapshot.sessions.filter((row) => row.agent !== "antigravity"));
        }
        const report = buildReport(raw, timezone, today, Date.now(), sessions);
        report.sessionRefreshError = session.error;
        snapshot = { report, sessions };
        rendered = { history: history.revision, antigravity, catalog };
        await store.saveReport(report);
      }
      preview = undefined;
      failures = 0;
      refreshError = null;
      nextRefreshAt = today === localToday(timezone)
        ? Date.now() + Math.min(15 * FRESH_MS, Math.max(FRESH_MS, (Date.now() - start) * 2)) : 0;
    } catch (error) {
      if (!signal.aborted) {
        failures = Math.min(failures + 1, 5);
        const delay = Math.max(FRESH_MS * 2 ** (failures - 1), (Date.now() - start) * 2);
        nextRefreshAt = Date.now() + Math.min(15 * FRESH_MS, delay);
        refreshError = (error as Error).message;
        console.error(`[ccusage-stats] ${refreshError}`);
      }
    } finally {
      running = false;
      if (pricesChanged) {
        nextRefreshAt = 0;
        schedule();
      }
    }
  }

  function schedule() {
    if (!restored || running || signal.aborted || Date.now() < nextRefreshAt) return;
    running = true;
    const reprice = pricesChanged;
    pricesChanged = false;
    void refresh(reprice);
  }

  async function current() {
    lastReadAt = Date.now();
    // Give a local cache hit one short read on the first request. Log scans never hold the RPC.
    startup ??= new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 100);
      void store.readReport().then((report) => {
        if (report && !signal.aborted) snapshot = { report, sessions: report.recentSessions };
      }).finally(() => {
        clearTimeout(timer);
        restored = true;
        schedule();
        resolve();
      });
    });
    await startup;
    schedule();
  }

  async function read(retry = false): Promise<ReportResponse> {
    if (retry && refreshError) nextRefreshAt = 0;
    await current();
    if (snapshot) return { ...snapshot.report, refreshError, refreshing: running };
    if (preview) return { ...preview, refreshError };
    if (refreshError && !running) throw new Error(refreshError);
    return { status: "loading" };
  }

  return {
    read,
    updatePrices() {
      priceUpdate ??= (async () => {
        await priceCatalog.update();
        pricesChanged = true;
        nextRefreshAt = 0;
        return read();
      })().finally(() => { priceUpdate = null; });
      return priceUpdate;
    },
    async sessions() {
      await current();
      return snapshot?.sessions ?? [];
    },
    invalidate() {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        if (Date.now() - lastReadAt < ACTIVE_READER_MS) schedule();
      }, INVALIDATE_DEBOUNCE_MS);
    },
    stop() {
      if (debounce) clearTimeout(debounce);
      lifetime.abort();
    },
  };
}
