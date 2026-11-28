import type { PluginTheme } from "@getpaseo/plugin";
import { useState } from "react";
import { Pressable, Text, View, type LayoutChangeEvent, type PressableStateCallbackType } from "react-native";
import type { PeriodKind, UsagePeriod, UsageView } from "../shared/usage";
import { formatMetric, METRIC_LABELS, metricValue, type UsageMetric } from "./dashboard-data";
import { agentSeriesKey, agentSwatch, foldAgents, OTHER_AGENTS_LABEL, type Swatch } from "./data";
import { agentLabel, formatPeriodLong, formatPeriodShort } from "./format";

// Thin marks with a hairline of surface between neighbours, so segments read apart without outlines.
const SEGMENT_GAP = 2;

type HoverState = PressableStateCallbackType & { hovered?: boolean };

export interface SegmentedOption<Value extends string> {
  value: Value;
  label: string;
}

/** A compact segmented control: a recessed track with the selected option raised. */
export function Segmented<Value extends string>({
  theme,
  options,
  value,
  onChange,
  accessibilityLabel,
}: {
  theme: PluginTheme;
  options: readonly SegmentedOption<Value>[];
  value: Value;
  onChange(value: Value): void;
  accessibilityLabel: string;
}) {
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={accessibilityLabel}
      style={{
        flexDirection: "row",
        padding: 2,
        gap: 2,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
      }}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            aria-selected={selected}
            accessibilityLabel={option.label}
            onPress={() => onChange(option.value)}
            style={({ hovered }: HoverState) => ({
              minWidth: 28,
              paddingVertical: 6,
              paddingHorizontal: 10,
              borderRadius: 6,
              alignItems: "center" as const,
              backgroundColor: selected
                ? theme.colors.surface0
                : hovered
                  ? theme.colors.surface1
                  : undefined,
            })}
          >
            <Text
              style={{
                fontSize: 12,
                color: selected ? theme.colors.foreground : theme.colors.foregroundMuted,
                fontWeight: selected ? "600" : "400",
              }}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export const PERIOD_OPTIONS: readonly SegmentedOption<UsageView>[] = [
  { value: "daily", label: "Day" },
  { value: "weekly", label: "Week" },
  { value: "monthly", label: "Month" },
  { value: "total", label: "Total" },
];

export function SwatchDot({ swatch, size = 8 }: { swatch: Swatch; size?: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: 2,
        backgroundColor: swatch.color,
        opacity: swatch.opacity,
      }}
    />
  );
}

export interface ShareSegment {
  key: string;
  value: number;
  swatch: Swatch;
}

/** A horizontal 100% bar: each segment's width is its share. An empty bar shows only the track. */
export function ShareBar({
  theme,
  segments,
  height = 6,
}: {
  theme: PluginTheme;
  segments: readonly ShareSegment[];
  height?: number;
}) {
  const visible = segments.filter((segment) => segment.value > 0);
  return (
    <View
      style={{
        flexDirection: "row",
        height,
        gap: visible.length > 1 ? SEGMENT_GAP : 0,
        borderRadius: height / 2,
        overflow: "hidden",
        backgroundColor: visible.length === 0 ? theme.colors.surface2 : undefined,
      }}
    >
      {visible.map((segment) => (
        <View
          key={segment.key}
          style={{
            flexGrow: segment.value,
            flexBasis: 0,
            // Keep tiny shares visible as a sliver rather than vanishing.
            minWidth: 2,
            backgroundColor: segment.swatch.color,
            opacity: segment.swatch.opacity,
          }}
        />
      ))}
    </View>
  );
}

/**
 * Today against a typical day: the fill is today's total, split by agent, and a tick marks the
 * typical day. The track spans twice the typical day, so the tick sits mid-track until today
 * passes double; then the track stretches to today and the tick slides left. A default typical
 * day gets a muted tick, since it says nothing about this machine. Segments and typical share
 * one unit.
 */
export function PaceBar({
  theme,
  segments,
  typical,
  estimated = false,
  height = 6,
}: {
  theme: PluginTheme;
  segments: readonly ShareSegment[];
  typical: number;
  estimated?: boolean;
  height?: number;
}) {
  const total = segments.reduce((sum, segment) => sum + Math.max(segment.value, 0), 0);
  const scale = Math.max(total, typical * 2, 1);
  const tickHeight = height + 4;
  return (
    <View style={{ height: tickHeight, justifyContent: "center" }}>
      <View
        style={{
          height,
          borderRadius: height / 2,
          // Outlined like host-monitor's meters, so the empty part of the track reads as a track.
          borderWidth: 1,
          borderColor: theme.colors.border,
          overflow: "hidden",
          backgroundColor: theme.colors.surface2,
        }}
      >
        {total > 0 ? (
          <View style={{ width: `${(total / scale) * 100}%`, minWidth: 2 }}>
            <ShareBar theme={theme} segments={segments} height={height - 2} />
          </View>
        ) : null}
      </View>
      <View
        style={{
          position: "absolute",
          left: `${(typical / scale) * 100}%`,
          width: 2,
          height: tickHeight,
          marginLeft: -1,
          borderRadius: 1,
          backgroundColor: estimated ? theme.colors.foregroundMuted : theme.colors.foreground,
        }}
      />
    </View>
  );
}

export function agentSegments(
  theme: PluginTheme,
  order: readonly string[],
  period: UsagePeriod | undefined,
  measure: "totalTokens" | "cost" | "outputTokens" = "totalTokens",
  swatchOrder = order,
): ShareSegment[] {
  if (!period) return [];
  return foldAgents(period.agents, order).map((agent) => ({
    key: agentSeriesKey(agent.agent),
    value: agent.usage[measure] ?? 0,
    swatch: agentSwatch(theme, swatchOrder, agent.agent),
  }));
}

/**
 * Stacked columns, one per period, with agents bottom-up in legend order.
 */
export function PeriodBars({
  theme,
  kind,
  periods,
  order,
  swatchOrder = order,
  selected,
  onSelect,
  height,
  labelEvery,
  today,
  showScale = false,
  metric = "tokens",
}: {
  theme: PluginTheme;
  kind: PeriodKind;
  periods: readonly UsagePeriod[];
  order: readonly string[];
  swatchOrder?: readonly string[];
  selected: number;
  onSelect(index: number): void;
  height: number;
  /** Label every Nth column, counted back from the newest. */
  labelEvery: number;
  today: string;
  showScale?: boolean;
  metric?: UsageMetric;
}) {
  const [plotWidth, setPlotWidth] = useState(0);
  const onPlotLayout = (event: LayoutChangeEvent) => setPlotWidth(event.nativeEvent.layout.width);
  const values = periods.map(({ usage }) => metricValue(usage, metric));
  const peak = Math.max(metric === "cost" ? 0.01 : 1, ...values.map((value) => value ?? 0));
  const step = 10 ** Math.floor(Math.log10(peak / 2));
  const max = showScale && metric !== "cache" ? Math.ceil(peak / (2 * step)) * 2 * step : peak;
  const ticks = max > 1 || metric === "cache" ? [max, max / 2, 0] : [max, 0];
  const measure = metric === "cost" ? "cost" : metric === "output" ? "outputTokens" : "totalTokens";
  const barWidth = periods.length > 20 ? "70%" : "56%";
  const lastIndex = periods.length - 1;
  const labelWidth = kind === "monthly" ? 57 : 49;
  const slotWidth = (plotWidth || 240) / Math.max(periods.length, 1);
  const labelStep = Math.max(labelEvery, Math.ceil(labelWidth / slotWidth));
  return (
    <View style={{ flexDirection: "row", gap: 10, paddingTop: showScale ? 5 : 0 }}>
      {showScale ? (
        <View style={{ height: height + 12, marginTop: -6, alignItems: "flex-end", justifyContent: "space-between" }}>
          {ticks.map((tick) => (
            <Text key={tick} style={{ fontSize: 10, lineHeight: 12, fontVariant: ["tabular-nums"], color: theme.colors.foregroundMuted }}>
              {formatMetric(tick, metric)}
            </Text>
          ))}
        </View>
      ) : null}
      <View onLayout={onPlotLayout} style={{ flex: 1, minWidth: 0, gap: 8 }}>
        <View style={{ height, flexDirection: "row" }}>
          {(showScale ? ticks : [0]).map((tick) => (
            <View key={tick} pointerEvents="none" style={{
              position: "absolute", top: `${(1 - tick / max) * 100}%`, left: 0, right: 0,
              height: 1, backgroundColor: theme.colors.border, opacity: tick === 0 ? 1 : 0.55,
            }} />
          ))}
          {periods.map((period, index) => {
            const isSelected = index === selected;
            const value = values[index];
            const barHeight = ((value ?? 0) / max) * height;
            const segments = !value ? [] : metric === "cache"
              ? [{ key: "cache", value, swatch: { color: theme.colors.accent, opacity: 1 } }]
              : agentSegments(theme, order, period, measure, swatchOrder).filter((segment) => segment.value > 0);
            return (
              <Pressable
                key={period.period}
                accessibilityRole="button"
                accessibilityState={{ selected: isSelected }}
                accessibilityLabel={`${formatPeriodLong(kind, period.period, today)}, ${METRIC_LABELS[metric]} ${formatMetric(value, metric)}`}
                onPress={() => onSelect(index)}
                style={({ hovered, pressed }: HoverState) => ({
                  flex: 1,
                  minWidth: 0,
                  justifyContent: "flex-end" as const,
                  alignItems: "center" as const,
                  borderRadius: 4,
                  backgroundColor: hovered || pressed ? theme.colors.surface2 : undefined,
                })}
              >
                {segments.length ? (
                  <View style={{
                    width: barWidth, maxWidth: 42, height: Math.max(barHeight, 2), flexDirection: "column-reverse",
                    gap: barHeight > segments.length * 4 ? 1 : 0,
                    borderTopLeftRadius: 4, borderTopRightRadius: 4, overflow: "hidden",
                  }}>
                    {segments.map((segment) => (
                      <View key={segment.key} style={{
                        flexGrow: segment.value, flexBasis: 0,
                        backgroundColor: segment.swatch.color, opacity: segment.swatch.opacity,
                      }} />
                    ))}
                  </View>
                ) : null}
                {isSelected ? (
                  <View pointerEvents="none" style={{ position: "absolute", bottom: -3, height: 2,
                    width: "48%", maxWidth: 16, borderRadius: 1, backgroundColor: theme.colors.accent }} />
                ) : null}
              </Pressable>
            );
          })}
        </View>
        <View style={{ flexDirection: "row", minHeight: 13 }}>
          {periods.map((period, index) => {
            const position = slotWidth >= labelWidth ? "center" : index === 0 ? "left" : index === lastIndex ? "right" : "center";
            const labelled = index === selected || (
              (lastIndex - index) % labelStep === 0 && Math.abs(index - selected) >= labelStep
            );
            return (
              <View key={period.period} style={{
                flex: 1, minWidth: 0, overflow: "visible",
                alignItems: position === "left" ? "flex-start" : position === "right" ? "flex-end" : "center",
              }}>
                {labelled ? (
                  <Text numberOfLines={1} style={{
                    width: labelWidth, maxWidth: labelWidth, textAlign: position, fontSize: 10,
                    fontWeight: index === selected ? "600" : "400",
                    color: index === selected ? theme.colors.foreground : theme.colors.foregroundMuted,
                  }}>
                    {formatPeriodShort(kind, period.period)}
                  </Text>
                ) : null}
              </View>
            );
          })}
        </View>
      </View>
    </View>
  );
}

/** One line per agent present in the window: swatch and name. Identity never rests on color alone. */
export function Legend({
  theme,
  order,
  periods,
}: {
  theme: PluginTheme;
  order: readonly string[];
  periods: readonly UsagePeriod[];
}) {
  const present = new Set(
    periods.flatMap((period) => foldAgents(period.agents, order).map((a) => a.agent)),
  );
  const keys = [
    ...order.filter((agent) => present.has(agent)),
    ...(present.has(null) ? [null] : []),
  ];
  if (keys.length < 2) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 12, rowGap: 4 }}>
      {keys.map((agent) => (
        <View key={agentSeriesKey(agent)} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
          <SwatchDot swatch={agentSwatch(theme, order, agent)} />
          <Text style={{ fontSize: 11, color: theme.colors.foregroundMuted }}>
            {agent === null ? OTHER_AGENTS_LABEL : agentLabel(agent)}
          </Text>
        </View>
      ))}
    </View>
  );
}
