import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const heartbeatSummary = z.object({
  agentId: z.string(),
  workspaceId: z.string().nullable(),
  title: z.string().nullable(),
  status: z.enum(["initializing", "idle", "running", "error", "closed"]).nullable(),
  direct: z.number().int().nonnegative(),
  descendants: z.number().int().nonnegative(),
});

export type HeartbeatSummary = z.infer<typeof heartbeatSummary>;

export const heartbeatSummaryRpc = defineRpc({
  name: "heartbeat.summary",
  input: z.object({ agentIds: z.array(z.string().min(1).max(200)).max(200) }),
  output: z.object({ agents: z.array(heartbeatSummary) }),
});
