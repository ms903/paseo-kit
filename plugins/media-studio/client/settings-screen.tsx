import { useRpc, useSettings, useTranslation, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { hostCheckRpc, statusRpc, storageRpc, storageCleanRpc } from "../shared/rpc";
import { settingsDefinition, type MediaStudioSettings } from "../shared/settings";
import { messages } from "./i18n";

type TextKey = "ffmpegPath" | "ffprobePath" | "uploadFolder" | "framesFolder" | "agentToolProviders" | "remoteHosts" | "remoteFfmpeg";

export function SettingsScreen({ theme }: PluginSurfaceProps) {
  const { t } = useTranslation(messages);
  const settings = useSettings(settingsDefinition);
  const status = useRpc(statusRpc);
  const check = useRpc(hostCheckRpc);
  const readStorage = useRpc(storageRpc);
  const cleanStorage = useRpc(storageCleanRpc);
  const storage = useQuery({ queryKey: ["media-studio", "storage"], queryFn: () => readStorage({}) });
  const [cleaning, setCleaning] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const tools = useQuery({ queryKey: ["media-studio", "status"], queryFn: () => status({}) });
  const [drafts, setDrafts] = useState<Partial<Record<TextKey, string>>>({});
  const [checks, setChecks] = useState<Record<string, string>>({});
  const { colors } = theme;

  if (settings.status === "loading") return <Text style={{ color: colors.foregroundMuted }}>{t("viewer.loading")}</Text>;
  if (settings.status !== "ready") {
    const invalid = settings.status === "invalid";
    return <SettingsCard><SettingsAction label={settings.saveError ?? settings.error}
      actionLabel={invalid ? t("settings.restoreDefaults") : t("settings.reload")} disabled={settings.saving}
      onPress={() => { void (invalid ? settings.reset() : settings.reload()); }} /></SettingsCard>;
  }
  const values = settings.values;
  const save = (patch: Partial<MediaStudioSettings>) => void settings.save({ ...values, ...patch }, settings.revision);
  const textRow = (key: TextKey, label: string, hint: string, placeholder?: string) => (
    <SettingsInput
      key={key}
      label={label}
      hint={hint}
      initialValue={values[key]}
      placeholder={placeholder}
      disabled={settings.saving}
      onChangeText={(text) => setDrafts((current) => ({ ...current, [key]: text }))}
    />
  );
  const dirty = Object.entries(drafts).some(([key, value]) => value !== values[key as TextKey]);
  const local = tools.data?.local;
  const describeTools = (entry: { ffmpeg: string | null; ffprobe: string | null; version: string | null; encoders: string[] } | null | undefined) =>
    entry?.ffmpeg
      ? `${entry.ffmpeg} (${entry.version ?? "?"}) · ${entry.encoders.join(", ") || t("settings.noEncoder")} · ffprobe: ${entry.ffprobe ? t("settings.yes") : t("settings.no")}`
      : t("settings.noFfmpeg");

  return (
    <View style={{ gap: 24 }}>
      {settings.saveError && <SettingsAction label={settings.saveError} actionLabel={t("settings.reload")}
        onPress={() => { void settings.reload(); }} />}
      <SettingsSection title={t("settings.storageTitle")}>
        <SettingsCard>
          <SettingsRow label={t("settings.cache")} hint={`${((storage.data?.cacheBytes ?? 0) / 1024 ** 2).toFixed(1)} MiB / 1024 MiB`} />
          <SettingsRow label={t("settings.notes")} hint={`${((storage.data?.noteBytes ?? 0) / 1024 ** 2).toFixed(1)} MiB / 64 MiB`} />
          <SettingsRow label={t("settings.frames")} hint={`${((storage.data?.frameBytes ?? 0) / 1024 ** 2).toFixed(1)} MiB / 1024 MiB`} />
          <SettingsRow label={t("settings.uploads")} hint={`${storage.data?.unfinishedUploads ?? 0} · ${((storage.data?.uploadReservedBytes ?? 0) / 1024 ** 3).toFixed(2)} GiB / 16 GiB`} />
          <SettingsAction label={storageError ?? storage.error?.message ?? t("settings.cleanup")} actionLabel={t("settings.clean")} disabled={cleaning} onPress={() => {
            setCleaning(true); setStorageError(null);
            void cleanStorage({}).then(() => storage.refetch()).catch((error) => setStorageError(String(error))).finally(() => setCleaning(false));
          }} />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title={t("settings.toolsTitle")}>
        <SettingsCard>
          <SettingsRow label={t("settings.thisHost")} hint={tools.isPending ? t("viewer.loading") : describeTools(local)} />
          {(tools.data?.remoteHosts ?? []).map((host) => (
            <SettingsAction
              key={host}
              label={host}
              hint={checks[host] ?? t("settings.checkHint")}
              actionLabel={t("settings.check")}
              onPress={() => {
                setChecks((current) => ({ ...current, [host]: t("settings.checking") }));
                void check({ host }).then((result) =>
                  setChecks((current) => ({ ...current, [host]: result.ok ? describeTools(result.tools) : (result.error ?? t("settings.unreachable")) })),
                );
              }}
            />
          ))}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t("settings.agentsTitle")}>
        <SettingsCard>
          <SettingsSwitch label={t("settings.agentTool")} hint={t("settings.agentToolHint")} value={values.agentTool} disabled={settings.saving} onValueChange={(agentTool) => save({ agentTool })} />
          <SettingsSwitch label={t("settings.turnCards")} hint={t("settings.turnCardsHint")} value={values.turnCards} disabled={settings.saving} onValueChange={(turnCards) => save({ turnCards })} />
          <SettingsSwitch label={t("settings.composerPill")} hint={t("settings.composerPillHint")} value={values.composerPill} disabled={settings.saving} onValueChange={(composerPill) => save({ composerPill })} />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t("settings.playbackTitle")}>
        <SettingsCard>
          <SettingsSelect
            label={t("settings.quality")}
            hint={t("settings.qualityHint")}
            value={values.quality}
            disabled={settings.saving}
            options={(["auto", "original", "1080", "720", "480"] as const).map((value) => ({ value, label: t(`quality.${value}`) }))}
            onValueChange={(quality) => save({ quality })}
          />
          <SettingsSwitch
            label={t("settings.hardware")}
            hint={t("settings.hardwareHint")}
            value={values.hardwareEncoding}
            disabled={settings.saving}
            onValueChange={(hardwareEncoding) => save({ hardwareEncoding })}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t("settings.pathsTitle")}>
        <SettingsCard>
          {textRow("uploadFolder", t("settings.uploadFolder"), t("settings.uploadFolderHint"), "uploads")}
          {textRow("framesFolder", t("settings.framesFolder"), t("settings.framesFolderHint"), ".media-studio/frames")}
          {textRow("remoteHosts", t("settings.remoteHosts"), t("settings.remoteHostsHint", { aliases: (tools.data?.sshAliases ?? []).join(", ") || "-" }), "gpu1, render")}
          {textRow("remoteFfmpeg", t("settings.remoteFfmpeg"), t("settings.remoteFfmpegHint"), "gpu1=/opt/ffmpeg/bin/ffmpeg")}
          {textRow("agentToolProviders", t("settings.providers"), t("settings.providersHint"), "claude, codex, opencode")}
          {textRow("ffmpegPath", t("settings.ffmpegPath"), t("settings.ffmpegPathHint"), "/opt/homebrew/bin/ffmpeg")}
          {textRow("ffprobePath", t("settings.ffprobePath"), t("settings.ffmpegPathHint"), "/opt/homebrew/bin/ffprobe")}
          <SettingsAction
            label={t("settings.saveHint")}
            actionLabel={t("settings.save")}
            disabled={!dirty || settings.saving}
            onPress={() => {
              const patch: Partial<MediaStudioSettings> = {};
              for (const [key, value] of Object.entries(drafts)) patch[key as TextKey] = (value ?? "").trim();
              void settings.save({ ...values, ...patch }, settings.revision).then((saved) => {
                if (saved) {
                  setDrafts({});
                  void tools.refetch();
                }
                return undefined;
              });
            }}
          />
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}
