import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { Pressable, Text, type PressableStateCallbackType } from "react-native";
import type { ReportResponse } from "../shared/usage";
import { USAGE_REPORT_KEY, useReadUsage } from "./data";

export function RefreshUsageButton({ theme, hostId, refreshing, compact = false }: {
  theme: PluginTheme;
  hostId: string;
  refreshing: boolean;
  compact?: boolean;
}) {
  const read = useReadUsage(hostId);
  const client = useQueryClient();
  const toast = useToast();
  const mutationKey = [...USAGE_REPORT_KEY, hostId, "refresh"];
  const request = useMutation({
    mutationKey,
    mutationFn: (target: { hostId: string; read: typeof read }) => target.read(true),
    retry: false,
    onSuccess: async (report, target) => {
      const queryKey = [...USAGE_REPORT_KEY, target.hostId];
      await client.cancelQueries({ queryKey, exact: true });
      client.setQueryData<ReportResponse>(queryKey, (current) => {
        if (current && !("status" in current) && ("status" in report || current.generatedAt > report.generatedAt)) return current;
        return report;
      });
    },
    onError: () => toast.error("Could not refresh usage"),
  });
  const requesting = useIsMutating({ mutationKey, exact: true }) > 0;
  const busy = refreshing || requesting;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Refresh usage"
      accessibilityState={{ busy, disabled: busy }}
      disabled={busy}
      onPress={() => request.mutate({ hostId, read })}
      style={({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) => ({
        flexDirection: "row", alignItems: "center", gap: 5, minHeight: compact ? 26 : 34,
        paddingHorizontal: compact ? 5 : 10, borderWidth: compact ? 0 : 1, borderRadius: 7,
        borderColor: theme.colors.border, opacity: busy ? 0.7 : 1,
        backgroundColor: !busy && (pressed || hovered) ? theme.colors.surface2 : theme.colors.surface1,
      })}
    >
      <Icon name="RefreshCw" size={compact ? 12 : 14} color={theme.colors.foregroundMuted} />
      <Text style={{ fontSize: 12, color: theme.colors.foreground }}>
        {busy ? "Refreshing…" : compact ? "Refresh" : "Refresh usage"}
      </Text>
    </Pressable>
  );
}
