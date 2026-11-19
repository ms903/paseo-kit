import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Text, View, type TextStyle } from "react-native";
import type { GpuUsage } from "../shared/stats";
import { formatBytes, formatPercent } from "./format";
import { Meter } from "./stats";

function SingleGpu({ theme, gpu }: { theme: PluginTheme; gpu: GpuUsage }) {
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  const value = { color: theme.colors.foreground, fontSize: 12 };
  return (
    <View style={{ gap: 6, paddingLeft: 20 }}>
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

function GpuTableRow({ theme, device, model, load, memory, temperature, header = false }: {
  theme: PluginTheme;
  device: string;
  model?: string;
  load?: string;
  memory?: string;
  temperature?: string;
  header?: boolean;
}) {
  const style: TextStyle = {
    color: header ? theme.colors.foregroundMuted : theme.colors.foreground,
    fontSize: 11,
    fontVariant: ["tabular-nums"],
  };
  const numeric: TextStyle = { ...style, textAlign: "right" };
  return (
    <View style={{ paddingVertical: 3,
      borderBottomWidth: header ? 1 : 0, borderBottomColor: theme.colors.border }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Text style={[style, { flex: 1, minWidth: 0 }]}>{device}</Text>
        {load !== undefined ? <Text style={[numeric, { width: 34 }]}>{load}</Text> : null}
        {memory !== undefined ? <Text style={[numeric, { width: 84 }]}>{memory}</Text> : null}
        {temperature !== undefined ? <Text style={[numeric, { width: 36 }]}>{temperature}</Text> : null}
      </View>
      {model ? <Text style={{ fontSize: 11, color: theme.colors.foregroundMuted }}>{model}</Text> : null}
    </View>
  );
}

function gib(bytes: number | null): string {
  return bytes === null ? "—" : (bytes / 1024 ** 3).toFixed(1);
}

function GpuTable({ theme, gpus, showNames }: { theme: PluginTheme; gpus: readonly GpuUsage[]; showNames: boolean }) {
  const hasLoad = gpus.some((gpu) => gpu.utilizationPercent !== null);
  const hasMemory = gpus.some((gpu) => gpu.vramUsedBytes !== null || gpu.vramTotalBytes !== null);
  const hasTemp = gpus.some((gpu) => gpu.temperatureCelsius !== null);
  return (
    <View>
      <GpuTableRow theme={theme} header device="GPU" load={hasLoad ? "Load" : undefined}
        memory={hasMemory ? "VRAM (GiB)" : undefined} temperature={hasTemp ? "Temp" : undefined} />
      {gpus.map((gpu) => (
        <GpuTableRow key={gpu.id} theme={theme} device={gpu.deviceLabel ?? gpu.id}
          model={showNames ? gpu.name : undefined}
          load={hasLoad ? (gpu.utilizationPercent === null ? "—" : formatPercent(gpu.utilizationPercent)) : undefined}
          memory={hasMemory ? `${gib(gpu.vramUsedBytes)} / ${gib(gpu.vramTotalBytes)}` : undefined}
          temperature={hasTemp ? (gpu.temperatureCelsius === null ? "—" : `${Math.round(gpu.temperatureCelsius)} °C`) : undefined} />
      ))}
    </View>
  );
}

export function GpuSection({ theme, gpus }: { theme: PluginTheme; gpus?: readonly GpuUsage[] }) {
  if (!gpus?.length) return null;
  const first = gpus[0];
  const sharedName = gpus.length > 1 && gpus.every((gpu) => gpu.name === first.name) ? first.name : null;
  const title = gpus.length > 1 ? `${gpus.length} GPUs${sharedName ? ` · ${sharedName}` : ""}` : "GPU";
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Icon name="CircuitBoard" size={14} color={theme.colors.foregroundMuted} />
        <Text style={{ flex: 1, color: theme.colors.foregroundMuted, fontSize: 12 }}>{title}</Text>
      </View>
      {gpus.length === 1
        ? <SingleGpu theme={theme} gpu={first} />
        : <GpuTable theme={theme} gpus={gpus} showNames={!sharedName} />}
    </View>
  );
}
