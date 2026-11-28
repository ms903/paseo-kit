import { addUsage, EMPTY_USAGE, type Usage, type UsagePeriod, type UsageReport } from "../shared/usage";

/** Source IDs before charts fold small agents into the display-only “Other” series. */
export function reportAgentOptions(report: UsageReport, knownSessionAgents: readonly string[] = []): string[] {
  const ids = new Set(report.agents);
  const periods = [...report.daily, ...report.weekly, ...report.monthly];
  if (report.total) periods.push(report.total);
  for (const period of periods) {
    for (const { agent } of period.agents) ids.add(agent);
  }
  for (const { agent } of report.recentSessions) ids.add(agent);
  for (const agent of report.sessionAgents ?? []) ids.add(agent);
  for (const agent of knownSessionAgents) ids.add(agent);
  return [...ids];
}

function filterPeriod(period: UsagePeriod, agent: string): UsagePeriod {
  const matches = period.agents.filter(row => row.agent === agent);
  if (matches.length < 2) {
    return { period: period.period, usage: matches[0]?.usage ?? EMPTY_USAGE, agents: matches };
  }

  // Some scanner versions can emit several rows for the same source.
  const modelTotals = new Map<string, Usage>();
  let usage = EMPTY_USAGE;
  for (const row of matches) {
    usage = addUsage(usage, row.usage);
    for (const { model, usage: modelUsage } of row.models) {
      modelTotals.set(model, addUsage(modelTotals.get(model) ?? EMPTY_USAGE, modelUsage));
    }
  }
  const models = [...modelTotals].map(([model, usage]) => ({ model, usage }))
    .sort((a, b) => b.usage.totalTokens - a.usage.totalTokens);
  return { period: period.period, usage, agents: [{ agent, usage, models }] };
}

/** Keep the daemon's calendar (including empty dates), period-specific totals and load state. */
export function filterUsageReport(report: UsageReport, agent: string | null | undefined): UsageReport {
  if (agent == null) return report;
  const project = (period: UsagePeriod) => filterPeriod(period, agent);
  return {
    ...report,
    agents: [agent],
    activity: report.activity?.map(({ day, sources }) => ({ day, sources: sources.filter(row => row.agent === agent) })),
    sessionAgents: report.sessionAgents?.filter(id => id === agent),
    daily: report.daily.map(project),
    weekly: report.weekly.map(project),
    monthly: report.monthly.map(project),
    total: report.total && project(report.total),
    recentSessions: report.recentSessions.filter(row => row.agent === agent),
  };
}
