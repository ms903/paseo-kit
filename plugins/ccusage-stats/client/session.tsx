import type {
  PluginButtonContentProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect } from "react";
import { Pressable, Text, View } from "react-native";
import { sessionUsageRpc, type SessionMatch } from "../shared/usage";
import { cacheHitRate, useSessionUsage } from "./data";
import { agentLabel, formatAgo, formatCost, formatPercent, formatTokens, shortSessionId } from "./format";
import { Composition, FONT, ModelRows } from "./summary";

const PILL_ID = "session-usage";
const PILL_REFRESH_MS = 60_000;
const AFTER_TURN_DELAY_MS = 2_000;

export function SessionUsageContent({ theme, host, layout, onUpdate, ...target }: PluginButtonContentProps & {
  onUpdate(match: SessionMatch): void;
}) {
  const agentId = target.context === "agent" ? target.agentId : "";
  const { query, refresh } = useSessionUsage(host.id, agentId);
  const { data } = query;
  const match = data?.match;
  const session = match?.status === "matched" ? match.session : undefined;
  const cacheHit = session ? cacheHitRate(session.usage) : null;
  const { used, limit } = data?.context ?? {};
  const occupied = used !== undefined && limit !== undefined ? used / limit : undefined;
  const context = used !== undefined
    ? (limit === undefined ? formatTokens(used) + " tokens" : formatTokens(used) + " / " + formatTokens(limit))
    : (limit === undefined ? "—" : formatTokens(limit) + " limit");
  const checkedAt = data?.usageCheckedAt ?? (data?.context ? data.checkedAt : undefined);
  const lastActivity = Date.parse(session?.lastActivity ?? "");
  const muted = { fontSize: FONT.caption, color: theme.colors.foregroundMuted };
  const targetLabel = session ? agentLabel(session.agent) + " session " + shortSessionId(session.id) : undefined;
  const busy = refresh.isPending;

  useEffect(() => {
    if (match) onUpdate(match);
  }, [match, onUpdate]);

  return (
    <View style={{ gap: 12, padding: layout.compact ? 4 : 0, minWidth: 260 }}>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <Text style={[muted, { flexGrow: 1 }]}>This session</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh session"
          accessibilityState={{ busy, disabled: busy }}
          disabled={busy || !agentId}
          onPress={() => refresh.mutate()}
          style={({ pressed }) => ({
            flexDirection: "row", alignItems: "center", gap: 6, minHeight: 36,
            paddingHorizontal: 8, borderRadius: 7, borderWidth: 1, borderColor: theme.colors.border,
            backgroundColor: pressed ? theme.colors.surface2 : theme.colors.surface1,
          })}
        >
          <Icon name="RefreshCw" size={14} color={theme.colors.foregroundMuted} />
          <Text style={{ fontSize: FONT.body, color: theme.colors.foreground }}>
            {busy ? "Refreshing…" : "Refresh"}
          </Text>
        </Pressable>
      </View>
      {session ? (
        <View style={{ flexDirection: "row", alignItems: "baseline", columnGap: 8, flexWrap: "wrap" }}>
          <Text style={{ fontSize: 22, fontWeight: "600", color: theme.colors.foreground, fontVariant: ["tabular-nums"] }}>
            {formatTokens(session.usage.totalTokens)}
          </Text>
          <Text style={muted}>tokens</Text>
          <Text style={{ fontSize: FONT.title, color: theme.colors.foreground, fontVariant: ["tabular-nums"] }}>
            {formatCost(session.usage.cost)}
          </Text>
        </View>
      ) : null}
      {data ? (
        <View style={{
          flexDirection: "row", flexWrap: "wrap", gap: 10, borderRadius: 7,
          backgroundColor: theme.colors.surface1, padding: 9,
        }}>
          <View style={{ flexGrow: 1, minWidth: 85, gap: 3 }}>
            <Text style={muted}>Cache hit rate</Text>
            <Text style={{ fontSize: FONT.title, fontWeight: "600", color: theme.colors.foreground }}>
              {cacheHit === null ? "—" : formatPercent(cacheHit)}
            </Text>
          </View>
          <View style={{ flexGrow: 1, minWidth: 116, gap: 3 }}>
            <Text style={muted}>Context window</Text>
            <Text style={{ fontSize: FONT.title, fontWeight: "600", color: theme.colors.foreground }}>
              {context}{occupied === undefined ? "" : " · " + formatPercent(occupied)}
            </Text>
          </View>
        </View>
      ) : null}
      {session ? (
        <>
          <Composition theme={theme} usage={session.usage} />
          {session.models.length ? <ModelRows theme={theme} models={session.models} /> : null}
        </>
      ) : query.isPending && !refresh.isError ? (
        <Text style={muted}>Loading session usage…</Text>
      ) : match ? (
        <Text style={muted}>{match.status === "unknown" ? "Provider session not started." : "No usage recorded yet."}</Text>
      ) : null}
      {refresh.isError || (query.isError && !data) ? (
        <Text accessibilityLiveRegion="polite" style={{ ...muted, color: theme.colors.statusWarning }}>
          {refresh.isError ? "Could not refresh session." : "Could not load session usage."}
        </Text>
      ) : null}
      {targetLabel || checkedAt !== undefined ? (
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 6 }}>
          <Icon name="Link" size={12} color={theme.colors.foregroundMuted} />
          <View style={{ flex: 1, gap: 2 }}>
            {targetLabel ? (
              <Text style={muted}>{targetLabel}{Number.isFinite(lastActivity) ? " · last active " + formatAgo(lastActivity) : ""}</Text>
            ) : null}
            {checkedAt !== undefined ? (
              <Text style={muted}>{data?.usageCheckedAt !== undefined ? "Usage checked " : "Context checked "}{formatAgo(checkedAt)}</Text>
            ) : null}
          </View>
        </View>
      ) : null}
    </View>
  );
}

function pillLabel(match: SessionMatch | undefined): {
  visible: boolean;
  label?: string;
  title?: string;
} {
  if (match?.status === "pending" && match.canRefresh) {
    return { visible: true, label: "Usage", title: "Session token usage" };
  }
  if (match?.status !== "matched" || match.session.usage.totalTokens <= 0)
    return { visible: false };
  const { usage } = match.session;
  return {
    visible: true,
    label: formatTokens(usage.totalTokens),
    title: `Session usage: ${formatTokens(usage.totalTokens)} tokens, ${formatCost(usage.cost)}`,
  };
}

interface AgentLike {
  id: string;
  workspaceId?: string | null;
  status?: string;
  archivedAt?: string | null;
}

/**
 * A composer pill per agent, shown once the report has recorded usage for its provider session.
 */
export function contributeSessionPills(client: PluginClientContext): () => void {
  const pills = new Map<string, PluginButtonRegistration>();
  const statuses = new Map<string, string | undefined>();
  const lifetime = new AbortController();
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;

  const refresh = async () => {
    const agentIds = [...pills.keys()];
    if (agentIds.length === 0 || lifetime.signal.aborted) return;
    try {
      const { sessions } = await client.rpc(sessionUsageRpc, { agentIds: agentIds.slice(0, 200) });
      if (lifetime.signal.aborted) return;
      for (const match of sessions) pills.get(match.agentId)?.update(pillLabel(match));
    } catch (error) {
      if (!lifetime.signal.aborted)
        console.warn("[ccusage-stats] Session usage refresh failed", error);
    }
  };

  const scheduleRefresh = (delay: number) => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refresh();
    }, delay);
  };

  const register = (agent: AgentLike) => {
    if (lifetime.signal.aborted || !agent.workspaceId || agent.archivedAt) return false;
    const previous = statuses.get(agent.id);
    statuses.set(agent.id, agent.status);
    if (pills.has(agent.id)) {
      // The provider may have established the session ID during the turn.
      if (previous === "running" && agent.status !== "running")
        scheduleRefresh(AFTER_TURN_DELAY_MS);
      return false;
    }
    const onUpdate = (match: SessionMatch) => pills.get(agent.id)?.update(pillLabel(match));
    pills.set(
      agent.id,
      client.addComposerPill({
        id: PILL_ID,
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        button: {
          title: "Session token usage",
          icon: "Coins",
          visible: false,
          behavior: { kind: "popover", Content: (props) => <SessionUsageContent {...props} onUpdate={onUpdate} /> },
        },
      }),
    );
    return true;
  };

  const unregister = (agentId: string) => {
    pills.get(agentId)?.remove();
    pills.delete(agentId);
    statuses.delete(agentId);
  };

  const removeAll = () => {
    for (const pill of pills.values()) pill.remove();
    pills.clear();
    statuses.clear();
  };

  // An owned list subscription delivers existing agents, then updates, and a fresh snapshot after a reconnect.
  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          removeAll();
          for (const { agent } of entries) register(agent);
          void refresh();
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") {
            if (update.agent.archivedAt) unregister(update.agent.id);
            else if (register(update.agent)) scheduleRefresh(1_000);
            return;
          }
          unregister(update.agentId);
        },
      });
      return undefined;
    })
    .catch((error) => {
      if (!lifetime.signal.aborted)
        console.error("[ccusage-stats] Agent observation failed", error);
    });

  const interval = setInterval(() => void refresh(), PILL_REFRESH_MS);

  return () => {
    lifetime.abort();
    clearInterval(interval);
    if (refreshTimer) clearTimeout(refreshTimer);
    removeAll();
  };
}
