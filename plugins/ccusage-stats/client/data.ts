import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  EMPTY_USAGE,
  sessionDetailRpc,
  usageReportRpc,
  type AgentUsage,
  type Usage,
  type UsagePeriod,
  type ReportResponse,
} from "../shared/usage";

const REPORT_REFRESH_MS = 2 * 60_000;
export const USAGE_REPORT_KEY = ["usage-report"] as const;
export const SESSION_USAGE_KEY = ["session-usage"] as const;

export type { UsageReport } from "../shared/usage";

export function useReadUsage(hostId: string) {
  const getReport = useRpc(usageReportRpc);
  const client = useQueryClient();
  return async (refresh = false): Promise<ReportResponse> => {
    const cached = client.getQueryData<ReportResponse>([...USAGE_REPORT_KEY, hostId]);
    const previous = cached && !("status" in cached) ? cached : undefined;
    const result = await getReport({ refresh, knownRevision: previous?.revision });
    let report: ReportResponse;
    if ("status" in result && result.status === "unchanged") {
      if (!previous || previous.revision !== result.revision) throw new Error("Usage report revision mismatch");
      report = {
        ...previous, generatedAt: result.generatedAt, usageRefreshedAt: result.usageRefreshedAt, refreshing: result.refreshing,
        refreshError: result.refreshError, progress: result.progress,
      };
    } else {
      report = result;
    }
    if (cached && !("status" in report) && !report.sessionsPending && previous?.revision !== report.revision) {
      void client.invalidateQueries({ queryKey: [...SESSION_USAGE_KEY, hostId] });
    }
    return report;
  };
}

export function useUsageReport(hostId: string) {
  const read = useReadUsage(hostId);
  const queryKey = [...USAGE_REPORT_KEY, hostId];
  const query = useQuery({
    queryKey,
    queryFn: () => read(),
    retry: false,
    refetchInterval: ({ state: { data, error } }) => {
      if (error || !data) return REPORT_REFRESH_MS;
      if ("status" in data) return data.status === "today" && data.refreshError ? REPORT_REFRESH_MS : 5_000;
      if (!data.refreshing) return REPORT_REFRESH_MS;
      return (data.progress?.elapsedSeconds ?? 0) >= 30 ? 15_000 : 5_000;
    },
    staleTime: REPORT_REFRESH_MS / 2,
  });
  const response = query.data;
  const data = response && !("status" in response) ? response : undefined;
  const preview = response && "status" in response && response.status === "today" ? response : undefined;
  return { ...query, data, preview, progress: response?.progress, isPending: !data && !query.error && !preview?.refreshError };
}

export function useSessionUsage(hostId: string, agentId: string) {
  const read = useRpc(sessionDetailRpc);
  const client = useQueryClient();
  const queryKey = [...SESSION_USAGE_KEY, hostId, "detail", agentId];
  const query = useQuery({
    queryKey,
    queryFn: () => read({ agentId }),
    enabled: !!agentId,
    retry: false,
    refetchOnMount: "always",
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });
  const refresh = useMutation({
    mutationFn: () => read({ agentId, refresh: true }),
    retry: false,
    onSuccess: async (data) => {
      await client.cancelQueries({ queryKey, exact: true });
      client.setQueryData(queryKey, data);
    },
  });
  return { query, refresh };
}

export function cacheHitRate(usage: Usage): number | null {
  const prompt = usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
  return prompt > 0 ? usage.cacheReadTokens / prompt : null;
}

// Days before today that define a typical day for the sidebar meter: four weeks, so weekly rhythms
// even out and enough active days remain once idle ones are skipped.
export const TYPICAL_DAYS = 28;
// With no history, the typical day follows SemiAnalysis's subscription limit tests (October 2026,
// agentic workload): a $200 Claude Max 20x plan holds about $11,726 of API-equivalent value a month
// on Opus 5.5, and 20% is a realistic utilization. Labs change limits often; revisit with new tests.
export const DEFAULT_TYPICAL_COST = (11726 * 0.2) / 30;

/** A typical day in API-equivalent dollars, the same measure ccusage's cost is in. */
export interface TypicalDay {
  cost: number;
  /** Active days the figure is drawn from; 0 when the default stands in. */
  activeDays: number;
  /** True when there is no recent history and the default stands in. */
  estimated: boolean;
  /**
   * Mean cost per calendar day, idle days included, from the first day with usage in the window
   * through yesterday: what the meter's agents cost over time, comparable to a plan's price.
   * Null with no history.
   */
  average: { cost: number; days: number } | null;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * Median cost per active day over the TYPICAL_DAYS before today. Idle days are skipped so
 * weekends and time off do not drag the typical day down, and the median keeps one marathon day,
 * or a day with a single prompt, from moving it far. Cost rather than tokens, because cache reads
 * dominate token counts while costing next to nothing.
 */
export function typicalDay(daily: readonly UsagePeriod[]): TypicalDay | null {
  const costs: number[] = [];
  for (const day of daily.slice(-TYPICAL_DAYS - 1, -1)) {
    if (day.usage.cost === null) return null;
    costs.push(day.usage.cost);
  }
  const active = costs.filter((cost) => cost > 0);
  if (active.length === 0) {
    return { cost: DEFAULT_TYPICAL_COST, activeDays: 0, estimated: true, average: null };
  }
  // Counting from the first active day, so a short history is not averaged over empty weeks
  // from before it began.
  const days = costs.length - costs.findIndex((cost) => cost > 0);
  const total = active.reduce((sum, cost) => sum + cost, 0);
  return {
    cost: median(active),
    activeDays: active.length,
    estimated: false,
    average: { cost: total / days, days },
  };
}

// Okabe–Ito Color Universal Design palette.
// https://jfly.uni-koeln.de/color/
const AGENT_COLORS = ["#0072B2", "#D55E00", "#009E73", "#CC79A7"] as const;

/** Named series before the rest fold into "Other". */
export const MAX_NAMED_AGENTS = AGENT_COLORS.length;
export const OTHER_AGENT = "other";

export interface Swatch {
  color: string;
  opacity: number;
}

/** Use the report-wide order so charts, legends and lists agree across periods. */
export function agentSwatch(theme: PluginTheme, agents: readonly string[], agent: string): Swatch {
  const color = agent === OTHER_AGENT ? undefined : AGENT_COLORS[agents.indexOf(agent)];
  return { color: color ?? theme.colors.foregroundMuted, opacity: 1 };
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: a.cost === null || b.cost === null ? null : a.cost + b.cost,
  };
}

/** A period's agents in report order, with anything past the named slots folded into "Other". */
export function foldAgents(agents: readonly AgentUsage[], order: readonly string[]): AgentUsage[] {
  const named: AgentUsage[] = [];
  let other: AgentUsage | null = null;
  for (const agent of agents) {
    const rank = order.indexOf(agent.agent);
    if (rank >= 0 && rank < MAX_NAMED_AGENTS) {
      named.push(agent);
    } else {
      other ??= { agent: OTHER_AGENT, usage: EMPTY_USAGE, models: [] };
      other = {
        agent: OTHER_AGENT,
        usage: addUsage(other.usage, agent.usage),
        models: [...other.models, ...agent.models],
      };
    }
  }
  named.sort((a, b) => order.indexOf(a.agent) - order.indexOf(b.agent));
  return other ? [...named, other] : named;
}
