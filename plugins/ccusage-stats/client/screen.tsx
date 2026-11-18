import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import {
  Pressable, ScrollView, Text, View, type PressableStateCallbackType, type TextStyle, type ViewStyle,
} from "react-native";
import { updatePricesRpc, type PeriodKind, type UsagePeriod } from "../shared/usage";
import { Legend, PERIOD_OPTIONS, PeriodBars, Segmented, SwatchDot } from "./charts";
import {
  agentSwatch, SESSION_USAGE_KEY, USAGE_REPORT_KEY, useUsageReport, type UsageReport,
} from "./data";
import {
  agentLabel, formatCost, formatPercent, formatPeriodLong, formatPeriodRange, formatTokens,
  reportTimeFormatter, shortSessionId,
} from "./format";
import {
  AgentList, Composition, FONT, TokenChange, UsageAmounts, UsageTableHeader, usageColumns,
} from "./summary";

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
  kind: PeriodKind;
  today: string;
  period: UsagePeriod;
  previous?: UsagePeriod;
  selected: number;
  count: number;
  onSelect(index: number): void;
  narrow: boolean;
}) {
  const { usage } = period;
  const perMillion = usage.totalTokens > 0 ? usage.cost / (usage.totalTokens / 1_000_000) : 0;
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
          <Text style={[muted, { fontSize: FONT.caption }]}>{formatCost(perMillion)} per 1,000,000 tokens</Text>
        </View>
      </View>
    </>
  );
}

function RecentSessions({
  theme,
  report,
  clock,
  narrow,
}: {
  theme: PluginTheme;
  report: UsageReport;
  clock: Intl.DateTimeFormat;
  narrow: boolean;
}) {
  const { agents, recentSessions } = report;
  const columns = narrow ? undefined : usageColumns(recentSessions.map((session) => session.usage));
  return (
    <Panel theme={theme} title="Recent sessions">
      {recentSessions.length === 0 ? (
        <Text style={{ fontSize: FONT.body, color: theme.colors.foregroundMuted }}>No sessions yet.</Text>
      ) : (
        <View>
          <UsageTableHeader theme={theme} label="Session" columns={columns} />
          {recentSessions.map((session, index) => {
            const lastActivity = Date.parse(session.lastActivity ?? "");
            const date = Number.isFinite(lastActivity) ? clock.format(lastActivity) : null;
            return (
              <View key={`${session.agent}:${session.id}`} style={{
                flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8,
                borderTopWidth: index > 0 ? 1 : 0, borderTopColor: theme.colors.border,
              }}>
                <SwatchDot swatch={agentSwatch(theme, agents, session.agent)} />
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <Text style={{ fontSize: FONT.body, color: theme.colors.foreground }}>
                    {agentLabel(session.agent)}
                    <Text style={{ color: theme.colors.foregroundMuted, fontVariant: ["tabular-nums"] }}>
                      {`  ${shortSessionId(session.id)}`}
                    </Text>
                  </Text>
                  <Text style={{ fontSize: FONT.caption, color: theme.colors.foregroundMuted }}>
                    {[session.models[0]?.model, date].filter(Boolean).join(" · ")}
                  </Text>
                </View>
                <UsageAmounts theme={theme} usage={session.usage} columns={columns} />
              </View>
            );
          })}
        </View>
      )}
    </Panel>
  );
}

function Body({
  theme,
  compact,
  report,
  priceAction,
  initialKind,
  initialPeriod,
}: {
  theme: PluginTheme;
  compact: boolean;
  report: UsageReport;
  priceAction: ReactNode;
  initialKind: PeriodKind;
  initialPeriod?: string;
}) {
  const [kind, setKind] = useState(initialKind);
  const [pickedKey, setPickedKey] = useState<string | null>(initialPeriod ?? null);
  const [width, setWidth] = useState(0);
  const { today, timezone } = report;
  const periods = report[kind];
  const picked = periods.findIndex(({ period }) => period === pickedKey);
  const selected = picked < 0 ? periods.length - 1 : picked;
  const period = periods[selected];
  const narrow = compact || (width > 0 && width < 610);
  const split = !compact && width >= 740;
  const clock = useMemo(() => reportTimeFormatter(timezone), [timezone]);
  const select = (index: number) => {
    setPickedKey(index === periods.length - 1 ? null : periods[index]?.period ?? null);
  };
  const changeKind = (next: PeriodKind) => {
    if (kind !== next) {
      setKind(next);
      setPickedKey(null);
    }
  };
  const prompt = period
    ? period.usage.inputTokens + period.usage.cacheCreationTokens + period.usage.cacheReadTokens
    : 0;
  const cacheHit = period && prompt > 0 ? formatPercent(period.usage.cacheReadTokens / prompt) : "—";
  const modelCount = period ? new Set(period.agents.flatMap((agent) => agent.models.map((model) => model.model))).size : 0;
  const columnStyle: ViewStyle | undefined = split ? { flex: 1, minWidth: 0 } : undefined;
  const updated = (
    <Text style={{ fontSize: FONT.caption, color: theme.colors.foregroundMuted }}>
      Updated {clock.format(report.generatedAt)} · {timezone}
    </Text>
  );

  return (
    <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)} style={{ gap: 14 }}>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <Segmented theme={theme} options={PERIOD_OPTIONS} value={kind} onChange={changeKind} accessibilityLabel="Period" />
        <View style={{ flex: 1 }} />
        {narrow ? null : updated}
        {priceAction}
      </View>
      {narrow ? updated : null}
      {report.refreshError ? (
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

      <RecentSessions theme={theme} report={report} clock={clock} narrow={narrow} />
    </View>
  );
}

export function UsageScreen({ theme, host, layout, params }: PluginScreenProps) {
  const { data, error, isPending, refetch, isRefetching } = useUsageReport(host.id);
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
  const priceAction = (
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
  );
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: layout.compact ? 12 : 24, alignItems: "center" }}
    >
      <View style={{ width: "100%", maxWidth: MAX_CONTENT_WIDTH, gap: 12 }}>
        {data ? (
          <Body
            key={`${host.id}:${initialKind}:${params.period ?? ""}`}
            theme={theme}
            compact={layout.compact}
            report={data}
            priceAction={priceAction}
            initialKind={initialKind}
            initialPeriod={params.period}
          />
        ) : (
          <>
            {priceAction}
            <View style={{ gap: 12, paddingVertical: 48, alignItems: "center" }}>
              <Icon
                name={isPending ? "Hourglass" : "CircleAlert"}
                size={20}
                color={isPending ? theme.colors.foregroundMuted : theme.colors.statusDanger}
              />
              <Text style={{ fontSize: FONT.title, color: theme.colors.foreground, textAlign: "center" }}>
                {isPending ? "Reading usage logs…" : "Could not read usage"}
              </Text>
              {error ? (
                <Text style={{ fontSize: FONT.body, color: theme.colors.foregroundMuted, textAlign: "center" }}>
                  {error.message}
                </Text>
              ) : null}
              {!isPending ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Try again"
                  disabled={isRefetching}
                  onPress={() => void refetch()}
                  style={({ hovered }: HoverState) => ({
                    paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8,
                    backgroundColor: hovered ? theme.colors.surface1 : theme.colors.surface2,
                  })}
                >
                  <Text style={{ fontSize: FONT.body, color: theme.colors.foreground }}>
                    {isRefetching ? "Trying…" : "Try again"}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          </>
        )}
      </View>
    </ScrollView>
  );
}
