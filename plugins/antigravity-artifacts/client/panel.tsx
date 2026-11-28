import type { PluginTheme } from "@getpaseo/plugin";
import { useComposers, useRpc, useTranslation, type PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { copyText, Icon, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, Text, TextInput, View, type PressableStateCallbackType } from "react-native";
import { listArtifacts, readArtifact, type Artifact } from "../shared/artifacts";
import { messages } from "./messages";

type HoverState = PressableStateCallbackType & { hovered?: boolean };
const fileIcons = { text: "FileText", image: "Image", file: "File" };

function artifactKey(item: Artifact) {
  return `${item.conversationId}/${item.path}`;
}

function bytesLabel(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function Action({ theme, label, icon, onPress, disabled }: {
  theme: PluginTheme;
  label: string;
  icon: string;
  onPress(): void;
  disabled?: boolean;
}) {
  const { colors } = theme;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
      style={({ hovered, pressed }: HoverState) => ({
        minHeight: 38, flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: 6,
        paddingHorizontal: 9, borderWidth: 1, borderColor: colors.border, borderRadius: 7,
        backgroundColor: hovered || pressed ? colors.surface2 : colors.surface1, opacity: disabled ? 0.5 : 1,
      })}>
      <Icon name={icon} size={15} color={colors.foregroundMuted} />
      <Text style={{ fontSize: 12, color: colors.foreground }}>{label}</Text>
    </Pressable>
  );
}

function Preview({ theme, hostId, scope, item, rootConversationId }: {
  theme: PluginTheme;
  hostId: string;
  scope: { agentId: string; workspaceId: string };
  item: Artifact;
  rootConversationId: string;
}) {
  const { colors } = theme;
  const { t } = useTranslation(messages);
  const toast = useToast();
  const [composer] = useComposers({ agentId: scope.agentId });
  const read = useRpc(readArtifact);
  const result = useQuery({
    queryKey: ["antigravity-artifacts", "preview", hostId, scope.workspaceId, scope.agentId,
      rootConversationId, item.ownerAgentId, artifactKey(item), item.modifiedAt, item.bytes],
    queryFn: () => read({ ...scope, rootConversationId, artifact: {
      ownerAgentId: item.ownerAgentId, conversationId: item.conversationId, path: item.path,
    } }),
    retry: false,
    gcTime: 0,
  });
  const data = result.isError ? undefined : result.data;
  const caption = { fontSize: 12, color: colors.foregroundMuted };
  const copy = async () => {
    if (!data) return;
    try {
      await copyText(data.absolutePath);
      toast.show(t("copied"));
    } catch {
      toast.show(t("copyError"));
    }
  };
  const insert = async () => {
    if (!data || !composer) return;
    const reference = t("reference", { path: JSON.stringify(data.absolutePath) });
    const errorMessage = t("insertError");
    try {
      composer.insertText(`\n${reference}\n`);
      await composer.focus();
    } catch {
      toast.show(errorMessage);
    }
  };
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14, gap: 10 }}>
      <Text accessibilityRole="header" selectable style={{ fontSize: 16, fontWeight: "600", color: colors.foreground }}>
        {item.path}
      </Text>
      <Text style={caption}>{bytesLabel(item.bytes)}</Text>
      {result.isPending ? <ActivityIndicator color={colors.accent} /> : null}
      {result.isError ? <Text style={caption}>{t("previewError")}</Text> : null}
      {data ? (
        <>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            <Action theme={theme} label={t("copy")} icon="Copy" onPress={() => void copy()} />
            {composer ? <Action theme={theme} label={t("insert")} icon="TextCursorInput" onPress={() => void insert()} /> : null}
          </View>
          {data.kind === "image" ? (
            <Image accessibilityLabel={item.path} source={{ uri: data.dataUri }} resizeMode="contain"
              style={{ height: 340, width: "100%", backgroundColor: colors.surface1, borderRadius: 8 }} />
          ) : null}
          {data.kind === "text" ? (
            <>
              {data.truncated ? <Text style={caption}>{t("previewLimit")}</Text> : null}
              <Text selectable style={{ padding: 10, backgroundColor: colors.surface1, color: colors.foreground,
                borderRadius: 8, fontSize: 13, lineHeight: 20 }}>{data.text}</Text>
            </>
          ) : null}
          {data.kind === "tooLarge" ? <Text style={caption}>{t("imageLimit")}</Text> : null}
          {data.kind === "file" ? <Text style={caption}>{t("otherFile")}</Text> : null}
        </>
      ) : null}
    </ScrollView>
  );
}

export function ArtifactsPanel(props: PluginAgentPanelProps) {
  return <Panel key={JSON.stringify([props.host.id, props.workspaceId, props.params.agentId])} {...props} />;
}

function Panel({ theme, host, workspaceId, params }: PluginAgentPanelProps) {
  const { colors } = theme;
  const { t } = useTranslation(messages);
  const [width, setWidth] = useState(0);
  const [search, setSearch] = useState("");
  const [selected, select] = useState<string | null>(null);
  const list = useRpc(listArtifacts);
  const scope = { workspaceId, agentId: params.agentId };
  const query = useQuery({
    queryKey: ["antigravity-artifacts", "list", host.id, workspaceId, params.agentId],
    queryFn: () => list(scope), retry: false, gcTime: 0,
  });
  const data = query.isError ? undefined : query.data;
  const ready = data?.status === "ready" ? data : undefined;
  const items = ready?.items ?? [];
  const match = search.trim().toLowerCase();
  const visible = items.filter((item) => item.path.toLowerCase().includes(match));
  const item = visible.find((item) => artifactKey(item) === selected);
  const split = width >= 680;
  const caption = { fontSize: 12, color: colors.foregroundMuted };
  const message = query.isError ? "listError" : data && data.status !== "ready" ? data.status
    : items.length === 0 ? "empty" : visible.length === 0 ? "noMatch" : null;
  return (
    <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)} style={{ flex: 1, flexDirection: split ? "row" : "column", backgroundColor: colors.surface0 }}>
      {split || !item ? (
        <View style={{ flex: split ? undefined : 1, width: split ? 285 : undefined, minHeight: 0,
          borderRightWidth: split ? 1 : 0, borderColor: colors.border }}>
          <View style={{ padding: 12, gap: 8 }}>
            <Action theme={theme} label={t("refresh")} icon="RefreshCw" disabled={query.isFetching} onPress={() => void query.refetch()} />
            {items.length > 1 ? (
              <TextInput accessibilityLabel={t("search")} placeholder={t("search")} placeholderTextColor={colors.foregroundMuted}
                value={search} onChangeText={setSearch} autoCapitalize="none" autoCorrect={false} maxLength={160}
                style={{ minHeight: 38, borderWidth: 1, borderColor: colors.border, borderRadius: 7, paddingHorizontal: 9,
                  fontSize: 16, color: colors.foreground }} />
            ) : null}
            {ready?.limited ? <Text style={caption}>{t("limited")}</Text> : null}
            {query.isPending ? <ActivityIndicator color={colors.accent} /> : null}
            {!query.isPending && message ? <Text style={caption}>{t(message)}</Text> : null}
          </View>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 12, gap: 4 }}>
            {visible.map((artifact) => {
              const key = artifactKey(artifact);
              const active = key === selected;
              const owner = artifact.ownerAgentId === scope.agentId ? t("main") : artifact.ownerTitle ?? t("child");
              return (
                <Pressable key={key} accessibilityRole="button" accessibilityLabel={`${artifact.path}, ${owner}`}
                  accessibilityState={{ selected: active }} onPress={() => select(key)}
                  style={({ hovered, pressed }: HoverState) => ({
                    padding: 8, minHeight: 46, flexDirection: "row", gap: 8, alignItems: "center", borderRadius: 7,
                    backgroundColor: active || hovered || pressed ? colors.surface2 : undefined,
                  })}>
                  <Icon name={fileIcons[artifact.kind]} size={16} color={active ? colors.accent : colors.foregroundMuted} />
                  <View style={{ flex: 1, gap: 3 }}>
                    <Text numberOfLines={2} style={{ fontSize: 13, fontWeight: "500", color: colors.foreground }}>{artifact.path}</Text>
                    <Text numberOfLines={1} style={caption}>{owner} · {bytesLabel(artifact.bytes)}</Text>
                  </View>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      ) : null}
      {item && ready ? (
        <View style={{ flex: 1, minWidth: 0 }}>
          {!split ? <View style={{ paddingHorizontal: 12, paddingTop: 10 }}>
            <Action theme={theme} label={t("back")} icon="ChevronLeft" onPress={() => select(null)} />
          </View> : null}
          <Preview theme={theme} hostId={host.id} scope={scope} item={item} rootConversationId={ready.conversationId} />
        </View>
      ) : split ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <Text style={caption}>{t("select")}</Text>
        </View>
      ) : null}
    </View>
  );
}
