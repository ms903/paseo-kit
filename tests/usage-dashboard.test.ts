import assert from "node:assert/strict";
import { test } from "node:test";
import { activityWeeks, metricValue, modelUsage } from "../plugins/ccusage-stats/client/dashboard-data";
import { filterUsageReport } from "../plugins/ccusage-stats/client/report-filter";
import { createSessionList } from "../plugins/ccusage-stats/server/session-list";
import { EMPTY_USAGE, type SessionUsage, type UsageReport } from "../plugins/ccusage-stats/shared/usage";

test("activity follows the agent filter and distinguishes an idle date from the edge of the scan", () => {
  const report: UsageReport = {
    generatedAt: 0, today: "2026-11-02", timezone: "America/Los_Angeles", agents: ["codex", "antigravity"],
    daily: [], weekly: [], monthly: [], recentSessions: [], refreshError: null,
    activity: [
      { day: "2026-10-31", sources: [{ agent: "codex", tokens: 100 }, { agent: "antigravity", tokens: 250 }] },
      { day: "2026-11-01", sources: [{ agent: "codex", tokens: 150 }] },
      { day: "2026-11-02", sources: [] },
    ],
  };
  assert.deepEqual(activityWeeks(report)[0].map(({ tokens }) => tokens), [null, null, null, null, null, 350, 150]);
  const selected = activityWeeks(filterUsageReport(report, "antigravity"));
  assert.deepEqual(selected[0].slice(-2).map(({ tokens }) => tokens), [250, 0]);
  assert.deepEqual(selected[1][0], { day: "2026-11-02", tokens: 0 });
  assert.equal(selected[1][1].tokens, null);

  const legacy = { daily: [{ period: "2026-11-02", usage: { ...EMPTY_USAGE, totalTokens: 19 }, agents: [] }] };
  assert.equal(activityWeeks(legacy)[0][0].tokens, 19);
});

test("model rows combine equal model IDs while retaining unknown cost and weighted cache rates", () => {
  const a = { ...EMPTY_USAGE, totalTokens: 150, inputTokens: 90, cacheReadTokens: 50, outputTokens: 10, cost: null };
  const b = { ...EMPTY_USAGE, totalTokens: 50, cacheReadTokens: 40, outputTokens: 10, cost: 0.1 };
  const models = modelUsage({ period: "total", usage: EMPTY_USAGE, agents: [
    { agent: "codex", usage: a, models: [{ model: "shared-model", usage: a }] },
    { agent: "opencode", usage: b, models: [{ model: "shared-model", usage: b }] },
  ] });
  assert.equal(models.length, 1);
  assert.equal(metricValue(models[0].usage, "cost"), null);
  assert.equal(metricValue(models[0].usage, "output"), 20);
  assert.equal(metricValue(models[0].usage, "cache"), 0.5);
  assert.equal(metricValue(EMPTY_USAGE, "cache"), null);
});

test("lifetime session ranking covers earlier pages and keeps activity sorting as the default", () => {
  const rows: SessionUsage[] = Array.from({ length: 13 }, (_, index) => ({
    id: `codex-session-${index}`, agent: "codex", models: [], lastActivity: "2026-11-02T12:00:00Z",
    usage: { ...EMPTY_USAGE, totalTokens: index },
  }));
  rows.push({ ...rows[0], id: "agy", agent: "antigravity", usage: { ...EMPTY_USAGE, totalTokens: 500 } });
  const list = createSessionList("Asia/Hong_Kong");
  assert.equal(list(rows, {}, true).sessions[0].id, rows[0].id);
  assert.equal(list(rows, { sort: "tokens" }, true).sessions[0].id, "agy");
  assert.equal(list(rows, { sort: "tokens", agent: "codex" }, true).sessions[0].id, rows[12].id);
  const page = list(rows, { sort: "tokens", agent: "codex", offset: 12 }, true);
  assert.equal(page.sessions[0].id, rows[0].id);
  assert.equal(page.total, 13);
});
