import { createHash } from "node:crypto";
import { runCcusage, type RawRow, type ScanKind } from "./ccusage";
import { joinSessions } from "./usage-rows";
import type { SavedHistory, UsageStore } from "./usage-store";

export const REPORT_MONTHS = 12;
const MINUTE = 60_000;
const HISTORY_REFRESH_MS = 7 * 24 * 60 * MINUTE;
const MAX_RETRY_MS = 15 * MINUTE;

export type RefreshMode = "auto" | "manual" | "prices";

interface UsageWindow {
  since: string;
  recent: RawRow[];
  usable?: SavedHistory;
  rebuild: boolean;
}
export type RecentSessions = { window: UsageWindow; error?: never } | { window?: never; error: Error };
type OnRecentDays = (rows: RawRow[], since: string) => void | Promise<void>;

function previousDay(day: string): string {
  const date = new Date(day + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export function oldestReportDay(today: string): string {
  const date = new Date(today + "T00:00:00Z");
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - REPORT_MONTHS + 1, 1)).toISOString().slice(0, 10);
}

export function createUsageHistory(timezone: string, signal: AbortSignal, scan = runCcusage, store?: UsageStore) {
  const saved = new Map<ScanKind, SavedHistory | undefined>();
  const retryAt = { daily: 0, session: 0 };
  let sessions: RawRow[] = [];
  let pricingWindow: Pick<UsageWindow, "since" | "recent"> | undefined;
  let sessionError: string | null = null;
  let nextSessionAt = 0;
  let sessionFailures = 0;
  let dailyReads = 0;
  let dailySignature: string | undefined;
  let sessionSignature: string | undefined;
  let verifySessionsAt = 0;
  let sessionRevision = 0;
  let lastDays: { today: string; recent: RawRow[] } | undefined;

  async function openWindow(kind: ScanKind, today: string, mode: RefreshMode): Promise<UsageWindow> {
    if (!saved.has(kind)) saved.set(kind, await store?.readHistory(kind));
    const old = saved.get(kind);
    const now = Date.now();
    const usable = old && old.since <= today && old.checkedAt <= now ? old : undefined;
    const rebuild = !usable || (mode !== "manual" && now >= usable.checkedAt + HISTORY_REFRESH_MS && now >= retryAt[kind]);
    const since = rebuild ? previousDay(today) : usable.since;
    const recent = await scan(kind, timezone, signal, since);
    return { since, recent, usable, rebuild };
  }

  async function readWindow(kind: ScanKind, window: UsageWindow, today: string) {
    const from = kind === "daily" ? oldestReportDay(today) : undefined;
    const { since, usable, rebuild } = window;
    let { recent } = window;
    let base = usable;
    if (rebuild) {
      try {
        const scanned = await scan(kind, timezone, signal, from, previousDay(since));
        if (signal.aborted) throw new Error("Usage scan cancelled");
        const older = from ? scanned.filter((row) => row.period >= from && row.period < since) : scanned;
        base = { older, since, checkedAt: Date.now() };
        saved.set(kind, base);
        await store?.saveHistory(kind, base);
      } catch (error) {
        if (!usable || signal.aborted) throw error;
        retryAt[kind] = Date.now() + MAX_RETRY_MS;
        console.error(`[ccusage-stats] Could not reread older ${kind} usage: ${(error as Error).message}`);
        if (usable.since !== since) recent = await scan(kind, timezone, signal, usable.since);
      }
    }
    if (!base) throw new Error("Missing usage history");
    const { older } = base;
    if (from) {
      recent = recent.filter((row) => row.period >= base.since);
      dailySignature = createHash("sha256").update(String(base.checkedAt)).update(JSON.stringify(recent)).digest("hex");
      return older.filter((row) => row.period >= from).concat(recent);
    }
    return joinSessions(older, recent);
  }

  async function readSessions(today: string, mode: RefreshMode = "auto", prepared?: RecentSessions) {
    const start = Date.now();
    const sameUsage = dailySignature !== undefined && dailySignature === sessionSignature;
    const reuse = !sessionError && sameUsage && (mode === "prices" || start < verifySessionsAt);
    if (!reuse && (mode === "manual" || start >= nextSessionAt)) {
      try {
        if (prepared?.error) throw prepared.error;
        const window = prepared?.window ?? await openWindow("session", today, mode);
        pricingWindow = { since: window.since, recent: window.recent };
        sessions = await readWindow("session", window, today);
        pricingWindow = undefined;
        sessionRevision++;
        sessionError = null;
        sessionFailures = 0;
        sessionSignature = dailySignature;
        // A redistribution between sessions can leave daily usage unchanged.
        verifySessionsAt = Date.now() + 60 * MINUTE;
      } catch (error) {
        if (signal.aborted) throw error;
        sessionError = (error as Error).message;
        sessionFailures = Math.min(sessionFailures + 1, 5);
        console.error(`[ccusage-stats] Could not refresh sessions: ${sessionError}`);
      }
      const end = Date.now();
      const cooldown = Math.max(MINUTE * 2 ** Math.max(0, sessionFailures - 1), (end - start) * 3);
      nextSessionAt = end + Math.min(cooldown, MAX_RETRY_MS);
    }
    const rows = sessions;
    return {
      get rows() { return structuredClone(rows); },
      error: sessionError,
      ...(sessionError && !rows.length && pricingWindow ? { pricingWindow } : {}),
    };
  }

  return {
    async readDays(today: string, onRecent?: OnRecentDays, mode: RefreshMode = "auto") {
      const base = saved.get("daily");
      if (mode === "prices" && base && lastDays?.today === today) {
        await onRecent?.(lastDays.recent, base.since);
        const from = oldestReportDay(today);
        return structuredClone(base.older.filter((row) => row.period >= from).concat(lastDays.recent));
      }
      const window = await openWindow("daily", today, mode);
      await onRecent?.(window.recent, window.since);
      const days = await readWindow("daily", window, today);
      dailyReads++;
      const cutoff = saved.get("daily")!.since;
      lastDays = { today, recent: days.filter((row) => row.period >= cutoff) };
      return structuredClone(days);
    },
    async prepareSessions(today: string, mode: RefreshMode): Promise<RecentSessions> {
      try {
        return { window: await openWindow("session", today, mode) };
      } catch (error) {
        if (signal.aborted) throw error;
        return { error: error as Error };
      }
    },
    readSessions,
    get dailyReads() { return dailyReads; },
    get revision() { return `${dailySignature}:${sessionRevision}:${sessionError}`; },
  };
}
