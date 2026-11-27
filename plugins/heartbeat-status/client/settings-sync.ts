import { settingsRpc } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { heartbeatSettings, type HeartbeatSettings } from "../shared/settings";

/** Keep tab and workspace indicators current even when no plugin settings screen is mounted. */
export function watchAppearance(
  client: Pick<PluginClientContext, "rpc" | "paseo">,
  apply: (settings: HeartbeatSettings) => void,
) {
  let revision = 0;
  const read = settingsRpc(heartbeatSettings.id).read;
  function refresh() {
    const request = ++revision;
    void client.rpc(read, {}).then((record) => {
      if (request !== revision || record.status !== "ready") return;
      const saved = heartbeatSettings.schema.safeParse(record.values);
      if (saved.success) apply(saved.data);
    }).catch(() => { /* Reconnect replays the subscription snapshot and reads again. */ });
  }
  const observation = client.paseo.observeEvents(["status.plugin_settings_changed"]);
  const unsubscribe = observation.subscribe({
    snapshot: refresh,
    update(message) {
      if (message.type !== "status") return;
      const change = message.payload;
      if (change.status === "plugin_settings_changed" && change.pluginId === "heartbeat-status" &&
          change.settingsId === heartbeatSettings.id) refresh();
    },
  });
  return () => {
    revision++;
    unsubscribe();
    void observation.release().catch(() => {});
  };
}
