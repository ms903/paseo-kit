import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { Text } from "react-native";
import { CCUSAGE_SETTINGS, SPEED_WINDOWS } from "../shared/settings";
import { useSpeedMessages } from "./speed-messages";

const windows = SPEED_WINDOWS.map((seconds) => String(seconds));
const bases = { live: "liveBasis", decode: "decodeBasis", "whole-turn": "adjustedTurn" } as const;
const basisOrder = ["live", "decode", "whole-turn"] as const;

export function UsageSettings({ theme }: PluginSurfaceProps) {
  const { t } = useSpeedMessages();
  const settings = useSettings(CCUSAGE_SETTINGS);
  if (settings.status === "loading") {
    return <Text style={{ color: theme.colors.foregroundMuted }}>{t("settingsLoading")}</Text>;
  }
  if (settings.status !== "ready") {
    return (
      <SettingsSection title={t("settings")}>
        <SettingsCard>
          <SettingsAction label={t("settingsUnavailable")} hint={settings.error} actionLabel={t("retry")}
            onPress={() => void settings.reload()} />
        </SettingsCard>
      </SettingsSection>
    );
  }
  const { revision, values, saving, saveError } = settings;
  return (
    <SettingsSection title={t("settings")}>
      <SettingsCard>
        <SettingsSwitch
          testID="usage-show-output-speed"
          label={t("showSpeed")}
          hint={t("showSpeedHint")}
          value={values.showSessionSpeed}
          disabled={saving}
          onValueChange={(showSessionSpeed) => void settings.save({ ...values, showSessionSpeed }, revision)}
        />
        <SettingsSelect
          testID="usage-speed-pill-basis"
          label={t("speedPillBasis")}
          hint={t("speedPillBasisHint")}
          value={values.speedPillBasis}
          options={basisOrder.map((value) => ({ value, label: t(bases[value]) }))}
          disabled={saving || !values.showSessionSpeed}
          onValueChange={(speedPillBasis) => void settings.save({ ...values, speedPillBasis }, revision)}
        />
        <SettingsSelect
          testID="usage-live-speed-window"
          label={t("speedWindow")}
          hint={t("speedWindowHint")}
          value={String(values.speedWindowSeconds)}
          options={windows.map((value) => ({ value, label: t("seconds", { value }) }))}
          disabled={saving || !values.showSessionSpeed}
          onValueChange={(value) => {
            const speedWindowSeconds = SPEED_WINDOWS.find((seconds) => String(seconds) === value);
            if (speedWindowSeconds) void settings.save({ ...values, speedWindowSeconds }, revision);
          }}
        />
      </SettingsCard>
      {saveError ? <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.statusWarning }}>
        {t("settingsSaveFailed")} {saveError}
      </Text> : null}
    </SettingsSection>
  );
}
