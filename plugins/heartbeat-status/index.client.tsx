import type { PluginIconProps } from "@getpaseo/plugin";
import {
  useTranslation,
  type PluginButtonContentProps,
  type PluginClientContext,
  type PluginWorkspaceRowBadgeItemProps,
} from "@getpaseo/plugin/client";
import { WorkspaceRowBadge } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { Platform, Text, View } from "react-native";
import { createClockIcon } from "./client/clock";
import { messages } from "./client/messages";
import { labelKey, watchHeartbeats } from "./client/monitor";
import { NativeWorkspaceClock } from "./client/native-workspace-clock";
import { appearanceTitle, HeartbeatSettingsScreen } from "./client/settings-screen";
import { watchAppearance } from "./client/settings-sync";
import { decorateWeb } from "./client/web";
import { heartbeatSummaryRpc, type HeartbeatSummary } from "./shared/heartbeat";
import { defaults } from "./shared/settings";

export default function contribute(client: PluginClientContext) {
  const clock = createClockIcon();
  let rows: readonly HeartbeatSummary[] = [];
  let appearance = defaults;
  let version = 0;
  let stopped = false;
  let decorations: ReturnType<typeof decorateWeb> | undefined;
  let stopWatchingDecorations: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const pills = new Map<string, {
    workspaceId: string;
    label: ReturnType<typeof labelKey>;
    registration: ReturnType<PluginClientContext["addComposerPill"]>;
  }>();

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  const snapshot = () => version;

  function Details(props: PluginButtonContentProps) {
    useSyncExternalStore(subscribe, snapshot, snapshot);
    const { t } = useTranslation(messages);
    if (props.context !== "agent") return null;
    const { agentId, theme } = props;
    const row = rows.find((item) => item.agentId === agentId);
    if (!row) return null;
    const name = row.title || t("agent", { id: row.agentId });
    return (
      <View style={{ padding: 12, gap: 6, maxWidth: 320 }}>
        <Text style={{ color: theme.colors.foreground }}>
          {t("details", { name, direct: row.direct, descendants: row.descendants })}
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted }}>{t("help")}</Text>
      </View>
    );
  }

  function refreshViews() {
    if (stopped) return;
    const targets = new Map(rows
      .filter((row) => !decorations?.isAgentDecorated(row.agentId))
      .map((row) => [row.agentId, row]));
    for (const [id, pill] of pills) {
      if (targets.get(id)?.workspaceId === pill.workspaceId) continue;
      pill.registration.remove();
      pills.delete(id);
    }
    for (const [agentId, row] of targets) {
      if (!row.workspaceId) continue;
      const label = labelKey(row);
      const pill = pills.get(agentId);
      if (pill) {
        if (pill.label !== label) {
          pill.label = label;
          const title = messages.message(label);
          pill.registration.update({ title, label: title });
        }
      } else {
        const title = messages.message(label);
        const registration = client.addComposerPill({
          id: "scheduled-heartbeat", workspaceId: row.workspaceId, agentId,
          button: {
            icon: clock.Icon, title, label: title,
            behavior: { kind: "popover", Content: Details },
          },
        });
        pills.set(agentId, { workspaceId: row.workspaceId, label, registration });
      }
    }
    version++;
    for (const listener of listeners) listener();
  }

  function bindHost(hostId: string) {
    if (!decorations && !stopped) {
      decorations = decorateWeb(hostId, () => client.i18n.locale);
      decorations.setSettings(appearance);
      stopWatchingDecorations = decorations.subscribe(refreshViews);
      decorations.update(rows);
    }
    return decorations;
  }

  function WorkspaceBadge({ workspaceId, host, theme }: PluginWorkspaceRowBadgeItemProps) {
    useSyncExternalStore(subscribe, snapshot, snapshot);
    const { t } = useTranslation(messages);
    const surface = theme.colors.surface0;
    const ThemedClock = useMemo(() => (props: PluginIconProps) =>
      <clock.Icon {...props} surface={surface} />, [surface]);
    useEffect(() => bindHost(host.id)?.mountWorkspace(workspaceId), [host.id, workspaceId]);
    if (decorations?.isWorkspaceDecorated(workspaceId)) return null;
    const workspaceRows = rows.filter((row) => row.workspaceId === workspaceId);
    if (!workspaceRows.length) return null;
    const name = (row: HeartbeatSummary) => row.title || t("agent", { id: row.agentId });
    const label = workspaceRows.map((row) =>
      t("details", { name: name(row), direct: row.direct, descendants: row.descendants })).join(" ");
    if (Platform.OS === "ios" || Platform.OS === "android") {
      return <NativeWorkspaceClock
        key={host.id + ":" + workspaceId}
        rowId={"sidebar-workspace-row-" + host.id + ":" + workspaceId}
        Icon={ThemedClock} label={label}
        fallback={<WorkspaceRowBadge icon={ThemedClock} accessibilityLabel={label} />}
      />;
    }
    return <WorkspaceRowBadge icon={ThemedClock} tone="muted"
      label={workspaceRows.map(name).join(", ")}
      accessibilityLabel={label} />;
  }

  const removeBadge = client.addWorkspaceRowBadgeItem({
    id: "scheduled-heartbeats", title: messages.message("heading"), icon: "Clock", Component: WorkspaceBadge,
  });
  const removeScreen = client.addSettingsScreen({
    id: "appearance", title: appearanceTitle, icon: "Clock", Component: HeartbeatSettingsScreen,
  });
  const stopAppearance = watchAppearance(client, (settings) => {
    appearance = settings;
    decorations?.setSettings(settings);
    clock.setSettings(settings);
  });
  const stopPolling = watchHeartbeats(() => client.rpc(heartbeatSummaryRpc, { agentIds: [] }), (agents) => {
    rows = agents;
    // When the sidebar is collapsed its row hasn't supplied a host ID. The SDK handle has the
    // authenticated server ID of this installation's daemon connection.
    if (!decorations && agents[0]) bindHost(client.paseo.agents.ref(agents[0].agentId).address.serverId);
    decorations?.update(rows);
    refreshViews();
  });
  return () => {
    stopped = true;
    stopAppearance();
    removeScreen();
    stopPolling();
    clock.dispose();
    stopWatchingDecorations?.();
    decorations?.dispose();
    for (const pill of pills.values()) pill.registration.remove();
    pills.clear();
    removeBadge();
    listeners.clear();
  };
}
