import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Text, View, type ViewStyle } from "react-native";
import {
  GPU_RECHECK_MS,
  GPU_REFRESH_MS,
  gpuStatsRpc,
  hostStatsRpc,
  type DiskUsage,
  type HostSample,
  type MemoryPressure,
  type MemoryUsage,
} from "../shared/stats";

const REFRESH_MS = 2000;

export function useHostStats(hostId: string) {
  const getStats = useRpc(hostStatsRpc);
  return useQuery({
    queryKey: ["host-stats", hostId],
    queryFn: () => getStats({}),
    staleTime: REFRESH_MS,
    refetchInterval: REFRESH_MS,
  });
}

export function useHostGpus(hostId: string) {
  const getGpus = useRpc(gpuStatsRpc);
  return useQuery({
    queryKey: ["host-gpus", hostId],
    queryFn: () => getGpus({}),
    staleTime: (query) => query.state.data?.length === 0 ? GPU_RECHECK_MS : GPU_REFRESH_MS,
    refetchInterval: (query) => query.state.data?.length ? GPU_REFRESH_MS : GPU_RECHECK_MS,
    retry: false,
  });
}

/** How hot a resource runs; anything but normal gets a status color. */
export type Severity = MemoryPressure;

export function percentSeverity(percent: number): Severity {
  if (percent >= 90) return "critical";
  if (percent >= 70) return "warning";
  return "normal";
}

/** Muted until a resource runs hot, like the built-in usage summary. */
export function severityColor(theme: PluginTheme, severity: Severity): string {
  if (severity === "critical") return theme.colors.statusDanger;
  if (severity === "warning") return theme.colors.statusWarning;
  return theme.colors.foregroundMuted;
}

export function memoryPercent(memory: Pick<MemoryUsage, "usedBytes" | "totalBytes">): number {
  return memory.totalBytes > 0 ? (memory.usedBytes / memory.totalBytes) * 100 : 0;
}

/**
 * macOS reports memory pressure, which is what decides whether the Mac is short of memory: it can
 * run at high usage with no pressure at all. Elsewhere the percentage stands in for it.
 */
export function memorySeverity(memory: MemoryUsage): Severity {
  return memory.pressure ?? percentSeverity(memoryPercent(memory));
}

/** Like df: the share of the space a user can fill, so a disk at 100% really has no room left. */
export function diskPercent(disk: Pick<DiskUsage, "usedBytes" | "availableBytes">): number {
  const usable = disk.usedBytes + disk.availableBytes;
  return usable > 0 ? (disk.usedBytes / usable) * 100 : 0;
}

/** All disks added together, as one figure for the sidebar. */
export function sumDisks(disks: readonly DiskUsage[]) {
  const sum = { totalBytes: 0, usedBytes: 0, availableBytes: 0 };
  for (const disk of disks) {
    sum.totalBytes += disk.totalBytes;
    sum.usedBytes += disk.usedBytes;
    sum.availableBytes += disk.availableBytes;
  }
  return { ...sum, percent: diskPercent(sum) };
}

export function scaleToPeak(samples: readonly HostSample[], pick: (s: HostSample) => number) {
  const peak = Math.max(1, ...samples.map(pick));
  return samples.map((sample) => (pick(sample) / peak) * 100);
}

// A load above zero always shows a sliver, so a nearly idle meter is not mistaken for an empty one.
const MIN_FILL_WIDTH = 2;

/** A horizontal bar filled to `percent`, colored by load unless `severity` is given. Size it with `style`. */
export function Meter({
  theme,
  percent,
  severity,
  height,
  style,
}: {
  theme: PluginTheme;
  percent: number;
  severity?: Severity;
  height: number;
  style?: ViewStyle;
}) {
  return (
    <View
      style={[
        {
          height,
          borderRadius: height / 2,
          // The outline keeps an empty meter visible on surfaces close to the track color.
          borderWidth: 1,
          borderColor: theme.colors.border,
          overflow: "hidden",
          backgroundColor: theme.colors.surface2,
        },
        style,
      ]}
    >
      <View
        style={{
          height: "100%",
          width: `${Math.min(Math.max(percent, 0), 100)}%`,
          minWidth: percent > 0 ? MIN_FILL_WIDTH : 0,
          backgroundColor: severityColor(theme, severity ?? percentSeverity(percent)),
        }}
      />
    </View>
  );
}

interface SparklineProps {
  /** Values on a 0-100 scale, oldest first. */
  values: readonly number[];
  color: string;
  height: number;
}

const SPARKLINE_BARS = 24;

export function Sparkline({ values, color, height }: SparklineProps) {
  const count = Math.min(values.length, SPARKLINE_BARS);
  // Keep brief spikes visible while spacing the bars evenly in a narrow card.
  const bars = count === values.length ? values : Array.from({ length: count }, (_, index) => {
    const from = Math.floor(index * values.length / count);
    const to = Math.floor((index + 1) * values.length / count);
    let peak = 0;
    for (let sample = from; sample < to; sample++) peak = Math.max(peak, values[sample]);
    return peak;
  });
  return (
    <View aria-hidden style={{ flexDirection: "row", alignItems: "flex-end", height, gap: 1 }}>
      {bars.map((value, index) => (
        <View
          key={index}
          style={{
            flex: 1,
            height: Math.max(1, (Math.min(value, 100) / 100) * height),
            backgroundColor: color,
            opacity: 0.72,
          }}
        />
      ))}
    </View>
  );
}

export function MonitorCard({ theme, icon, title, style, children }: {
  theme: PluginTheme;
  icon: string;
  title: string;
  style?: ViewStyle;
  children: ReactNode;
}) {
  return (
    <View style={[{
      minWidth: 0, padding: 10, gap: 9, borderWidth: 1, borderRadius: 10,
      borderColor: theme.colors.border, backgroundColor: theme.colors.surface1,
    }, style]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Icon name={icon} size={14} color={theme.colors.foregroundMuted} />
        <Text accessibilityRole="header" style={{ flex: 1, color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>
          {title}
        </Text>
      </View>
      {children}
    </View>
  );
}
