import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Pressable, Text, TextInput, View, type PressableStateCallbackType } from "react-native";
import { SESSION_PAGE_SIZE, sessionListRpc, type UsageReport } from "../shared/usage";
import { SwatchDot } from "./charts";
import { agentSwatch } from "./data";
import { agentLabel, formatCost, formatTokens, shortSessionId } from "./format";
import { Composition, FONT, ModelRows, UsageAmounts, UsageTableHeader, usageColumns } from "./summary";

type HoverState = PressableStateCallbackType & { hovered?: boolean };

function SessionControl({ theme, icon, label, onPress, active, expanded, disabled }: {
  theme: PluginTheme;
  icon?: string;
  label: string;
  onPress(): void;
  active?: boolean;
  expanded?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active, expanded, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ hovered, pressed }: HoverState) => ({
        flexDirection: "row", alignItems: "center", gap: 6, minHeight: 38,
        paddingHorizontal: 9, borderRadius: 6, borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: active || hovered || pressed ? theme.colors.surface2 : theme.colors.surface0,
        opacity: disabled ? 0.5 : 1,
      })}
    >
      {icon ? <Icon name={icon} size={14} color={theme.colors.foregroundMuted} /> : null}
      <Text style={{ fontSize: FONT.body, color: theme.colors.foreground }}>{label}</Text>
      {expanded !== undefined ? (
        <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={14} color={theme.colors.foregroundMuted} />
      ) : null}
    </Pressable>
  );
}

export function SessionList({ theme, hostId, report, clock, narrow, period }: {
  theme: PluginTheme;
  hostId: string;
  report: UsageReport;
  clock: Intl.DateTimeFormat;
  narrow: boolean;
  period?: { since: string; until: string; label: string };
}) {
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [agent, setAgent] = useState("");
  const [openFilter, setOpenFilter] = useState<"agent" | "date" | null>(null);
  const [withinPeriod, setWithinPeriod] = useState(false);
  const [page, setPage] = useState({ filter: "", offset: 0 });
  const [expanded, setExpanded] = useState<string | null>(null);
  const dateRange = withinPeriod ? period : undefined;
  const filter = JSON.stringify([agent, text.trim(), dateRange?.since, dateRange?.until]);
  const offset = page.filter === filter ? page.offset : 0;
  const list = useRpc(sessionListRpc);
  const ready = text.trim() === search;
  useEffect(() => {
    const timer = setTimeout(() => setSearch(text.trim()), 220);
    return () => clearTimeout(timer);
  }, [text]);
  const query = useQuery({
    queryKey: ["usage-session-list", hostId, report.revision, filter, offset],
    queryFn: () => list({
      agent: agent || undefined, search: search || undefined,
      since: dateRange?.since, until: dateRange?.until, offset,
    }),
    enabled: ready,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === hostId && previousQuery.queryKey[3] === filter ? previous : undefined,
    retry: false,
    refetchInterval: ({ state }) => state.data?.complete === false && !report.sessionRefreshError && !report.refreshError
      ? 10_000 : false,
    staleTime: Infinity,
    gcTime: 60_000,
  });
  const result = ready ? query.data : undefined;
  const rows = result?.sessions ?? (!agent && !text.trim() && !dateRange && offset === 0 ? report.recentSessions : []);
  const allAgents = result?.agents ?? report.agents;
  const first = result?.offset ?? 0;
  const total = result?.total ?? rows.length;
  const columns = narrow ? undefined : usageColumns(rows.map((session) => session.usage));
  const muted = { fontSize: FONT.body, color: theme.colors.foregroundMuted };
  const title = { fontSize: FONT.body, fontWeight: "600" as const, color: theme.colors.foreground };
  const pageTo = (next: number) => {
    setPage({ filter, offset: next });
    setExpanded(null);
  };

  return (
    <>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        <View style={{
          flexDirection: "row", alignItems: "center", gap: 7, minHeight: 38,
          flexBasis: narrow ? "100%" : 220, flexGrow: 1, minWidth: 0, paddingHorizontal: 9,
          borderRadius: 6, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface0,
        }}>
          <Icon name="Search" size={14} color={theme.colors.foregroundMuted} />
          <TextInput
            accessibilityLabel="Search sessions by ID or model"
            placeholder="Session ID or model"
            placeholderTextColor={theme.colors.foregroundMuted}
            value={text}
            onChangeText={(next) => { setText(next); setExpanded(null); }}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            maxLength={120}
            style={{ flex: 1, minWidth: 0, minHeight: 36, color: theme.colors.foreground, fontSize: narrow ? 16 : FONT.body }}
          />
          {text ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Clear session search" hitSlop={8}
              onPress={() => { setText(""); setSearch(""); setExpanded(null); }}>
              <Icon name="X" size={14} color={theme.colors.foregroundMuted} />
            </Pressable>
          ) : null}
        </View>
        <SessionControl theme={theme} icon="Filter" label={agent ? agentLabel(agent) : "All agents"}
          expanded={openFilter === "agent"} active={!!agent}
          onPress={() => setOpenFilter(openFilter === "agent" ? null : "agent")} />
        {period ? (
          <SessionControl theme={theme} icon="Calendar" active={!!dateRange}
            label={dateRange ? dateRange.label : "All dates"} expanded={openFilter === "date"}
            onPress={() => setOpenFilter(openFilter === "date" ? null : "date")} />
        ) : null}
      </View>
      {openFilter === "agent" ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {["", ...allAgents].map((option) => (
            <SessionControl key={option} theme={theme} label={option ? agentLabel(option) : "All agents"}
              active={agent === option} onPress={() => { setAgent(option); setOpenFilter(null); setExpanded(null); }} />
          ))}
        </View>
      ) : null}
      {openFilter === "date" && period ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {[false, true].map((limit) => (
            <SessionControl key={String(limit)} theme={theme} label={limit ? period.label : "All dates"}
              active={withinPeriod === limit}
              onPress={() => { setWithinPeriod(limit); setOpenFilter(null); setExpanded(null); }} />
          ))}
        </View>
      ) : null}
      {report.sessionRefreshError ? (
        <Text style={[muted, { color: theme.colors.statusWarning }]}>Could not refresh sessions. {report.sessionRefreshError}</Text>
      ) : null}
      {rows.length ? (
        <View>
          <UsageTableHeader theme={theme} label="Session" columns={columns} trailing={14} />
          {rows.map((session, index) => {
            const key = JSON.stringify([session.agent, session.id]);
            const open = expanded === key;
            const name = agentLabel(session.agent);
            const id = shortSessionId(session.id);
            const lastActivity = Date.parse(session.lastActivity ?? "");
            const date = Number.isFinite(lastActivity) ? clock.format(lastActivity) : null;
            const model = session.models[0]?.model;
            const caption = model && date ? `${model} · ${date}` : model ?? date;
            return (
              <View key={key} style={{ borderTopWidth: index > 0 ? 1 : 0, borderTopColor: theme.colors.border }}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${name} session ${id}, ${formatTokens(session.usage.totalTokens)} tokens, ${formatCost(session.usage.cost)}`}
                  accessibilityState={{ expanded: open }}
                  aria-expanded={open}
                  onPress={() => setExpanded(open ? null : key)}
                  style={({ hovered, pressed }: HoverState) => ({
                    flexDirection: "row", alignItems: "center", gap: 10, minHeight: 46, paddingVertical: 8,
                    marginHorizontal: -6, paddingHorizontal: 6, borderRadius: 6,
                    backgroundColor: open || hovered || pressed ? theme.colors.surface2 : undefined,
                  })}
                >
                  <SwatchDot swatch={agentSwatch(theme, report.agents, session.agent)} />
                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    <Text style={{ fontSize: FONT.body, color: theme.colors.foreground }}>
                      {name}
                      <Text style={{ color: theme.colors.foregroundMuted, fontVariant: ["tabular-nums"] }}>
                        {`  ${id}`}
                      </Text>
                    </Text>
                    {caption ? <Text style={[muted, { fontSize: FONT.caption }]}>{caption}</Text> : null}
                  </View>
                  <UsageAmounts theme={theme} usage={session.usage} columns={columns} />
                  <Icon name={open ? "ChevronUp" : "ChevronDown"} size={14} color={theme.colors.foregroundMuted} />
                </Pressable>
                {open ? (
                  <View style={{ gap: 10, marginVertical: 6, padding: 12, borderRadius: 6, backgroundColor: theme.colors.surface0 }}>
                    <Text accessibilityRole="header" style={title}>Token breakdown</Text>
                    <Composition theme={theme} usage={session.usage} />
                    {session.models.length ? (
                      <View>
                        <UsageTableHeader theme={theme} label="Model" columns={columns} />
                        <ModelRows theme={theme} models={session.models} columns={columns} />
                      </View>
                    ) : null}
                  </View>
                ) : null}
              </View>
            );
          })}
        </View>
      ) : null}
      {query.isError && ready ? (
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <Text style={muted}>Could not load sessions.</Text>
          <SessionControl theme={theme} label="Try again" onPress={() => void query.refetch()} />
        </View>
      ) : !result || !result.complete ? (
        report.sessionRefreshError || report.refreshError ? null : <Text style={muted}>Reading session history…</Text>
      ) : !rows.length ? (
        <Text style={muted}>{agent || search || dateRange ? "No matching sessions." : "No sessions yet."}</Text>
      ) : null}
      {total > SESSION_PAGE_SIZE ? (
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
          <Text accessibilityLiveRegion="polite" style={[muted, { flexGrow: 1 }]}>{first + 1}–{first + rows.length} of {total}</Text>
          {first > 0 ? (
            <SessionControl theme={theme} label="Previous" disabled={query.isPlaceholderData}
              onPress={() => pageTo(first - SESSION_PAGE_SIZE)} />
          ) : null}
          {first + rows.length < total ? (
            <SessionControl theme={theme} label="Next" disabled={query.isPlaceholderData}
              onPress={() => pageTo(first + SESSION_PAGE_SIZE)} />
          ) : null}
        </View>
      ) : null}
    </>
  );
}
