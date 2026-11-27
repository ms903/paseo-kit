import { settingsRpc } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { turnCalibration } from "../../shared/turn-calibration";
import { DEFAULT_CHARS_PER_TOKEN } from "./meter";

export function createCalibration(client: PluginClientContext) {
  const rpc = settingsRpc(turnCalibration.id);
  const learned = new Map<string, number>();
  let pending = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writing = false;
  let loaded = false;
  let disposed = false;
  const flush = async () => {
    timer = undefined;
    if (writing || !pending.size || disposed) return;
    writing = true;
    const batch = pending;
    pending = new Map();
    try {
      for (let attempt = 0; attempt < 2 && !disposed; attempt++) {
        const read = await client.rpc(rpc.read, {});
        if (read.status !== "ready" || disposed) return;
        const parsed = turnCalibration.schema.safeParse(read.values);
        if (!parsed.success) return;
        // Keep the most recently calibrated models in a bounded host preference.
        const merged = new Map(Object.entries(parsed.data.calibration));
        for (const [key, value] of batch) { merged.delete(key); merged.set(key, value); }
        const calibration = Object.fromEntries([...merged].slice(-256));
        const write = await client.rpc(rpc.write, { revision: read.revision, values: { calibration } });
        if (write.status !== "conflict") break;
      }
    } catch { /* A disconnected host can continue using its in-memory calibration. */ }
    finally {
      writing = false;
      if (pending.size && !disposed && !timer) timer = setTimeout(() => void flush(), 2000);
    }
  };
  return {
    load() {
      if (loaded || disposed) return;
      loaded = true;
      void client.rpc(rpc.read, {}).then(read => {
        if (read.status !== "ready" || disposed) return;
        const parsed = turnCalibration.schema.safeParse(read.values);
        if (!parsed.success) return;
        for (const [key, value] of Object.entries(parsed.data.calibration).slice(-256)) {
          if (!learned.has(key)) learned.set(key, value);
        }
      }).catch(() => { loaded = false; });
    },
    get: (model: string) => learned.get(model),
    effective: (model: string | null) => (model ? learned.get(model) : undefined) ?? DEFAULT_CHARS_PER_TOKEN,
    set(model: string, value: number) {
      if (disposed) return;
      learned.set(model, value);
      pending.set(model, value);
      if (!timer && !writing) timer = setTimeout(() => void flush(), 2000);
    },
    dispose() { disposed = true; clearTimeout(timer); pending.clear(); learned.clear(); },
  };
}
