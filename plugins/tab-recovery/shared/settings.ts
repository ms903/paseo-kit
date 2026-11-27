import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const limits = ["10", "25", "50"] as const;
export const historySettings = defineSettings({
  id: "history", scope: "host", version: 1,
  schema: z.object({ limit: z.enum(limits).default("50") }),
});
