import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const usageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheCreationTokens: z.number(),
  cacheReadTokens: z.number(),
  totalTokens: z.number(),
  cost: z.number().nullable(),
});

const modelUsageSchema = z.object({ model: z.string(), usage: usageSchema });

const agentUsageSchema = z.object({
  /** ccusage's agent name: "claude", "codex", "gemini", ... */
  agent: z.string(),
  usage: usageSchema,
  models: z.array(modelUsageSchema),
});

const periodSchema = z.object({
  /** "2026-10-12" for days and weeks (the Monday), "2026-10" for months. */
  period: z.string(),
  usage: usageSchema,
  agents: z.array(agentUsageSchema),
});

export const sessionSchema = z.object({
  id: z.string(),
  agent: z.string(),
  usage: usageSchema,
  models: z.array(modelUsageSchema),
  lastActivity: z.string().nullable(),
  recorded: z.literal(true).optional(),
});

export const PARENT_AGENT_LABEL = "paseo.parent-agent-id";

const progressSchema = z.object({
  stage: z.enum(["recentUsage", "recentSessions", "dailyHistory", "sessionHistory", "totals"]),
  elapsedSeconds: z.number().nonnegative(),
  window: z.object({ since: z.iso.date().optional(), until: z.iso.date().optional() }).optional(),
  codexSessions: z.array(z.string().max(12)).max(2).optional(),
});
export type ScanProgress = z.infer<typeof progressSchema>;

export const usageReportSchema = z.object({
  /** When ccusage last produced this report, in epoch milliseconds. */
  generatedAt: z.number(),
  usageRefreshedAt: z.number().optional(),
  revision: z.string().optional(),
  /** The daemon's local date, the same calendar ccusage groups by. */
  today: z.string(),
  timezone: z.string(),
  /** Every agent seen in the report, heaviest first: a stable order for colors. */
  agents: z.array(z.string()),
  /** Contiguous series, oldest first; the last entry is the current period. */
  daily: z.array(periodSchema),
  weekly: z.array(periodSchema),
  monthly: z.array(periodSchema),
  total: periodSchema.optional(),
  recentSessions: z.array(sessionSchema),
  sessionRefreshError: z.string().nullable().optional(),
  /** Set when the latest refresh failed and an older report is served instead. */
  refreshError: z.string().nullable(),
  refreshing: z.boolean().optional(),
  historyPending: z.boolean().optional(),
  sessionsPending: z.boolean().optional(),
  progress: progressSchema.optional(),
});

const previewSchema = z.object({
  status: z.literal("today"),
  today: z.string(),
  totalTokens: z.number(),
  refreshError: z.string().nullable(),
  progress: progressSchema.optional(),
});
const reportResponseSchema = z.union([usageReportSchema, previewSchema, z.object({ status: z.literal("loading"), progress: progressSchema.optional() })]);
export type UsageReport = z.infer<typeof usageReportSchema>;
export type TodayPreview = z.infer<typeof previewSchema>;
export type ReportResponse = z.infer<typeof reportResponseSchema>;

const unchangedSchema = z.object({
  status: z.literal("unchanged"),
  revision: z.string(),
  generatedAt: z.number(),
  usageRefreshedAt: z.number().optional(),
  refreshing: z.boolean(),
  refreshError: z.string().nullable(),
  progress: progressSchema.optional(),
});
const usageReadSchema = z.union([unchangedSchema, reportResponseSchema]);
export type UsageRead = z.infer<typeof usageReadSchema>;

export const usageReportRpc = defineRpc({
  name: "usage.report",
  input: z.object({ refresh: z.boolean().optional(), retry: z.boolean().optional(), knownRevision: z.string().max(80).optional() }),
  output: usageReadSchema,
});

export const updatePricesRpc = defineRpc({
  name: "usage.prices.update",
  input: z.object({}),
  output: reportResponseSchema,
});

const sessionMatchSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("matched"),
    agentId: z.string(),
    providerSessionId: z.string(),
    session: sessionSchema,
  }),
  /** The provider session exists but ccusage has not recorded usage for it yet. */
  z.object({
    status: z.literal("pending"), agentId: z.string(), providerSessionId: z.string(),
    canRefresh: z.literal(true).optional(),
  }),
  /** Paseo has no provider session id for the agent (never started, or not persistable). */
  z.object({ status: z.literal("unknown"), agentId: z.string() }),
]);

export const sessionUsageRpc = defineRpc({
  name: "usage.sessions",
  input: z.object({ agentIds: z.array(z.string()).max(200) }),
  output: z.object({ generatedAt: z.number(), sessions: z.array(sessionMatchSchema) }),
});

export const sessionDetailRpc = defineRpc({
  name: "usage.session.detail",
  input: z.object({ agentId: z.string().min(1), refresh: z.boolean().optional() }),
  output: z.object({
    match: sessionMatchSchema,
    latestRequest: usageSchema.optional(),
    context: z.object({
      used: z.int().nonnegative().optional(),
      limit: z.int().positive().optional(),
    }).optional(),
    checkedAt: z.number(),
    usageCheckedAt: z.number().optional(),
  }),
});

export const SESSION_PAGE_SIZE = 12;

export const sessionListRpc = defineRpc({
  name: "usage.sessions.list",
  input: z.object({
    agent: z.string().max(120).optional(),
    search: z.string().max(120).optional(),
    since: z.iso.date().optional(),
    until: z.iso.date().optional(),
    offset: z.int().nonnegative().optional(),
  }),
  output: z.object({
    sessions: z.array(sessionSchema).max(SESSION_PAGE_SIZE),
    agents: z.array(z.string()),
    total: z.int().nonnegative(),
    offset: z.int().nonnegative(),
    complete: z.boolean(),
  }),
});

export type Usage = z.infer<typeof usageSchema>;
export type ModelUsage = z.infer<typeof modelUsageSchema>;
export type AgentUsage = z.infer<typeof agentUsageSchema>;
export type UsagePeriod = z.infer<typeof periodSchema>;
export type SessionUsage = z.infer<typeof sessionSchema>;
export type SessionMatch = z.infer<typeof sessionMatchSchema>;
export type PeriodKind = "daily" | "weekly" | "monthly";
export type UsageView = PeriodKind | "total";

export const EMPTY_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  totalTokens: 0,
  cost: 0,
};
