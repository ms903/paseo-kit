import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import {
  sessionSpeedSample,
  type recordSessionSpeedRpc,
  type SessionSpeed,
  type SessionSpeedSample,
  type sessionSpeedRpc,
} from "../shared/speed";
import { readCompletedTurnSpeed, readSpeedHistory, speedSession, type SpeedHistory, type SpeedSession } from "./speed-history";
import { createUsageStore } from "./usage-store";

type Paseo = PluginHandlerContext["paseo"];
type AgentHandle = ReturnType<Paseo["agents"]["ref"]>;
type Agent = NonNullable<ReturnType<AgentHandle["current"]>>;
type AgentList = Awaited<ReturnType<Paseo["agents"]["list"]>>;
type AgentListOptions = NonNullable<Parameters<Paseo["agents"]["list"]>[0]>;

const MAX_CACHE_ENTRIES = 64;
const MAX_COMPLETIONS = 256;
const MAX_LOOKUP_PAGES = 8;
const MAX_SAMPLES = 24;
const CACHE_MS = 30_000;
const ENRICHMENT_MS = 5 * 60_000;
const COMPLETION_MS = 2 * 60_000;
const STORE_REVISION = "2";
const CODEX_THREAD_ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const CODEX_ROLLOUT = /^(?:\d{4}[/\\]\d{2}[/\\]\d{2}[/\\])?rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([\da-f-]+)$/i;

function indexedSession(provider: string, sessionId: string): SpeedSession | undefined {
  if (provider !== "codex") return { provider, sessionId };
  const id = CODEX_ROLLOUT.exec(sessionId)?.[1] ?? sessionId;
  if (CODEX_THREAD_ID.test(id)) return { provider, sessionId: id.toLowerCase() };
}

function sessionKey(provider: string, sessionId: string) {
  return JSON.stringify([provider, sessionId]);
}

interface CompletedTurn {
  expiresAt: number;
  measuredAt: string;
  sessionKey: Promise<string | undefined>;
}

function keepNewest<K, V>(map: Map<K, V>, key: K, value: V, limit: number) {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value!);
}

function priority(sample: SessionSpeedSample) {
  return sample.source === "provider" ? 2 : sample.approximate ? 0 : 1;
}

function mergeSamples(...lists: readonly SessionSpeedSample[][]): SessionSpeedSample[] {
  const samples = new Map<string, SessionSpeedSample>();
  for (const list of lists) {
    for (const sample of list) {
      const key = JSON.stringify([sample.turnId, sample.basis]);
      const previous = samples.get(key);
      if (!previous || priority(sample) > priority(previous)) samples.set(key, sample);
    }
  }
  return [...samples.values()].sort((a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt));
}

async function findAgent(paseo: Paseo, expected: SpeedSession): Promise<Agent | undefined> {
  let cursor: string | null = null;
  let includeBackground = true;
  for (let page = 0; page < MAX_LOOKUP_PAGES; page++) {
    const options: AgentListOptions = {
      filter: { includeArchived: true },
      page: { limit: 200, ...(cursor ? { cursor } : {}) },
      sort: [{ key: "updated_at" as const, direction: "desc" as const }],
      timeout: 3_000,
    };
    const result: AgentList = includeBackground
      ? await paseo.agents.list({ ...options, includeBackground }).catch((error: unknown) => {
          if (!String(error).includes("background workspaces")) throw error;
          includeBackground = false;
          return paseo.agents.list(options);
        })
      : await paseo.agents.list(options);
    const match = result.entries.find(({ agent }) => {
      const target = speedSession(agent);
      return target?.provider === expected.provider && target.sessionId === expected.sessionId;
    });
    if (match) return match.agent;
    if (!result.pageInfo.nextCursor || result.pageInfo.nextCursor === cursor) return;
    cursor = result.pageInfo.nextCursor;
  }
}

export const emptySpeed: SessionSpeed = { status: "unavailable", active: false, turns: [], hasOlder: false };

export function createSessionSpeed({ now = Date.now, store = createUsageStore("UTC") } = {}) {
  const recorded = store.fileIndex("turn-speed", z.array(sessionSpeedSample).max(MAX_SAMPLES));
  const completions = new Map<string, CompletedTurn>();
  const history = new Map<string, { agentId: string; expiresAt: number; value: Promise<SpeedHistory> }>();
  const agents = new Map<string, { expiresAt: number; value: Promise<Agent | undefined> }>();
  const enriched = new Map<string, number>();
  let writes = Promise.resolve();
  let generation = 0;
  let enriching = false;

  function save(key: string, updates: SessionSpeedSample[]): Promise<void> {
    const currentGeneration = generation;
    const result = writes.then(async () => {
      if (currentGeneration !== generation) return;
      const previous = await recorded.get(key, STORE_REVISION) ?? [];
      const next = mergeSamples(previous, updates).slice(0, MAX_SAMPLES);
      if (currentGeneration !== generation || JSON.stringify(previous) === JSON.stringify(next)) return;
      await recorded.set(key, STORE_REVISION, next);
      await recorded.flush();
    });
    writes = result.catch(() => {});
    return result;
  }

  async function complete(paseo: Paseo, agentId: string, turnId: string | null) {
    for (const [key, entry] of history) if (entry.agentId === agentId) history.delete(key);
    if (!turnId) return;
    const completionKey = sessionKey(agentId, turnId);
    if (completions.has(completionKey)) return;

    const currentGeneration = generation;
    const completedAt = now();
    const handle = paseo.agents.ref(agentId);
    const measured = readCompletedTurnSpeed(handle, turnId).catch(() => undefined);
    const key = measured.then((result) => {
      const target = speedSession(result?.agent);
      if (target) return sessionKey(target.provider, target.sessionId);
    });

    keepNewest(completions, completionKey, {
      expiresAt: completedAt + COMPLETION_MS,
      measuredAt: new Date(completedAt).toISOString(),
      sessionKey: key,
    }, MAX_COMPLETIONS);

    const [target, result] = await Promise.all([key, measured]);
    if (target && result?.samples.length && currentGeneration === generation) await save(target, result.samples);
  }

  async function record(input: RpcInput<typeof recordSessionSpeedRpc>): Promise<boolean> {
    const turnId = input.samples[0]?.turnId;
    if (!turnId || input.samples.some((sample) => sample.turnId !== turnId)) return false;
    const completion = completions.get(sessionKey(input.agentId, turnId));
    if (!completion || completion.expiresAt < now()) return false;
    const currentGeneration = generation;
    const target = await completion.sessionKey;
    if (!target || currentGeneration !== generation) return false;
    await save(target, input.samples.map((sample) => ({
      ...sample, measuredAt: completion.measuredAt, source: "observed",
    })));
    return true;
  }

  function readHistory(agent: AgentHandle, session: SpeedSession) {
    const key = JSON.stringify([agent.id, session.provider, session.sessionId]);
    const cached = history.get(key);
    if (cached && cached.expiresAt > now()) return cached.value;
    const value = readSpeedHistory(agent, session).catch(() => ({ turns: [], hasOlder: false }));
    keepNewest(history, key, { agentId: agent.id, value, expiresAt: now() + CACHE_MS }, MAX_CACHE_ENTRIES);
    return value;
  }

  function indexedAgent(paseo: Paseo, expected: SpeedSession) {
    const key = sessionKey(expected.provider, expected.sessionId);
    const cached = agents.get(key);
    if (cached && cached.expiresAt > now()) return cached.value;
    const value: Promise<Agent | undefined> = findAgent(paseo, expected).catch(() => undefined).then((found) => {
      if (!found && agents.get(key)?.value === value) agents.delete(key);
      return found;
    });
    keepNewest(agents, key, { value, expiresAt: now() + CACHE_MS }, MAX_CACHE_ENTRIES);
    return value;
  }

  async function savedFor(session: SpeedSession): Promise<SessionSpeed> {
    const saved = await recorded.get(sessionKey(session.provider, session.sessionId), STORE_REVISION);
    return saved?.length
      ? { ...emptySpeed, status: "ready", turns: saved, hasOlder: saved.length === MAX_SAMPLES }
      : emptySpeed;
  }

  async function matchingAgent(paseo: Paseo, expected: SpeedSession): Promise<Agent | undefined> {
    const indexed = await indexedAgent(paseo, expected);
    if (!indexed) return;
    const snapshot = (await paseo.agents.ref(indexed.id).refresh().catch(() => null))?.agent;
    const actual = speedSession(snapshot);
    if (actual?.provider === expected.provider && actual.sessionId === expected.sessionId) return snapshot;
    agents.delete(sessionKey(expected.provider, expected.sessionId));
  }

  function enrich(paseo: Paseo, expected: SpeedSession) {
    const key = sessionKey(expected.provider, expected.sessionId);
    if (enriching || (enriched.get(key) ?? 0) > now()) return;
    keepNewest(enriched, key, now() + ENRICHMENT_MS, MAX_CACHE_ENTRIES);
    const currentGeneration = generation;
    enriching = true;
    void matchingAgent(paseo, expected).then(async (snapshot) => {
      if (!snapshot || currentGeneration !== generation) return;
      const native = await readHistory(paseo.agents.ref(snapshot.id), expected);
      if (native.turns.length && currentGeneration === generation) await save(key, native.turns);
    }).catch(() => {}).finally(() => { enriching = false; });
  }

  async function read(input: RpcInput<typeof sessionSpeedRpc>, paseo: Paseo): Promise<SessionSpeed> {
    const currentGeneration = generation;
    let snapshot: Agent | undefined;
    if ("agentId" in input) {
      snapshot = (await paseo.agents.ref(input.agentId).refresh().catch(() => null))?.agent;
    } else {
      const expected = indexedSession(input.provider, input.sessionId);
      if (!expected) return emptySpeed;
      const saved = await savedFor(expected);
      if (currentGeneration !== generation) return emptySpeed;
      if (saved.status === "ready") {
        enrich(paseo, expected);
        return saved;
      }
      snapshot = await matchingAgent(paseo, expected);
    }
    if (currentGeneration !== generation) return emptySpeed;
    const target = speedSession(snapshot);
    if (!target || !snapshot) return { ...emptySpeed, active: snapshot?.status === "running" };

    const [native, saved] = await Promise.all([
      readHistory(paseo.agents.ref(snapshot.id), target),
      recorded.get(sessionKey(target.provider, target.sessionId), STORE_REVISION),
    ]);
    if (currentGeneration !== generation) return emptySpeed;
    const samples = mergeSamples(native.turns, saved ?? []);
    const turns = samples.slice(0, MAX_SAMPLES);
    if (native.turns.length && JSON.stringify(turns) !== JSON.stringify(saved)) {
      void save(sessionKey(target.provider, target.sessionId), turns).catch(() => {});
    }
    return {
      active: snapshot.status === "running", turns,
      hasOlder: native.hasOlder || samples.length > turns.length || saved?.length === MAX_SAMPLES,
      status: turns.length ? "ready" : "unavailable",
    };
  }

  function clear() {
    generation++;
    completions.clear();
    history.clear();
    agents.clear();
    enriched.clear();
  }

  return { complete, record, read, clear, async stop() { clear(); await writes; } };
}
