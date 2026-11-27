import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** Per-model characters per output token, learned from observed provider usage. */
export const turnCalibration = defineSettings({
  id: "turn-calibration",
  scope: "host",
  version: 1,
  schema: z.object({ calibration: z.record(z.string(), z.number().min(1).max(12)).default({}) }),
});
