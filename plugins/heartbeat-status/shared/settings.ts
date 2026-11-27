import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const accents = ["teal", "blue", "violet", "amber"] as const;

// IBM Carbon Teal 60/30, Blue 60/40, Purple 60/30, Yellow 60/30.
// https://www.ibm.com/design/language/color/
export const accentColors = {
  teal: { light: "#007D79", dark: "#3DDBD9" },
  blue: { light: "#0F62FE", dark: "#78A9FF" },
  violet: { light: "#8A3FFC", dark: "#D4BBFF" },
  amber: { light: "#8E6A00", dark: "#F1C21B" },
} as const satisfies Record<typeof accents[number], { light: string; dark: string }>;

export const SETTINGS_ID = "appearance";
export const heartbeatSettings = defineSettings({
  id: SETTINGS_ID,
  scope: "host",
  version: 1,
  schema: z.object({
    accent: z.enum(accents).default("teal"),
    animate: z.boolean().default(true),
  }),
});

export type HeartbeatSettings = z.output<typeof heartbeatSettings.schema>;
export const defaults: HeartbeatSettings = heartbeatSettings.schema.parse({});
