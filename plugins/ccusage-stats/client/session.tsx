import type {
  PluginButtonContentProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect } from "react";
import { Pressable, Text, View } from "react-native";
import { PARENT_AGENT_LABEL, sessionUsageRpc, type SessionMatch } from "../shared/usage";
import { cacheHitRate, useSessionUsage } from "./data";
import { agentLabel, formatAgo, formatCost, formatPercent, formatTokens, shortSessionId } from "./format";
import { Composition, FONT, ModelRows } from "./summary";

const PILL_ID = "session-usage";
const PILL_REFRESH_MS = 60_000;
const AFTER_TURN_DELAY_MS = 2_000;
const BATCH_SIZE = 200;

export function SessionUsageContent({ theme, host, layout, onUpdate, ...target }: PluginButtonContentProps & {
  onUpdate(match: SessionMatch): void;
}) {
  const agentId = target.context === "agent" ? target.agentId : "";
  const { query, refresh } = useSessionUsage(host.id, agentId);
  const { data } = query;
  const match = data?.match;
  const session = match?.status === "matched" ? match.session : undefined;
  const usage = session?.usage ?? data?.latestRequest;
  const cacheHit = usage ? cacheHitRate(usage) : null;
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
        <Text style={[muted, { flexGrow: 1 }]}>{!session && usage ? "Latest request" : "This session"}</Text>
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
      {usage ? (
        <View style={{ flexDirection: "row", alignItems: "baseline", columnGap: 8, flexWrap: "wrap" }}>
          <Text style={{ fontSize: 22, fontWeight: "600", color: theme.colors.foreground, fontVariant: ["tabular-nums"] }}>
            {formatTokens(usage.totalTokens)}
          </Text>
          <Text style={muted}>{session?.recorded ? "recorded tokens" : "tokens"}</Text>
          {usage.cost !== null ? (
            <Text style={{ fontSize: FONT.title, color: theme.colors.foreground, fontVariant: ["tabular-nums"] }}>
              {formatCost(usage.cost)}
            </Text>
          ) : null}
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
      {usage ? (
        <>
          <Composition theme={theme} usage={usage} />
          {session?.models.length ? <ModelRows theme={theme} models={session.models} /> : null}
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

function pillLabel(match: SessionMatch | undefined, child: boolean): {
  visible: boolean;
  label?: string;
  title?: string;
} {
  if (match?.status !== "matched" || match.session.usage.totalTokens <= 0) {
    return child || (match?.status === "pending" && match.canRefresh)
      ? { visible: true, label: "Usage", title: "Session token usage" }
      : { visible: false };
  }
  const { usage, recorded } = match.session;
  const tokens = formatTokens(usage.totalTokens);
  return {
    visible: true,
    label: tokens,
    title: `Session usage · ${tokens} ${recorded ? "recorded tokens" : "tokens"}${usage.cost === null ? "" : " · " + formatCost(usage.cost)}`,
  };
}

interface AgentLike {
  id: string;
  workspaceId?: string | null;
  status?: string;
  archivedAt?: string | null;
  labels?: Readonly<Record<string, string>>;
}

export function contributeSessionPills(client: PluginClientContext): () => void {
  const pills = new Map<string, PluginButtonRegistration>();
  const agents = new Map<string, AgentLike>();
  const lifetime = new AbortController();
  let generation = 0;
  let running = false;
  let queued = false;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;

  const updatePill = (match: SessionMatch) => {
    const agent = agents.get(match.agentId);
    if (agent) pills.get(match.agentId)?.update(pillLabel(match, !!agent.labels?.[PARENT_AGENT_LABEL]));
  };

  const refresh = async () => {
    const agentIds = [...pills.keys()];
    if (agentIds.length === 0 || lifetime.signal.aborted) return;
    if (running) { queued = true; return; }
    running = true;
    const epoch = generation;
    try {
      for (let start = 0; start < agentIds.length; start += BATCH_SIZE) {
        const { sessions } = await client.rpc(sessionUsageRpc, { agentIds: agentIds.slice(start, start + BATCH_SIZE) });
        if (lifetime.signal.aborted || epoch !== generation) return;
        for (const match of sessions) updatePill(match);
      }
    } catch (error) {
      if (!lifetime.signal.aborted)
        console.warn("[ccusage-stats] Session usage refresh failed", error);
    } finally {
      running = false;
      if (queued) { queued = false; void refresh(); }
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
    const previous = agents.get(agent.id);
    agents.set(agent.id, agent);
    const child = !!agent.labels?.[PARENT_AGENT_LABEL];
    if (pills.has(agent.id)) {
      // The provider may have established the session ID during the turn.
      if (child !== !!previous?.labels?.[PARENT_AGENT_LABEL]) {
        pills.get(agent.id)?.update(pillLabel(undefined, child));
        scheduleRefresh(1_000);
      } else if (previous?.status === "running" && agent.status !== "running") {
        scheduleRefresh(AFTER_TURN_DELAY_MS);
      }
      return false;
    }
    pills.set(
      agent.id,
      client.addComposerPill({
        id: PILL_ID,
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        button: {
          icon: "Coins",
          title: "Session token usage",
          ...pillLabel(undefined, child),
          behavior: { kind: "popover", Content: (props) => <SessionUsageContent {...props} onUpdate={updatePill} /> },
        },
      }),
    );
    return true;
  };

  const unregister = (agentId: string) => {
    pills.get(agentId)?.remove();
    pills.delete(agentId);
    agents.delete(agentId);
  };

  const removeAll = () => {
    for (const pill of pills.values()) pill.remove();
    pills.clear();
    agents.clear();
  };

  async function observeAgents() {
    const sort = [{ key: "created_at" as const, direction: "desc" as const }];
    let options = { includeBackground: true, signal: lifetime.signal, sort };
    const { subscription } = await client.paseo.agents.list({ ...options, subscribe: {} }).catch((error) => {
      if (lifetime.signal.aborted) throw error;
      // The inclusive selector was introduced after the plugin's minimum Paseo version.
      options = { ...options, includeBackground: false };
      return client.paseo.agents.list({ subscribe: {}, signal: options.signal, sort });
    });
    let paging: Set<string> | undefined;
    if (!lifetime.signal.aborted) {
      subscription.subscribe({
        snapshot: ({ entries, pageInfo }) => {
          const epoch = ++generation;
          removeAll();
          for (const { agent } of entries) register(agent);
          const cursor = pageInfo?.nextCursor;
          paging = cursor ? new Set() : undefined;
          if (cursor && paging) void loadMore(cursor, epoch, paging);
          else void refresh();
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          paging?.add(update.kind === "upsert" ? update.agent.id : update.agentId);
          if (update.kind === "upsert") {
            if (update.agent.archivedAt) unregister(update.agent.id);
            else if (register(update.agent)) scheduleRefresh(1_000);
            return;
          }
          unregister(update.agentId);
        },
      });
    }

    async function loadMore(cursor: string | null | undefined, epoch: number, changes: Set<string>) {
      const visited = new Set<string>();
      try {
        while (cursor && !visited.has(cursor) && !lifetime.signal.aborted && epoch === generation) {
          visited.add(cursor);
          const page = await client.paseo.agents.list({ ...options, page: { cursor, limit: BATCH_SIZE } });
          if (lifetime.signal.aborted || epoch !== generation) return;
          for (const { agent } of page.entries) if (!changes.has(agent.id)) register(agent);
          cursor = page.pageInfo.nextCursor;
        }
      } catch (error) {
        if (!lifetime.signal.aborted) console.warn("[ccusage-stats] Additional agent page failed", error);
      } finally {
        if (epoch === generation) {
          paging = undefined;
          void refresh();
        }
      }
    }
  }

  void observeAgents().catch((error) => {
    if (!lifetime.signal.aborted) console.error("[ccusage-stats] Agent observation failed", error);
  });

  const interval = setInterval(() => void refresh(), PILL_REFRESH_MS);

  return () => {
    lifetime.abort();
    clearInterval(interval);
    if (refreshTimer) clearTimeout(refreshTimer);
    removeAll();
  };
}
