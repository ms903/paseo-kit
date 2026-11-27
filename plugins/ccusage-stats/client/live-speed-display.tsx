import type { PluginTheme } from "@getpaseo/plugin";
import { Text, View } from "react-native";
import type { SessionSpeedSample } from "../shared/speed";
import { formatPercent, formatTokens, shortSessionId } from "./format";
import { formatRate } from "./speed-format";
import type { useSpeedMessages } from "./speed-messages";
import { FONT } from "./summary";
import type { useLiveSpeed } from "./turn-speed";

type Copy = ReturnType<typeof useSpeedMessages>;
export type ObservedTurn = NonNullable<ReturnType<typeof useLiveSpeed>>;
const MAX_CHILDREN = 5;

export function observedPause(turn: ObservedTurn | null | undefined) {
  if (!turn || turn.phase !== "running") return null;
  if (turn.summary.waiting) return "waitingForUser";
  if (turn.summary.delegated) return "delegated";
  return turn.summary.tooling ? "runningTool" : null;
}

export function outputRate(rate: number, approximate: boolean, { locale, t }: Copy): string {
  return t("tokensPerSecond", { value: `${approximate ? "≈" : ""}${formatRate(rate, locale)}` });
}

export function formatDuration(value: number, { locale, t }: Copy): string {
  const formatter = new Intl.NumberFormat(locale, { maximumFractionDigits: value < 1000 ? 0 : 1 });
  return value < 1000
    ? t("milliseconds", { value: formatter.format(value) })
    : t("seconds", { value: formatter.format(value / 1000) });
}

function positive(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value) && value > 0;
}

export function observedMeasurement(turn: ObservedTurn | undefined | null): {
  sample: SessionSpeedSample;
  recent: boolean;
} | null {
  if (!turn || turn.phase === "idle") return null;
  const { summary, liveTokPerSec } = turn;
  const recent = turn.phase === "running" && !observedPause(turn) && positive(liveTokPerSec);
  const rate = recent ? liveTokPerSec : summary.tokPerSecDecode;
  if (!positive(rate)) return null;
  return {
    recent,
    sample: {
      turnId: turn.turnId ?? "current-observation",
      measuredAt: new Date(turn.state.endedAt ?? Date.now()).toISOString(),
      tokensPerSecond: rate,
      source: "observed",
      basis: "decode",
      // Recent-window speed is inferred from streamed output even if earlier steps reported usage.
      approximate: recent || summary.approx,
      outputTokens: !recent && summary.estTokens >= 1 ? Math.round(summary.estTokens) : undefined,
      durationMs: !recent && positive(summary.decodeMs) ? summary.decodeMs : undefined,
      ttftMs: summary.prefillMs ?? undefined,
    },
  };
}

function Metric({ label, value, theme }: { label: string; value: string; theme: PluginTheme }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: FONT.body, flexShrink: 1 }}>{label}</Text>
      <Text style={{ color: theme.colors.foreground, fontSize: FONT.body, fontVariant: ["tabular-nums"], flexShrink: 1 }}>{value}</Text>
    </View>
  );
}

export function LiveTurnDetails({ turn, theme, copy }: { turn: ObservedTurn; theme: PluginTheme; copy: Copy }) {
  const { t } = copy;
  const { summary, state, team } = turn;
  const lines: { label: string; value: string }[] = [];
  const add = (key: Parameters<Copy["t"]>[0], value: string) => lines.push({ label: t(key), value });
  const timed = (key: Parameters<Copy["t"]>[0], value: number | null) => {
    if (positive(value)) add(key, formatDuration(value, copy));
  };
  if (turn.model) add("model", turn.provider ? `${turn.model} · ${turn.provider}` : turn.model);
  if (summary.inputTokens > 0 || summary.estTokens > 0) {
    add("turnTokens", `${formatTokens(summary.inputTokens)} / ${summary.approx ? "≈" : ""}${formatTokens(summary.estTokens)}`);
  }
  if (summary.thinkingTokens > 0) add("reasoning", `≈${formatTokens(summary.thinkingTokens)}`);
  if (summary.cacheHitRate !== null) {
    add("promptCache", `${formatPercent(summary.cacheHitRate)} · ${formatTokens(summary.cachedTokens)} / ${formatTokens(summary.promptTokens)}`);
  }
  if (state.ctxUsed !== null && positive(state.ctxMax)) {
    add("context", `${formatTokens(state.ctxUsed)} / ${formatTokens(state.ctxMax)}`);
  }
  if (positive(summary.tokPerSecDecode)) add("decode", outputRate(summary.tokPerSecDecode, summary.approx, copy));
  if (!summary.partial && positive(summary.tokPerSecTurn)) add("adjustedTurn", outputRate(summary.tokPerSecTurn, summary.approx, copy));
  timed("prefill", summary.prefillMs);
  timed("decodeTime", summary.decodeMs);
  if (summary.partial) timed("observedTime", summary.observedMs);
  else timed("wallTime", summary.totalMs);
  timed("toolTime", summary.toolMs);
  timed("userTime", summary.userWaitMs);
  timed("delegatedTime", summary.delegatedMs);
  timed("gaps", summary.waitMs);
  if (summary.steps > 0) add("steps", String(summary.steps));

  return (
    <View testID="usage-live-turn-details" style={{ gap: 6, borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 8 }}>
      {summary.partial ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: FONT.caption }}>{t("partial")}</Text> : null}
      {lines.map(({ label, value }) => <Metric key={label} label={label} value={value} theme={theme} />)}
      {team?.members.length ? (
        <View style={{ gap: 5, marginTop: 2 }}>
          <Text accessibilityRole="header" style={{ color: theme.colors.foreground, fontSize: FONT.body, fontWeight: "600" }}>{t("team")}</Text>
          {team.members.slice(0, MAX_CHILDREN).map((member) => {
            const activity = positive(member.liveTokPerSec) ? outputRate(member.liveTokPerSec, true, copy) : t(member.running ? "running" : "finished");
            const tokens = member.estTokens > 0 ? t("tokens", { value: `${member.approx ? "≈" : ""}${formatTokens(member.estTokens)}` }) : null;
            return <Metric key={member.id} theme={theme} label={member.title || member.model || t("childAgent", { value: shortSessionId(member.id) })}
              value={tokens ? `${activity} · ${tokens}` : activity} />;
          })}
          {positive(team.liveTokPerSec) ? (
            <Metric theme={theme} label={t("teamRate")} value={outputRate(team.liveTokPerSec, true, copy)} />
          ) : null}
          {team.members.length > MAX_CHILDREN ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: FONT.caption }}>
              {t("moreChildren", { value: String(team.members.length - MAX_CHILDREN) })}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
