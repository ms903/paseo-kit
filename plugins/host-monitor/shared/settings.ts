import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const footerMetrics = ["cpu", "memory", "gpu", "disk", "network"] as const;
export type MetricKey = (typeof footerMetrics)[number];
export const refreshSeconds = ["2", "5", "10", "30"] as const;

export const settingsDefinition = defineSettings({
  id: "host-monitor",
  scope: "host",
  version: 1,
  schema: z.object({
    cpu: z.boolean().default(true),
    memory: z.boolean().default(true),
    gpu: z.boolean().default(true),
    disk: z.boolean().default(true),
    network: z.boolean().default(true),
    refreshSeconds: z.enum(refreshSeconds).default("2"),
  }),
});

export type MonitorSettings = z.output<typeof settingsDefinition.schema>;
export const defaults = settingsDefinition.schema.parse({});
