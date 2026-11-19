import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatCost,
  formatPeriodLong,
  formatPeriodRange,
  formatPeriodShort,
  formatScanProgress,
  formatTokens,
  reportTimeFormatter,
} from "../plugins/ccusage-stats/client/format";

test("abbreviates token counts and displays USD amounts in full", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(265_741), "266K");
  assert.equal(formatTokens(999_500), "1.00M");
  assert.equal(formatTokens(555_855_928), "556M");
  assert.equal(formatTokens(2_773_484_011), "2.77B");
  assert.equal(formatCost(1_238.47), "$1,238.47");
  assert.equal(formatCost(118.26), "$118.26");
  assert.equal(formatCost(0), "$0.00");
  assert.equal(formatCost(null), "—");
  assert.equal(formatCost(0.001), "<$0.01");
});

test("shows the report's exact calendar dates and inclusive date ranges", () => {
  assert.equal(formatPeriodLong("daily", "2026-11-18"), "November 18, 2026");
  assert.equal(formatPeriodLong("monthly", "2026-11"), "November 2026");
  assert.equal(formatPeriodShort("monthly", "2025-12"), "Dec ’25");
  assert.equal(formatPeriodRange("monthly", "2026-11", "2026-11-18"), "Nov 1–18, 2026");
  assert.equal(formatPeriodRange("monthly", "2026-10", "2026-11-18"), "Oct 1–31, 2026");
  assert.equal(formatPeriodRange("monthly", "2024-02"), "Feb 1–29, 2024");
  assert.equal(formatPeriodLong("weekly", "2026-11-16", "2026-11-18"), "Nov 16–18, 2026");
  assert.equal(
    formatPeriodLong("weekly", "2026-12-28"),
    "December 28, 2026 – January 3, 2027",
  );
  const utc = Date.UTC(2026, 10, 18, 16, 17);
  assert.equal(reportTimeFormatter("Asia/Hong_Kong").format(utc), "Nov 19, 2026, 00:17");
});

test("describes the active usage scan and its elapsed time", () => {
  assert.equal(formatScanProgress({ stage: "recentSessions", elapsedSeconds: 2 }), "Reading recent sessions…");
  assert.equal(formatScanProgress({ stage: "dailyHistory", elapsedSeconds: 19 }), "Reading daily history · 19s");
  assert.equal(formatScanProgress({ stage: "sessionHistory", elapsedSeconds: 71 }), "Reading session history · 1m 11s");
});
