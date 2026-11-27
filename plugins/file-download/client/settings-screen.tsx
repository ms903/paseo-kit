import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { Text } from "react-native";
import { downloadSettings } from "../shared/settings";

export function DownloadSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(downloadSettings);
  if (settings.status === "loading") return <Text style={{ color: theme.colors.foregroundMuted }}>Loading…</Text>;
  if (settings.status !== "ready") {
    return <SettingsCard><SettingsAction label={settings.error} actionLabel="Retry"
      onPress={() => { void settings.reload(); }} /></SettingsCard>;
  }
  return (
    <SettingsSection title="File downloads">
      <SettingsCard>
        <SettingsSwitch label="Download with Ctrl+S or ⌘S" hint="Use the save shortcut in file previews. Download current file is always available in the Command Center."
          value={settings.values.saveShortcut} disabled={settings.saving} error={settings.saveError}
          onValueChange={(saveShortcut) => { void settings.save({ saveShortcut }, settings.revision); }} />
      </SettingsCard>
    </SettingsSection>
  );
}
