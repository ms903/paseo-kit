import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Text, View } from "react-native";
import type { GpuUsage } from "../shared/stats";
import { formatBytes, formatPercent } from "./format";
import { Meter } from "./stats";

export function GpuSection({ theme, gpus }: { theme: PluginTheme; gpus?: readonly GpuUsage[] }) {
  if (!gpus?.length) return null;
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  const value = { color: theme.colors.foreground, fontSize: 12 };

  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Icon name="CircuitBoard" size={14} color={theme.colors.foregroundMuted} />
        <Text style={muted}>GPU</Text>
      </View>
      {gpus.map((gpu, index) => (
        <View key={gpu.id} style={{ gap: 6, paddingLeft: 20 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={[value, { flex: 1, fontWeight: "500" }]}>
              {gpus.length > 1 ? `GPU ${index + 1} · ` : ""}{gpu.name}
            </Text>
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
      ))}
    </View>
  );
}
