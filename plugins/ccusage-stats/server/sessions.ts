import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import type { SessionMatch, SessionUsage, sessionDetailRpc, sessionUsageRpc } from "../shared/usage";
import type { ReportCache } from "./report";

type PaseoApi = PluginHandlerContext["paseo"];
type Agent = NonNullable<ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["current"]>>;

// A provider session id rarely changes once an agent has one; a resume or refresh can replace it.
const SESSION_ID_TTL_MS = 5 * 60_000;
const MAX_SESSION_IDS = 1000;
const MAX_REFRESHED = 32;

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

function sessionTarget(agent: Agent | undefined): CachedSessionId {
  const persistence = agent?.persistence;
  const provider = persistence?.provider ?? agent?.provider;
  const sessionId = persistence && provider === "antigravity" && !persistence.nativeHandle
    ? antigravityConversationId(persistence.sessionId, persistence.metadata?.pluginProviderPersistence)
    : persistence?.nativeHandle || persistence?.sessionId || null;
  return { sessionId, provider, at: Date.now() };
}

function contextOf(usage: Agent["lastUsage"]) {
  const used = usage?.contextWindowUsedTokens;
  const limit = usage?.contextWindowMaxTokens;
  const validUsed = typeof used === "number" && Number.isSafeInteger(used) && used >= 0 ? used : undefined;
  const validLimit = typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0 ? limit : undefined;
  return validUsed === undefined && validLimit === undefined ? undefined : { used: validUsed, limit: validLimit };
}

export function createSessionMatcher(cache: Pick<ReportCache, "sessions"> & Partial<Pick<ReportCache, "refreshSession">>) {
  const sessionIds = new Map<string, CachedSessionId>();
  const updated = new Map<string, { session: SessionUsage; at: number }>();
  const refreshing = new Map<string, Promise<void>>();

  async function providerSession(paseo: PaseoApi, agentId: string): Promise<CachedSessionId> {
    const cached = sessionIds.get(agentId);
    if (cached && Date.now() - cached.at < (cached.sessionId ? SESSION_ID_TTL_MS : 10_000)) {
      return cached;
    }
    const result = await paseo.agents.ref(agentId).refresh();
    return remember(agentId, sessionTarget(result?.agent));
  }

  function remember(agentId: string, entry: CachedSessionId) {
    for (const [id, entry] of sessionIds) {
      if (Date.now() - entry.at >= SESSION_ID_TTL_MS) sessionIds.delete(id);
    }
    if (sessionIds.size >= MAX_SESSION_IDS) sessionIds.delete(sessionIds.keys().next().value!);
    sessionIds.set(agentId, entry);
    return entry;
  }

  function refreshUsage(id: string, read: ReportCache["refreshSession"]) {
    let job = refreshing.get(id);
    if (!job) {
      job = read(id).then((session) => {
        if (!session) return;
        updated.delete(id);
        updated.set(id, { session, at: Date.now() });
        if (updated.size > MAX_REFRESHED) updated.delete(updated.keys().next().value!);
      }).finally(() => { refreshing.delete(id); });
      refreshing.set(id, job);
    }
    return job;
  }

  function match(
    agentId: string,
    target: CachedSessionId | null,
    sessions: SessionUsage[],
  ): SessionMatch {
    const sessionId = target?.sessionId;
    if (!sessionId) return { status: "unknown", agentId };
    let session = sessions.find((candidate) =>
      target.provider === "antigravity"
        ? candidate.agent === "antigravity" && candidate.id === sessionId
        : sessionKeyMatches(candidate.id, sessionId),
    );
    const refreshed = target.provider === "antigravity" ? updated.get(sessionId)?.session : undefined;
    if (refreshed && (!session || (refreshed.lastActivity ?? "") > (session.lastActivity ?? "") ||
      (refreshed.lastActivity === session.lastActivity && refreshed.usage.totalTokens > session.usage.totalTokens))) {
      session = refreshed;
    }
    return session
      ? { status: "matched", agentId, providerSessionId: sessionId, session }
      : {
        status: "pending", agentId, providerSessionId: sessionId,
        canRefresh: target.provider === "antigravity" ? true : undefined,
      };
  }

  return {
    async resolve(
      { agentIds }: RpcInput<typeof sessionUsageRpc>,
      paseo: PaseoApi,
    ): Promise<RpcOutput<typeof sessionUsageRpc>> {
      const sessions = await cache.sessions(false);
      const unique = [...new Set(agentIds)];
      const targets = await Promise.all(
        unique.map((agentId) => providerSession(paseo, agentId).catch(() => null)),
      );
      return {
        generatedAt: Date.now(),
        sessions: unique.map((agentId, index) => match(agentId, targets[index] ?? null, sessions)),
      };
    },
    async detail(
      { agentId, refresh }: RpcInput<typeof sessionDetailRpc>,
      paseo: PaseoApi,
    ): Promise<RpcOutput<typeof sessionDetailRpc>> {
      const result = await paseo.agents.ref(agentId).refresh();
      const checkedAt = Date.now();
      const target = result ? remember(agentId, sessionTarget(result.agent))
        : sessionIds.get(agentId) ?? sessionTarget(undefined);
      if (refresh && target.provider === "antigravity" && target.sessionId && cache.refreshSession) {
        await refreshUsage(target.sessionId, cache.refreshSession);
      }
      return {
        match: match(agentId, target, await cache.sessions(false)),
        context: contextOf(result?.agent.lastUsage),
        checkedAt,
        usageCheckedAt: target.provider === "antigravity" && target.sessionId
          ? updated.get(target.sessionId)?.at : undefined,
      };
    },
    /** A turn can start a new provider session; look the id up again next time. */
    forget(agentId: string) {
      sessionIds.delete(agentId);
    },
  };
}
