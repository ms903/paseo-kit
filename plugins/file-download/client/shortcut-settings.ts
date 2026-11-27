import { settingsRpc } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { downloadSettings } from "../shared/settings";

/** The first read and reconnects must respect a previously disabled shortcut. */
export function watchSaveShortcut(client: Pick<PluginClientContext, "paseo" | "rpc">, listen: () => () => void) {
  let unlisten: (() => void) | undefined;
  let nextRead = 0;
  const contract = settingsRpc(downloadSettings.id).read;
  function refresh() {
    const token = ++nextRead;
    void client.rpc(contract, {}).then((record) => {
      if (token !== nextRead || record.status !== "ready") return;
      const parsed = downloadSettings.schema.safeParse(record.values);
      if (!parsed.success) return;
      if (parsed.data.saveShortcut) unlisten ??= listen();
      else {
        unlisten?.();
        unlisten = undefined;
      }
    }).catch(() => { /* Preserve the last confirmed preference while disconnected. */ });
  }
  refresh();
  const events = client.paseo?.observeEvents?.(["status.plugin_settings_changed"]);
  // A partial legacy client may only expose RPC. Use the same revision-checked reads there.
  if (!events) {
    const polling = setInterval(refresh, 5_000);
    return () => {
      nextRead++;
      clearInterval(polling);
      unlisten?.();
    };
  }
  const unsubscribe = events.subscribe({
    snapshot: refresh,
    update(message) {
      if (message.type === "status" && message.payload.status === "plugin_settings_changed" &&
        message.payload.settingsId === downloadSettings.id) refresh();
    },
  });
  return () => {
    nextRead++;
    unsubscribe();
    void events.release().catch(() => {});
    unlisten?.();
  };
}
