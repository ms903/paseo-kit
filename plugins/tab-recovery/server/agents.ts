import { execFile } from "node:child_process";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { ClosedAgent } from "../shared/agents";

type Paseo = PluginHandlerContext["paseo"];

const PARENT_AGENT_LABEL = "paseo.parent-agent-id";
const PAGE_SIZE = 200;
const MAX_AGENTS = 50;
const RESTORE_TIMEOUT_MS = 90_000;

const listCaches = new WeakMap<Paseo, { at: number; pending: Promise<Map<string, ClosedAgent[]>> }>();
const restoring = new Map<string, Promise<void>>();

async function scanClosedAgents(paseo: Paseo): Promise<Map<string, ClosedAgent[]>> {
  const grouped = new Map<string, ClosedAgent[]>();
  let cursor: string | undefined;
  do {
    const result = await paseo.agents.list({
      filter: { includeArchived: true },
      page: { limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) },
    });
    for (const { agent } of result.entries) {
      // Closing a subagent's tab only hides it, so only top-level agents end up archived by a close.
      if (!agent.workspaceId || !agent.archivedAt || agent.labels?.[PARENT_AGENT_LABEL]) continue;
      const agents = grouped.get(agent.workspaceId) ?? [];
      agents.push({
        id: agent.id,
        title: agent.title,
        provider: agent.provider,
        model: agent.model,
        createdAt: agent.createdAt,
        archivedAt: agent.archivedAt,
      });
      agents.sort((a, b) => Date.parse(b.archivedAt) - Date.parse(a.archivedAt));
      if (agents.length > MAX_AGENTS) agents.length = MAX_AGENTS;
      grouped.set(agent.workspaceId, agents);
    }
    cursor = result.pageInfo.hasMore ? (result.pageInfo.nextCursor ?? undefined) : undefined;
  } while (cursor);
  return grouped;
}

export async function listClosedAgents(paseo: Paseo, workspaceId: string): Promise<ClosedAgent[]> {
  let entry = listCaches.get(paseo);
  if (!entry || Date.now() - entry.at > 30_000) {
    const next = { at: Date.now(), pending: scanClosedAgents(paseo) };
    entry = next;
    listCaches.set(paseo, next);
    next.pending.then(() => { next.at = Date.now(); }, () => { if (listCaches.get(paseo) === next) listCaches.delete(paseo); });
  }
  return (await entry.pending).get(workspaceId) ?? [];
}

export function restoreClosedAgent(paseo: Paseo, workspaceId: string, agentId: string): Promise<void> {
  const existing = restoring.get(agentId);
  if (existing) return existing;
  const pending = (async () => {
    const result = await paseo.agents.ref(agentId).refresh();
    const agent = result?.agent;
    if (!agent || agent.workspaceId !== workspaceId || !agent.archivedAt || agent.labels?.[PARENT_AGENT_LABEL]) throw new Error("This agent is no longer closed in this workspace.");
    await restoreAgent(agentId);
    listCaches.delete(paseo);
  })().finally(() => restoring.delete(agentId));
  restoring.set(agentId, pending);
  return pending;
}

/**
 * The SDK has no unarchive call, so this runs `paseo agent reload`. It sends the same request as
 * the Unarchive button in an archived agent's tab: unarchive, then resume the provider session.
 * The CLI finds this daemon through PASEO_HOME, which the plugin process inherits.
 */
export function restoreAgent(agentId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "paseo",
      ["agent", "reload", agentId, "--json"],
      { timeout: RESTORE_TIMEOUT_MS, env: process.env },
      (error, _stdout, stderr) => {
        if (!error) return resolve();
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return reject(new Error("The paseo CLI is not on the daemon's PATH, so the agent cannot be restored."));
        }
        const detail = stderr.trim().split("\n").filter(Boolean).at(-1);
        reject(new Error(detail ? `Could not restore the agent: ${detail}` : error.message));
      },
    );
  });
}
