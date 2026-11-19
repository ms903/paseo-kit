import { createHash } from "node:crypto";
import { runCcusage, type RawRow, type ScanKind } from "./ccusage";
import { joinSessions } from "./usage-rows";
import type { SavedHistory, UsageStore } from "./usage-store";

const MINUTE = 60_000;
const HISTORY_REFRESH_MS = 7 * 24 * 60 * MINUTE;
const MAX_RETRY_MS = 15 * MINUTE;

function previousDay(day: string): string {
  const date = new Date(day + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export function createUsageHistory(timezone: string, signal: AbortSignal, scan = runCcusage, store?: UsageStore) {
  const saved = new Map<ScanKind, SavedHistory | undefined>();
  const retryAt = { daily: 0, session: 0 };
  let sessions: RawRow[] = [];
  let sessionError: string | null = null;
  let nextSessionAt = 0;
  let sessionFailures = 0;
  let dailySignature: string | undefined;
  let sessionSignature: string | undefined;
  let verifySessionsAt = 0;
  let sessionRevision = 0;
  let lastDays: { today: string; recent: RawRow[] } | undefined;

  async function readWindow(kind: ScanKind, today: string, onRecent?: (rows: RawRow[]) => void) {
    if (!saved.has(kind)) saved.set(kind, await store?.readHistory(kind));
    const old = saved.get(kind);
    const now = Date.now();
    const usable = old && old.since <= today && old.checkedAt <= now ? old : undefined;
    const rebuild = !usable || (now >= usable.checkedAt + HISTORY_REFRESH_MS && now >= retryAt[kind]);
    // Both scans use the same boundary even if the clock crosses midnight between them.
    const since = rebuild ? previousDay(today) : usable.since;
    let recent = await scan(kind, timezone, signal, since);
    onRecent?.(recent);
    let base = usable;
    if (rebuild) {
      try {
        const scanned = await scan(kind, timezone, signal, undefined, previousDay(since));
        if (signal.aborted) throw new Error("Usage scan cancelled");
        const older = kind === "daily" ? scanned.filter((row) => row.period < since) : scanned;
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
    if (kind === "daily") {
      recent = recent.filter((row) => row.period >= base.since);
      lastDays = { today, recent };
      dailySignature = createHash("sha256").update(String(base.checkedAt)).update(JSON.stringify(recent)).digest("hex");
      return structuredClone(older.concat(recent));
    }
    return joinSessions(older, recent);
  }

  async function readSessions(today: string, reprice = false) {
    const start = Date.now();
    const sameUsage = dailySignature !== undefined && dailySignature === sessionSignature;
    const reuse = !sessionError && sameUsage && (reprice || start < verifySessionsAt);
    if (!reuse && start >= nextSessionAt) {
      try {
        sessions = await readWindow("session", today);
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
    };
  }

  return {
    async readDays(today: string, onRecent?: (rows: RawRow[]) => void, reprice = false) {
      const base = saved.get("daily");
      if (reprice && base && lastDays?.today === today) return structuredClone(base.older.concat(lastDays.recent));
      return readWindow("daily", today, onRecent);
    },
    readSessions,
    get revision() { return `${dailySignature}:${sessionRevision}:${sessionError}`; },
  };
}
