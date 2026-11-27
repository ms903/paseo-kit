import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { PARENT_AGENT_LABEL, type SessionMatch, type SessionUsage, type sessionDetailRpc, type sessionUsageRpc } from "../shared/usage";
import { createCodexSessionReader } from "./codex-session";
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
  child?: boolean;
  createdAt?: string;
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

export function sessionTarget(agent: Agent | undefined): CachedSessionId {
  const persistence = agent?.persistence;
  const provider = persistence?.provider ?? agent?.provider;
  const sessionId = persistence && provider === "antigravity" && !persistence.nativeHandle
    ? antigravityConversationId(persistence.sessionId, persistence.metadata?.pluginProviderPersistence)
    : persistence?.nativeHandle || persistence?.sessionId || null;
  return { sessionId, provider, child: !!agent?.labels?.[PARENT_AGENT_LABEL], createdAt: agent?.createdAt, at: Date.now() };
}

function contextOf(usage: Agent["lastUsage"]) {
  const used = usage?.contextWindowUsedTokens;
  const limit = usage?.contextWindowMaxTokens;
  const validUsed = typeof used === "number" && Number.isSafeInteger(used) && used >= 0 ? used : undefined;
  const validLimit = typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0 ? limit : undefined;
  return validUsed === undefined && validLimit === undefined ? undefined : { used: validUsed, limit: validLimit };
}

function latestCodexRequest(usage: Agent["lastUsage"]) {
  const input = usage?.inputTokens;
  const output = usage?.outputTokens;
  if (typeof input !== "number" || typeof output !== "number" ||
    !Number.isSafeInteger(input) || !Number.isSafeInteger(output) || input < 0 || output < 0 || !input && !output) return;
  const cached = usage?.cachedInputTokens;
  const cacheReadTokens = typeof cached === "number" && Number.isSafeInteger(cached)
    ? Math.min(Math.max(cached, 0), input) : 0;
  return {
    inputTokens: input - cacheReadTokens, outputTokens: output, cacheReadTokens,
    cacheCreationTokens: 0, totalTokens: input + output, cost: null,
  };
}

export function createSessionMatcher(cache: Pick<ReportCache, "sessions"> & Partial<Pick<ReportCache, "refreshSession">>) {
  const sessionIds = new Map<string, CachedSessionId>();
  const updated = new Map<string, { session: SessionUsage; at: number }>();
  const refreshing = new Map<string, Promise<void>>();
  const readCodex = createCodexSessionReader();

  async function providerSession(paseo: PaseoApi, agentId: string): Promise<CachedSessionId> {
    const cached = sessionIds.get(agentId);
    if (cached && Date.now() - cached.at < (cached.sessionId ? SESSION_ID_TTL_MS : 10_000)) {
      return cached;
    }
    const result = await paseo.agents.ref(agentId).refresh();
    return remember(agentId, sessionTarget(result?.agent));
  }

  function remember(agentId: string, entry: CachedSessionId) {
    sessionIds.delete(agentId);
    if (sessionIds.size >= MAX_SESSION_IDS) sessionIds.delete(sessionIds.keys().next().value!);
    sessionIds.set(agentId, entry);
    return entry;
  }

  function refreshUsage(key: string, read: () => Promise<SessionUsage | undefined>) {
    let job = refreshing.get(key);
    if (!job) {
      job = read().then((session) => {
        if (!session) return;
        updated.delete(key);
        updated.set(key, { session, at: Date.now() });
        if (updated.size > MAX_REFRESHED) updated.delete(updated.keys().next().value!);
      }).finally(() => { refreshing.delete(key); });
      refreshing.set(key, job);
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
    let session = sessions.find((candidate) => sessionMatches(candidate, target.provider, sessionId));
    const refreshed = updated.get(`${target.provider}:${sessionId}`)?.session;
    if (refreshed) {
      const recordedAt = Date.parse(refreshed.lastActivity ?? "") || 0;
      const indexedAt = Date.parse(session?.lastActivity ?? "") || 0;
      const usedMoreTokens = refreshed.usage.totalTokens > (session?.usage.totalTokens ?? 0);
      // Keep a priced Codex row once the report covers the same activity.
      const newer = refreshed.recorded
        ? recordedAt > indexedAt && usedMoreTokens
        : recordedAt > indexedAt || (recordedAt === indexedAt && usedMoreTokens);
      if (!session || newer) session = refreshed;
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
      const sessions = await cache.sessions(false);
      const { sessionId, provider } = target;
      const key = `${provider}:${sessionId}`;
      const readAntigravity = cache.refreshSession;
      if (refresh && provider === "antigravity" && sessionId && readAntigravity) {
        await refreshUsage(key, () => readAntigravity(sessionId));
      }
      if (provider === "codex" && target.child && sessionId) {
        const indexed = sessions.find((session) => sessionMatches(session, provider, sessionId));
        await refreshUsage(key, () => readCodex(sessionId, target.createdAt, indexed?.id)).catch(() => {});
      }
      const current = match(agentId, target, sessions);
      return {
        match: current,
        latestRequest: provider === "codex" && target.child && current.status !== "matched"
          ? latestCodexRequest(result?.agent.lastUsage) : undefined,
        context: contextOf(result?.agent.lastUsage),
        checkedAt,
        usageCheckedAt: sessionId ? updated.get(key)?.at : undefined,
      };
    },
    /** A turn can start a new provider session; look the id up again next time. */
    forget(agentId: string) {
      sessionIds.delete(agentId);
    },
  };
}

function sessionMatches(candidate: SessionUsage, provider: string | undefined, id: string) {
  if (provider === "antigravity") return candidate.agent === provider && candidate.id === id;
  return (provider !== "codex" || candidate.agent === provider) && sessionKeyMatches(candidate.id, id);
}
