import { runCcusage, type RawRow } from "./ccusage";

const MINUTE = 60_000;
const HISTORY_REFRESH_MS = 6 * 60 * MINUTE;
const MAX_RETRY_MS = 15 * MINUTE;

export function createUsageHistory(timezone: string, signal: AbortSignal, scan = runCcusage) {
  let history: { since: string; older: RawRow[]; refreshAt: number } | undefined;
  let sessions: RawRow[] = [];
  let sessionError: string | null = null;
  let nextSessionAt = 0;
  let sessionFailures = 0;

  async function readDays(today: string): Promise<RawRow[]> {
    if (!history || Date.now() >= history.refreshAt || today < history.since) {
      try {
        const days = await scan("daily", timezone, signal);
        const yesterday = new Date(`${today}T00:00:00Z`);
        yesterday.setUTCDate(yesterday.getUTCDate() - 1);
        const since = yesterday.toISOString().slice(0, 10);
        // Pricing mutates the report rows. Keep the original ccusage costs for future catalogs.
        history = {
          older: structuredClone(days.filter((row) => row.period < since)),
          since,
          refreshAt: Date.now() + HISTORY_REFRESH_MS,
        };
        return days;
      } catch (error) {
        if (!history || today < history.since || signal.aborted) throw error;
        history.refreshAt = Date.now() + MAX_RETRY_MS;
        console.error(`[ccusage-stats] Historical usage reread failed: ${(error as Error).message}`);
      }
    }
    const { older, since } = history;
    const recent = await scan("daily", timezone, signal, since);
    return structuredClone(older).concat(recent.filter((row) => row.period >= since));
  }

  async function readSessions() {
    const start = Date.now();
    if (start >= nextSessionAt) {
      try {
        // A bounded session query truncates resumed Codex conversations at the date filter.
        sessions = await scan("session", timezone, signal);
        sessionError = null;
        sessionFailures = 0;
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
    return { rows: structuredClone(sessions), error: sessionError };
  }

  return { readDays, readSessions };
}
