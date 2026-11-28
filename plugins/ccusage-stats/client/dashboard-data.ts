import { addUsage, cacheHitRate, EMPTY_USAGE, type Usage, type UsagePeriod, type UsageReport } from "../shared/usage";
import { formatCost, formatPercent, formatTokens } from "./format";

export type UsageMetric = "tokens" | "cost" | "output" | "cache";

export const METRIC_LABELS: Record<UsageMetric, string> = {
  tokens: "Total tokens",
  cost: "Estimated cost",
  output: "Output tokens",
  cache: "Cache hit rate",
};

export function metricValue(usage: Usage, metric: UsageMetric): number | null {
  if (metric === "cache") return cacheHitRate(usage);
  if (metric === "cost") return usage.cost;
  return metric === "output" ? usage.outputTokens : usage.totalTokens;
}

export function formatMetric(value: number | null, metric: UsageMetric): string {
  if (value === null) return "—";
  if (metric === "cache") return formatPercent(value);
  if (metric === "cost") return formatCost(value);
  return formatTokens(value);
}

export function modelUsage(period: UsagePeriod) {
  const models = new Map<string, Usage>();
  for (const agent of period.agents) {
    for (const { model, usage } of agent.models) {
      models.set(model, addUsage(models.get(model) ?? EMPTY_USAGE, usage));
    }
  }
  return [...models].map(([model, usage]) => ({ model, usage }));
}

const DAY_MS = 86_400_000;

interface ActivityDay {
  day: string;
  tokens: number | null;
}

/** Dates are already in the daemon's calendar. Align the visible ledger to Mondays in UTC. */
export function activityWeeks(report: Pick<UsageReport, "activity" | "daily">): ActivityDay[][] {
  const days = report.activity?.map(({ day, sources }) => ({ day, tokens: sources.reduce((sum, source) => sum + source.tokens, 0) }))
    ?? report.daily.map(({ period, usage }) => ({ day: period, tokens: usage.totalTokens }));
  if (!days.length) return [];

  const byDay = new Map(days.map(({ day, tokens }) => [day, tokens]));
  const first = new Date(days[0].day);
  const monday = first.valueOf() - ((first.getUTCDay() + 6) % 7) * DAY_MS;
  const last = Date.parse(days[days.length - 1].day);
  const weeks = Math.floor((last - monday) / (7 * DAY_MS)) + 1;
  return Array.from({ length: weeks }, (_, week) => Array.from({ length: 7 }, (_, offset) => {
    const day = new Date(monday + (week * 7 + offset) * DAY_MS).toISOString().slice(0, 10);
    return { day, tokens: byDay.get(day) ?? null };
  }));
}
