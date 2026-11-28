import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginPopoverProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useCallback, useState, type ReactNode } from "react";
import {
  Pressable,
  Text,
  View,
  type LayoutChangeEvent,
  type PressableStateCallbackType,
} from "react-native";
import type { PeriodKind, UsageView } from "../shared/usage";
import { agentSegments, Legend, PaceBar, PERIOD_OPTIONS, PeriodBars, Segmented } from "./charts";
import {
  TYPICAL_DAYS,
  typicalDay,
  useUsageReport,
  type TypicalDay,
  type UsageReport,
} from "./data";
import { formatAgo, formatCost, formatPercent, formatPeriodLong, formatTokens } from "./format";
import { RefreshUsageButton, UsageRefreshStatus } from "./refresh";
import { AgentList, FONT, Headline, TodayUsage } from "./summary";

// Geometry follows the built-in usage summary and host-monitor in the same footer.
const ICON_SIZE = 14;
const ICON_GAP = 6;
const TEXT_GAP = 8;
const MIN_METER_WIDTH = 24;
const DIGIT_WIDTH = 8;
// Columns shown in the popover for each period kind.
const POPOVER_PERIODS: Record<PeriodKind, number> = { daily: 14, weekly: 8, monthly: 6 };

type HoverState = PressableStateCallbackType & { hovered?: boolean };

function triggerStyle(theme: PluginTheme) {
  return ({ hovered }: HoverState) => ({
    width: "100%" as const,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    overflow: "hidden" as const,
    minHeight: 28,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 8,
    backgroundColor: hovered ? theme.colors.surface2 : undefined,
  });
}

function todayOf(report: UsageReport) {
  return report.daily[report.daily.length - 1];
}

export function UsageSidebarItem({ theme, host, openPopover }: PluginSidebarItemProps) {
  const { data, error, preview } = useUsageReport(host.id);
  const [available, setAvailable] = useState<number | null>(null);
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => setAvailable(event.nativeEvent.layout.width),
    [],
  );

  // Like the built-in usage summary: nothing until there is something to show.
  if (!data && !preview && !error) return null;
  const today = data ? todayOf(data) : undefined;
  const typical = data && !data.historyPending ? typicalDay(data.daily) : null;
  const tokens = formatTokens(today?.usage.totalTokens ?? preview?.totalTokens ?? 0);
  const cost = formatCost(today?.usage.cost ?? null);
  const labelWidth = ICON_SIZE + ICON_GAP + tokens.length * DIGIT_WIDTH;
  const costWidth = labelWidth + TEXT_GAP + cost.length * DIGIT_WIDTH;
  const meterWidth = costWidth + MIN_METER_WIDTH + TEXT_GAP;
  const width = available ?? meterWidth;
  const pace =
    today && today.usage.cost !== null && typical && !typical.estimated
      ? `, ${formatPercent(today.usage.cost / typical.cost)} of a typical day`
      : "";
  const label = today
    ? `${formatPeriodLong("daily", today.period)}, ${tokens} tokens${pace}, ${cost}`
    : preview ? `${formatPeriodLong("daily", preview.today)}, ${tokens} tokens` : "Token usage unavailable";

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => openPopover(UsagePopover)}
      style={triggerStyle(theme)}
    >
      <View
        onLayout={onLayout}
        style={{
          flex: 1,
          minWidth: 0,
          flexDirection: "row",
          alignItems: "center",
          overflow: "hidden",
        }}
      >
        <Icon name="Coins" size={ICON_SIZE} color={theme.colors.foregroundMuted} />
        {today && data ? (
          <>
            {width >= labelWidth ? (
              <Text style={{
                marginLeft: ICON_GAP, fontSize: FONT.body,
                color: theme.colors.foreground, fontVariant: ["tabular-nums"],
              }}>
                {tokens}
              </Text>
            ) : null}
            {width >= meterWidth && typical && today.usage.cost !== null ? (
              <View style={{ flex: 1, minWidth: MIN_METER_WIDTH, marginLeft: TEXT_GAP }}>
                <PaceBar
                  theme={theme}
                  segments={agentSegments(theme, data.agents, today, "cost")}
                  typical={typical.cost}
                  estimated={typical.estimated}
                />
              </View>
            ) : (
              <View style={{ flex: 1 }} />
            )}
            {width >= costWidth ? (
              <Text
                numberOfLines={1}
                style={{
                  marginLeft: TEXT_GAP,
                  fontSize: FONT.body,
                  color: theme.colors.foregroundMuted,
                  fontVariant: ["tabular-nums"],
                }}
              >
                {cost}
              </Text>
            ) : null}
          </>
        ) : (
          <Text
            numberOfLines={1}
            style={{
              marginLeft: ICON_GAP,
              fontSize: FONT.body,
              color: theme.colors.foregroundMuted,
            }}
          >
            {preview ? tokens : "Usage unavailable"}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

export function UsagePopover({ theme, host, layout, openScreen, close }: PluginPopoverProps) {
  const { data, error, isPending, preview, progress } = useUsageReport(host.id);
  const [requestedKind, setKind] = useState<UsageView>("daily");
  const [pickedKey, setPickedKey] = useState<string | null>(null);
  const rootStyle = {
    gap: 12,
    padding: layout.compact ? 16 : 12,
    width: layout.compact ? undefined : 320,
    backgroundColor: theme.colors.surface1,
  };

  const refresh = <RefreshUsageButton theme={theme} hostId={host.id} refreshing={!error && (isPending || !!data?.refreshing)} compact />;
  if (preview) return <View style={rootStyle}><TodayUsage theme={theme} preview={preview} />{refresh}</View>;
  if (!data) {
    return (
      <View style={rootStyle}>
        <Text style={{ fontSize: FONT.title, color: theme.colors.foreground }}>Token usage</Text>
        {isPending ? (
          <UsageRefreshStatus theme={theme} progress={progress} />
        ) : (
          <Text style={{ fontSize: FONT.body, color: theme.colors.statusDanger }}>
            {error?.message ?? "Usage is unavailable."}
          </Text>
        )}
        {error ? refresh : null}
      </View>
    );
  }

  const kind = requestedKind === "total" || data[requestedKind].length > 0 ? requestedKind : "daily";
  const options = PERIOD_OPTIONS.filter(({ value }) => value === "total" || data[value].length > 0);
  const periods = kind === "total" ? (data.total ? [data.total] : []) : data[kind].slice(-POPOVER_PERIODS[kind]);
  const typical = data.historyPending ? null : typicalDay(data.daily);
  const picked = periods.findIndex(({ period }) => period === pickedKey);
  const selected = picked < 0 ? periods.length - 1 : picked;
  const changeKind = (next: UsageView) => {
    setKind(next);
    setPickedKey(null);
  };

  return (
    <View style={rootStyle}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ flex: 1, fontSize: FONT.title, color: theme.colors.foreground }}>
          Token usage
        </Text>
        {options.length > 1 ? <Segmented
          theme={theme}
          options={options}
          value={kind}
          onChange={changeKind}
          accessibilityLabel="Period"
        /> : null}
      </View>
      <Headline theme={theme} kind={kind} periods={periods} index={selected} today={data.today} />
      {kind === "daily" && typical ? (
        <View style={{ gap: 2 }}>
          {typicalCaption(typical).map((line) => (
            <Text key={line} style={{ fontSize: FONT.caption, color: theme.colors.foregroundMuted }}>
              {line}
            </Text>
          ))}
        </View>
      ) : null}
      {kind !== "total" ? (
        <>
          <PeriodBars
            theme={theme}
            kind={kind}
            periods={periods}
            order={data.agents}
            selected={selected}
            onSelect={(index) => setPickedKey(index === periods.length - 1 ? null : periods[index]?.period ?? null)}
            height={52}
            labelEvery={kind === "daily" ? 7 : kind === "weekly" ? 4 : 3}
            today={data.today}
          />
          <Legend theme={theme} order={data.agents} periods={periods} />
        </>
      ) : null}
      <View style={{ height: 1, backgroundColor: theme.colors.border }} />
      {kind === "total" && !data.total ? (
        <Text style={{ fontSize: FONT.body, color: theme.colors.foregroundMuted }}>
          {data.refreshing ? "Collecting all-time usage…" : "All-time usage unavailable. Refresh usage to retry."}
        </Text>
      ) : <AgentList theme={theme} order={data.agents} period={periods[selected]} />}
      <Footer theme={theme} report={data} refresh={refresh} onMore={() => {
        close();
        openScreen({ screenId: "usage", params: pickedKey ? { kind, period: pickedKey } : { kind } });
      }} />
    </View>
  );
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** The meter's tick, then the long-run daily average it is not. Both at API prices, like the headline. */
function typicalCaption(typical: TypicalDay): string[] {
  const cost = formatCost(typical.cost);
  if (!typical.average) {
    return [`Typical day: ${cost} at API prices, a default until there is usage history`];
  }
  const { average } = typical;
  return [
    `Typical day ${cost} · median of ${plural(typical.activeDays, "active day")} in ${TYPICAL_DAYS}`,
    `Average ${formatCost(average.cost)}/day over ${plural(average.days, "day")} · ~${formatCost(average.cost * 30)}/month`,
  ];
}

function Footer({
  theme,
  report,
  refresh,
  onMore,
}: {
  theme: PluginTheme;
  report: UsageReport;
  refresh: ReactNode;
  onMore(): void;
}) {
  return (
    <View style={{ gap: 6 }}>
      {report.refreshing ? <UsageRefreshStatus theme={theme} progress={report.progress} /> : null}
      {!report.refreshing && (report.refreshError || report.sessionRefreshError) ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Icon name="TriangleAlert" size={12} color={theme.colors.statusWarning} />
          <Text
            numberOfLines={2}
            style={{ flex: 1, fontSize: FONT.caption, color: theme.colors.statusWarning }}
          >
            {report.refreshError ? `Could not refresh usage. ${report.refreshError}` : `Could not refresh sessions. ${report.sessionRefreshError}`}
          </Text>
        </View>
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <Text style={{ flex: 1, fontSize: FONT.caption, color: theme.colors.foregroundMuted }}>
          Usage refreshed {report.usageRefreshedAt === undefined ? "—" : formatAgo(report.usageRefreshedAt)}
        </Text>
        {refresh}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open usage details"
          onPress={onMore}
          style={({ hovered }: HoverState) => ({
            flexDirection: "row" as const,
            alignItems: "center" as const,
            gap: 2,
            paddingVertical: 3,
            paddingLeft: 8,
            paddingRight: 4,
            borderRadius: 6,
            backgroundColor: hovered ? theme.colors.surface2 : undefined,
          })}
        >
          <Text style={{ fontSize: FONT.body, color: theme.colors.foreground }}>Details</Text>
          <Icon name="ChevronRight" size={14} color={theme.colors.foregroundMuted} />
        </Pressable>
      </View>
    </View>
  );
}
