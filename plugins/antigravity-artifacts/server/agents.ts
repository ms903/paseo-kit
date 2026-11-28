import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { isAntigravity, uuid } from "../shared/artifacts";

type Paseo = PluginHandlerContext["paseo"];
type Agent = NonNullable<ReturnType<ReturnType<Paseo["agents"]["ref"]>["current"]>>;
const PARENT = "paseo.parent-agent-id";
const CHILD_LIMIT = 24;
const providerPersistence = z.object({ version: z.literal(1), data: z.object({
  sessionId: z.unknown().optional(), conversationId: z.unknown().optional(),
}) });

export function conversationOf(agent: Agent): string | undefined {
  const persistence = agent.persistence;
  if (!persistence || !isAntigravity(agent.provider) || !isAntigravity(persistence.provider)) return;

  function fromRecord(value: unknown) {
    const record = providerPersistence.safeParse(value);
    if (!record.success) return;
    for (const value of [record.data.data.sessionId, record.data.data.conversationId]) {
      const id = uuid.safeParse(value);
      if (id.success) return id.data;
    }
  }

  const structured = fromRecord(persistence.metadata?.pluginProviderPersistence);
  if (structured) return structured;
  for (const handle of [persistence.nativeHandle, persistence.sessionId]) {
    if (typeof handle !== "string") continue;
    if (uuid.safeParse(handle).success) return handle;
    if (handle.startsWith("plugin:") && handle.length < 8192) {
      try {
        const id = fromRecord(JSON.parse(handle.slice("plugin:".length)));
        if (id) return id;
      } catch {
        // Fall back to the other handle for agents saved by older providers.
      }
    }
  }
}

export async function scopedAgent(paseo: Paseo, agentId: string, workspaceId: string) {
  const result = await paseo.agents.ref(agentId).refresh();
  const agent = result?.agent;
  if (agent?.id === agentId && agent.workspaceId === workspaceId && !agent.internal && isAntigravity(agent.provider)) return agent;
}

export function isChild(agent: Agent, parent: Agent): boolean {
  return agent.id !== parent.id && agent.workspaceId === parent.workspaceId && !agent.internal &&
    agent.labels[PARENT] === parent.id && isAntigravity(agent.provider);
}

export async function childAgents(paseo: Paseo, parent: Agent) {
  const { entries, pageInfo } = await paseo.agents.list({
    filter: { labels: { [PARENT]: parent.id }, includeArchived: true, includeBackground: true },
    page: { limit: CHILD_LIMIT },
  });
  return { children: entries.map(({ agent }) => agent).filter((agent) => isChild(agent, parent)), limited: pageInfo.hasMore };
}
