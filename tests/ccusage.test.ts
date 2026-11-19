import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { describeCcusageFailure, type RawRow } from "../plugins/ccusage-stats/server/ccusage";
import { rollupDays } from "../plugins/ccusage-stats/server/usage-rows";
import { createUsageHistory } from "../plugins/ccusage-stats/server/usage-history";
import { createReportCache, localToday } from "../plugins/ccusage-stats/server/report";

test("identifies ccusage timeouts, termination signals, and quiet exit codes", () => {
  assert.equal(describeCcusageFailure({ killed: true, signal: "SIGTERM" }, "", "session"), "ccusage session scan timed out after 300 seconds");
  assert.equal(describeCcusageFailure({ signal: "SIGKILL" }, "", "session"), "ccusage was terminated (SIGKILL)");
  assert.equal(describeCcusageFailure({ code: 1 }, "", "session"), "ccusage exited (1)");
  assert.equal(describeCcusageFailure({ code: 2 }, "invalid timezone\n", "daily"), "ccusage exited (2). invalid timezone");
  assert.equal(describeCcusageFailure({ code: "ENOENT" }, "", "session"), "ccusage executable was not found");
  assert.equal(describeCcusageFailure({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, "", "session"), "ccusage output exceeded the size limit");
});

function row(period: string, tokens: number, agent = "codex"): RawRow {
  const counts = { inputTokens: tokens, outputTokens: 1, cacheReadTokens: 2, cacheCreationTokens: 3 };
  return {
    period, agent, ...counts, totalTokens: tokens + 6, totalCost: tokens / 10,
    modelBreakdowns: [{ modelName: "fixture", ...counts, cost: tokens / 10 }],
  };
}

test("replaces the recent days and preserves raw historical prices until the next full scan", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-01T16:30:00Z") });
  const bounds: (string | undefined)[] = [];
  const history = createUsageHistory("Asia/Hong_Kong", new AbortController().signal, async (kind, _tz, _signal, since) => {
    assert.equal(kind, "daily");
    bounds.push(since);
    if (bounds.length === 1) return [row("2026-10-31", 1), row("2026-11-01", 3), row("2026-11-02", 5)];
    if (since) return [row("2026-11-02", 8)];
    return [row("2026-10-31", 12), row("2026-11-02", 8)];
  });
  const first = await history.readDays("2026-11-02");
  first[0].modelBreakdowns[0].cost = 50;
  const warm = await history.readDays("2026-11-02");
  assert.deepEqual(warm, [row("2026-10-31", 1), row("2026-11-02", 8)]);
  t.mock.timers.tick(6 * 3_600_000);
  assert.deepEqual(await history.readDays("2026-11-02"), [row("2026-10-31", 12), row("2026-11-02", 8)]);
  assert.deepEqual(bounds, [undefined, "2026-11-01", undefined]);
});

test("groups priced models and agent totals across month and Monday boundaries", () => {
  const daily = [
    row("2026-10-31", 4),
    { ...row("2026-11-01", 0), agents: [row("2026-11-01", 3), row("2026-11-01", 2, "pi")] },
    row("2026-11-02", 9),
  ];
  const week = rollupDays(daily, "weekly");
  const month = rollupDays(daily, "monthly");
  assert.deepEqual(week.map((r) => [r.period, r.totalTokens]), [["2026-10-26", 27], ["2026-11-02", 15]]);
  assert.deepEqual(month.map((r) => [r.period, r.totalTokens]), [["2026-10", 10], ["2026-11", 32]]);
  assert.equal(week[0].agents?.[0].modelBreakdowns[0].cacheCreationTokens, 6);
  assert.equal(month[1].agents?.[1].agent, "pi");
  assert.ok(Math.abs(month[1].totalCost - 1.4) < 1e-9);
  assert.equal(daily[0].inputTokens, 4);
});

test("slow session scans keep lifetime totals, back off after failure and clear the error after recovery", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-20T00:00:00Z") });
  t.mock.method(console, "error", () => {});
  let calls = 0;
  const history = createUsageHistory("Asia/Hong_Kong", new AbortController().signal, async (kind, _tz, _signal, since) => {
    assert.equal(kind, "session");
    assert.equal(since, undefined);
    calls++;
    if (calls === 2) throw new Error("ccusage session scan timed out");
    t.mock.timers.tick(70_000);
    return [row("resumed-session", calls)];
  });
  const first = await history.readSessions();
  first.rows[0].totalCost = 8;
  t.mock.timers.tick(209_999);
  assert.deepEqual(await history.readSessions(), { rows: [row("resumed-session", 1)], error: null });
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(await history.readSessions(), { rows: [row("resumed-session", 1)], error: "ccusage session scan timed out" });
  assert.equal(calls, 2);
  t.mock.timers.tick(60_000);
  assert.deepEqual(await history.readSessions(), { rows: [row("resumed-session", 3)], error: null });
});

test("one slow or failed section cannot freeze usage or start a retry on every RPC", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-20T12:00:00Z") });
  t.mock.method(console, "error", () => {});
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-usage-refresh-"));
  const previous = process.env.GEMINI_DIR;
  process.env.GEMINI_DIR = root;
  const day = localToday(Intl.DateTimeFormat().resolvedOptions().timeZone);
  let calendarReads = 0;
  let sessionReads = 0;
  const cache = createReportCache(async (kind) => {
    if (kind === "daily") {
      if (++calendarReads === 1) throw new Error("daily scan failed");
      return [row(day, calendarReads * 100)];
    }
    if (++sessionReads === 1) throw new Error("session scan failed");
    return [row("resumed-session", 500)];
  });
  try {
    await assert.rejects(cache.read(), /daily scan failed/);
    await Promise.allSettled([cache.read(), cache.sessions(), cache.read()]);
    assert.equal(calendarReads, 1);
    t.mock.timers.tick(60_001);
    const [report] = await Promise.all([cache.read(), cache.sessions()]);
    assert.equal(calendarReads, 2);
    assert.equal(sessionReads, 1);
    assert.equal(report.refreshError, null);
    assert.equal(report.sessionRefreshError, "session scan failed");
    assert.equal(report.daily.at(-1)?.usage.inputTokens, 200);
    t.mock.timers.tick(60_001);
    let fresh = await cache.read();
    for (let i = 0; i < 200 && fresh.generatedAt === report.generatedAt; i++) {
      await delay(5);
      fresh = await cache.read();
    }
    assert.equal(fresh.daily.at(-1)?.usage.inputTokens, 300);
    assert.equal(fresh.recentSessions[0]?.id, "resumed-session");
    assert.equal(fresh.sessionRefreshError, null);
    assert.equal(sessionReads, 2);
  } finally {
    cache.stop();
    if (previous === undefined) delete process.env.GEMINI_DIR;
    else process.env.GEMINI_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
