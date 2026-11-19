import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { describeCcusageFailure, type RawRow } from "../plugins/ccusage-stats/server/ccusage";
import { joinSessions, rollupDays } from "../plugins/ccusage-stats/server/usage-rows";
import { createUsageHistory } from "../plugins/ccusage-stats/server/usage-history";
import { createUsageStore } from "../plugins/ccusage-stats/server/usage-store";
import { createReportCache, localToday, type ReportCache } from "../plugins/ccusage-stats/server/report";

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

test("replaces the recent window and reconciles older days after seven days", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-01T16:30:00Z") });
  const bounds: (string | undefined)[][] = [];
  const history = createUsageHistory("Asia/Hong_Kong", new AbortController().signal, async (kind, _tz, _signal, since, until) => {
    assert.equal(kind, "daily");
    bounds.push([since, until]);
    if (until) return [row("2026-10-31", bounds.length === 2 ? 1 : 12)];
    if (since === "2026-11-08") return [];
    return bounds.length === 1 ? [row("2026-11-01", 3), row("2026-11-02", 5)] : [row("2026-11-02", 8)];
  });
  const first = await history.readDays("2026-11-02");
  first[0].modelBreakdowns[0].cost = 50;
  assert.deepEqual(await history.readDays("2026-11-02"), [row("2026-10-31", 1), row("2026-11-02", 8)]);
  t.mock.timers.tick(7 * 24 * 3_600_000);
  assert.deepEqual(await history.readDays("2026-11-09"), [row("2026-10-31", 12)]);
  assert.deepEqual(bounds, [
    ["2026-11-01", undefined], [undefined, "2026-10-31"], ["2026-11-01", undefined],
    ["2026-11-08", undefined], [undefined, "2026-11-07"],
  ]);
});

test("resumed sessions retain older model costs and provider-specific lifetime totals", () => {
  const older = [row("resumed", 40), row("resumed", 5, "qwen"), row("resumed", 9, "pi")];
  const latest = row("resumed", 10);
  latest.metadata = { lastActivity: "2026-11-20T01:00:00Z" };
  const qwen = row("resumed", 15, "qwen");
  const [codex, lifetime, pi] = joinSessions(older, [latest, qwen]);
  assert.equal(codex.totalTokens, 62);
  assert.equal(codex.totalCost, 5);
  assert.equal(codex.modelBreakdowns[0].cost, 5);
  assert.deepEqual(codex.metadata, latest.metadata);
  assert.deepEqual(lifetime, qwen);
  assert.deepEqual(pi, older[2]);
  assert.equal(older[0].totalCost, 4);
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

test("session scans keep the previous lifetime totals after a failure and back off", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-20T00:00:00Z") });
  t.mock.method(console, "error", () => {});
  let calls = 0;
  const history = createUsageHistory("Asia/Hong_Kong", new AbortController().signal, async (kind, _tz, _signal, since, until) => {
    assert.equal(kind, "session");
    if (until) return [];
    assert.equal(since, "2026-11-19");
    if (++calls === 2) throw new Error("session timeout");
    t.mock.timers.tick(70_000);
    return [row("resumed", calls)];
  });
  const read = () => history.readSessions("2026-11-20");
  const first = await read();
  first.rows[0].totalCost = 8;
  t.mock.timers.tick(209_999);
  assert.deepEqual(await read(), { rows: [row("resumed", 1)], error: null });
  t.mock.timers.tick(1);
  assert.deepEqual(await read(), { rows: [row("resumed", 1)], error: "session timeout" });
  t.mock.timers.tick(60_000);
  assert.deepEqual(await read(), { rows: [row("resumed", 3)], error: null });
});

async function complete(cache: ReportCache) {
  for (let i = 0; i < 400; i++) {
    const data = await cache.read();
    if (!("status" in data) && !data.refreshing) return data;
    await delay(5);
  }
  throw new Error("Report did not finish");
}

test("report and session RPCs return during a slow cold scan, then restore a disk snapshot and rescan only recent data", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-usage-refresh-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = process.env.GEMINI_DIR;
  process.env.GEMINI_DIR = root;
  t.after(() => { if (original === undefined) delete process.env.GEMINI_DIR; else process.env.GEMINI_DIR = original; });
  const day = localToday(Intl.DateTimeFormat().resolvedOptions().timeZone);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const calls: string[] = [];
  const cache = createReportCache(async (kind, _tz, _signal, since, until) => {
    calls.push(`${kind} ${since ? "recent" : "older"}`);
    if (kind === "session" && until) {
      await gate;
      return [row("resumed", 400)];
    }
    return until ? [] : [row(kind === "daily" ? day : "resumed", 80)];
  }, root);
  t.after(() => cache.stop());
  for (let i = 0; i < 400 && calls.length < 4; i++) {
    await Promise.all([cache.read(), cache.sessions(), cache.read()]);
    await delay(5);
  }
  assert.deepEqual(calls, ["daily recent", "daily older", "session recent", "session older"]);
  assert.deepEqual(await cache.read(), { status: "today", today: day, totalTokens: 86, refreshError: null });
  assert.deepEqual(await cache.sessions(), []);
  release();
  const first = await complete(cache);
  assert.equal(first.recentSessions[0].usage.totalTokens, 492);
  assert.equal(first.daily.at(-1)?.usage.totalTokens, 86);
  cache.stop();
  const compressed = path.join(root, "report.json.gz");
  assert.equal((await stat(compressed)).mode & 0o777, 0o600);
  const oldBytes = await readFile(compressed);
  const warmCalls: string[] = [];
  let resume!: () => void;
  const pause = new Promise<void>((resolve) => { resume = resolve; });
  const restarted = createReportCache(async (kind, _tz, _signal, since, until) => {
    assert.ok(since); assert.equal(until, undefined);
    warmCalls.push(kind);
    await pause;
    return [row(kind === "daily" ? day : "resumed", 100)];
  }, root);
  t.after(() => restarted.stop());
  const restored = await restarted.read();
  assert.ok(!("status" in restored));
  assert.equal(restored.generatedAt, first.generatedAt);
  assert.equal(restored.recentSessions[0].usage.totalTokens, 492);
  resume();
  const next = await complete(restarted);
  assert.equal(next.daily.at(-1)?.usage.totalTokens, 106);
  assert.equal(next.recentSessions[0].usage.totalTokens, 512);
  assert.deepEqual(warmCalls, ["daily", "session"]);
  assert.notDeepEqual(await readFile(compressed), oldBytes);
  const store = createUsageStore(next.timezone, root);
  await store.readReport();
  const savedAt = (await stat(compressed)).mtimeMs;
  await store.saveReport({ ...next, refreshing: undefined, generatedAt: next.generatedAt + 1000 });
  assert.equal((await stat(compressed)).mtimeMs, savedAt);
  assert.deepEqual((await readdir(root)).sort(), ["history-daily.json.gz", "history-session.json.gz", "report.json.gz"]);
  assert.equal(await createUsageStore(next.timezone === "UTC" ? "Asia/Tokyo" : "UTC", root).readReport(), undefined);
  await writeFile(compressed, "incomplete");
  assert.equal(await store.readReport(), undefined);
});

test("identical daily metrics skip session scans, and redistribute or reconnect after the verification interval", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-20T00:00:00Z") });
  const day = "2026-11-20";
  let count = 50;
  let sessionCalls = 0;
  const history = createUsageHistory("UTC", new AbortController().signal, async (kind, _tz, _sig, _since, until) => {
    if (until) return [];
    if (kind === "session") sessionCalls++;
    return [row(kind === "session" ? "session" : day, count)];
  });
  async function read() { await history.readDays(day); return history.readSessions(day); }
  await read();
  t.mock.timers.tick(120_000);
  await read();
  assert.equal(sessionCalls, 1);
  count += 5;
  await read();
  assert.equal(sessionCalls, 2);
  t.mock.timers.tick(3_600_000);
  await read();
  assert.equal(sessionCalls, 3);
});

test("a cold failure is reported without repeated scans, then saves the available calendar while sessions recover", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-20T00:00:00Z") });
  t.mock.method(console, "error", () => {});
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-usage-fail-"));
  const day = localToday(Intl.DateTimeFormat().resolvedOptions().timeZone);
  let daily = 0, sessions = 0;
  const cache = createReportCache(async (kind, _tz, _sig, _since, until) => {
    if (until) return [];
    if (kind === "daily" && ++daily === 1) throw new Error("daily scan failed");
    if (kind === "session" && ++sessions === 1) throw new Error("session scan failed");
    return [row(kind === "daily" ? day : "resumed", 200)];
  }, root);
  try {
    await assert.rejects(complete(cache), /daily scan failed/);
    await Promise.allSettled([cache.read(), cache.sessions(), cache.read()]);
    assert.equal(daily, 1);
    await cache.read(true);
    const calendar = await complete(cache);
    assert.equal(calendar.sessionRefreshError, "session scan failed");
    assert.equal(calendar.daily.at(-1)?.usage.inputTokens, 200);
    const saved = await createUsageStore(calendar.timezone, root).readReport();
    assert.equal(saved?.sessionRefreshError, "session scan failed");
    assert.equal(saved?.daily.at(-1)?.usage.inputTokens, 200);
    t.mock.timers.tick(60_001);
    const recovered = await complete(cache);
    assert.equal(recovered.sessionRefreshError, null);
    assert.equal(recovered.recentSessions[0].id, "resumed");
  } finally {
    cache.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("manual price updates reuse a finished or in-flight scan and return before session indexing finishes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-usage-reprice-"));
  const oldCache = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = root;
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return Response.json({ openai: { models: { fixture: { cost: { input: requests, output: 1 } } } } });
  });
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  let scans = 0;
  const day = localToday(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const cache = createReportCache(async (kind, _tz, _sig, _since, until) => {
    scans++;
    if (kind === "session" && until) await gate;
    return until ? [] : [row(kind === "daily" ? day : "resumed", 4000)];
  }, root);
  try {
    for (let i = 0; i < 400 && scans < 4; i++) { await cache.read(); await delay(5); }
    assert.equal(requests, 0);
    const result = await cache.updatePrices();
    assert.ok("status" in result);
    finish();
    const first = await complete(cache);
    assert.equal(requests, 1);
    assert.equal(scans, 4);
    const next = await cache.updatePrices();
    assert.ok(!("status" in next));
    const fresh = await complete(cache);
    assert.equal(requests, 2);
    assert.equal(scans, 4);
    assert.ok(fresh.daily.at(-1)!.usage.cost > first.daily.at(-1)!.usage.cost);
  } finally {
    finish();
    cache.stop();
    if (oldCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = oldCache;
    await rm(root, { recursive: true, force: true });
  }
});
