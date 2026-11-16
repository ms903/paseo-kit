import v8 from "node:v8";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listClosedAgents, restoreClosedAgent } from "./server/agents";
import { closedAgentsRpc, restoreAgentRpc } from "./shared/agents";

// The plugin process validates every daemon message with one generated function of about 11 MB
// (`safeParse_WSOutboundMessageSchema` in @getpaseo/protocol). Once it is hot, V8's Maglev compiler
// optimizes it on a worker thread, taking about 500 MB of native memory per compile, and again after
// each deopt; glibc keeps that memory, so the process peaked at 2.2 GB. Turbofan already skips a
// function this large, so without Maglev it stays in the interpreter. The flag must be set before
// the function gets hot, and this bundle is evaluated before the daemon client connects.
v8.setFlagsFromString("--no-maglev");

export default function contribute(server: PluginServerContext) {
  server.handle(closedAgentsRpc, async ({ workspaceId }, { paseo }) => ({
    agents: await listClosedAgents(paseo, workspaceId),
  }));
  server.handle(restoreAgentRpc, async ({ workspaceId, agentId }, { paseo }) => {
    await restoreClosedAgent(paseo, workspaceId, agentId);
    return {};
  });
  return () => {};
}
