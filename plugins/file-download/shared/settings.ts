import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const downloadSettings = defineSettings({
  id: "downloads", scope: "host", version: 1,
  schema: z.object({ saveShortcut: z.boolean().default(true) }),
});
