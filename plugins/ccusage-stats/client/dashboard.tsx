import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState } from "react";
import { Pressable, Text, TextInput, View, type PressableStateCallbackType } from "react-native";
import type { UsagePeriod, UsageReport, UsageView } from "../shared/usage";
import { Segmented } from "./charts";
import { activityWeeks, formatMetric, METRIC_LABELS, metricValue, modelUsage, type UsageMetric } from "./dashboard-data";
import { formatCost, formatPercent, formatPeriodLong, formatPeriodShort, formatTokens } from "./format";
import { FONT, TokenChange } from "./summary";

type HoverState = PressableStateCallbackType & { hovered?: boolean };
const metrics = ["tokens", "cost", "output", "cache"] as const;
const metricIcons = { tokens: "Layers", cost: "Coins", output: "ArrowUpRight", cache: "Database" };

export function MetricCards({ theme, period, previous, history, kind, narrow, selected, onSelect }: {
  theme: PluginTheme;
  period: UsagePeriod;
  previous?: UsagePeriod;
  history: readonly UsagePeriod[];
  kind: UsageView;
  narrow: boolean;
  selected: UsageMetric;
  onSelect(metric: UsageMetric): void;
}) {
  const { usage } = period;
  const { colors } = theme;
  const perMillion = usage.cost !== null && usage.totalTokens > 0 ? usage.cost / (usage.totalTokens / 1_000_000) : null;
  const caption = { color: colors.foregroundMuted, fontSize: FONT.caption };
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {metrics.map((metric) => {
        const active = selected === metric;
        const value = formatMetric(metricValue(usage, metric), metric);
        const trend = history.slice(-12).map((point) => metricValue(point.usage, metric));
        const peak = Math.max(metric === "cache" ? 1 : Number.EPSILON, ...trend.map((value) => value ?? 0));
        return (
          <Pressable key={metric} accessibilityRole="button" accessibilityState={{ selected: active }}
            accessibilityLabel={`${METRIC_LABELS[metric]} ${value}. Show history`}
            onPress={() => onSelect(metric)}
            style={({ hovered, pressed }: HoverState) => ({
              flexBasis: narrow ? "45%" : 125, flexGrow: 1, flexShrink: 1, minWidth: 0, gap: 4,
              padding: narrow ? 10 : 13, borderRadius: 8, borderWidth: 1,
              borderColor: active ? colors.accent : colors.border,
              backgroundColor: active || hovered || pressed ? colors.surface2 : colors.surface0,
            })}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
              <Icon name={metricIcons[metric]} size={13} color={active ? colors.accent : colors.foregroundMuted} />
              <Text style={[caption, { flexShrink: 1 }]}>{METRIC_LABELS[metric]}</Text>
            </View>
            <Text adjustsFontSizeToFit numberOfLines={1} style={{
              fontSize: narrow ? 24 : 28, fontWeight: "600", color: colors.foreground, fontVariant: ["tabular-nums"],
            }}>{value}</Text>
            {metric === "tokens" ? <TokenChange theme={theme} kind={kind} current={usage.totalTokens} previous={previous} /> : null}
            {metric === "cost" && perMillion !== null ? <Text style={caption}>{formatCost(perMillion)} / 1M tokens</Text> : null}
            {trend.some((value) => value !== null && value > 0) ? (
              <View accessible={false} style={{ marginTop: "auto", paddingTop: 4, flexDirection: "row", alignItems: "flex-end", gap: 2 }}>
                {trend.map((point, index) => (
                  <View key={history[history.length - trend.length + index].period} style={{
                    flex: 1, minWidth: 0, height: Math.max(1, 14 * ((point ?? 0) / peak)), borderRadius: 1,
                    backgroundColor: point ? colors.accent : colors.border, opacity: active ? 0.85 : 0.42,
                  }} />
                ))}
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const monthName = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });
const intensities = [0.24, 0.43, 0.65, 1];

export function ActivityCalendar({ theme, report, width }: { theme: PluginTheme; report: UsageReport; width: number }) {
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const { colors } = theme;
  const weeks = useMemo(() => activityWeeks(report), [report.activity, report.daily]);
  const days = useMemo(() => weeks.flat(), [weeks]);
  if (!days.length) return null;

  const gridWidth = Math.max(130, width - 63);
  const perPage = Math.floor(gridWidth / 14);
  const lastPage = Math.ceil(weeks.length / perPage) - 1;
  const current = Math.min(page, lastPage);
  const end = weeks.length - current * perPage;
  const visibleWeeks = weeks.slice(Math.max(0, end - perPage), end);
  const visibleDays = visibleWeeks.flat().filter((day) => day.tokens !== null);
  const peak = Math.max(1, ...days.map((day) => day.tokens ?? 0));
  const detail = visibleDays.find(({ day }) => day === (hovered ?? selected)) ?? visibleDays.at(-1);
  const caption = { color: colors.foregroundMuted, fontSize: FONT.caption };
  const cellSize = Math.min(14, Math.floor(gridWidth / visibleWeeks.length) - 3);
  const firstDay = visibleDays[0]?.day ?? visibleWeeks[0][0].day;
  const lastDay = visibleDays.at(-1)?.day ?? visibleWeeks.at(-1)![6].day;
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
        <Text style={[caption, { flex: 1 }]}>
          {formatPeriodShort("daily", firstDay)} – {formatPeriodShort("daily", lastDay)}
        </Text>
        {lastPage > 0 ? [
          { delta: 1, icon: "ChevronLeft", title: "Older activity" },
          { delta: -1, icon: "ChevronRight", title: "Newer activity" },
        ].map(({ delta, icon, title }) => {
          const next = current + delta;
          const disabled = next < 0 || next > lastPage;
          return (
            <Pressable key={title} accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ disabled }}
              disabled={disabled} onPress={() => { setPage(next); setHovered(null); }}
              style={{ width: 34, height: 33, alignItems: "center", justifyContent: "center", opacity: disabled ? 0.35 : 1,
                borderWidth: 1, borderColor: colors.border, borderRadius: 6, backgroundColor: colors.surface0 }}>
              <Icon name={icon} size={15} color={colors.foreground} />
            </Pressable>
          );
        }) : null}
      </View>
      <View style={{ flexDirection: "row", gap: 7, alignItems: "flex-end" }}>
        <View style={{ gap: 3 }}>
          {["Mon", "", "Wed", "", "Fri", "", ""].map((label, index) => (
            <Text key={index} style={{ height: cellSize, lineHeight: cellSize, fontSize: 9, color: colors.foregroundMuted }}>{label}</Text>
          ))}
        </View>
        <View style={{ gap: 3 }}>
          <View style={{ height: 12 }}>
            {visibleWeeks.slice(0, -2).map((week, index) => {
              const monthStart = week.find(({ day, tokens }) => tokens !== null && day.endsWith("-01"));
              return monthStart ? (
                <Text key={monthStart.day} pointerEvents="none" style={{
                  position: "absolute", top: 0, left: index * (cellSize + 3), fontSize: 9, color: colors.foregroundMuted,
                }}>{monthName.format(new Date(monthStart.day))}</Text>
              ) : null;
            })}
          </View>
          <View style={{ flexDirection: "row", gap: 3 }}>
            {visibleWeeks.map((week) => (
              <View key={week[0].day} style={{ width: cellSize, gap: 3 }}>
                {week.map(({ day, tokens }) => {
                  if (tokens === null) return <View key={day} style={{ height: cellSize }} />;
                  const intensity = Math.min(3, Math.floor(4 * Math.sqrt(tokens / peak)));
                  return (
                    <Pressable key={day} accessibilityRole="button" accessibilityState={{ selected: selected === day }}
                      accessibilityLabel={`${formatPeriodLong("daily", day)}, ${formatTokens(tokens)} tokens`}
                      onPress={() => setSelected(day)} onHoverIn={() => setHovered(day)} onHoverOut={() => setHovered(null)}
                      onFocus={() => setHovered(day)} onBlur={() => setHovered(null)}
                      style={{ height: cellSize, borderRadius: 2, borderWidth: detail?.day === day ? 1 : 0,
                        borderColor: colors.foreground, justifyContent: "center", alignItems: "center" }}>
                      <View style={{ width: "100%", height: "100%", borderRadius: 2,
                        backgroundColor: tokens ? colors.accent : colors.surface2, opacity: tokens ? intensities[intensity] : 1 }} />
                    </Pressable>
                  );
                })}
              </View>
            ))}
          </View>
        </View>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6, justifyContent: "space-between" }}>
        {detail ? <Text style={caption}>{formatPeriodLong("daily", detail.day)} · {formatTokens(detail.tokens ?? 0)} tokens</Text> : null}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
          <Text style={caption}>Less</Text>
          {intensities.map((opacity) => <View key={opacity} style={{ width: 9, height: 9, borderRadius: 2, backgroundColor: colors.accent, opacity }} />)}
          <Text style={caption}>More</Text>
        </View>
      </View>
    </View>
  );
}

const MODEL_SORTS = [{ value: "tokens", label: "Tokens" }, { value: "cost", label: "Cost" }] as const;

export function ModelBreakdown({ theme, period, narrow }: { theme: PluginTheme; period: UsagePeriod; narrow: boolean }) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"tokens" | "cost">("tokens");
  const [expanded, setExpanded] = useState(false);
  const { colors } = theme;
  const models = useMemo(() => modelUsage(period), [period]);
  const query = search.trim().toLowerCase();
  const matches = models.filter(({ model }) => model.toLowerCase().includes(query)).sort((a, b) => {
    if (sort === "cost") {
      const cost = (b.usage.cost ?? -1) - (a.usage.cost ?? -1);
      if (cost !== 0) return cost;
    }
    return b.usage.totalTokens - a.usage.totalTokens || a.model.localeCompare(b.model);
  });
  const visible = expanded ? matches : matches.slice(0, 6);
  const caption = { fontSize: FONT.caption, color: colors.foregroundMuted };
  if (!models.length) return <Text style={caption}>No model breakdown for this period.</Text>;
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 36,
          flexBasis: 160, flexGrow: 1, paddingHorizontal: 8, borderRadius: 6, borderWidth: 1,
          borderColor: colors.border, backgroundColor: colors.surface0 }}>
          <Icon name="Search" size={14} color={colors.foregroundMuted} />
          <TextInput accessibilityLabel="Filter models" placeholder="Filter models" placeholderTextColor={colors.foregroundMuted}
            value={search} onChangeText={(value) => { setSearch(value); setExpanded(false); }} maxLength={120}
            autoCorrect={false} autoCapitalize="none" style={{ flex: 1, minWidth: 0, minHeight: 36,
              fontSize: narrow ? 16 : FONT.body, color: colors.foreground }} />
        </View>
        <Segmented theme={theme} accessibilityLabel="Sort models by" options={MODEL_SORTS} value={sort} onChange={(next) => setSort(next)} />
      </View>
      {visible.map(({ model, usage }) => {
        const share = period.usage.totalTokens > 0 ? usage.totalTokens / period.usage.totalTokens : 0;
        return (
          <View key={model} style={{ gap: 5, paddingTop: 8, borderTopWidth: 1, borderColor: colors.border }}>
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
              <Text style={{ flex: 1, minWidth: 0, fontSize: FONT.body, fontWeight: "500", color: colors.foreground }}>{model}</Text>
              <Text style={{ fontSize: FONT.body, color: colors.foreground, fontVariant: ["tabular-nums"] }}>
                {formatTokens(usage.totalTokens)}
              </Text>
              <Text accessibilityLabel={`${formatPercent(share)} of tokens`} style={[caption, { width: 34, textAlign: "right" }]}>{formatPercent(share)}</Text>
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <View style={{ flex: 1, height: 3, borderRadius: 2, backgroundColor: colors.surface2, overflow: "hidden" }}>
                <View style={{ height: 3, width: `${Math.min(share, 1) * 100}%`, backgroundColor: colors.accent }} />
              </View>
              <Text accessibilityLabel={`Estimated cost ${formatCost(usage.cost)}`} style={caption}>{formatCost(usage.cost)}</Text>
            </View>
          </View>
        );
      })}
      {matches.length === 0 ? <Text style={caption}>No matching models.</Text> : null}
      {matches.length > 6 ? (
        <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded(!expanded)}
          style={{ alignSelf: "flex-start", justifyContent: "center", minHeight: 34 }}>
          <Text style={{ fontSize: FONT.body, fontWeight: "500", color: colors.accent }}>
            {expanded ? "Show fewer models" : `Show all ${matches.length} models`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
