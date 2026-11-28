import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ArtifactsPanel } from "./client/panel";
import { messages } from "./client/messages";
import { isAntigravity } from "./shared/artifacts";

export default function contribute(client: PluginClientContext) {
  const removePanel = client.addAgentPanel({ id: "artifacts", title: messages.message("title"), icon: "FileStack", Component: ArtifactsPanel });
  const removeCommand = client.addCommandCenterItem({
    id: "open-artifacts",
    title: messages.message("open"),
    icon: "FileStack",
    keywords: ["artifacts", "brain", "产物"],
    context: "agent",
    onSelect({ agent, openPanel }) {
      if (!isAntigravity(agent.provider)) throw new Error(client.i18n.t(messages, "unavailable"));
      openPanel("artifacts");
    },
  });
  return () => { removeCommand(); removePanel(); };
}
