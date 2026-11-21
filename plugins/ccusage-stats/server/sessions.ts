import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import type { SessionMatch, SessionUsage, sessionUsageRpc } from "../shared/usage";
import type { ReportCache } from "./report";

type PaseoApi = PluginHandlerContext["paseo"];

// A provider session id rarely changes once an agent has one; a resume or refresh can replace it.
const SESSION_ID_TTL_MS = 5 * 60_000;
const MAX_SESSION_IDS = 1000;

interface CachedSessionId {
  /** null: the agent has no provider session yet. */
  sessionId: string | null;
  provider?: string;
  at: number;
}

const antigravityPersistence = z
  .object({
    version: z.literal(1),
    // ACP stores sessionId. Saved agents from the stream-json provider use conversationId.
    data: z.union([
      z.object({ sessionId: z.string().min(1) }),
      z.object({ conversationId: z.string().min(1) }),
    ]),
  })
  .transform(({ data }) => ("sessionId" in data ? data.sessionId : data.conversationId));
const PLUGIN_SESSION_PREFIX = "plugin:";

function antigravityConversationId(sessionId: string, metadata: unknown): string | null {
  const saved = antigravityPersistence.safeParse(metadata);
  if (saved.success) return saved.data;
  if (!sessionId.startsWith(PLUGIN_SESSION_PREFIX)) return sessionId || null;

  // Paseo also serializes the provider persistence in the session id.
  try {
    const parsed = antigravityPersistence.safeParse(
      JSON.parse(sessionId.slice(PLUGIN_SESSION_PREFIX.length)),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Paseo agents carry their provider's session handle: a Claude Code session UUID, which is
 * ccusage's session key, or a Codex thread id, which ends ccusage's rollout file name
 * (`rollout-<time>-<thread id>`, sometimes under a `YYYY/MM/DD/` path).
 */
export function sessionKeyMatches(ccusageId: string, providerSessionId: string): boolean {
  if (ccusageId === providerSessionId) return true;
  return ccusageId.endsWith(`-${providerSessionId}`) || ccusageId.endsWith(`/${providerSessionId}`);
}

export function createSessionMatcher(cache: Pick<ReportCache, "sessions">) {
  const sessionIds = new Map<string, CachedSessionId>();

  async function providerSession(paseo: PaseoApi, agentId: string): Promise<CachedSessionId> {
    const cached = sessionIds.get(agentId);
    if (cached && Date.now() - cached.at < (cached.sessionId ? SESSION_ID_TTL_MS : 10_000)) {
      return cached;
    }
    const result = await paseo.agents.ref(agentId).refresh();
    const persistence = result?.agent.persistence;
    const provider = persistence?.provider;
    let sessionId = persistence?.nativeHandle || persistence?.sessionId || null;
    if (persistence && provider === "antigravity" && !persistence.nativeHandle) {
      sessionId = antigravityConversationId(
        persistence.sessionId,
        persistence.metadata?.pluginProviderPersistence,
      );
    }
    for (const [id, entry] of sessionIds) {
      if (Date.now() - entry.at >= SESSION_ID_TTL_MS) sessionIds.delete(id);
    }
    if (sessionIds.size >= MAX_SESSION_IDS) sessionIds.delete(sessionIds.keys().next().value!);
    const entry = { sessionId, provider, at: Date.now() };
    sessionIds.set(agentId, entry);
    return entry;
  }

  function match(
    agentId: string,
    target: CachedSessionId | null,
    sessions: SessionUsage[],
  ): SessionMatch {
    const sessionId = target?.sessionId;
    if (!sessionId) return { status: "unknown", agentId };
    const session = sessions.find((candidate) =>
      target.provider === "antigravity"
        ? candidate.agent === "antigravity" && candidate.id === sessionId
        : sessionKeyMatches(candidate.id, sessionId),
    );
    return session
      ? { status: "matched", agentId, providerSessionId: sessionId, session }
      : { status: "pending", agentId, providerSessionId: sessionId };
  }

  return {
    async resolve(
      { agentIds }: RpcInput<typeof sessionUsageRpc>,
      paseo: PaseoApi,
    ): Promise<RpcOutput<typeof sessionUsageRpc>> {
      const sessions = await cache.sessions();
      const unique = [...new Set(agentIds)];
      const targets = await Promise.all(
        unique.map((agentId) => providerSession(paseo, agentId).catch(() => null)),
      );
      return {
        generatedAt: Date.now(),
        sessions: unique.map((agentId, index) => match(agentId, targets[index] ?? null, sessions)),
      };
    },
    /** A turn can start a new provider session; look the id up again next time. */
    forget(agentId: string) {
      sessionIds.delete(agentId);
    },
  };
}
