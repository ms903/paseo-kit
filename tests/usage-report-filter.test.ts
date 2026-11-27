import assert from "node:assert/strict";
import { test } from "node:test";
import { filterUsageReport, reportAgentOptions } from "../plugins/ccusage-stats/client/report-filter";
import { EMPTY_USAGE, type AgentUsage, type Usage, type UsagePeriod, type UsageReport } from "../plugins/ccusage-stats/shared/usage";

function usage(n: number, cost: number | null = n): Usage {
  return {
    inputTokens: n, outputTokens: 2 * n, cacheCreationTokens: 3 * n,
    cacheReadTokens: 4 * n, totalTokens: 10 * n, cost,
  };
}

function source(agent: string, n: number, cost: number | null = n): AgentUsage {
  return { agent, usage: usage(n, cost), models: [{ model: "shared-model", usage: usage(n, cost) }] };
}

function bucket(period: string, ...agents: AgentUsage[]): UsagePeriod {
  return { period, usage: usage(10000, null), agents };
}

function fixture(): UsageReport {
  const codex = source("codex", 60, null);
  return {
    generatedAt: 123, revision: "test:2", refreshing: false, refreshError: null,
    today: "2026-11-01", timezone: "America/Los_Angeles",
    agents: ["codex", "claude", "gemini", "pi", "opencode"],
    daily: [
      bucket("2026-10-30", codex, source("opencode", 3)),
      bucket("2026-10-31", codex),
      bucket("2026-11-01", codex, source("opencode", 2)),
    ],
    weekly: [bucket("2026-10-19", codex), bucket("2026-10-26", codex, source("opencode", 15))],
    monthly: [bucket("2026-10", codex, source("opencode", 50)), bucket("2026-11", codex, source("opencode", 2))],
    total: bucket("total", codex, source("opencode", 900), source("archived-days", 10)),
    recentSessions: ["codex", "opencode"].map(agent => ({
      id: "shared-session-id", agent, usage: usage(3), models: [], lastActivity: null,
    })),
    sessionAgents: ["codex", "opencode", "archived-sessions"],
  };
}

test("selects exact agent totals, costs, model usage and sessions across independent report periods", () => {
  const raw = fixture();
  const original = structuredClone(raw);
  assert.equal(filterUsageReport(raw, null), raw);
  assert.equal(filterUsageReport(raw, undefined), raw);
  const selected = filterUsageReport(raw, "opencode");
  assert.deepEqual(selected.agents, ["opencode"]);
  assert.deepEqual(selected.daily.map(day => day.usage), [usage(3), EMPTY_USAGE, usage(2)]);
  assert.deepEqual(selected.weekly.map(week => week.usage), [EMPTY_USAGE, usage(15)]);
  assert.deepEqual(selected.monthly.map(month => month.usage), [usage(50), usage(2)]);
  assert.deepEqual(selected.total?.usage, usage(900));
  assert.deepEqual(selected.daily.map(day => day.period), raw.daily.map(day => day.period));
  assert.deepEqual(selected.daily[1].agents, []);
  for (const period of [...selected.daily, ...selected.weekly, ...selected.monthly, selected.total!]) {
    if (period.usage.totalTokens === 0) continue;
    assert.deepEqual(period.agents, [{
      agent: "opencode", usage: period.usage, models: [{ model: "shared-model", usage: period.usage }],
    }]);
  }
  assert.deepEqual(selected.recentSessions, [raw.recentSessions[1]]);
  assert.equal(selected.timezone, raw.timezone);
  assert.equal(selected.today, raw.today);
  assert.equal(selected.revision, raw.revision);
  assert.deepEqual(filterUsageReport(raw, "codex").total?.usage, usage(60, null));
  assert.deepEqual(raw, original);
});

test("offers exact source identities including hidden chart series and older sessions, without inventing Other", () => {
  const report = fixture();
  report.weekly.push(bucket("2026-10-12", source("Pi", 4)));
  assert.deepEqual(reportAgentOptions(report), [
    "codex", "claude", "gemini", "pi", "opencode", "Pi", "archived-days", "archived-sessions",
  ]);
  const actualOther = source("other", 17);
  report.daily[2].agents.push(actualOther);
  assert.ok(reportAgentOptions(report, ["extra-index", "extra-index"]).includes("other"));
  assert.deepEqual(filterUsageReport(report, "other").daily.at(-1)?.agents, [actualOther]);
  assert.deepEqual(filterUsageReport(report, "Pi").weekly.at(-1)?.usage, usage(4));
  assert.deepEqual(filterUsageReport(report, "pi").weekly.at(-1)?.usage, EMPTY_USAGE);
  assert.deepEqual(filterUsageReport(report, "archived-days").total?.usage, usage(10));
});

test("preserves partial and legacy report state; an absent provider gets empty dated buckets", () => {
  const report = fixture();
  delete report.total;
  delete report.sessionAgents;
  report.historyPending = true;
  report.sessionsPending = true;
  const selected = filterUsageReport(report, "pending-agent");
  assert.equal(selected.total, undefined);
  assert.equal(selected.historyPending, true);
  assert.equal(selected.sessionsPending, true);
  for (const kind of ["daily", "weekly", "monthly"] as const) {
    assert.deepEqual(selected[kind], report[kind].map(({period}) => ({period, usage: EMPTY_USAGE, agents: []})));
  }
  assert.deepEqual(selected.recentSessions, []);
  report.recentSessions[0] = { ...report.recentSessions[0], agent: "legacy-sessions" };
  assert.ok(reportAgentOptions(report).includes("legacy-sessions"));
});

test("combines repeated source rows using the scanner's token totals, preserving per-model pending costs", () => {
  const raw = fixture();
  const first = source("opencode", 1);
  const second = source("opencode", 2, null);
  second.usage.totalTokens = 30;
  second.models.push({ model: "small", usage: usage(1) });
  raw.daily = [bucket(raw.today, first, source("codex", 100), second)];
  const period = filterUsageReport(raw, "opencode").daily[0];
  assert.deepEqual(period.usage, { ...usage(3, null), totalTokens: 40 });
  assert.deepEqual(period.agents, [{
    agent: "opencode", usage: period.usage,
    models: [{ model: "shared-model", usage: usage(3, null) }, { model: "small", usage: usage(1) }],
  }]);
});
