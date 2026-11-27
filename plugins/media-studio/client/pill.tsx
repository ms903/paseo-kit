import { settingsRpc } from "@getpaseo/plugin";
import type { PluginButtonRegistration, PluginClientContext, PluginText } from "@getpaseo/plugin/client";
import { PROJECT_SUMMARY_BATCH_SIZE, projectSummaryRpc, type ProjectSummary } from "../shared/rpc";
import { DEFAULT_SETTINGS, settingsDefinition } from "../shared/settings";
import { messages } from "./i18n";
import { openInMediaPanel } from "./state";

const PILL_ID = "media";
const REFRESH_MS = 90_000;
// Files the agent wrote are on disk once its turn ends; a short wait lets renders finish closing.
const AFTER_TURN_DELAY_MS = 3_000;

interface AgentLike {
  id: string;
  workspaceId?: string | null;
  cwd?: string | null;
  status?: string;
  archivedAt?: string | null;
}

function pillState(summary: ProjectSummary | undefined) {
  if (!summary?.isMedia) return { visible: false };
  const { video, audio, image } = summary;
  return {
    visible: true,
    label: messages.message("pill.label", { count: video + audio + image }),
    title: messages.message("pill.title", { video, audio, image }),
  };
}

/**
 * A composer pill per agent whose folder looks like a media project, with the media count; it
 * opens the media panel. Pills start hidden, so agents in code folders never show one.
 */
export function contributeMediaPills(client: PluginClientContext): () => void {
  const agents = new Map<string, { workspaceId: string; cwd: string; status?: string; pill: PluginButtonRegistration<PluginText> }>();
  const lifetime = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let freshDirs = new Set<string>();

  const enabled = async () => {
    const stored = await client.rpc(settingsRpc(settingsDefinition.id).read, {}).catch(() => null);
    const parsed = stored?.status === "ready" ? settingsDefinition.schema.safeParse(stored.values) : null;
    return parsed?.success ? parsed.data.composerPill : DEFAULT_SETTINGS.composerPill;
  };

  const refresh = async () => {
    const revision = ++generation;
    const current = () => revision === generation && !lifetime.signal.aborted;
    if (!agents.size || !current()) return;
    try {
      const show = await enabled();
      if (!current()) return;
      const fresh = freshDirs;
      freshDirs = new Set();
      const byDir = new Map<string, ProjectSummary>();
      if (show) {
        const dirs = [...new Set([...agents.values()].map((agent) => agent.cwd))];
        // A finished turn needs fresh data. Every active directory fits in one of the batches.
        for (const rescan of [true, false]) {
          const group = dirs.filter((dir) => fresh.has(dir) === rescan);
          for (let i = 0; i < group.length; i += PROJECT_SUMMARY_BATCH_SIZE) {
            const batch = group.slice(i, i + PROJECT_SUMMARY_BATCH_SIZE);
            const { projects } = await client.rpc(projectSummaryRpc, { dirs: batch, fresh: rescan });
            if (!current()) return;
            for (const summary of projects) byDir.set(summary.dir, summary);
          }
        }
      }
      for (const agent of agents.values()) agent.pill.update(pillState(byDir.get(agent.cwd)));
    } catch (error) {
      if (!lifetime.signal.aborted) console.warn("[media-studio] Media pill refresh failed", error);
    }
  };

  const schedule = (delay: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void refresh();
    }, delay);
  };

  const unregister = (agentId: string) => {
    agents.get(agentId)?.pill.remove();
    agents.delete(agentId);
  };

  /** True when the pills need a refresh: a new agent, a new folder, or a finished turn. */
  const register = (agent: AgentLike): boolean => {
    if (lifetime.signal.aborted || !agent.workspaceId || !agent.cwd || agent.archivedAt) {
      unregister(agent.id);
      return false;
    }
    const known = agents.get(agent.id);
    if (known && known.cwd === agent.cwd && known.workspaceId === agent.workspaceId) {
      const finished = known.status === "running" && agent.status !== "running";
      known.status = agent.status;
      if (finished) freshDirs.add(agent.cwd);
      return finished;
    }
    if (known) unregister(agent.id);
    const { workspaceId } = agent;
    const pill = client.addComposerPill({
      id: PILL_ID,
      workspaceId,
      agentId: agent.id,
      button: {
        title: messages.message("commands.open"),
        icon: "Clapperboard",
        visible: false,
        behavior: { kind: "action", onPress: () => openInMediaPanel(workspaceId, null) },
      },
    });
    agents.set(agent.id, { workspaceId, cwd: agent.cwd, status: agent.status, pill });
    return true;
  };

  const removeAll = () => {
    for (const agent of agents.values()) agent.pill.remove();
    agents.clear();
  };

  // The list subscription delivers the agents, then updates, and a fresh snapshot after a reconnect.
  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          removeAll();
          for (const { agent } of entries) register(agent);
          void refresh();
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind !== "upsert") {
            unregister(update.agentId);
            return;
          }
          if (register(update.agent)) schedule(AFTER_TURN_DELAY_MS);
        },
      });
      return undefined;
    })
    .catch((error) => {
      if (!lifetime.signal.aborted) console.error("[media-studio] Agent observation failed", error);
    });

  const interval = setInterval(() => void refresh(), REFRESH_MS);
  return () => {
    lifetime.abort();
    clearInterval(interval);
    if (timer) clearTimeout(timer);
    removeAll();
  };
}
