import type { PluginTheme } from "@getpaseo/plugin";
import { Text, View, type TextStyle } from "react-native";
import type { GpuUsage } from "../shared/stats";
import { formatBytes, formatPercent } from "./format";
import { Meter, MonitorCard, percentSeverity, severityColor } from "./stats";

function SingleGpu({ theme, gpu }: { theme: PluginTheme; gpu: GpuUsage }) {
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  const value: TextStyle = { color: theme.colors.foreground, fontSize: 12, fontVariant: ["tabular-nums"] };
  return (
    <View style={{ gap: 7 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={[value, { flex: 1, fontWeight: "500" }]}>{gpu.name}</Text>
        {gpu.temperatureCelsius !== null ? <Text style={value}>{gpu.temperatureCelsius} °C</Text> : null}
      </View>
      {gpu.utilizationPercent !== null ? (
        <>
          <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
            <Text style={muted}>Utilization</Text>
            <Text style={value}>{formatPercent(gpu.utilizationPercent)}</Text>
          </View>
          <Meter theme={theme} percent={gpu.utilizationPercent} height={4} />
        </>
      ) : null}
      {gpu.vramUsedBytes !== null || gpu.vramTotalBytes !== null ? (
        <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
          <Text style={muted}>VRAM</Text>
          <Text style={value}>
            {gpu.vramUsedBytes !== null ? formatBytes(gpu.vramUsedBytes) : null}
            {gpu.vramUsedBytes !== null && gpu.vramTotalBytes !== null ? " / " : null}
            {gpu.vramTotalBytes !== null ? formatBytes(gpu.vramTotalBytes) : null}
            {gpu.vramUsedBytes === null ? " total" : gpu.vramTotalBytes === null ? " used" : null}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function GpuTableRow({ theme, device, model, load, memory, temperature, loadColor, memoryColor, header = false, alternate = false }: {
  theme: PluginTheme;
  device: string;
  model?: string;
  load?: string;
  memory?: string;
  temperature?: string;
  loadColor?: string;
  memoryColor?: string;
  header?: boolean;
  alternate?: boolean;
}) {
  const style: TextStyle = {
    color: header ? theme.colors.foregroundMuted : theme.colors.foreground,
    fontSize: header ? 10 : 12,
    fontVariant: ["tabular-nums"],
  };
  const numeric: TextStyle = { ...style, textAlign: "right" };
  return (
    <View style={{
      paddingVertical: header ? 6 : 5, paddingHorizontal: 7, gap: 2,
      borderTopWidth: header ? 0 : 1, borderTopColor: theme.colors.border,
      backgroundColor: header ? theme.colors.surface2 : alternate ? theme.colors.surface1 : theme.colors.surface0,
    }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Text style={[style, { flex: 1, minWidth: 0, fontWeight: "600" }]}>{device}</Text>
        {load !== undefined ? <Text style={[numeric, { width: 35, color: loadColor ?? numeric.color }]}>{load}</Text> : null}
        {memory !== undefined ? <Text style={[numeric, { width: 73, color: memoryColor ?? numeric.color }]}>{memory}</Text> : null}
        {temperature !== undefined ? <Text style={[numeric, { width: 42 }]}>{temperature}</Text> : null}
      </View>
      {model ? <Text style={{ fontSize: 11, color: theme.colors.foregroundMuted }}>{model}</Text> : null}
    </View>
  );
}

function gib(bytes: number | null): string {
  return bytes === null ? "—" : (bytes / 1024 ** 3).toFixed(1);
}

function readingColor(theme: PluginTheme, percent: number | null) {
  if (percent === null || percent === 0) return theme.colors.foregroundMuted;
  const severity = percentSeverity(percent);
  return severity === "normal" ? theme.colors.foreground : severityColor(theme, severity);
}

function GpuTable({ theme, gpus, showNames }: { theme: PluginTheme; gpus: readonly GpuUsage[]; showNames: boolean }) {
  const hasLoad = gpus.some((gpu) => gpu.utilizationPercent !== null);
  const hasMemory = gpus.some((gpu) => gpu.vramUsedBytes !== null || gpu.vramTotalBytes !== null);
  const hasTemp = gpus.some((gpu) => gpu.temperatureCelsius !== null);
  return (
    <View style={{ borderRadius: 7, borderWidth: 1, borderColor: theme.colors.border, overflow: "hidden" }}>
      <GpuTableRow theme={theme} header device="GPU" load={hasLoad ? "Load" : undefined}
        memory={hasMemory ? "VRAM (GiB)" : undefined} temperature={hasTemp ? "Temp" : undefined} />
      {gpus.map((gpu, index) => {
        const vramPercent = gpu.vramUsedBytes !== null && gpu.vramTotalBytes
          ? (gpu.vramUsedBytes / gpu.vramTotalBytes) * 100 : null;
        return (
          <GpuTableRow key={gpu.id} theme={theme} device={gpu.deviceLabel ?? gpu.id}
            model={showNames ? gpu.name : undefined} alternate={index % 2 === 1}
            load={hasLoad ? (gpu.utilizationPercent === null ? "—" : formatPercent(gpu.utilizationPercent)) : undefined}
            loadColor={readingColor(theme, gpu.utilizationPercent)}
            memory={hasMemory ? `${gib(gpu.vramUsedBytes)} / ${gib(gpu.vramTotalBytes)}` : undefined}
            memoryColor={readingColor(theme, vramPercent)}
            temperature={hasTemp ? (gpu.temperatureCelsius === null ? "—" : `${Math.round(gpu.temperatureCelsius)} °C`) : undefined} />
        );
      })}
    </View>
  );
}

export function GpuSection({ theme, gpus }: { theme: PluginTheme; gpus?: readonly GpuUsage[] }) {
  if (!gpus?.length) return null;
  const first = gpus[0];
  const sharedName = gpus.length > 1 && gpus.every((gpu) => gpu.name === first.name) ? first.name : null;
  const title = gpus.length > 1 ? `${gpus.length} GPUs` : "GPU";
  return (
    <MonitorCard theme={theme} icon="CircuitBoard" title={title}>
      {sharedName ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{sharedName}</Text> : null}
      {gpus.length === 1
        ? <SingleGpu theme={theme} gpu={first} />
        : <GpuTable theme={theme} gpus={gpus} showNames={!sharedName} />}
    </MonitorCard>
  );
}
