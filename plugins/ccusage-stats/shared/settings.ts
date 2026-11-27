import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const SPEED_WINDOWS = [3, 5, 10, 30] as const;

export const CCUSAGE_SETTINGS = defineSettings({
  id: "display",
  scope: "host",
  version: 1,
  schema: z.object({
    showSessionSpeed: z.boolean().default(true),
    speedPillBasis: z.enum(["live", "decode", "whole-turn"]).default("live"),
    speedWindowSeconds: z.literal(SPEED_WINDOWS).default(5),
  }),
});
