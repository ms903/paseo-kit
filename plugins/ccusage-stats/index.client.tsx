import type { PluginClientContext } from "@getpaseo/plugin/client";
import { UsageScreen } from "./client/screen";
import { contributeSessionPills } from "./client/session";
import { UsageSidebarItem } from "./client/sidebar";
import { UsageSettings } from "./client/settings";
import { usageSettingsTitle } from "./client/speed-messages";

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "usage", title: "Token usage", Component: UsageScreen });
  client.addSettingsScreen({ id: "display", title: usageSettingsTitle, icon: "Gauge", Component: UsageSettings });
  client.addSidebarFooterItem({
    id: "usage-today",
    title: "Token usage",
    Component: UsageSidebarItem,
  });
  client.addCommandCenterItem({
    id: "open-usage",
    title: "Open token usage",
    icon: "Coins",
    keywords: ["ccusage", "tokens", "cost", "spend"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: "usage" });
    },
  });
  return contributeSessionPills(client);
}
