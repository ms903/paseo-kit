import type { PluginTheme, RpcOutput } from "@getpaseo/plugin";
import { useSettings, type PluginHostProps, type PluginPopoverProps, type PluginScreenProps, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useCallback, useState, type ReactNode } from "react";
import {
  Pressable,
  ScrollView,
  Text,
  View,
  type LayoutChangeEvent,
  type PressableStateCallbackType,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { defaults, footerMetrics, settingsDefinition, type MetricKey, type MonitorSettings } from "../shared/settings";
import type { GpuUsage, hostStatsRpc } from "../shared/stats";
import { formatBytes, formatCompactRate, formatPercent, formatRate, formatUptime, gpuSummary } from "./format";
import { GpuSection } from "./gpus";
import {
  Meter,
  MonitorCard,
  Sparkline,
  diskPercent,
  memoryPercent,
  memorySeverity,
  percentSeverity,
  scaleToPeak,
  severityColor,
  sumDisks,
  useHostGpus,
  useHostStats,
  type Severity,
} from "./stats";

// Geometry follows the built-in usage summary in the same footer.
const ICON_SIZE = 14;
const FONT_SIZE = 12;
const ICON_GAP = 6;
const METRIC_GAP = 10;
const MIN_METER_WIDTH = 16;
const METER_GAP = 4;
const METER_HEIGHT = 6;
// Between the download and upload numbers that share one icon.
const PAIR_SEPARATOR = "/";
const PAIR_SEPARATOR_WIDTH = 8;

export const HOST_MONITOR_SCREEN_ID = "host-monitor";

type HostStats = RpcOutput<typeof hostStatsRpc>;

/** Which metrics fit, and whether the percentages get meters. */
interface LineLayout {
  shown: readonly Metric[];
  meters: boolean;
}

interface Metric {
  key: MetricKey;
  icon: string;
  /** One number, or two (download and upload) sharing the icon. */
  texts: readonly string[];
  wideValue?: boolean;
  percent?: number;
  /** Sets the color of a metric with a percent. */
  severity?: Severity;
}

// Keep the processor readings together when space is tight.
const DROP_ORDER: readonly MetricKey[] = ["network", "disk"];

function metricsOf(stats: HostStats, gpu: ReturnType<typeof gpuSummary>): Metric[] {
  const { current, memory, network, disks } = stats;
  const ram = memoryPercent(memory);
  const metrics: Metric[] = [
    {
      key: "cpu",
      icon: "Cpu",
      texts: [formatPercent(current.cpuPercent)],
      percent: current.cpuPercent,
      severity: percentSeverity(current.cpuPercent),
    },
    {
      key: "memory",
      icon: "MemoryStick",
      texts: [formatPercent(ram)],
      percent: ram,
      severity: memorySeverity(memory),
    },
  ];
  if (gpu) {
    metrics.push({
      key: "gpu",
      icon: "CircuitBoard",
      texts: [gpu.text],
      wideValue: gpu.wide,
      percent: gpu.percent,
      severity: gpu.percent === undefined ? undefined : percentSeverity(gpu.percent),
    });
  }
  if (disks.length > 0) {
    const { percent } = sumDisks(disks);
    metrics.push({
      key: "disk",
      icon: "HardDrive",
      texts: [formatPercent(percent)],
      percent,
      severity: percentSeverity(percent),
    });
  }
  if (network) {
    metrics.push({
      key: "network",
      icon: "ArrowDownUp",
      texts: [formatCompactRate(current.rxBytesPerSec), formatCompactRate(current.txBytesPerSec)],
    });
  }
  return metrics;
}

// The widest text a slot can hold: rounded percents top out at 100%, compact rates at 4 characters.
const SLOT_TEMPLATES = ["100%", "888K", "8.8M"];
// Used until the templates are measured.
const ESTIMATED_SLOT_WIDTH = FONT_SIZE * 2.6;
const TEXT_GAP = 4;

function MetricLine({
  theme,
  layout,
  slotWidth,
}: {
  theme: PluginTheme;
  layout: LineLayout;
  slotWidth: number;
}) {
  return layout.shown.map((metric, index) => {
    const metered = layout.meters && metric.percent !== undefined;
    const valueColor =
      metric.severity !== undefined && metric.severity !== "normal"
        ? severityColor(theme, metric.severity)
        : theme.colors.foreground;
    const textStyle = { color: valueColor, fontSize: FONT_SIZE, fontVariant: ["tabular-nums" as const] };
    const [first, second] = metric.texts;
    return (
      <View
        key={metric.key}
        style={{
          flexDirection: "row",
          alignItems: "center",
          marginLeft: index === 0 ? 0 : METRIC_GAP,
          // Meter slots share the leftover width, so the line fills the row.
          flexGrow: metered ? 1 : 0,
          flexShrink: metered ? 1 : 0,
        }}
      >
        <Icon name={metric.icon} size={ICON_SIZE} color={theme.colors.foregroundMuted} />
        {metered ? (
          <Meter
            theme={theme}
            percent={metric.percent ?? 0}
            severity={metric.severity}
            height={METER_HEIGHT}
            style={{ flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: MIN_METER_WIDTH, marginLeft: ICON_GAP }}
          />
        ) : null}
        {/* Fixed slots: changing digits never move anything around them. A lone number sits
            right-aligned; a pair hugs the separator between them. */}
        <Text
          numberOfLines={1}
          style={[textStyle, { width: metric.wideValue ? 2 * slotWidth : slotWidth, marginLeft: metered ? METER_GAP : TEXT_GAP, textAlign: "right" }]}
        >
          {first}
        </Text>
        {second !== undefined ? (
          <>
            <Text
              style={{
                width: PAIR_SEPARATOR_WIDTH,
                textAlign: "center",
                color: theme.colors.foregroundMuted,
                fontSize: FONT_SIZE,
              }}
            >
              {PAIR_SEPARATOR}
            </Text>
            <Text numberOfLines={1} style={[textStyle, { width: slotWidth, textAlign: "left" }]}>
              {second}
            </Text>
          </>
        ) : null}
      </View>
    );
  });
}

/** Width of a meterless line; depends only on fixed sizes, never on values. */
function lineWidth(metrics: readonly Metric[], slotWidth: number): number {
  let width = Math.max(metrics.length - 1, 0) * METRIC_GAP;
  for (const { texts, wideValue } of metrics) {
    const slots = texts.length + (wideValue ? 1 : 0);
    width += ICON_SIZE + TEXT_GAP + slots * slotWidth + (texts.length - 1) * PAIR_SEPARATOR_WIDTH;
  }
  return width;
}

/** Meters when everything fits, else plain numbers; when neither fits, drop a metric and retry. */
function chooseLayout(available: number | null, metrics: readonly Metric[], slotWidth: number): LineLayout {
  let shown = metrics;
  if (available === null) return { shown, meters: false };
  for (const drop of [...DROP_ORDER, null]) {
    const plain = lineWidth(shown, slotWidth);
    const meterCount = shown.filter((m) => m.percent !== undefined).length;
    if (plain + meterCount * (ICON_GAP + MIN_METER_WIDTH + METER_GAP - TEXT_GAP) <= available) {
      return { shown, meters: true };
    }
    if (plain <= available || drop === null) return { shown, meters: false };
    shown = shown.filter((m) => m.key !== drop);
  }
  return { shown, meters: false };
}

function triggerStyle(theme: PluginTheme) {
  return ({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => ({
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

function describe(hostLabel: string, stats: HostStats, gpu: ReturnType<typeof gpuSummary>, settings: MonitorSettings): string {
  const { current, memory, network, disks } = stats;
  const parts: string[] = [];
  if (settings.cpu) parts.push(`CPU ${formatPercent(current.cpuPercent)}`);
  if (settings.memory) parts.push(`memory ${formatPercent(memoryPercent(memory))}`);
  if (settings.memory && memory.pressure) parts.push(`memory pressure ${memory.pressure}`);
  if (settings.gpu && gpu) parts.push(gpu.description);
  if (settings.disk && disks.length > 0) {
    const disk = sumDisks(disks);
    parts.push(`disk ${formatPercent(disk.percent)}, ${formatBytes(disk.availableBytes)} available`);
  }
  if (settings.network && network) {
    parts.push(
      `download ${formatRate(current.rxBytesPerSec)}`,
      `upload ${formatRate(current.txBytesPerSec)}`,
    );
  }
  return `${hostLabel} host status, ${parts.join(", ")}`;
}

function layoutWidth(event: LayoutChangeEvent): number {
  return event.nativeEvent.layout.width;
}

export function HostStatusItem({ theme, host, openPopover }: PluginSidebarItemProps) {
  const preferences = useSettings(settingsDefinition);
  const settings = preferences.status === "ready" ? preferences.values : defaults;
  const refreshMs = Number(settings.refreshSeconds) * 1000;
  const visible = preferences.status !== "loading" && footerMetrics.some(key => settings[key]);
  const { data } = useHostStats(host.id, refreshMs, visible);
  const { data: gpus } = useHostGpus(host.id, refreshMs, visible && settings.gpu);
  const [available, setAvailable] = useState<number | null>(null);
  const [measuredSlot, setMeasuredSlot] = useState<number | null>(null);
  const onAvailable = useCallback((e: LayoutChangeEvent) => setAvailable(layoutWidth(e)), []);
  const onTemplate = useCallback((e: LayoutChangeEvent) => {
    const width = Math.ceil(layoutWidth(e));
    setMeasuredSlot((current) => Math.max(current ?? 0, width));
  }, []);

  // Like the built-in usage summary: nothing until there is something to show.
  if (!visible || !data) return null;
  const gpu = settings.gpu ? gpuSummary(gpus) : null;
  const metrics = metricsOf(data, gpu).filter(metric => settings[metric.key]);
  if (!metrics.length) return null;
  const slotWidth = measuredSlot ?? ESTIMATED_SLOT_WIDTH;
  const layout = chooseLayout(available, metrics, slotWidth);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={describe(host.label, data, gpu, settings)}
      onPress={() => openPopover(HostPopover)}
      style={triggerStyle(theme)}
    >
      <View
        style={{ flex: 1, minWidth: 0, flexDirection: "row", flexWrap: "wrap", alignItems: "center", overflow: "hidden" }}
        onLayout={onAvailable}
      >
        <MetricLine theme={theme} layout={layout} slotWidth={slotWidth} />
      </View>
      {/* Off-screen templates fix the slot width once, independent of live values. */}
      <View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ position: "absolute", top: 0, left: 0, width: 10_000, opacity: 0 }}
      >
        {SLOT_TEMPLATES.map((template) => (
          <Text
            key={template}
            onLayout={onTemplate}
            style={{ alignSelf: "flex-start", fontSize: FONT_SIZE, fontVariant: ["tabular-nums"] }}
          >
            {template}
          </Text>
        ))}
      </View>
    </Pressable>
  );
}

const summaryCard: ViewStyle = { flexBasis: 112, flexGrow: 1, flexShrink: 1 };
const reading: TextStyle = { fontWeight: "600", fontVariant: ["tabular-nums"] };

function ResourceTrend({ theme, icon, title, percent, detail, severity, values }: {
  theme: PluginTheme;
  icon: string;
  title: string;
  percent: number;
  detail: string;
  severity: Severity;
  values: readonly number[];
}) {
  const normal = severity === "normal";
  const color = normal ? theme.colors.accent : severityColor(theme, severity);
  return (
    <MonitorCard theme={theme} icon={icon} title={title} style={summaryCard}>
      <View style={{ flexGrow: 1, gap: 2 }}>
        <Text style={[reading, { fontSize: 22, lineHeight: 25, color: normal ? theme.colors.foreground : color }]}>
          {formatPercent(percent)}
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{detail}</Text>
      </View>
      <Sparkline values={values} color={color} height={17} />
    </MonitorCard>
  );
}

/** macOS also reports reclaimable files and pressure. */
function memoryDetail(memory: HostStats["memory"]): string {
  const parts = [`${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}`];
  if (memory.cachedBytes !== null) parts.push(`Cached files ${formatBytes(memory.cachedBytes)}`);
  if (memory.pressure !== null) parts.push(`Pressure ${memory.pressure}`);
  return parts.join(" · ");
}

function NetworkSection({ theme, current, history }: {
  theme: PluginTheme;
  current: HostStats["current"];
  history: HostStats["history"];
}) {
  const rates = [
    { label: "Download", icon: "ArrowDown", value: current.rxBytesPerSec,
      color: theme.colors.accent, values: scaleToPeak(history, (sample) => sample.rxBytesPerSec) },
    { label: "Upload", icon: "ArrowUp", value: current.txBytesPerSec,
      color: theme.colors.foregroundMuted, values: scaleToPeak(history, (sample) => sample.txBytesPerSec) },
  ];
  return (
    <MonitorCard theme={theme} icon="ArrowDownUp" title="Network">
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7 }}>
        {rates.map(({ label, icon, value, color, values }) => (
          <View key={label} style={[summaryCard, {
            minWidth: 0, padding: 7, gap: 4, borderRadius: 7, backgroundColor: theme.colors.surface0,
          }]}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              <Icon name={icon} size={12} color={color} />
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, flexShrink: 1 }}>{label}</Text>
            </View>
            <Text style={[reading, { color: theme.colors.foreground, fontSize: 15 }]}>{formatRate(value)}</Text>
            <Sparkline values={values} color={color} height={14} />
          </View>
        ))}
      </View>
    </MonitorCard>
  );
}

function StorageUsage({ theme, percent, total, used, available, mount }: {
  theme: PluginTheme;
  percent: number;
  total: number;
  used: number;
  available: number;
  mount?: string;
}) {
  const severity = percentSeverity(percent);
  const color = severity === "normal" ? theme.colors.foregroundMuted : severityColor(theme, severity);
  return (
    <View style={{ gap: 5 }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 6 }}>
        <Text style={{
          flex: 1, minWidth: 0, fontSize: mount === undefined ? 18 : 12,
          fontWeight: "600", color: theme.colors.foreground,
        }} numberOfLines={mount === undefined ? undefined : 2} ellipsizeMode="tail">
          {mount ?? `${formatBytes(available)} available`}
        </Text>
        <Text style={[reading, { color, fontSize: 11, minWidth: 65, textAlign: "right" }]}>{formatPercent(percent)} used</Text>
      </View>
      <Meter theme={theme} percent={percent} height={mount === undefined ? 6 : 4} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", columnGap: 8, rowGap: 3 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
          {formatBytes(used)} / {formatBytes(total)}
        </Text>
        {mount !== undefined ? (
          <Text style={{ color: theme.colors.foreground, fontSize: 11 }}>
            {formatBytes(available)} available
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function DiskSection({ theme, disks }: { theme: PluginTheme; disks: HostStats["disks"] }) {
  const total = sumDisks(disks);
  return (
    <MonitorCard theme={theme} icon="HardDrive" title="Storage">
      <StorageUsage theme={theme} percent={total.percent} used={total.usedBytes}
        total={total.totalBytes} available={total.availableBytes} />
      {disks.some((disk) => disk.fsType === "apfs") ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>APFS container: all volumes sharing it</Text>
      ) : null}
      {disks.length > 1 ? disks.map((disk) => (
        <View key={disk.mount} style={{ borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 8 }}>
          <StorageUsage theme={theme} mount={disk.mount} percent={diskPercent(disk)} used={disk.usedBytes}
            total={disk.totalBytes} available={disk.availableBytes} />
        </View>
      )) : null}
    </MonitorCard>
  );
}

function HostMetrics({ theme, data, gpus }: { theme: PluginTheme; data: HostStats; gpus?: GpuUsage[] }) {
  const { current, history, memory, network, disks } = data;
  return (
    <>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <ResourceTrend theme={theme} icon="Cpu" title="CPU" percent={current.cpuPercent}
          detail={`${data.cpuCount} cores`} severity={percentSeverity(current.cpuPercent)}
          values={history.map((sample) => sample.cpuPercent)} />
        <ResourceTrend theme={theme} icon="MemoryStick" title="Memory" percent={memoryPercent(memory)}
          detail={memoryDetail(memory)} severity={memorySeverity(memory)}
          values={history.map((sample) => sample.memoryPercent)} />
      </View>
      <GpuSection theme={theme} gpus={gpus} />
      {network ? <NetworkSection theme={theme} current={current} history={history} /> : null}
      {disks.length > 0 ? <DiskSection theme={theme} disks={disks} /> : null}
    </>
  );
}

function HostDetails({ theme, host, action }: Pick<PluginHostProps, "theme" | "host"> & { action?: ReactNode }) {
  const preferences = useSettings(settingsDefinition);
  const seconds = preferences.status === "ready" ? preferences.values.refreshSeconds : defaults.refreshSeconds;
  const refreshMs = Number(seconds) * 1000;
  const { data, isError } = useHostStats(host.id, refreshMs);
  const { data: gpus } = useHostGpus(host.id, refreshMs);

  return (
    <>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text accessibilityRole="header" numberOfLines={1}
            style={{ color: theme.colors.foreground, fontSize: 16, fontWeight: "600" }}>
            {host.label}
          </Text>
          {data ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: FONT_SIZE - 1 }}>
              {data.hostname !== host.label ? `${data.hostname} · ` : ""}
              Up {formatUptime(data.uptimeSeconds)} · Load avg{" "}
              {data.loadAverage.map((n) => n.toFixed(2)).join(" ")}
            </Text>
          ) : null}
        </View>
        {action}
      </View>
      {data ? <HostMetrics theme={theme} data={data} gpus={gpus} /> : (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: FONT_SIZE }}>
          {isError ? "Could not load host metrics." : "Loading…"}
        </Text>
      )}
    </>
  );
}

function HostPopover({ theme, layout, host, openScreen }: PluginPopoverProps) {
  return (
    <View style={{
      gap: 10, padding: layout.compact ? 12 : 10, minWidth: layout.compact ? 240 : 264,
      backgroundColor: theme.colors.surface0,
    }}>
      <HostDetails
        theme={theme}
        host={host}
        action={(
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open host monitor details"
            onPress={() => openScreen({ screenId: HOST_MONITOR_SCREEN_ID })}
            style={({ pressed }) => ({
              minHeight: 34, flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8,
              borderWidth: 1, borderColor: theme.colors.border, borderRadius: 7,
              backgroundColor: pressed ? theme.colors.surface2 : theme.colors.surface1,
            })}
          >
            <Text style={{ color: theme.colors.accent, fontSize: FONT_SIZE }}>Details</Text>
            <Icon name="ChevronRight" size={ICON_SIZE} color={theme.colors.accent} />
          </Pressable>
        )}
      />
    </View>
  );
}

export function HostMonitorScreen({ theme, layout, host }: PluginScreenProps) {
  return (
    <ScrollView style={{ backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: layout.compact ? 12 : 24 }}>
      <View style={{
        alignSelf: "center",
        width: "100%",
        maxWidth: 640,
        gap: 12,
      }}>
        <HostDetails theme={theme} host={host} />
      </View>
    </ScrollView>
  );
}
