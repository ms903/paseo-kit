import { randomUUID } from "node:crypto";
import { createAntigravityReport, mergeAntigravity } from "./antigravity";
import {
  EMPTY_USAGE,
  type AgentUsage,
  type ModelUsage,
  type SessionUsage,
  type Usage,
  type UsagePeriod,
  type UsageReport,
  type UsageRead,
  type ReportResponse,
  type ScanProgress,
} from "../shared/usage";
import {
  runCcusage,
  type RawAgentRow,
  type RawModel,
  type RawReport,
  type RawRow,
} from "./ccusage";
import { createReportPricer, type ReportPrices } from "./codex-prices";
import { createPriceCatalog, type PriceCatalog } from "./price-catalog";
import { createUsageHistory, oldestReportDay, REPORT_MONTHS, type RecentSessions, type RefreshMode } from "./usage-history";
import { emptyRow, rollupDays } from "./usage-rows";
import { createUsageStore } from "./usage-store";

const AUTO_REFRESH_MS = 45 * 60_000;
const MAX_RETRY_DELAY_MS = 3 * 60 * 60_000;
const SERIES_LENGTH = { daily: 30, weekly: 12, monthly: REPORT_MONTHS } as const;
const RECENT_SESSIONS = 12;
const DAY_MS = 86_400_000;

function usageOf(row: RawAgentRow | RawModel, total?: number, cost?: number): Usage {
  const sum = row.inputTokens + row.outputTokens + row.cacheCreationTokens + row.cacheReadTokens;
  const pending = "modelName" in row ? row.costPending : row.modelBreakdowns.some((model) => model.costPending);
  return {
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheCreationTokens: row.cacheCreationTokens,
    cacheReadTokens: row.cacheReadTokens,
    totalTokens: total ?? sum,
    cost: pending ? null : cost ?? ("cost" in row ? row.cost : 0),
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
  const agents = agentsOf(row);
  const usage = usageOf(row, row.totalTokens, row.totalCost);
  if (agents.some((agent) => agent.usage.cost === null)) usage.cost = null;
  return { period: row.period, usage, agents };
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

function series(kind: keyof typeof SERIES_LENGTH, rows: RawRow[], today: string, from?: string): UsagePeriod[] {
  const byPeriod = new Map(rows.map((row) => [row.period, row]));
  const keys = periodKeys(kind, today).filter((key) => !from || (kind === "monthly" ? key + "-01" : key) >= from);
  return keys.map((key) => {
    const row = byPeriod.get(key);
    return row ? periodOf(row) : { period: key, usage: EMPTY_USAGE, agents: [] };
  });
}

function agentOrder(rows: RawRow[]): string[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    for (const agent of row.agents ?? [row]) {
      totals.set(agent.agent, (totals.get(agent.agent) ?? 0) + agent.totalTokens);
    }
  }
  return [...totals.entries()]
    .filter(([, total]) => total > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([agent]) => agent);
}

function buildReport(
  raw: RawReport, timezone: string, today: string, generatedAt: number, sessions: SessionUsage[],
  options: { from?: string; allDates: boolean },
): UsageReport {
  const { from, allDates } = options;
  const firstDay = from ?? oldestReportDay(today);
  const total = allDates ? rollupDays(raw.daily.filter((row) => row.period <= today), "total")[0] : undefined;
  return {
    generatedAt,
    today,
    timezone,
    agents: agentOrder(raw.daily.filter((row) => row.period >= firstDay)),
    daily: series("daily", raw.daily, today, from),
    weekly: series("weekly", raw.weekly, today, from),
    monthly: series("monthly", raw.monthly, today, from),
    total: allDates ? periodOf(total ?? emptyRow("total", "all")) : undefined,
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
  read(refresh?: boolean): Promise<ReportResponse>;
  read(refresh: boolean | undefined, knownRevision: string | undefined): Promise<UsageRead>;
  updatePrices(): Promise<ReportResponse>;
  sessions(): Promise<SessionUsage[]>;
  stop(): void;
}

export function createReportCache(scan = runCcusage, cacheDirectory?: string): ReportCache {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const lifetime = new AbortController();
  const { signal } = lifetime;
  const store = createUsageStore(timezone, cacheDirectory, signal);
  const priceCatalog = createPriceCatalog(signal);
  const preparePrices = createReportPricer(undefined, store);
  const readAntigravity = createAntigravityReport(store);
  const history = createUsageHistory(timezone, signal, scan, store, (kind, since, until) => {
    const window = { since, until };
    if (kind === "daily") startStage(until ? "dailyHistory" : "recentUsage", window);
    else startStage(until ? "sessionHistory" : "recentSessions", window);
  });
  let snapshot: Snapshot | undefined;
  const instance = randomUUID();
  let version = 0;
  let rendered: { history: string; antigravity: RawReport; catalog: PriceCatalog } | undefined;
  let startup: Promise<void> | undefined;
  let restored = false;
  let running = false;
  let nextRefreshAt = 0;
  let failures = 0;
  let refreshError: string | null = null;
  let priceUpdate: Promise<ReportResponse> | null = null;
  let pricesChanged = false;
  let manualRequested = false;
  let stage: { name: ScanProgress["stage"]; start: number; window?: ScanProgress["window"] } | undefined;
  const codexReads = new Set<string>();

  function startStage(name: ScanProgress["stage"], window?: ScanProgress["window"]) {
    if (stage?.name !== name) stage = { name, start: Date.now() };
    stage.window = window;
  }

  function trackCodexRead(id: string) {
    codexReads.add(id);
    return () => { codexReads.delete(id); };
  }

  async function publish(
    today: string, daily: RawRow[], lifetimeSessions: RawRow[], antigravity: RawReport, prices: ReportPrices,
    options: { from?: string; sessionsKnownFrom?: string; sessionError?: string | null; refreshed?: boolean } = {},
  ) {
    const sessionsPending = options.sessionsKnownFrom !== undefined;
    const base: RawReport = { daily, weekly: [], monthly: [], session: lifetimeSessions };
    prices(base, options.sessionsKnownFrom);
    if (signal.aborted) throw new Error("Usage scan cancelled");
    const oldestDay = oldestReportDay(today);
    const calendarDays = daily.filter((row) => row.period >= oldestDay);
    base.weekly = rollupDays(calendarDays, "weekly");
    base.monthly = rollupDays(calendarDays, "monthly");
    const raw = mergeAntigravity(base, antigravity);
    const sessions = raw.session.map(sessionOf);
    if ((sessionsPending || options.sessionError) && !base.session.length && snapshot) {
      sessions.push(...snapshot.sessions.filter((row) => row.agent !== "antigravity"));
    }
    const report = buildReport(raw, timezone, today, Date.now(), sessions, {
      from: options.from, allDates: !options.from && history.allDates,
    });
    if (options.from) report.historyPending = true;
    if (sessionsPending) report.sessionsPending = true;
    report.sessionRefreshError = options.sessionError ?? null;
    report.usageRefreshedAt = options.refreshed ? report.generatedAt : snapshot?.report.usageRefreshedAt;
    version++;
    snapshot = { report, sessions };
    await store.saveReport(report);
  }

  async function refresh(mode: RefreshMode) {
    const today = localToday(timezone);
    const previousReads = history.dailyReads;
    startStage(mode === "prices" ? "totals" : "recentUsage");
    try {
      const prices = priceCatalog.read();
      const inputs = Promise.all([readAntigravity(timezone, signal, undefined, prices), prices]);
      const needsCalendar = !snapshot || !!snapshot.report.historyPending;
      const needsSessions = needsCalendar || (!!snapshot?.report.sessionsPending && (!rendered || mode === "manual"));
      const tomorrow = dayKey(keyMs(today) + DAY_MS);
      // A bounded session row can identify a pricing source, but only a joined lifetime row belongs in the session list.
      let recentSessions: RecentSessions | undefined;
      let recentPrices: ReportPrices | undefined;
      const days = history.readDays(today, needsSessions ? async (recent, since) => {
        const [antigravity, catalog] = await inputs;
        startStage("recentSessions");
        if (!snapshot) {
          const prices = await preparePrices([], timezone, catalog, signal, ["daily"]);
          await publish(today, structuredClone(recent), [], antigravity, prices, { from: since, sessionsKnownFrom: tomorrow });
        }
        recentSessions = await history.prepareSessions(today, mode);
        const window = recentSessions.window;
        recentPrices = await preparePrices(window?.recent ?? [], timezone, catalog, signal, ["daily"], trackCodexRead);
        if (needsCalendar) {
          await publish(today, structuredClone(recent), [], antigravity, recentPrices, {
            from: since, sessionsKnownFrom: window?.since ?? tomorrow, sessionError: recentSessions.error?.message,
          });
        }
      } : undefined, mode);
      const reads = [days, inputs] as const;
      const [daily, pricing] = await Promise.all(reads).finally(() => Promise.allSettled(reads));
      let [antigravity, catalog] = pricing;
      if (recentPrices) {
        const window = recentSessions?.window;
        await publish(today, structuredClone(daily), [], antigravity, recentPrices, {
          sessionsKnownFrom: window?.since ?? tomorrow, sessionError: recentSessions?.error?.message,
        });
      }
      const session = await history.readSessions(today, mode, recentSessions);
      if (pricesChanged) {
        pricesChanged = false;
        catalog = await priceCatalog.read();
        antigravity = await readAntigravity(timezone, signal, undefined, catalog);
      }
      const refreshed = history.dailyReads !== previousReads && !session.error;
      const unchanged = rendered?.history === history.revision && rendered.antigravity === antigravity
        && rendered.catalog === catalog && snapshot?.report.today === today;
      if (unchanged && snapshot && !session.error) {
        const generatedAt = Date.now();
        const usageRefreshedAt = refreshed ? generatedAt : snapshot.report.usageRefreshedAt;
        snapshot.report = { ...snapshot.report, generatedAt, usageRefreshedAt };
        await store.saveRefreshTime(usageRefreshedAt);
      } else {
        startStage("totals");
        const rows = session.rows;
        const incomplete = !!session.error && !rows.length;
        const source = incomplete ? session.pricingWindow?.recent ?? [] : rows;
        const prices = await preparePrices(source, timezone, catalog, signal, ["daily", "session"], trackCodexRead);
        await publish(today, daily, rows, antigravity, prices, {
          sessionError: session.error, refreshed,
          sessionsKnownFrom: incomplete ? session.pricingWindow?.since ?? tomorrow : undefined,
        });
        rendered = { history: history.revision, antigravity, catalog };
      }
      if (history.dailyReads !== previousReads) {
        refreshError = null;
        failures = 0;
        nextRefreshAt = Date.now() + AUTO_REFRESH_MS;
      }
    } catch (error) {
      if (!signal.aborted) {
        failures = Math.min(failures + 1, 5);
        const delay = Math.min(MAX_RETRY_DELAY_MS, AUTO_REFRESH_MS * 2 ** (failures - 1));
        nextRefreshAt = Date.now() + delay;
        refreshError = (error as Error).message;
        console.error(`[ccusage-stats] ${refreshError}`);
      }
    } finally {
      stage = undefined;
      running = false;
      if (pricesChanged) schedule();
    }
  }

  function schedule() {
    if (!restored || running || signal.aborted) return;
    const mode = manualRequested ? "manual" : pricesChanged ? "prices" : "auto";
    if (mode === "auto") {
      const now = Date.now();
      if (now < nextRefreshAt) return;
      const report = snapshot?.report;
      const lastChecked = report?.usageRefreshedAt;
      // Reuse a fresh, complete report even after the daemon restarts.
      if (report?.total && !report.sessionsPending && !report.sessionRefreshError &&
        lastChecked !== undefined && lastChecked <= now && now - lastChecked < AUTO_REFRESH_MS) return;
    }
    running = true;
    manualRequested = false;
    pricesChanged = false;
    void refresh(mode);
  }

  async function current() {
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

  function read(force?: boolean): Promise<ReportResponse>;
  function read(force: boolean | undefined, knownRevision: string | undefined): Promise<UsageRead>;
  async function read(force = false, knownRevision?: string): Promise<UsageRead> {
    if (force && !running) manualRequested = true;
    await current();
    const progress = stage && {
      stage: stage.name, elapsedSeconds: Math.max(0, Math.floor((Date.now() - stage.start) / 1000)),
      ...(stage.window ? { window: stage.window } : {}),
      ...(codexReads.size ? { codexSessions: [...codexReads] } : {}),
    };
    if (snapshot) {
      const revision = `${instance}:${version}`;
      const status = { revision, generatedAt: snapshot.report.generatedAt, usageRefreshedAt: snapshot.report.usageRefreshedAt, refreshing: running, refreshError, progress };
      return knownRevision === revision ? { status: "unchanged", ...status } : { ...snapshot.report, ...status };
    }
    if (refreshError && !running) throw new Error(refreshError);
    return { status: "loading", progress };
  }

  return {
    read,
    updatePrices() {
      priceUpdate ??= (async () => {
        await priceCatalog.update();
        pricesChanged = true;
        return read();
      })().finally(() => { priceUpdate = null; });
      return priceUpdate;
    },
    async sessions() {
      await current();
      return snapshot?.sessions ?? [];
    },
    stop() { lifetime.abort(); },
  };
}
