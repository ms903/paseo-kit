import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const speedSample = z.object({
  turnId: z.string().min(1).max(300),
  measuredAt: z.iso.datetime({ offset: true }),
  tokensPerSecond: z.number().positive().max(5_000),
  basis: z.enum(["response", "whole-turn", "decode", "model-time"]),
  approximate: z.boolean(),
  outputTokens: z.number().int().positive().optional(),
  durationMs: z.number().positive().optional(),
  ttftMs: z.number().nonnegative().optional(),
});

export const sessionSpeedSample = speedSample.extend({
  source: z.enum(["provider", "observed"]),
});

export const recordSessionSpeedRpc = defineRpc({
  name: "usage.session.speed.record",
  input: z.object({
    agentId: z.string().min(1).max(200),
    samples: z.array(speedSample.extend({ basis: z.enum(["decode", "whole-turn"]) }).strict()).min(1).max(2),
  }).strict(),
  output: z.object({ recorded: z.boolean() }),
});

export const sessionSpeedRpc = defineRpc({
  name: "usage.session.speed",
  input: z.union([
    z.object({ agentId: z.string().min(1).max(200) }).strict(),
    z.object({ sessionId: z.string().min(1).max(1024), provider: z.string().min(1).max(120) }).strict(),
  ]),
  output: z.object({
    status: z.enum(["ready", "unavailable"]),
    active: z.boolean(),
    turns: z.array(sessionSpeedSample),
    hasOlder: z.boolean(),
  }),
});

export type SessionSpeedSample = z.infer<typeof sessionSpeedSample>;
export type SessionSpeed = z.output<typeof sessionSpeedRpc.output>;
