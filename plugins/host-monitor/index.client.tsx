import type { PluginClientContext } from "@getpaseo/plugin/client";
import { HOST_MONITOR_SCREEN_ID, HostMonitorScreen, HostStatusItem } from "./client/sidebar";

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: HOST_MONITOR_SCREEN_ID, title: "Host monitor", Component: HostMonitorScreen });
  client.addSidebarFooterItem({ id: "host-status", title: "Host status", Component: HostStatusItem });
  return () => {};
}
