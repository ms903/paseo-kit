import type { PluginTheme } from "@getpaseo/plugin";
import { useAgent, useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View, type TextStyle } from "react-native";
import { CCUSAGE_SETTINGS } from "../shared/settings";
import { sessionSpeedRpc, type SessionSpeedSample } from "../shared/speed";
import { useFocusedAgentComposer, type ReadAgentComposer } from "./composer-focus";
import { chartColors } from "./data";
import { formatDuration, LiveTurnDetails, observedMeasurement, observedPause, outputRate, type ObservedTurn } from "./live-speed-display";
import { groupTurnSpeeds } from "./speed-format";
import { useSpeedMessages } from "./speed-messages";
import { FONT } from "./summary";
import { useLiveSpeed, type TurnSpeedRuntime } from "./turn-speed";

type SpeedTarget = { agentId: string } | { sessionId: string; provider: string };
type Copy = ReturnType<typeof useSpeedMessages>;

const basisLabels = {
  response: "response",
  "whole-turn": "wholeTurn",
  decode: "decode",
  "model-time": "modelTime",
} as const;
const RECENT_TURNS = 5;

export function speedQueryKey(hostId: string, target: SpeedTarget) {
  return "agentId" in target
    ? ["usage-session-speed", hostId, "agent", target.agentId] as const
    : ["usage-session-speed", hostId, "provider", target.provider, target.sessionId] as const;
}

function labelRate(sample: SessionSpeedSample, copy: Copy): string {
  return outputRate(sample.tokensPerSecond, sample.approximate, copy);
}

function sourceLabel(sample: SessionSpeedSample, { t }: Copy): string {
  const basis = sample.source === "observed" && sample.basis === "whole-turn" ? "adjustedTurn" : basisLabels[sample.basis];
  return `${t(basis)} · ${t(sample.source)}`;
}

function details(sample: SessionSpeedSample, copy: Copy): string {
  const { t, locale } = copy;
  return [
    sample.outputTokens === undefined ? null
      : t("tokens", { value: new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(sample.outputTokens) }),
    sample.durationMs === undefined ? null : t("duration", { value: formatDuration(sample.durationMs, copy) }),
    sample.ttftMs === undefined ? null : t("firstToken", { value: formatDuration(sample.ttftMs, copy) }),
  ].filter(Boolean).join(" · ");
}

function measurementTime(sample: SessionSpeedSample, clock: Intl.DateTimeFormat): string | null {
  const at = Date.parse(sample.measuredAt);
  return Number.isFinite(at) ? clock.format(at) : null;
}

type SpeedPanelProps = {
  theme: PluginTheme;
  hostId: string;
  target: SpeedTarget;
  clock?: Intl.DateTimeFormat;
  readAgentComposer?: ReadAgentComposer;
  runtime?: TurnSpeedRuntime;
};

export function SessionSpeed(props: SpeedPanelProps) {
  const settings = useSettings(CCUSAGE_SETTINGS);
  if (settings.status !== "ready" || !settings.values.showSessionSpeed) return null;
  if ("agentId" in props.target) {
    return <AgentSpeed key={`${props.hostId}:${props.target.agentId}`} {...props} agentId={props.target.agentId} windowSeconds={settings.values.speedWindowSeconds} />;
  }
  return <SessionSpeedContent {...props} windowSeconds={settings.values.speedWindowSeconds} />;
}

function AgentSpeed({ agentId, readAgentComposer, runtime, ...props }: SpeedPanelProps & { agentId: string; windowSeconds: number }) {
  const status = useAgent(agentId, (agent) => agent.status);
  const focused = useFocusedAgentComposer(agentId, readAgentComposer, true);
  const observed = useLiveSpeed({ runtime: focused ? runtime : undefined, agentId, windowSeconds: props.windowSeconds });
  return <SessionSpeedContent {...props} observed={observed} agentRunning={status === null ? undefined : status === "running"} />;
}

function SessionSpeedContent({ theme, hostId, target, clock, windowSeconds, agentRunning, observed }: SpeedPanelProps & {
  windowSeconds: number;
  agentRunning?: boolean;
  observed?: ObservedTurn | null;
}) {
  const copy = useSpeedMessages();
  const { t, locale } = copy;
  const read = useRpc(sessionSpeedRpc);
  const current = "agentId" in target;
  const [expanded, setExpanded] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const query = useQuery({
    queryKey: speedQueryKey(hostId, target),
    queryFn: () => read(target),
    retry: false,
    staleTime: current ? 0 : 30_000,
    refetchOnReconnect: true,
    refetchOnWindowFocus: false,
  });
  const previousRunning = useRef(agentRunning);
  const { refetch } = query;
  useEffect(() => {
    if (previousRunning.current !== agentRunning) {
      previousRunning.current = agentRunning;
      void refetch();
    }
  }, [agentRunning, refetch]);
  const groups = groupTurnSpeeds(query.data?.turns ?? []);
  const active = observed && observed.phase !== "idle" ? observed.phase === "running" : agentRunning ?? query.data?.active === true;
  const pause = observedPause(observed);
  const measured = observedMeasurement(observed);
  const latest = groups[0];
  const primary = latest?.[0];
  const useObserved = !!measured && (active || !primary || Date.parse(measured.sample.measuredAt) >= Date.parse(primary.measuredAt));
  const main = useObserved ? measured.sample : active ? undefined : primary;
  const alternates = main && latest?.filter((sample) => sample.turnId === main.turnId &&
    (sample.basis !== main.basis || sample.source !== main.source));
  const liveDetails = observed && observed.phase !== "idle" && (active || useObserved) ? observed : null;
  const history = groups.some(([sample]) => sample.turnId !== main?.turnId) ? groups.slice(0, RECENT_TURNS) : [];
  const chartBasis = history[0]?.[0];
  const chartSeries = chartBasis ? history.flat().filter((sample) => sample.basis === chartBasis.basis && sample.source === chartBasis.source) : [];
  const chartMaximum = chartSeries.length > 1 ? Math.max(...chartSeries.map(({ tokensPerSecond }) => tokensPerSecond)) : 0;
  const clockFormat = clock ?? new Intl.DateTimeFormat(locale, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
  const muted: TextStyle = { fontSize: FONT.caption, color: theme.colors.foregroundMuted };
  const value: TextStyle = { fontSize: 20, fontWeight: "600", color: theme.colors.foreground, fontVariant: ["tabular-nums"] };

  return (
    <View testID="usage-session-speed" style={{
      padding: 10, gap: 6, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1,
    }}>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
        <Text accessibilityRole="header" style={{ fontSize: FONT.title, fontWeight: "600", color: theme.colors.foreground, flexGrow: 1 }}>
          {t("speed")}
        </Text>
        {active ? <Icon name={pause ? "Pause" : "Activity"} size={13} color={chartColors(theme)[1]} /> : null}
        {active || main ? <Text style={muted}>{t(pause ?? (active ? "live" : "last"))}</Text> : null}
      </View>
      {main ? (
        <>
          <View style={{ flexDirection: "row", alignItems: "baseline", flexWrap: "wrap", gap: 7 }}>
            <Text testID="usage-session-speed-rate" style={value}>{labelRate(main, copy)}</Text>
            <Text style={muted}>
              {useObserved && measured.recent ? t("recentOutput", { value: String(windowSeconds) }) : sourceLabel(main, copy)}
              {main.approximate ? ` · ${t("estimated")}` : ""}
            </Text>
          </View>
          <SpeedNote sample={main} copy={copy} clock={active ? undefined : clockFormat} style={muted} />
          {!active ? alternates?.map((sample) => (
            <SpeedRow key={`${sample.basis}:${sample.source}`} sample={sample} copy={copy} theme={theme} />
          )) : null}
        </>
      ) : (
        <Text style={muted}>
          {t(active ? "collecting" : query.isError ? "error" : query.isPending ? "loading" : "missing")}
        </Text>
      )}
      {query.isError && (main || active) ? <Text style={muted}>{t(active || useObserved ? "historyError" : "error")}</Text> : null}
      {query.isError ? (
        <Pressable accessibilityRole="button" onPress={() => void query.refetch()} style={{ alignSelf: "flex-start", paddingVertical: 6 }}>
          <Text style={{ color: theme.colors.accent, fontSize: FONT.body }}>{t("retry")}</Text>
        </Pressable>
      ) : null}
      {liveDetails ? (
        <>
          <SpeedExpander label={t("turnDetails")} expanded={detailsOpen} onChange={setDetailsOpen} theme={theme} testID="usage-session-speed-details" />
          {detailsOpen ? <LiveTurnDetails turn={liveDetails} copy={copy} theme={theme} /> : null}
        </>
      ) : null}
      {history.length ? (
        <>
          <SpeedExpander label={t("recentTurns")} expanded={expanded} onChange={setExpanded} theme={theme} testID="usage-session-speed-history" />
          {expanded ? history.map((turn) => (
            <View key={turn[0]!.turnId} style={{ borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 6, gap: 3 }}>
              <SpeedNote sample={turn[0]!} copy={copy} clock={clockFormat} style={muted} />
              {turn.map((sample) => <SpeedRow key={`${sample.basis}:${sample.source}`} sample={sample} copy={copy} theme={theme}
                chartMaximum={chartSeries.includes(sample) ? chartMaximum : 0} />)}
            </View>
          )) : null}
          {expanded && (query.data?.hasOlder || groups.length > RECENT_TURNS) ? (
            <Text style={muted}>{t("historyLimit")}</Text>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

function SpeedExpander({ label, expanded, onChange, theme, testID }: {
  label: string;
  expanded: boolean;
  onChange(expanded: boolean): void;
  theme: PluginTheme;
  testID: string;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ expanded }} testID={testID} onPress={() => onChange(!expanded)}
      style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 6, minHeight: 36 }}>
      <Text style={{ flexShrink: 1, color: theme.colors.foreground, fontSize: FONT.body }}>{label}</Text>
      <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={14} color={theme.colors.foregroundMuted} />
    </Pressable>
  );
}

function SpeedNote({ sample, copy, clock, style }: {
  sample: SessionSpeedSample;
  copy: Copy;
  clock?: Intl.DateTimeFormat;
  style: TextStyle;
}) {
  const text = [clock && measurementTime(sample, clock), details(sample, copy)].filter(Boolean).join(" · ");
  return text ? <Text style={style}>{text}</Text> : null;
}

function SpeedRow({ sample, copy, theme, chartMaximum = 0 }: {
  sample: SessionSpeedSample;
  copy: Copy;
  theme: PluginTheme;
  chartMaximum?: number;
}) {
  return (
    <View style={{ gap: 3 }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", flexWrap: "wrap", columnGap: 8 }}>
        <Text style={{ flexGrow: 1, fontSize: FONT.body, color: theme.colors.foregroundMuted }}>
          {sourceLabel(sample, copy)}
        </Text>
        <Text style={{ fontSize: FONT.body, color: theme.colors.foreground, fontVariant: ["tabular-nums"] }}>
          {labelRate(sample, copy)}
        </Text>
      </View>
      {chartMaximum > 0 ? (
        <View style={{ height: 4, borderRadius: 2, backgroundColor: theme.colors.surface2, overflow: "hidden" }}>
          <View importantForAccessibility="no" style={{
            height: "100%", minWidth: 1, width: `${sample.tokensPerSecond / chartMaximum * 100}%`, backgroundColor: chartColors(theme)[0],
          }} />
        </View>
      ) : null}
    </View>
  );
}
