import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createHeartbeatSummaryReader } from "./server/summary";
import { heartbeatSummaryRpc } from "./shared/heartbeat";

export default function contribute(server: PluginServerContext) {
  const readSummary = createHeartbeatSummaryReader();
  server.handle(heartbeatSummaryRpc, async ({ agentIds }, { paseo }) => ({
    agents: await readSummary(paseo, agentIds),
  }));
  return () => {};
}
