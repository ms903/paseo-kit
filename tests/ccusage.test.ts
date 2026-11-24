import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { describeCcusageFailure, locateCcusage, type RawRow } from "../plugins/ccusage-stats/server/ccusage";
import { joinSessions, rollupDays } from "../plugins/ccusage-stats/server/usage-rows";
import { createUsageHistory } from "../plugins/ccusage-stats/server/usage-history";
import { createUsageStore } from "../plugins/ccusage-stats/server/usage-store";
import { createReportCache, localToday, type ReportCache } from "../plugins/ccusage-stats/server/report";
import { createSessionList } from "../plugins/ccusage-stats/server/session-list";
import { createSessionMatcher } from "../plugins/ccusage-stats/server/sessions";
import { PARENT_AGENT_LABEL, SESSION_PAGE_SIZE, type SessionUsage } from "../plugins/ccusage-stats/shared/usage";

test("identifies ccusage timeouts, termination signals, and quiet exit codes", () => {
  assert.equal(describeCcusageFailure({ killed: true, signal: "SIGTERM" }, "", "session"), "ccusage session scan timed out after 300 seconds");
  assert.equal(describeCcusageFailure({ signal: "SIGKILL" }, "", "session"), "ccusage was terminated (SIGKILL)");
  assert.equal(describeCcusageFailure({ code: 1 }, "", "session"), "ccusage exited (1)");
  assert.equal(describeCcusageFailure({ code: 2 }, "invalid timezone\n", "daily"), "ccusage exited (2). invalid timezone");
  assert.equal(describeCcusageFailure({ code: "ENOENT" }, "", "session"), "ccusage executable was not found");
  assert.equal(describeCcusageFailure({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, "", "session"), "ccusage output exceeded the size limit");
});


test("uses a locally built scanner only for the registered plugin's pinned release", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-scanner-discovery-"));
  const previous = process.env.PASEO_HOME;
  process.env.PASEO_HOME = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previous;
    await rm(root, { recursive: true, force: true });
  });

  const directory = path.join(root, "plugin");
  const modules = path.join(directory, "node_modules");
  const executable = process.platform === "win32" ? "ccusage.exe" : "ccusage";
  const native = path.join(modules, "@ccusage", `ccusage-${process.platform}-${process.arch}`, "bin", executable);
  const local = path.join(modules, ".paseo-ccusage", "20.0.51", executable);
  for (const file of [native, local]) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "", { mode: 0o755 });
  }
  await writeFile(path.join(root, "config.json"), JSON.stringify({ plugins: { "ccusage-stats": { path: directory } } }));
  const manifest = path.join(directory, "package.json");
  await writeFile(manifest, JSON.stringify({ name: "ccusage-stats", dependencies: { ccusage: "20.0.51" } }));
  assert.deepEqual(locateCcusage(), { file: local, source: "local" });
  await writeFile(manifest, JSON.stringify({ name: "ccusage-stats", dependencies: { ccusage: "20.0.52" } }));
  assert.deepEqual(locateCcusage(), { file: native, source: "bundled" });
});

function row(period: string, tokens: number, agent = "codex"): RawRow {
  const counts = { inputTokens: tokens, outputTokens: 1, cacheReadTokens: 2, cacheCreationTokens: 3 };
  return {
    period, agent, ...counts, totalTokens: tokens + 6, totalCost: tokens / 10,
    modelBreakdowns: [{ modelName: "fixture", ...counts, cost: tokens / 10 }],
  };
}

test("replaces the recent window and reconciles older days after thirty days", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-01T16:30:00Z") });
  const bounds: (string | undefined)[][] = [];
  const history = createUsageHistory("Asia/Hong_Kong", new AbortController().signal, async (kind, _tz, _signal, since, until) => {
    assert.equal(kind, "daily");
    bounds.push([since, until]);
    if (until) return [row("2025-11-30", 123), row("2026-10-31", bounds.length === 2 ? 1 : 12)];
    if (since === "2026-12-02") return [];
    return [row("2026-11-02", bounds.length === 1 ? 5 : 8)];
  });
  const first = await history.readDays("2026-11-02");
  first[0].modelBreakdowns[0].cost = 50;
  assert.deepEqual(await history.readDays("2026-11-02"), [row("2025-11-30", 123), row("2026-10-31", 1), row("2026-11-02", 8)]);
  t.mock.timers.tick(30 * 24 * 3_600_000);
  assert.deepEqual(await history.readDays("2026-12-02"), [row("2025-11-30", 123), row("2026-10-31", 12)]);
  assert.deepEqual(bounds, [
    ["2026-11-02", undefined], [undefined, "2026-11-01"], ["2026-11-02", undefined],
    ["2026-12-02", undefined], [undefined, "2026-12-01"],
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

test("opens an unindexed Paseo Codex child using its own rollout, then uses the priced report when it catches up", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-child-usage-"));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await rm(root, { recursive: true, force: true });
  });
  const createdAt = "2026-11-24T00:02:00Z";
  const observedAt = "2026-11-24T00:03:00Z";
  const prefix = Date.parse(createdAt).toString(16).padStart(12, "0");
  const id = (suffix: string) => `${prefix.slice(0, 8)}-${prefix.slice(8)}-7000-8000-${suffix.padStart(12, "0")}`;
  const child = id("1"), parent = id("2"), fork = id("3"), missing = id("4");
  const dir = path.join(root, "sessions", "2026", "11", "23");
  await mkdir(dir, { recursive: true });
  const fileName = (thread: string) => `rollout-2026-11-23T16-02-00-${thread}`;
  const file = (thread: string) => path.join(dir, fileName(thread) + ".jsonl");
  const tokenEvent = (input: number, output: number, read: number, at = observedAt) => JSON.stringify({
    type: "event_msg", timestamp: at,
    payload: { type: "token_count", info: { total_token_usage: {
      input_tokens: input, output_tokens: output, cached_input_tokens: read,
    } } },
  });
  for (const thread of [child, parent, fork]) {
    const meta = JSON.stringify({
      type: "session_meta", payload: { id: thread, ...(thread === fork ? { forked_from_id: parent } : {}) },
    });
    const event = thread === child ? tokenEvent(100, 20, 70) : tokenEvent(9000, 10, 8900);
    await writeFile(file(thread), meta + "\n" + " ".repeat(560 * 1024) + "\n" + event + "\n");
  }
  const indexed: SessionUsage[] = [];
  const matcher = createSessionMatcher({
    sessions: async (scan) => { assert.equal(scan, false); return indexed; },
  });
  const lookup: Record<string, string> = { child, parent, fork, missing };
  const paseo = {
    agents: {
      ref: (agentId: string) => ({
        refresh: async () => ({ agent: {
          createdAt, labels: agentId === "parent" ? {} : { [PARENT_AGENT_LABEL]: "parent" },
          persistence: { provider: "codex", sessionId: lookup[agentId] },
          lastUsage: { inputTokens: 42, outputTokens: 8, cachedInputTokens: 30,
            contextWindowUsedTokens: 50, contextWindowMaxTokens: 475_000 },
        } }),
      }),
    },
  } as Parameters<ReturnType<typeof createSessionMatcher>["detail"]>[1];

  const request = (agentId: string, refresh = false) => matcher.detail({ agentId, refresh }, paseo);
  const cached = await matcher.resolve({ agentIds: ["child"] }, paseo);
  assert.equal(cached.sessions[0].status, "pending");
  const opened = await request("child");
  assert.equal(opened.match.status, "matched");
  assert.equal(opened.match.session.recorded, true);
  assert.equal(opened.match.session.usage.totalTokens, 120);
  assert.equal(opened.match.session.usage.cacheReadTokens, 70);
  assert.deepEqual(opened.context, { used: 50, limit: 475_000 });
  const fallback = await request("missing");
  assert.equal(fallback.match.status, "pending");
  assert.equal(fallback.latestRequest?.totalTokens, 50);
  const forked = await request("fork");
  assert.equal(forked.match.status, "pending");
  assert.equal(forked.latestRequest?.totalTokens, 50);
  assert.equal((await request("parent")).latestRequest, undefined);

  const now = "2026-11-24T00:04:00Z";
  await appendFile(file(child), tokenEvent(140, 30, 90, now) + "\n");
  const updated = await request("child", true);
  assert.equal(updated.match.status, "matched");
  assert.equal(updated.match.session.usage.totalTokens, 170);
  indexed.push({
    ...updated.match.session, recorded: undefined,
    id: `2026/11/23/${fileName(child)}`, lastActivity: "2026-11-24T00:04:00.000Z",
    usage: { ...updated.match.session.usage, cost: 0.012 },
  });
  assert.equal((await request("child")).match.status, "matched");
  const report = await matcher.resolve({ agentIds: ["child"] }, paseo);
  assert.equal(report.sessions[0].status, "matched");
  assert.deepEqual(report.sessions[0].session, indexed[0]);
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
    assert.equal(since, "2026-11-20");
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
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-20T08:00:00Z") });
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-usage-refresh-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = process.env.GEMINI_DIR;
  process.env.GEMINI_DIR = root;
  t.after(() => { if (original === undefined) delete process.env.GEMINI_DIR; else process.env.GEMINI_DIR = original; });
  const day = localToday(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const recentDays = Promise.withResolvers<void>();
  const recentSessions = Promise.withResolvers<void>();
  const olderDays = Promise.withResolvers<void>();
  const olderSessions = Promise.withResolvers<void>();
  const calls: string[] = [];
  const cache = createReportCache(async (kind, _tz, _signal, _since, until) => {
    calls.push(`${kind} ${until ? "older" : "recent"}`);
    if (kind === "daily" && until) {
      await olderDays.promise;
      const older = row("2026-11-13", 400);
      older.modelBreakdowns[0].modelName = "gpt-6.2-sol";
      return [row("2025-09-01", 100), { ...older, agents: [older, row("2026-11-13", 30, "pi")] }];
    }
    if (kind === "session") {
      await (until ? olderSessions : recentSessions).promise;
      return [row("resumed", until ? 400 : 80)];
    }
    await recentDays.promise;
    return [row(day, 80)];
  }, root);
  t.after(() => {
    recentDays.resolve();
    recentSessions.resolve();
    olderDays.resolve();
    olderSessions.resolve();
    cache.stop();
  });
  const loading = await cache.read();
  assert.ok("status" in loading && loading.status === "loading");
  assert.equal(loading.progress?.stage, "recentUsage");
  recentDays.resolve();
  async function stage(expected: "recentSessions" | "dailyHistory" | "sessionHistory", callCount: number) {
    for (let i = 0; i < 400; i++) {
      const [report] = await Promise.all([cache.read(), cache.sessions(), cache.read()]);
      if (!("status" in report) && report.progress?.stage === expected && calls.length === callCount) return report;
      await delay(5);
    }
    throw new Error("Stage did not become ready: " + expected);
  }
  const initial = await stage("recentSessions", 2);
  assert.equal(initial.daily.at(-1)?.usage.totalTokens, 86);
  assert.equal(initial.daily.at(-1)?.usage.cost, 8);
  assert.equal(initial.historyPending, true);
  assert.equal(initial.daily.length, 1);
  assert.deepEqual(initial.weekly, []);
  assert.deepEqual(initial.monthly, []);
  assert.equal(initial.total, undefined);
  assert.equal(initial.progress?.window?.until, undefined);
  assert.ok(initial.progress?.window?.since);
  assert.deepEqual(await cache.sessions(), []);
  recentSessions.resolve();
  const recent = await stage("dailyHistory", 3);
  assert.deepEqual(recent.daily, initial.daily);
  assert.equal(recent.sessionsPending, true);
  const storeDuringScan = createUsageStore(recent.timezone, root);
  assert.deepEqual((await storeDuringScan.readReport())?.daily, recent.daily);
  olderDays.resolve();
  const calendar = await stage("sessionHistory", 4);
  assert.equal(calendar.historyPending, undefined);
  assert.equal(calendar.sessionsPending, true);
  assert.equal(calendar.daily.length, 30);
  assert.equal(calendar.weekly.length, 12);
  assert.equal(calendar.monthly.length, 12);
  const oldDay = calendar.daily.find((r) => r.period === "2026-11-13")!;
  assert.equal(oldDay.usage.cost, null);
  assert.equal(oldDay.agents.find((a) => a.agent === "codex")?.models[0].usage.cost, null);
  assert.equal(oldDay.agents.find((a) => a.agent === "pi")?.usage.cost, 3);
  assert.equal(calendar.monthly.at(-1)?.usage.cost, null);
  assert.equal(calendar.total?.usage.cost, null);
  assert.equal(calendar.total?.usage.totalTokens, 634);
  assert.equal(calendar.daily.at(-1)?.usage.cost, 8);
  assert.deepEqual(calendar.recentSessions, []);
  assert.deepEqual(await cache.sessions(), []);
  assert.deepEqual(calls, ["daily recent", "session recent", "daily older", "session older"]);
  olderSessions.resolve();
  const first = await complete(cache);
  assert.equal(first.recentSessions[0].usage.totalTokens, 492);
  assert.equal(first.daily.at(-1)?.usage.totalTokens, 86);
  assert.equal(first.daily.find((r) => r.period === "2026-11-13")?.usage.cost, 43);
  assert.equal(first.monthly.at(-1)?.usage.cost, 51);
  assert.equal(first.total?.usage.cost, 61);
  assert.equal(first.total?.agents.length, 2);
  assert.equal(first.sessionsPending, undefined);
  assert.equal(first.progress, undefined);
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
  assert.deepEqual(restored.total, first.total);
  assert.deepEqual(warmCalls, []);
  await restarted.read(true);
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

test("filters and pages lifetime sessions outside the recent report without a log scan after restart", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-21T10:00:00Z") });
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-session-list-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const day = localToday(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const latest = Array.from({ length: SESSION_PAGE_SIZE + 1 }, (_, i) => ({
    ...row(`session-${i}`, 100),
    metadata: { lastActivity: `2026-11-21T08:${String(i).padStart(2, "0")}:00Z` },
  }));
  const older = { ...row("archived-8f75ade9", 240, "pi"), metadata: { lastActivity: "2026-11-19T16:15:00Z" } };
  older.modelBreakdowns.push({ ...older.modelBreakdowns[0], modelName: "gemini-4-neon" });
  let scans = 0;
  const cache = createReportCache(async (kind, _timezone, _signal, _since, until) => {
    scans++;
    return kind === "daily" ? (until ? [] : [row(day, 100)]) : (until ? [older] : latest);
  }, root);
  t.after(() => cache.stop());
  const report = await complete(cache);
  assert.equal(report.recentSessions.length, SESSION_PAGE_SIZE);
  const scansAfterRefresh = scans;
  const first = await cache.listSessions({});
  const second = await cache.listSessions({ offset: SESSION_PAGE_SIZE });
  assert.equal(first.total, latest.length + 1);
  assert.equal(first.sessions[0].id, latest.at(-1)?.period);
  assert.deepEqual(second.sessions.map(({ id }) => id), [latest[0].period, older.period]);
  assert.deepEqual(second.agents, ["codex", "pi"]);
  assert.equal(second.complete, true);
  assert.equal((await cache.listSessions({ offset: 1_000_000 })).offset, SESSION_PAGE_SIZE);
  assert.equal((await cache.listSessions({ agent: "codex", search: "NEON" })).total, 0);
  assert.equal(scans, scansAfterRefresh);
  cache.stop();

  const reopened = createReportCache(async () => { scans++; return []; }, root);
  t.after(() => reopened.stop());
  const filtered = await reopened.listSessions({ agent: "pi", search: "  NeOn  " });
  assert.equal(filtered.complete, true);
  assert.equal(filtered.total, 1);
  assert.deepEqual(filtered.sessions[0].models.map(({ model }) => model), ["fixture", "gemini-4-neon"]);
  assert.equal((await reopened.listSessions({ search: "8F75ADE9" })).sessions[0].id, older.period);
  assert.equal(scans, scansAfterRefresh);
  const restored = await reopened.read();
  assert.ok(!("status" in restored));
  assert.equal("olderSessions" in restored, false);

  const list = createSessionList("Asia/Hong_Kong");
  const catalog = [filtered.sessions[0], { ...filtered.sessions[0], id: "unknown-date", lastActivity: null }];
  assert.equal(list(catalog, { until: "2026-11-19" }, true).total, 0);
  assert.deepEqual(list(catalog, { since: "2026-11-20", until: "2026-11-20" }, true).sessions, filtered.sessions);
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
    t.mock.timers.tick(45 * 60_000);
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
    assert.ok(!("status" in result));
    assert.equal(result.sessionsPending, true);
    assert.equal(result.daily.at(-1)?.usage.totalTokens, 4006);
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

test("manual refresh coalesces clicks, reuses archives, checks changed sessions and sends small unchanged replies", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-20T08:00:00Z") });
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-manual-usage-"));
  const requests = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected price request"); });
  const calls: string[] = [];
  let recent = 80;
  let paused = false;
  const gate = Promise.withResolvers<void>();
  const cache = createReportCache(async (kind, tz, _signal, since, until) => {
    calls.push(`${kind} ${until ? (since ? "catch-up" : "archive") : "recent"}`);
    if (paused && kind === "daily") await gate.promise;
    if (until) return !since && kind === "session" ? [row("resumed", 400)] : [];
    return [row(kind === "session" ? "resumed" : localToday(tz), recent)];
  }, root);
  try {
    const original = await complete(cache);
    assert.ok(original.revision);
    calls.length = 0;
    recent = 100;
    paused = true;
    const replies = await Promise.all(Array.from({ length: 12 }, () => cache.read(true, original.revision)));
    for (const reply of replies) {
      assert.ok("status" in reply && reply.status === "unchanged" && reply.refreshing);
      assert.ok(!("daily" in reply));
      assert.equal(reply.progress?.stage, "recentUsage");
      assert.equal(reply.progress?.elapsedSeconds, 0);
    }
    assert.deepEqual(calls, ["daily recent"]);
    t.mock.timers.tick(12_000);
    const inProgress = await cache.read(false, original.revision);
    assert.ok("status" in inProgress && inProgress.status === "unchanged");
    assert.equal(inProgress.progress?.stage, "recentUsage");
    assert.equal(inProgress.progress?.elapsedSeconds, 12);
    assert.ok(inProgress.progress?.window?.since);
    paused = false;
    gate.resolve();
    const updated = await complete(cache);
    assert.equal(updated.daily.at(-1)?.usage.totalTokens, 106);
    assert.equal(updated.recentSessions[0].usage.totalTokens, 512);
    assert.notEqual(updated.revision, original.revision);
    assert.deepEqual(calls, ["daily recent", "session recent"]);

    calls.length = 0;
    await cache.read(true);
    const identical = await complete(cache);
    assert.equal(identical.revision, updated.revision);
    assert.deepEqual(calls, ["daily recent"]);
    const unchanged = await cache.read(false, identical.revision);
    assert.ok("status" in unchanged && unchanged.status === "unchanged" && !unchanged.refreshing);
    assert.ok(JSON.stringify(unchanged).length * 10 < JSON.stringify(identical).length);
    const newClient = await cache.read(false, "another-instance:1");
    assert.ok(!("status" in newClient) && newClient.revision === identical.revision);

    calls.length = 0;
    t.mock.timers.tick(31 * 86_400_000);
    await cache.read(true);
    await complete(cache);
    assert.deepEqual(calls, ["daily catch-up", "daily recent", "session catch-up", "session recent"]);
    t.mock.timers.tick(45 * 60_000);
    await complete(cache);
    assert.ok(calls.includes("daily archive") && calls.includes("session archive"));
    assert.equal(requests.mock.callCount(), 0);
  } finally {
    gate.resolve();
    cache.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("a restart during session indexing keeps the calendar and publishes new activity before lifetime totals finish", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-incomplete-sessions-"));
  t.mock.method(console, "error", () => {});
  let count = 80;
  const gate = Promise.withResolvers<void>();
  const archiveStarted = Promise.withResolvers<void>();
  const scan: Parameters<typeof createReportCache>[0] = async (kind, tz, _signal, _since, until) => {
    if (kind === "session" && until) {
      if (count === 80) throw new Error("session archive timed out");
      archiveStarted.resolve();
      await gate.promise;
      return [row("resumed", 400)];
    }
    return until ? [] : [row(kind === "daily" ? localToday(tz) : "resumed", count)];
  };
  let cache = createReportCache(scan, root);
  try {
    const old = await complete(cache);
    assert.equal(old.sessionRefreshError, "session archive timed out");
    assert.equal(old.daily.length, 30);
    cache.stop();

    count = 100;
    cache = createReportCache(scan, root);
    const restored = await cache.read(true);
    assert.ok(!("status" in restored));
    assert.equal(restored.monthly.length, 12);
    assert.equal(restored.daily.at(-1)?.usage.cost, 8);
    await archiveStarted.promise;
    const updated = await cache.read();
    assert.ok(!("status" in updated));
    assert.equal(updated.monthly.length, 12);
    assert.equal(updated.daily.at(-1)?.usage.cost, 10);
    assert.equal(updated.progress?.stage, "sessionHistory");
    assert.deepEqual(updated.recentSessions, []);
    gate.resolve();
    assert.equal((await complete(cache)).recentSessions[0].usage.totalTokens, 512);
  } finally {
    gate.resolve();
    cache.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("last usage refresh survives restart and advances only on a successful scan", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-20T04:50:01Z") });
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async () => Response.json({ openai: { models: { fixture: { cost: { input: 3, output: 1 } } } } }));
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-usage-clock-"));
  const original = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = root;
  let failed = false;
  const cache = createReportCache(async (kind, tz, _signal, _since, until) => {
    if (failed) throw new Error("scan failed");
    return until ? [] : [row(kind === "daily" ? localToday(tz) : "resumed", 100)];
  }, root);
  try {
    const first = await complete(cache);
    assert.equal(first.usageRefreshedAt, Date.now());
    const file = path.join(root, "report.json.gz");
    const before = (await stat(file)).mtimeMs;
    t.mock.timers.tick(2_000);
    await cache.read(true);
    const checked = await complete(cache);
    assert.equal(checked.usageRefreshedAt, Date.now());
    assert.equal((await stat(file)).mtimeMs, before);
    assert.equal((await createUsageStore(first.timezone, root).readReport())?.usageRefreshedAt, checked.usageRefreshedAt);
    const delta = await cache.read(false, first.revision);
    assert.ok("status" in delta && delta.status === "unchanged");
    assert.equal(delta.usageRefreshedAt, checked.usageRefreshedAt);
    t.mock.timers.tick(3_000);
    await cache.updatePrices();
    assert.equal((await complete(cache)).usageRefreshedAt, checked.usageRefreshedAt);
    failed = true;
    t.mock.timers.tick(5_000);
    await cache.read(true);
    const stale = await complete(cache);
    assert.equal(stale.refreshError, "scan failed");
    assert.equal(stale.usageRefreshedAt, checked.usageRefreshedAt);
  } finally {
    cache.stop();
    if (original === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = original;
    await rm(root, { recursive: true, force: true });
  }
});

test("extends the old bounded archive once without counting its dates twice", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-02T16:00:00Z") });
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-total-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createUsageStore("UTC", root);
  const cached = row("2026-10-31", 12);
  await store.saveHistory("daily", { since: "2026-11-01", checkedAt: Date.now(), older: [cached] });
  let olderScans = 0;
  const history = createUsageHistory("UTC", new AbortController().signal, async (_kind, _zone, _signal, since, until) => {
    if (until) {
      assert.equal(since, undefined);
      olderScans++;
      return [row("2025-06-15", 8), cached];
    }
    return [row("2026-11-02", 40)];
  }, store);
  const days = await history.readDays("2026-11-02", undefined, "manual");
  assert.equal(history.allDates, true);
  assert.deepEqual(days.map((day) => day.period), ["2025-06-15", "2026-10-31", "2026-11-02"]);
  assert.equal(rollupDays(days, "total")[0].totalTokens, 78);
  await history.readDays("2026-11-02", undefined, "manual");
  assert.equal(olderScans, 1);
});

test("manual usage refresh restarts the 45-minute automatic cooldown at completion", async (t) => {
  const interval = 45 * 60_000;
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-20T08:00:00Z") });
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-refresh-interval-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let dailyScans = 0;
  const cache = createReportCache(async (kind, tz, _signal, since, until) => {
    if (until || kind === "session") return [];
    assert.equal(since, localToday(tz));
    dailyScans++;
    t.mock.timers.tick(180_000); // A slow native scan takes three minutes.
    return [row(localToday(tz), 100)];
  }, root);
  t.after(() => cache.stop());
  await complete(cache);
  assert.equal(dailyScans, 1);

  t.mock.timers.tick(20 * 60_000);
  await Promise.all([cache.read(), cache.sessions()]);
  assert.equal(dailyScans, 1);
  await cache.read(true);
  const manual = await complete(cache);
  assert.equal(dailyScans, 2);

  t.mock.timers.tick(interval - 1);
  await Promise.all([cache.read(), cache.sessions(), cache.read()]);
  assert.equal(dailyScans, 2);
  t.mock.timers.tick(1);
  const automatic = await complete(cache);
  assert.equal(dailyScans, 3);
  assert.equal(automatic.usageRefreshedAt, manual.usageRefreshedAt! + interval + 180_000);
});

test("moves completed days to the archive once and preserves resumed session totals", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-20T08:00:00Z") });
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-rolling-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls: [string, string | undefined, string | undefined][] = [];
  const scan: Parameters<typeof createUsageHistory>[2] = async (kind, _tz, _signal, since, until) => {
    calls.push([kind, since, until]);
    if (!since) return [row(kind === "daily" ? "2026-11-19" : "resumed", 40)];
    if (until) return [row(kind === "daily" ? "2026-11-20" : "resumed", 20)];
    return [row(kind === "daily" ? since : "resumed", 10)];
  };
  const open = () => createUsageHistory("UTC", new AbortController().signal, scan, createUsageStore("UTC", root));
  const history = open();
  await history.readDays("2026-11-20");
  await history.readSessions("2026-11-20");
  t.mock.timers.tick(2 * 86_400_000);
  calls.length = 0;
  const days = await history.readDays("2026-11-22");
  const sessions = await history.readSessions("2026-11-22");
  assert.deepEqual(days.map(({ period }) => period), ["2026-11-19", "2026-11-20", "2026-11-22"]);
  assert.equal(sessions.rows[0].inputTokens, 70);
  assert.deepEqual(calls, [
    ["daily", "2026-11-20", "2026-11-21"],
    ["daily", "2026-11-22", undefined],
    ["session", "2026-11-20", "2026-11-21"],
    ["session", "2026-11-22", undefined],
  ]);
  calls.length = 0;
  t.mock.timers.tick(45 * 60_000);
  assert.deepEqual(await history.readDays("2026-11-22"), days);
  assert.equal((await history.readSessions("2026-11-22")).rows[0].inputTokens, 70);
  assert.deepEqual(calls, [["daily", "2026-11-22", undefined]]);

  calls.length = 0;
  const restored = open();
  assert.deepEqual(await restored.readDays("2026-11-22"), days);
  assert.equal((await restored.readSessions("2026-11-22")).rows[0].inputTokens, 70);
  assert.deepEqual(calls, [["daily", "2026-11-22", undefined], ["session", "2026-11-22", undefined]]);
});
