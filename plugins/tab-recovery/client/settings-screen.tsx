import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { Text } from "react-native";
import { historySettings, limits } from "../shared/settings";

const options = limits.map((limit) => ({ value: limit, label: limit }));

export function HistorySettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(historySettings);
  if (settings.status === "loading") return <Text style={{ color: theme.colors.foregroundMuted }}>Loading…</Text>;
  if (settings.status !== "ready") {
    return <SettingsCard><SettingsAction label={settings.error} actionLabel="Retry"
      onPress={() => { void settings.reload(); }} /></SettingsCard>;
  }
  return (
    <SettingsSection title="Closed agents">
      <SettingsCard>
        <SettingsSelect label="Maximum closed agents" hint="Show this many recently closed agents per workspace."
          options={options} value={settings.values.limit} disabled={settings.saving} error={settings.saveError}
          onValueChange={(limit) => { void settings.save({ limit }, settings.revision); }} />
      </SettingsCard>
    </SettingsSection>
  );
}
