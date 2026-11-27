import {
  useTranslation,
  type PluginButtonContentProps,
  type PluginClientContext,
  type PluginWorkspaceRowBadgeItemProps,
} from "@getpaseo/plugin/client";
import { WorkspaceRowBadge } from "@getpaseo/plugin/client/react-native";
import { useEffect, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { messages } from "./client/messages";
import { labelKey, watchHeartbeats } from "./client/monitor";
import { decorateWeb } from "./client/web";
import { heartbeatSummaryRpc, type HeartbeatSummary } from "./shared/heartbeat";

const icon = "HeartPulse";

export default function contribute(client: PluginClientContext) {
  let rows: readonly HeartbeatSummary[] = [];
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
          pill.registration.update({ label: messages.message(label) });
        }
      } else {
        const registration = client.addComposerPill({
          id: "scheduled-heartbeat", workspaceId: row.workspaceId, agentId,
          button: {
            icon, title: messages.message("heading"), label: messages.message(label),
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
      stopWatchingDecorations = decorations.subscribe(refreshViews);
      decorations.update(rows);
    }
    return decorations;
  }

  function WorkspaceBadge({ workspaceId, host }: PluginWorkspaceRowBadgeItemProps) {
    useSyncExternalStore(subscribe, snapshot, snapshot);
    const { t } = useTranslation(messages);
    useEffect(() => bindHost(host.id)?.mountWorkspace(workspaceId), [host.id, workspaceId]);
    if (decorations?.isWorkspaceDecorated(workspaceId)) return null;
    const workspaceRows = rows.filter((row) => row.workspaceId === workspaceId);
    if (!workspaceRows.length) return null;
    const name = (row: HeartbeatSummary) => row.title || t("agent", { id: row.agentId });
    return <WorkspaceRowBadge icon={icon} tone="info"
      label={workspaceRows.map(name).join(", ")}
      accessibilityLabel={workspaceRows.map((row) =>
        t("details", { name: name(row), direct: row.direct, descendants: row.descendants })).join(" ")} />;
  }

  const removeBadge = client.addWorkspaceRowBadgeItem({
    id: "scheduled-heartbeats", title: messages.message("heading"), icon, Component: WorkspaceBadge,
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
    stopPolling();
    stopWatchingDecorations?.();
    decorations?.dispose();
    for (const pill of pills.values()) pill.registration.remove();
    pills.clear();
    removeBadge();
    listeners.clear();
  };
}
