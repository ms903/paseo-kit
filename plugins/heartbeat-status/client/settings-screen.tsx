import { defineTranslations, useSettings, useTranslation, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { accents, heartbeatSettings, type HeartbeatSettings } from "../shared/settings";

const copy = defineTranslations({
  resources: {
    en: {
      appearance: "Appearance", clock: "Heartbeat clock", color: "Clock color", animate: "Animate the clock hand",
      motionHint: "Follows the system’s Reduce Motion preference.", teal: "Teal", blue: "Blue", violet: "Purple", amber: "Amber",
      loading: "Loading settings…", reload: "Reload", reset: "Restore defaults",
    },
    "zh-CN": {
      appearance: "外观", clock: "心跳时钟", color: "时钟颜色", animate: "让指针转动",
      motionHint: "遵循系统的「减少动态效果」设置。", teal: "青绿", blue: "蓝色", violet: "紫色", amber: "琥珀色",
      loading: "正在读取设置…", reload: "重新加载", reset: "恢复默认设置",
    },
  },
});
export const appearanceTitle = copy.message("appearance");

export function HeartbeatSettingsScreen({ theme }: PluginSurfaceProps) {
  const { t } = useTranslation(copy);
  const settings = useSettings(heartbeatSettings);
  if (settings.status === "loading") return <Text style={{ color: theme.colors.foregroundMuted }}>{t("loading")}</Text>;
  if (settings.status !== "ready") {
    const reset = settings.status === "invalid";
    return <SettingsCard><SettingsAction label={settings.error} actionLabel={t(reset ? "reset" : "reload")}
      disabled={settings.saving} onPress={() => { void (reset ? settings.reset() : settings.reload()); }} /></SettingsCard>;
  }
  const { values, revision, saving } = settings;
  const save = (patch: Partial<HeartbeatSettings>) => { void settings.save({ ...values, ...patch }, revision); };
  return (
    <View style={{ padding: 12 }}>
      <SettingsSection title={t("clock")}>
        <SettingsCard>
          <SettingsSelect label={t("color")} value={values.accent} options={accents.map(value => ({ value, label: t(value) }))}
            disabled={saving} onValueChange={accent => save({ accent })} />
          <SettingsSwitch label={t("animate")} hint={t("motionHint")} value={values.animate}
            disabled={saving} onValueChange={animate => save({ animate })} />
          {settings.saveError ? <SettingsAction label={settings.saveError} actionLabel={t("reload")}
            onPress={() => { void settings.reload(); }} /> : null}
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}
