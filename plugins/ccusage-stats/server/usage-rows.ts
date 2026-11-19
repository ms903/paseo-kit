import type { RawAgentRow, RawModel, RawRow } from "./ccusage";

export function emptyRow(period: string, agent: string): RawRow {
  return {
    period,
    agent,
    totalTokens: 0,
    totalCost: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    modelBreakdowns: [],
  };
}

const tokenFields = ["inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens"] as const;

function addModel(models: RawModel[], model: RawModel): void {
  const existing = models.find(
    (entry) => entry.modelName === model.modelName,
  );
  if (!existing) {
    models.push({ ...model });
    return;
  }
  for (const key of tokenFields) existing[key] += model[key];
  existing.cost += model.cost;
  if (model.missingPricing) existing.missingPricing = true;
}

export function addModelUsage(row: RawAgentRow, model: RawModel): void {
  for (const key of tokenFields) {
    row[key] += model[key];
    row.totalTokens += model[key];
  }
  row.totalCost += model.cost;
  addModel(row.modelBreakdowns, model);
}

export function addTotals(to: RawAgentRow, from: RawAgentRow): void {
  for (const key of tokenFields) to[key] += from[key];
  to.totalTokens += from.totalTokens;
  to.totalCost += from.totalCost;
}

export function weekOf(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

/** Group daily rows after pricing, so every week and month uses the same days as the chart. */
export function rollupDays(daily: RawRow[], kind: "weekly" | "monthly"): RawRow[] {
  const groups = new Map<string, RawRow & { agents: RawAgentRow[] }>();
  for (const day of daily) {
    const period = kind === "weekly" ? weekOf(day.period) : day.period.slice(0, 7);
    let group = groups.get(period);
    if (!group) {
      group = { ...emptyRow(period, "all"), agents: [] };
      groups.set(period, group);
    }
    for (const agent of day.agents ?? [day]) {
      let combined = group.agents.find((entry) => entry.agent === agent.agent);
      if (!combined) {
        combined = emptyRow(period, agent.agent);
        group.agents.push(combined);
      }
      addTotals(combined, agent);
      for (const model of agent.modelBreakdowns) addModel(combined.modelBreakdowns, model);
      addTotals(group, agent);
    }
  }
  return [...groups.values()];
}
