import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, Text, View, type PressableStateCallbackType, type TextStyle, type ViewStyle } from "react-native";
import type { ModelUsage, TodayPreview, Usage, UsagePeriod, UsageView } from "../shared/usage";
import { ShareBar, SwatchDot, type ShareSegment } from "./charts";
import { agentSeriesKey, agentSwatch, chartColors, foldAgents, OTHER_AGENTS_LABEL } from "./data";
import {
  agentLabel,
  formatCost,
  formatPercent,
  formatPeriodLong,
  formatPeriodRange,
  formatScanProgress,
  formatTokens,
} from "./format";

type HoverState = PressableStateCallbackType & { hovered?: boolean };

export const FONT = { caption: 11, body: 12, title: 13 } as const;

export function TodayUsage({ theme, preview }: { theme: PluginTheme; preview: TodayPreview }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ fontSize: FONT.title, color: theme.colors.foreground }}>
        {formatPeriodLong("daily", preview.today)}
      </Text>
      <Text style={{ fontSize: 22, fontWeight: "600", color: theme.colors.foreground }}>
        {formatTokens(preview.totalTokens)} tokens
      </Text>
      <Text style={{ fontSize: FONT.body, color: preview.refreshError ? theme.colors.statusWarning : theme.colors.foregroundMuted }}>
        {preview.refreshError ?? (preview.progress ? formatScanProgress(preview.progress) : "Loading usage history…")}
      </Text>
    </View>
  );
}

const amountStyle: TextStyle = {
  fontSize: FONT.body,
  textAlign: "right",
  fontVariant: ["tabular-nums"],
};

export function Headline({
  theme,
  kind,
  periods,
  index,
  today,
}: {
  theme: PluginTheme;
  kind: UsageView;
  periods: readonly UsagePeriod[];
  index: number;
  today: string;
}) {
  const period = periods[index];
  if (!period) return null;
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ fontSize: FONT.title, fontWeight: "600", color: theme.colors.foreground }}>
        {formatPeriodLong(kind, period.period, today)}
      </Text>
      {kind === "monthly" ? (
        <Text style={{ fontSize: FONT.caption, color: theme.colors.foregroundMuted }}>
          {formatPeriodRange(kind, period.period, today)}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "baseline", flexWrap: "wrap", columnGap: 8 }}>
        <Text style={{ fontSize: 22, fontWeight: "600", color: theme.colors.foreground, fontVariant: ["tabular-nums"] }}>
          {formatTokens(period.usage.totalTokens)}
        </Text>
        <Text style={{ fontSize: FONT.body, color: theme.colors.foregroundMuted }}>tokens</Text>
        <Text style={{ fontSize: FONT.title, color: theme.colors.foreground, fontVariant: ["tabular-nums"] }}>
          {formatCost(period.usage.cost)}
        </Text>
      </View>
      <TokenChange theme={theme} kind={kind} current={period.usage.totalTokens} previous={periods[index - 1]} />
    </View>
  );
}

export function TokenChange({
  theme,
  kind,
  current,
  previous,
}: {
  theme: PluginTheme;
  kind: UsageView;
  current: number;
  previous?: UsagePeriod;
}) {
  const before = previous?.usage.totalTokens ?? 0;
  if (!previous || (!before && !current)) return null;

  const date = formatPeriodLong(kind, previous.period);
  const delta = before > 0 ? current / before - 1 : 0;
  const icon = current === before ? "Minus" : current > before ? "TrendingUp" : "TrendingDown";
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "";
  const detail = before > 0
    ? `${sign}${formatPercent(Math.abs(delta))} vs ${date} (${formatTokens(before)})`
    : `${date} · 0 tokens`;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
      <Icon name={icon} size={12} color={theme.colors.foregroundMuted} />
      <Text style={{ flexShrink: 1, fontSize: FONT.caption, color: theme.colors.foregroundMuted }}>
        {detail}
      </Text>
    </View>
  );
}

export function Composition({ theme, usage }: { theme: PluginTheme; usage: Usage }) {
  const colors = chartColors(theme);
  const parts: (ShareSegment & { label: string })[] = [
    {
      key: "input",
      label: "Input",
      value: usage.inputTokens,
      swatch: { color: colors[0], opacity: 1 },
    },
    {
      key: "output",
      label: "Output",
      value: usage.outputTokens,
      swatch: { color: colors[1], opacity: 1 },
    },
    {
      key: "cache-write",
      label: "Cache write",
      value: usage.cacheCreationTokens,
      swatch: { color: colors[2], opacity: 1 },
    },
    {
      key: "cache-read",
      label: "Cache read",
      value: usage.cacheReadTokens,
      swatch: { color: colors[3], opacity: 1 },
    },
  ];
  const total = Math.max(usage.totalTokens, 1);
  return (
    <View style={{ gap: 8 }}>
      <ShareBar theme={theme} segments={parts} height={8} />
      {parts.map((part) => (
        <View key={part.key} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <SwatchDot swatch={part.swatch} />
          <Text style={{ flex: 1, fontSize: FONT.body, color: theme.colors.foregroundMuted }}>
            {part.label}
          </Text>
          <Text style={[amountStyle, { color: theme.colors.foreground }]}>
            {formatTokens(part.value)}
          </Text>
          <Text style={[amountStyle, { width: 40, color: theme.colors.foregroundMuted }]}>
            {formatPercent(part.value / total)}
          </Text>
        </View>
      ))}
    </View>
  );
}

interface UsageColumns {
  tokens: number;
  cost: number;
}

export function usageColumns(usages: readonly Usage[]): UsageColumns {
  let tokens = 94;
  let cost = 78;
  for (const usage of usages) {
    tokens = Math.max(tokens, formatTokens(usage.totalTokens).length * 8);
    cost = Math.max(cost, formatCost(usage.cost).length * 8);
  }
  return { tokens, cost };
}

export function UsageAmounts({
  theme,
  usage,
  columns,
}: {
  theme: PluginTheme;
  usage: Usage;
  columns?: UsageColumns;
}) {
  const amounts = (
    <>
      <Text style={[amountStyle, { width: columns?.tokens, color: theme.colors.foreground }]}>
        {formatTokens(usage.totalTokens)}
      </Text>
      <Text style={[amountStyle, { width: columns?.cost, color: theme.colors.foregroundMuted }]}>
        {formatCost(usage.cost)}
      </Text>
    </>
  );
  return columns ? amounts : <View style={{ alignItems: "flex-end", gap: 2 }}>{amounts}</View>;
}

export function UsageTableHeader({
  theme,
  label,
  columns,
  trailing,
}: {
  theme: PluginTheme;
  label: string;
  columns?: UsageColumns;
  trailing?: number;
}) {
  const style = { fontSize: FONT.caption, color: theme.colors.foregroundMuted };
  return (
    <View style={{
      flexDirection: "row", alignItems: "center", gap: 10, paddingBottom: 8,
      borderBottomWidth: 1, borderBottomColor: theme.colors.border,
    }}>
      <Text style={[style, { flex: 1 }]}>{label}</Text>
      {columns ? (
        <>
          <Text style={[style, { textAlign: "right", width: columns.tokens }]}>Tokens</Text>
          <Text style={[style, { textAlign: "right", width: columns.cost }]}>Cost</Text>
        </>
      ) : <Text style={style}>Tokens / Cost</Text>}
      {trailing ? <View style={{ width: trailing }} /> : null}
    </View>
  );
}

export function ModelRows({
  theme,
  models,
  columns,
  style,
}: {
  theme: PluginTheme;
  models: readonly ModelUsage[];
  columns?: UsageColumns;
  style?: ViewStyle;
}) {
  return (
    <View style={style}>
      {models.map((model) => (
        <View key={model.model} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6 }}>
          <Text style={{ flex: 1, minWidth: 0, fontSize: FONT.body, color: theme.colors.foregroundMuted }}>
            {model.model}
          </Text>
          <UsageAmounts theme={theme} usage={model.usage} columns={columns} />
        </View>
      ))}
    </View>
  );
}

export function AgentList({
  theme,
  order,
  period,
  expandable = false,
  compact = true,
}: {
  theme: PluginTheme;
  order: readonly string[];
  period: UsagePeriod | undefined;
  expandable?: boolean;
  compact?: boolean;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const agents = !period ? [] : expandable ? period.agents : foldAgents(period.agents, order);
  if (!period || !agents.length) {
    return (
      <Text style={{ fontSize: FONT.body, color: theme.colors.foregroundMuted }}>
        No usage recorded in this period.
      </Text>
    );
  }
  const columns = compact ? undefined : usageColumns(
    agents.flatMap((agent) => [agent.usage, ...agent.models.map((model) => model.usage)]),
  );
  const total = Math.max(period.usage.totalTokens, 1);
  return (
    <View>
      {expandable ? <UsageTableHeader theme={theme} label="Agent" columns={columns} trailing={14} /> : null}
      {agents.map((agent, index) => {
        const canExpand = expandable && agent.agent !== null && agent.models.length > 0;
        const open = canExpand && expanded === agent.agent;
        const name = agent.agent === null ? OTHER_AGENTS_LABEL : agentLabel(agent.agent);
        const share = formatPercent(agent.usage.totalTokens / total);
        const row = (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 38, paddingVertical: 6 }}>
            <View style={{ flex: 1, minWidth: 0, flexDirection: "row", gap: 7, alignItems: "center" }}>
              <SwatchDot swatch={agentSwatch(theme, order, agent.agent)} />
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <Text style={{ fontSize: FONT.body, color: theme.colors.foreground }}>{name}</Text>
                <Text style={{ fontSize: FONT.caption, color: theme.colors.foregroundMuted }}>{share}</Text>
              </View>
            </View>
            <UsageAmounts theme={theme} usage={agent.usage} columns={columns} />
            {expandable ? (
              <View style={{ width: 14 }}>
                {canExpand ? (
                  <Icon name={open ? "ChevronUp" : "ChevronDown"} size={14} color={theme.colors.foregroundMuted} />
                ) : null}
              </View>
            ) : null}
          </View>
        );
        return (
          <View key={agentSeriesKey(agent.agent)} style={{
            borderTopWidth: index > 0 ? 1 : 0,
            borderTopColor: theme.colors.border,
          }}>
            {canExpand ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: open }}
                aria-expanded={open}
                accessibilityLabel={`${name}, ${formatTokens(agent.usage.totalTokens)} tokens, ${formatCost(agent.usage.cost)}`}
                onPress={() => setExpanded(open ? null : agent.agent)}
                style={({ hovered, pressed }: HoverState) => ({
                  marginHorizontal: -6, paddingHorizontal: 6, borderRadius: 6,
                  backgroundColor: hovered || pressed ? theme.colors.surface2 : undefined,
                })}
              >
                {row}
              </Pressable>
            ) : row}
            {open ? (
              <ModelRows theme={theme} models={agent.models} columns={columns} style={{
                backgroundColor: theme.colors.surface0, borderRadius: 6,
                paddingLeft: 16, paddingRight: 24, marginBottom: 8,
              }} />
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
