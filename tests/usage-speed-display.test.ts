import assert from "node:assert/strict";
import { test } from "node:test";
import { formatRate, groupTurnSpeeds, hasMeasuredSpeed } from "../plugins/ccusage-stats/client/speed-format";
import { CCUSAGE_SETTINGS } from "../plugins/ccusage-stats/shared/settings";
import type { SessionSpeedSample } from "../plugins/ccusage-stats/shared/speed";

const sample = (turnId: string, basis: SessionSpeedSample["basis"], tokensPerSecond: number): SessionSpeedSample => ({
  turnId, basis, tokensPerSecond, approximate: false, source: "provider", measuredAt: "2026-11-28T00:00:00.000Z",
});

test("groups recent turns without mixing output speeds measured on different bases", () => {
  const current = sample("current", "decode", 42.1);
  const whole = sample("current", "whole-turn", 13);
  const older = sample("previous", "response", 36);
  const observed = { ...whole, source: "observed" as const, tokensPerSecond: 16 };
  assert.deepEqual(groupTurnSpeeds([whole, current, older, sample("current", "decode", 37)]), [[current, whole], [older]]);
  assert.deepEqual(groupTurnSpeeds([whole, observed]), [[whole, observed]]);
});

test("keeps absent and unusable measurements out of numeric displays", () => {
  assert.equal(hasMeasuredSpeed(undefined), false);
  assert.deepEqual(groupTurnSpeeds([sample("zero", "decode", 0), sample("invalid", "response", Number.NaN)]), []);
  assert.equal(formatRate(0.025, "en-US"), "<0.1");
  assert.equal(formatRate(12.64, "en-US"), "12.6");
  assert.equal(formatRate(12.64, "de"), "12,6");
});

test("existing display preferences pick the live basis and preserve the user's window", () => {
  assert.deepEqual(CCUSAGE_SETTINGS.schema.parse({ showSessionSpeed: false, speedWindowSeconds: 10 }), {
    showSessionSpeed: false, speedWindowSeconds: 10, speedPillBasis: "live",
  });
  assert.equal(CCUSAGE_SETTINGS.schema.safeParse({ speedWindowSeconds: 0 }).success, false);
});

test("Carbon series preserve their order and reach non-text contrast in both Paseo themes", async () => {
  const { chartColors } = await import("../plugins/ccusage-stats/client/data");
  const palette = (surface0: string) => chartColors({ colors: { surface0 } } as Parameters<typeof chartColors>[0]);
  const luminance = (hex: string) => {
    const [r, g, b] = hex.slice(1).match(/../g)!.map(part => {
      const value = parseInt(part, 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  for (const surface of ["#fafafa", "#272727"]) {
    const bg = luminance(surface);
    assert.equal(new Set(palette(surface)).size, 4);
    for (const color of palette(surface)) {
      const fg = luminance(color);
      assert.ok((Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05) >= 3, color);
    }
  }
  assert.deepEqual(palette("#222"), palette("rgb(34, 34, 34)"));
  assert.notDeepEqual(palette("#222"), palette("#fff"));
});
