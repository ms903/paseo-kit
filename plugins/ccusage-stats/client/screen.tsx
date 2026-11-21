import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import {
  Pressable, ScrollView, Text, View, type PressableStateCallbackType, type TextStyle, type ViewStyle,
} from "react-native";
import { updatePricesRpc, type UsagePeriod, type UsageView } from "../shared/usage";
import { Legend, PERIOD_OPTIONS, PeriodBars, Segmented } from "./charts";
import { cacheHitRate, SESSION_USAGE_KEY, USAGE_REPORT_KEY, useUsageReport, type UsageReport } from "./data";
import {
  formatCost, formatPercent, formatPeriodLong, formatPeriodRange, formatTokens, periodDateBounds, reportTimeFormatter,
} from "./format";
import { AgentList, Composition, FONT, TodayUsage, TokenChange } from "./summary";
import { RefreshUsageButton, UsageRefreshStatus } from "./refresh";
import { SessionList } from "./session-list";

type HoverState = PressableStateCallbackType & { hovered?: boolean };

const MAX_CONTENT_WIDTH = 1_080;

function Panel({
  theme,
  title,
  detail,
  style,
  children,
}: {
  theme: PluginTheme;
  title?: string;
  detail?: string;
  style?: ViewStyle;
  children: ReactNode;
}) {
  return (
    <View style={[{
      gap: 12, padding: 16, borderRadius: 12, borderWidth: 1,
      borderColor: theme.colors.border, backgroundColor: theme.colors.surface1,
    }, style]}>
      {title ? (
        <View style={{ flexDirection: "row", alignItems: "baseline", flexWrap: "wrap", gap: 6 }}>
          <Text accessibilityRole="header" style={{ flexGrow: 1, fontSize: 15, fontWeight: "600", color: theme.colors.foreground }}>
            {title}
          </Text>
          {detail ? <Text style={{ fontSize: FONT.caption, color: theme.colors.foregroundMuted }}>{detail}</Text> : null}
        </View>
      ) : null}
      {children}
    </View>
  );
}

function PeriodOverview({
  theme,
  kind,
  today,
  period,
  previous,
  selected,
  count,
  onSelect,
  narrow,
}: {
  theme: PluginTheme;
  kind: UsageView;
  today: string;
  period: UsagePeriod;
  previous?: UsagePeriod;
  selected: number;
  count: number;
  onSelect(index: number): void;
  narrow: boolean;
}) {
  const { usage } = period;
  const perMillion = usage.cost !== null && usage.totalTokens > 0 ? usage.cost / (usage.totalTokens / 1_000_000) : null;
  const muted = { fontSize: FONT.body, color: theme.colors.foregroundMuted };
  const value: TextStyle = {
    fontSize: narrow ? 28 : 36,
    fontWeight: "600",
    color: theme.colors.foreground,
    fontVariant: ["tabular-nums"],
  };
  return (
    <>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <Text accessibilityRole="header" style={{
            fontSize: narrow ? 21 : 25, fontWeight: "600", color: theme.colors.foreground,
          }}>
            {formatPeriodLong(kind, period.period, today)}
          </Text>
          {kind === "monthly" ? <Text style={muted}>{formatPeriodRange(kind, period.period, today)}</Text> : null}
        </View>
        {kind !== "total" ? (
          <View style={{ flexDirection: "row", gap: 4 }}>
            {[
              { label: "Previous period", icon: "ChevronLeft", index: selected - 1 },
              { label: "Next period", icon: "ChevronRight", index: selected + 1 },
            ].map(({ label, icon, index }) => {
              const disabled = index < 0 || index >= count;
              return (
                <Pressable
                  key={label}
                  accessibilityRole="button"
                  accessibilityLabel={label}
                  accessibilityState={{ disabled }}
                  disabled={disabled}
                  onPress={() => onSelect(index)}
                  style={({ hovered, pressed }: HoverState) => ({
                    minWidth: 34, minHeight: 34, alignItems: "center", justifyContent: "center",
                    borderRadius: 7, borderWidth: 1, borderColor: theme.colors.border,
                    backgroundColor: hovered || pressed ? theme.colors.surface2 : theme.colors.surface0,
                    opacity: disabled ? 0.4 : 1,
                  })}
                >
                  <Icon name={icon} size={16} color={theme.colors.foreground} />
                </Pressable>
              );
            })}
          </View>
        ) : null}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", rowGap: 12, columnGap: 28 }}>
        <View style={{ flexGrow: 1, flexBasis: narrow ? 240 : 350, gap: 3 }}>
          <Text style={muted}>Total tokens</Text>
          <Text style={value}>{formatTokens(usage.totalTokens)}</Text>
          <TokenChange theme={theme} kind={kind} current={usage.totalTokens} previous={previous} />
        </View>
        <View style={{ flexGrow: 1, flexBasis: 165, gap: 3 }}>
          <Text style={muted}>Cost</Text>
          <Text style={value}>{formatCost(usage.cost)}</Text>
          {perMillion !== null ? <Text style={[muted, { fontSize: FONT.caption }]}>{formatCost(perMillion)} per 1M tokens</Text> : null}
        </View>
      </View>
    </>
  );
}

function Body({
  theme,
  hostId,
  compact,
  report,
  actions,
  initialKind,
  initialPeriod,
}: {
  theme: PluginTheme;
  hostId: string;
  compact: boolean;
  report: UsageReport;
  actions: ReactNode;
  initialKind: UsageView;
  initialPeriod?: string;
}) {
  const [requestedKind, setKind] = useState(initialKind);
  const kind = requestedKind === "total" || report[requestedKind].length > 0 ? requestedKind : "daily";
  const options = PERIOD_OPTIONS.filter(({ value }) => value === "total" || report[value].length > 0);
  const [pickedKey, setPickedKey] = useState<string | null>(initialPeriod ?? null);
  const [width, setWidth] = useState(0);
  const { today, timezone } = report;
  const periods = kind === "total" ? [] : report[kind];
  const picked = periods.findIndex(({ period }) => period === pickedKey);
  const selected = picked < 0 ? periods.length - 1 : picked;
  const period = kind === "total" ? report.total : periods[selected];
  const narrow = compact || (width > 0 && width < 610);
  const split = !compact && width >= 740;
  const clock = useMemo(() => reportTimeFormatter(timezone), [timezone]);
  const sessionPeriod = period && kind !== "total" ? {
    ...periodDateBounds(kind, period.period, today),
    label: formatPeriodRange(kind, period.period, today),
  } : undefined;
  const select = (index: number) => {
    setPickedKey(index === periods.length - 1 ? null : periods[index]?.period ?? null);
  };
  const changeKind = (next: UsageView) => {
    if (kind !== next) {
      setKind(next);
      setPickedKey(null);
    }
  };
  const hitRate = period ? cacheHitRate(period.usage) : null;
  const cacheHit = hitRate === null ? "—" : formatPercent(hitRate);
  const modelCount = period ? new Set(period.agents.flatMap((agent) => agent.models.map((model) => model.model))).size : 0;
  const columnStyle: ViewStyle | undefined = split ? { flex: 1, minWidth: 0 } : undefined;
  const refreshClock = useMemo(() => reportTimeFormatter(timezone, true), [timezone]);
  const updated = (
    <Text style={{ fontSize: FONT.caption, color: theme.colors.foregroundMuted }}>
      Usage last refreshed {report.usageRefreshedAt === undefined ? "—" : refreshClock.format(report.usageRefreshedAt)} · {timezone}
    </Text>
  );

  return (
    <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)} style={{ gap: 14 }}>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        {options.length > 1 ? <Segmented theme={theme} options={options} value={kind} onChange={changeKind} accessibilityLabel="Period" /> : null}
        <View style={{ flex: 1 }} />
        {narrow ? null : updated}
        {actions}
      </View>
      {narrow ? updated : null}
      {report.refreshing ? <UsageRefreshStatus theme={theme} progress={report.progress} /> : null}
      {report.refreshError && !report.refreshing ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Icon name="TriangleAlert" size={14} color={theme.colors.statusWarning} />
          <Text style={{ flex: 1, fontSize: FONT.body, color: theme.colors.statusWarning }}>
            Could not refresh usage. {report.refreshError}
          </Text>
        </View>
      ) : null}

      {period ? (
        <>
          <Panel theme={theme}>
            <PeriodOverview
              theme={theme}
              kind={kind}
              today={today}
              period={period}
              previous={periods[selected - 1]}
              selected={selected}
              count={periods.length}
              onSelect={select}
              narrow={narrow}
            />
            {kind !== "total" ? (
              <View style={{
                gap: 10, marginTop: 2, paddingTop: 12,
                borderTopWidth: 1, borderTopColor: theme.colors.border,
              }}>
                <Text style={{ fontSize: FONT.body, fontWeight: "600", color: theme.colors.foreground }}>Token history</Text>
                <PeriodBars
                  theme={theme}
                  kind={kind}
                  periods={periods}
                  order={report.agents}
                  selected={selected}
                  onSelect={select}
                  height={narrow ? 108 : 150}
                  labelEvery={kind === "daily" ? 5 : 1}
                  today={today}
                  showScale={width >= 480}
                />
                <Legend theme={theme} order={report.agents} periods={periods} />
              </View>
            ) : null}
          </Panel>

          <View style={{ flexDirection: split ? "row" : "column", alignItems: split ? "flex-start" : "stretch", gap: 14 }}>
            <Panel theme={theme} title="Token breakdown" detail={`Cache hit rate ${cacheHit}`} style={columnStyle}>
              <Composition theme={theme} usage={period.usage} />
            </Panel>
            <Panel
              theme={theme}
              title="By agent"
              detail={`${period.agents.length} ${period.agents.length === 1 ? "agent" : "agents"} · ${modelCount} ${modelCount === 1 ? "model" : "models"}`}
              style={columnStyle}
            >
              <AgentList theme={theme} order={report.agents} period={period} expandable compact={narrow} />
            </Panel>
          </View>
        </>
      ) : null}

      {kind === "total" && !period ? (
        <Panel theme={theme} title="All time">
          <Text style={{ fontSize: FONT.body, color: theme.colors.foregroundMuted }}>
            {report.refreshing ? "Collecting all-time usage…" : "All-time usage unavailable. Refresh usage to retry."}
          </Text>
        </Panel>
      ) : null}

      <Panel theme={theme} title="Sessions">
        <SessionList theme={theme} hostId={hostId} report={report} clock={clock} narrow={narrow} period={sessionPeriod} />
      </Panel>
    </View>
  );
}

export function UsageScreen({ theme, host, layout, params }: PluginScreenProps) {
  const { data, error, isPending, preview, progress } = useUsageReport(host.id);
  const updatePrices = useRpc(updatePricesRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const initialKind = PERIOD_OPTIONS.find(({ value }) => value === params.kind)?.value ?? "daily";
  const priceUpdate = useMutation({
    mutationFn: (_hostId: string) => updatePrices({}),
    retry: false,
    onSuccess: async (report, hostId) => {
      const queryKey = [...USAGE_REPORT_KEY, hostId];
      await queryClient.cancelQueries({ queryKey });
      queryClient.setQueryData(queryKey, report);
      void queryClient.invalidateQueries({ queryKey: [...SESSION_USAGE_KEY, hostId] });
    },
    onError: () => toast.error("Could not update prices"),
  });
  const actions = (
    <View style={{ alignSelf: "flex-end", flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
      <RefreshUsageButton theme={theme} hostId={host.id} refreshing={!error && (isPending || !!data?.refreshing)} />
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ busy: priceUpdate.isPending, disabled: priceUpdate.isPending }}
        disabled={priceUpdate.isPending}
        onPress={() => priceUpdate.mutate(host.id)}
        style={({ hovered, pressed }: HoverState) => ({
          alignSelf: "flex-end", flexDirection: "row", alignItems: "center", gap: 6,
          minHeight: 34, paddingHorizontal: 10, borderRadius: 7,
          borderWidth: 1, borderColor: theme.colors.border,
          backgroundColor: hovered || pressed ? theme.colors.surface2 : theme.colors.surface1,
        })}
      >
        <Icon name="RefreshCw" size={14} color={theme.colors.foregroundMuted} />
        <Text style={{ fontSize: FONT.body, color: theme.colors.foreground }}>
          {priceUpdate.isPending ? "Updating prices…" : "Update prices"}
        </Text>
      </Pressable>
    </View>
  );
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: layout.compact ? 12 : 24, alignItems: "center" }}
    >
      <View style={{ width: "100%", maxWidth: MAX_CONTENT_WIDTH, gap: 12 }}>
        {data ? (
          <Body
            key={`${host.id}:${initialKind}:${params.period ?? ""}`}
            theme={theme}
            hostId={host.id}
            compact={layout.compact}
            report={data}
            actions={actions}
            initialKind={initialKind}
            initialPeriod={params.period}
          />
        ) : preview ? (
          <>
            {actions}
            <Panel theme={theme}><TodayUsage theme={theme} preview={preview} /></Panel>
          </>
        ) : (
          <>
            {actions}
            {isPending ? (
              <UsageRefreshStatus theme={theme} progress={progress} />
            ) : (
              <View style={{ gap: 12, paddingVertical: 48, alignItems: "center" }}>
                <Icon name="CircleAlert" size={20} color={theme.colors.statusDanger} />
                <Text style={{ fontSize: FONT.title, color: theme.colors.foreground, textAlign: "center" }}>
                  Could not read usage
                </Text>
                {error ? (
                  <Text style={{ fontSize: FONT.body, color: theme.colors.foregroundMuted, textAlign: "center" }}>
                    {error.message}
                  </Text>
                ) : null}
              </View>
            )}
          </>
        )}
      </View>
    </ScrollView>
  );
}
