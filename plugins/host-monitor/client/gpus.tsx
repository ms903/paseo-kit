import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { GPU_REFRESH_MS, gpuStatsRpc } from "../shared/stats";
import { formatBytes, formatPercent } from "./format";
import { Meter } from "./stats";

export function GpuSection({ theme, host }: Pick<PluginHostProps, "theme" | "host">) {
  const getGpus = useRpc(gpuStatsRpc);
  const { data, isPending, isError } = useQuery({
    queryKey: ["host-gpus", host.id],
    queryFn: () => getGpus({}),
    staleTime: GPU_REFRESH_MS,
    refetchInterval: GPU_REFRESH_MS,
    retry: false,
  });
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  const value = { color: theme.colors.foreground, fontSize: 12 };

  return (
    <View style={{ gap: 10, paddingTop: 12, borderTopWidth: 1, borderTopColor: theme.colors.border }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Icon name="CircuitBoard" size={14} color={theme.colors.foregroundMuted} />
        <Text style={muted}>GPU</Text>
      </View>
      {data?.length ? data.map((gpu, index) => (
        <View key={gpu.id} style={{ gap: 6, paddingLeft: 20 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={[value, { flex: 1, fontWeight: "500" }]}>
              {data.length > 1 ? `GPU ${index + 1} · ` : ""}{gpu.name}
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
      )) : (
        <Text style={muted}>
          {isPending ? "Reading GPU status…" : isError ? "Could not load GPU status." : "No GPU readings."}
        </Text>
      )}
    </View>
  );
}
