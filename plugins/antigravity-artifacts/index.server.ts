import os from "node:os";
import path from "node:path";
import type { RpcOutput } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { childAgents, conversationOf, isChild, scopedAgent } from "./server/agents";
import { previewArtifact, scanBudget, scanConversation } from "./server/brain";
import { listArtifacts, MAX_ARTIFACTS, readArtifact, type Artifact } from "./shared/artifacts";

export function registerArtifacts(server: PluginServerContext, brain: string) {
  server.handle(listArtifacts, async ({ agentId, workspaceId }, { paseo }): Promise<RpcOutput<typeof listArtifacts>> => {
    if (process.platform !== "linux") return { status: "unsupported" };
    const parent = await scopedAgent(paseo, agentId, workspaceId);
    if (!parent) return { status: "unavailable" };
    const conversationId = conversationOf(parent);
    if (!conversationId) return { status: "waiting" };

    const { children, limited } = await childAgents(paseo, parent);
    const budget = scanBudget();
    const items: Artifact[] = [];
    const visited = new Set<string>();
    for (const agent of [parent, ...children]) {
      if (!budget.entries || !budget.directories) {
        budget.limited = true;
        break;
      }
      const id = conversationOf(agent);
      if (!id || visited.has(id)) continue;
      visited.add(id);
      items.push(...await scanConversation(brain, {
        conversationId: id, ownerAgentId: agent.id, ownerTitle: agent.id === agentId ? null : agent.title,
      }, budget));
    }
    const latest = await scopedAgent(paseo, agentId, workspaceId);
    if (!latest || conversationOf(latest) !== conversationId) return { status: "unavailable" };
    items.sort((a, b) => b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path));
    return { status: "ready", conversationId, items: items.slice(0, MAX_ARTIFACTS), limited: limited || budget.limited || items.length > MAX_ARTIFACTS };
  });

  server.handle(readArtifact, async ({ agentId, workspaceId, rootConversationId, artifact }, { paseo }) => {
    if (process.platform !== "linux") throw new Error("This preview requires a Linux daemon.");

    async function verifyOwner() {
      const parent = await scopedAgent(paseo, agentId, workspaceId);
      if (!parent || conversationOf(parent) !== rootConversationId) return false;
      const owner = artifact.ownerAgentId === agentId ? parent : await scopedAgent(paseo, artifact.ownerAgentId, workspaceId);
      return !!owner && (owner === parent || isChild(owner, parent)) && conversationOf(owner) === artifact.conversationId;
    }

    if (!await verifyOwner()) throw new Error("Artifact is outside the current conversation.");
    const preview = await previewArtifact(brain, artifact.conversationId, artifact.path).catch(() => {
      throw new Error("Artifact is unavailable on the daemon.");
    });
    if (!await verifyOwner()) throw new Error("Artifact is outside the current conversation.");
    return preview;
  });
}

export default function contribute(server: PluginServerContext) {
  const gemini = process.env.GEMINI_DIR || path.join(os.homedir(), ".gemini");
  registerArtifacts(server, path.resolve(gemini, "antigravity-cli", "brain"));
  return () => {};
}
