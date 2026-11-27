import { execFile } from "node:child_process";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { ClosedAgent } from "../shared/agents";

type Paseo = PluginHandlerContext["paseo"];

const PARENT_AGENT_LABEL = "paseo.parent-agent-id";
const PAGE_SIZE = 200;
const MAX_AGENTS = 50;
const RESTORE_TIMEOUT_MS = 90_000;

const listCaches = new WeakMap<Paseo, { expires: number; pending: Promise<Map<string, ClosedAgent[]>> }>();
const restoresByHost = new WeakMap<Paseo, Map<string, Promise<void>>>();

// Paseo hides background sessions and only archives a tab on close if it has no parent.
function isRecoverable(agent: {
  workspaceId?: string | null;
  archivedAt?: string | null;
  labels?: Record<string, unknown> | null;
  background?: boolean;
}): agent is typeof agent & { workspaceId: string; archivedAt: string } {
  const parent = agent.labels?.[PARENT_AGENT_LABEL];
  return !!agent.workspaceId && !!agent.archivedAt && !agent.background &&
    !(typeof parent === "string" && parent.trim());
}

async function scanClosedAgents(paseo: Paseo): Promise<Map<string, ClosedAgent[]>> {
  const grouped = new Map<string, ClosedAgent[]>();
  let cursor: string | undefined;
  do {
    const result = await paseo.agents.list({
      filter: { includeArchived: true },
      page: { limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) },
    });
    for (const { agent } of result.entries) {
      if (!isRecoverable(agent)) continue;
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
  if (!entry || Date.now() >= entry.expires) {
    const next = { expires: Infinity, pending: scanClosedAgents(paseo) };
    entry = next;
    listCaches.set(paseo, next);
    next.pending.then(() => { next.expires = Date.now() + 30_000; }, () => { if (listCaches.get(paseo) === next) listCaches.delete(paseo); });
  }
  return (await entry.pending).get(workspaceId) ?? [];
}

export function restoreClosedAgent(paseo: Paseo, workspaceId: string, agentId: string): Promise<void> {
  const restoring = restoresByHost.get(paseo) ?? new Map<string, Promise<void>>();
  restoresByHost.set(paseo, restoring);
  const key = JSON.stringify([workspaceId, agentId]);
  const existing = restoring.get(key);
  if (existing) return existing;
  const pending = (async () => {
    try {
      const handle = paseo.agents.ref(agentId);
      const result = await handle.refresh();
      const agent = result?.agent;
      if (!agent || agent.workspaceId !== workspaceId || !isRecoverable(agent)) {
        throw new Error("This agent is no longer closed in this workspace.");
      }
      if (typeof handle.reload === "function") {
        const reloaded = await handle.reload();
        if (!reloaded?.agent || reloaded.agent.archivedAt) {
          throw new Error("The daemon could not confirm that this agent was reopened.");
        }
      } else {
        await restoreWithCli(agentId);
      }
    } finally {
      // A different client may have reopened it, or a failed reload may have cleared archivedAt.
      listCaches.delete(paseo);
    }
  })().finally(() => restoring.delete(key));
  restoring.set(key, pending);
  return pending;
}

/**
 * Older hosts expose refresh (a read) but not reload. Their CLI can send the same restore request.
 */
function restoreWithCli(agentId: string): Promise<void> {
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
