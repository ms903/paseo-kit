import type { PluginClientContext } from "@getpaseo/plugin/client";
import { MonitorSettingsScreen, settingsTitle } from "./client/settings-screen";
import { HOST_MONITOR_SCREEN_ID, HostMonitorScreen, HostStatusItem } from "./client/sidebar";

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({ id: "settings", title: settingsTitle, icon: "Activity", Component: MonitorSettingsScreen });
  client.addScreen({ id: HOST_MONITOR_SCREEN_ID, title: "Host monitor", Component: HostMonitorScreen });
  client.addSidebarFooterItem({ id: "host-status", title: "Host status", Component: HostStatusItem });
  return () => {};
}
