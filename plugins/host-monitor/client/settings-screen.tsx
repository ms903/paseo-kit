import { defineTranslations, useSettings, useTranslation, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { footerMetrics, refreshSeconds, settingsDefinition } from "../shared/settings";

const en = {
  title: "Host monitor", footer: "Sidebar footer", readings: "Live readings", interval: "Refresh interval",
  hint: "Applies to the sidebar and the details page. GPU and disk readings also follow the host’s sampling limits.",
  cpu: "CPU", memory: "Memory", gpu: "GPU", disk: "Disk", network: "Network", seconds: "{{value}} seconds",
  loading: "Loading settings…", reset: "Restore defaults", retry: "Retry", reload: "Reload settings",
};
const zh: Record<keyof typeof en, string> = {
  title: "主机监控", footer: "侧栏底部", readings: "实时读数", interval: "刷新间隔",
  hint: "应用于侧栏和详情页。GPU 和磁盘读数还取决于主机的采样间隔。",
  cpu: "CPU", memory: "内存", gpu: "GPU", disk: "磁盘", network: "网络", seconds: "{{value}} 秒",
  loading: "正在读取设置…", reset: "恢复默认设置", retry: "重试", reload: "重新加载设置",
};
// Paseo 0.11.1 supplies the settings controls and uses English before the translation SDK.
const messages = typeof defineTranslations === "function" && typeof useTranslation === "function"
  ? defineTranslations({ resources: { en, "zh-CN": zh } }) : null;
type Translate = (key: keyof typeof en, options?: { value: string }) => string;
const useLabels: () => { t: Translate } = messages
  ? () => useTranslation(messages)
  : () => ({ t: (key, options) => en[key].replace("{{value}}", options?.value ?? "") });
export const settingsTitle = messages?.message("title") ?? en.title;

export function MonitorSettingsScreen({ theme }: PluginSurfaceProps) {
  const { t } = useLabels();
  const settings = useSettings(settingsDefinition);
  if (settings.status === "loading") return <Text style={{ color: theme.colors.foregroundMuted }}>{t("loading")}</Text>;
  if (settings.status !== "ready") {
    const invalid = settings.status === "invalid";
    return (
      <SettingsCard>
        <SettingsAction label={settings.saveError ?? settings.error}
          actionLabel={t(invalid ? "reset" : "retry")} disabled={settings.saving}
          onPress={() => { void (invalid ? settings.reset() : settings.reload()); }} />
      </SettingsCard>
    );
  }
  const { values, revision, saving } = settings;
  return (
    <View style={{ gap: 20 }}>
      <SettingsSection title={t("footer")}>
        <SettingsCard>
          {footerMetrics.map(key => (
            <SettingsSwitch key={key} label={t(key)} value={values[key]} disabled={saving}
              onValueChange={value => { void settings.save({ ...values, [key]: value }, revision); }} />
          ))}
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title={t("readings")}>
        <SettingsCard>
          <SettingsSelect label={t("interval")} hint={t("hint")}
            value={values.refreshSeconds} disabled={saving}
            options={refreshSeconds.map(value => ({ value, label: t("seconds", { value }) }))}
            onValueChange={value => { void settings.save({ ...values, refreshSeconds: value }, revision); }} />
        </SettingsCard>
      </SettingsSection>
      {settings.saveError && (
        <SettingsAction label={settings.saveError} actionLabel={t("reload")} onPress={() => { void settings.reload(); }} />
      )}
    </View>
  );
}
