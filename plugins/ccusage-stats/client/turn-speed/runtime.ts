import type { PluginClientContext } from "@getpaseo/plugin/client";
import { recordSessionSpeedRpc } from "../../shared/speed";
import { createCalibration } from "./calibration";
import { parentAgentIdOf } from "./links";
import { DEFAULT_MAX_TOK_PER_SEC, type MeterState, type TurnSummary } from "./meter";
import { observeAgent, type AgentInfo } from "./observe";
import { createAgentSpeedStore, type AgentSpeedStore } from "./store";
import { summarizeTeam, type TeamMemberView, type TeamView } from "./team";

export interface LiveTurnSpeed {
  phase: MeterState["phase"];
  turnId: string | null;
  state: MeterState;
  provider: string | null;
  model: string | null;
  charsPerToken: number;
  liveTokPerSec: number | null;
  summary: TurnSummary;
  team: TeamView | null;
}

interface Attachment {
  store: AgentSpeedStore;
  stream?: ReturnType<typeof observeAgent>;
  unsubscribe: () => void;
  settleTimer?: ReturnType<typeof setTimeout>;
}

/** Scoped to one ccusage installation. The token pill's existing agent list supplies topology. */
export function createTurnSpeedRuntime(client: PluginClientContext) {
  const calibration = createCalibration(client);
  const book = new Map<string, AgentInfo>();
  const attachments = new Map<string, Attachment>();
  const watchers = new Map<string, Set<() => void>>();
  const parents = new Map<string, string>();
  const unavailable = new Set<string>();
  const toolParents = new Map<string, string>();
  // Keep finished worker totals for this parent turn without holding its old timeline open.
  const recent = new Map<string, { start: number; members: Map<string, TeamMemberView> }>();
  const retryTimers = new Set<ReturnType<typeof setTimeout>>();
  let disposed = false;
  let revision = 0;
  let updating = false;
  let updateAgain = false;
  let redraw: ReturnType<typeof setTimeout> | undefined;
  let clock: ReturnType<typeof setInterval> | undefined;

  function notify() {
    if (disposed || redraw !== undefined || !watchers.size) return;
    // Coalesce fast token streams while still updating timers during tool or permission waits.
    redraw = setTimeout(() => {
      redraw = undefined;
      revision++;
      for (const set of watchers.values()) for (const fn of set) fn();
    }, 100);
  }
  function members(id: string) {
    const list = [];
    for (const [child, entry] of attachments) {
      if (parents.get(child) !== id || child === id) continue;
      list.push({ id: child, title: book.get(child)?.title ?? null, model: entry.store.model, store: entry.store });
    }
    return list;
  }
  function sessionKey(provider: string | null | undefined, session: string) {
    return (provider ?? "") + "\0" + session;
  }
  function rememberParent(id: string, agent: AgentInfo) {
    const session = agent.runtimeInfo?.sessionId ?? agent.persistence?.sessionId;
    const parent = parentAgentIdOf(agent) || (session ? toolParents.get(sessionKey(agent.provider, session)) : undefined);
    const old = parents.get(id);
    if (parent && parent !== id) parents.set(id, parent);
    else parents.delete(id);
    return old !== parents.get(id);
  }
  function record(agentId: string, store: AgentSpeedStore) {
    const { turnId, endedAt, phase, provisional } = store.state;
    if (!turnId || endedAt === null || phase !== "completed" || provisional) return;
    const summary = store.summary(endedAt);
    if (summary.partial) return;
    const samples = [];
    const measuredAt = new Date(endedAt).toISOString();
    for (const basis of ["decode", "whole-turn"] as const) {
      const rate = basis === "decode" ? summary.tokPerSecDecode : summary.tokPerSecTurn;
      if (!rate || !Number.isFinite(rate) || rate > DEFAULT_MAX_TOK_PER_SEC) continue;
      samples.push({
        turnId, measuredAt, basis, tokensPerSecond: rate, approximate: summary.approx,
        ttftMs: summary.prefillMs ?? undefined,
        durationMs: basis === "decode" && summary.decodeMs > 0 ? summary.decodeMs : undefined,
      });
    }
    if (!samples.length) return;
    const payload = { agentId, samples };
    // The daemon's completed-turn hook can run just after the client receives its terminal event.
    void client.rpc(recordSessionSpeedRpc, payload).then(result => {
      if (result.recorded || disposed) return;
      const timer = setTimeout(() => {
        retryTimers.delete(timer);
        if (!disposed) void client.rpc(recordSessionSpeedRpc, payload).catch(() => {});
      }, 350);
      retryTimers.add(timer);
    }).catch(() => {});
  }
  function attach(id: string) {
    const store = createAgentSpeedStore({
      agentId: id, now: Date.now, charsPerToken: calibration.effective,
      learnedCharsPerToken: calibration.get, onCalibration: calibration.set, cacheCounting: () => "auto",
    });
    const entry: Attachment = { store, unsubscribe: () => {} };
    attachments.set(id, entry);
    entry.unsubscribe = store.subscribe(() => {
      const parent = parents.get(id);
      if (parent) {
        attachments.get(parent)?.stream?.syncWaits();
        if (store.state.provisional && entry.settleTimer === undefined) {
          // The agent list can announce idle just before its authoritative terminal stream event.
          entry.settleTimer = setTimeout(() => { entry.settleTimer = undefined; sync(); }, 1500);
        }
      }
      notify();
    });
    try {
      entry.stream = observeAgent(client.paseo.agents.ref(id), store, book.get(id), {
        hasRunningChildren: () => members(id).some(member => member.store.isRunning()),
        maxRate: () => DEFAULT_MAX_TOK_PER_SEC,
        linkSession(session) {
          const key = sessionKey(store.provider, session);
          if (toolParents.get(key) === id) return;
          toolParents.set(key, id);
          // Some providers report only the child session in their tool call. Others publish
          // the linked agent after the tool call, which upsert below reconciles on arrival.
          for (const [child, agent] of book) {
            if ((agent.runtimeInfo?.sessionId ?? agent.persistence?.sessionId) === session && agent.provider === store.provider) {
              rememberParent(child, agent);
            }
          }
          sync();
        },
        completed() {
          record(id, store);
          clearTimeout(entry.settleTimer);
          entry.settleTimer = undefined;
          if (parents.has(id)) sync();
        },
      });
    } catch { /* A removed or disconnected agent can have no live timeline. */ }
  }
  function detach(id: string) {
    const entry = attachments.get(id);
    const parent = parents.get(id);
    const start = parent ? attachments.get(parent)?.store.state.startedAt : null;
    if (entry && parent && start != null && entry.store.state.phase !== "idle" && !entry.store.isRunning()) {
      const cache = recent.get(parent);
      const records = cache?.start === start ? cache.members : new Map<string, TeamMemberView>();
      const summary = entry.store.summary();
      records.delete(id);
      records.set(id, { id, title: book.get(id)?.title ?? null, model: entry.store.model, running: false,
        liveTokPerSec: null, estTokens: summary.estTokens, approx: summary.approx });
      if (records.size > 64) records.delete(records.keys().next().value!);
      recent.set(parent, { start, members: records });
    }
    recent.delete(id);
    clearTimeout(entry?.settleTimer);
    attachments.delete(id);
    entry?.unsubscribe();
    entry?.stream?.stop();
    for (const [key, parent] of toolParents) if (parent === id) toolParents.delete(key);
  }
  function sync() {
    if (disposed) return;
    if (updating) { updateAgain = true; return; }
    updating = true;
    do {
      updateAgain = false;
      const wanted = new Set([...watchers.keys()].filter(id => !unavailable.has(id)));
      // A descendant may itself be waiting on its own workers. Follow the transitive subtree,
      // keeping one attachment even if two open views share a worker.
      const children = new Map<string, string[]>();
      for (const [child, parent] of parents) {
        const entry = attachments.get(child);
        if (book.get(child)?.status !== "running" && !entry?.store.isRunning() && entry?.settleTimer === undefined) continue;
        const list = children.get(parent) ?? [];
        list.push(child);
        children.set(parent, list);
      }
      for (const id of wanted) for (const child of children.get(id) ?? []) wanted.add(child);
      for (const id of attachments.keys()) if (!wanted.has(id)) detach(id);
      for (const id of wanted) if (!attachments.has(id)) attach(id);
      for (const entry of attachments.values()) entry.stream?.syncWaits();
    } while (updateAgain);
    updating = false;
    notify();
  }
  return {
    upsert(row: AgentInfo) {
      if (disposed) return;
      if (row.archivedAt || row.status === "closed") { this.remove(row.id); return; }
      const restored = unavailable.delete(row.id);
      // Retain only meter fields from the shared list, never messages or permission payloads.
      const previous = book.get(row.id);
      const agent: AgentInfo = {
        id: row.id, title: row.title, provider: row.provider, model: row.model, status: row.status,
        activeTurn: row.activeTurn, pendingPermissions: row.pendingPermissions?.map(p => ({ id: p.id })),
        lastUsage: row.lastUsage, parentAgentId: parentAgentIdOf(row), runtimeInfo: row.runtimeInfo && { sessionId: row.runtimeInfo.sessionId },
        persistence: row.persistence && { sessionId: row.persistence.sessionId },
      };
      book.set(row.id, agent);
      const changed = rememberParent(row.id, agent);
      attachments.get(row.id)?.stream?.snapshot(agent);
      if ((changed || restored || (parents.has(row.id) && previous?.status !== row.status)) && watchers.size) sync();
      else if (previous?.title !== row.title && attachments.has(row.id)) notify();
    },
    remove(id: string) {
      book.delete(id);
      const parent = parents.get(id);
      if (watchers.has(id)) unavailable.add(id);
      detach(id);
      parents.delete(id);
      notify();
      if (parent && watchers.size) sync();
    },
    clearAgents() {
      book.clear();
      parents.clear();
      toolParents.clear();
      unavailable.clear();
      if (watchers.size) sync();
    },
    watch(id: string, fn: () => void) {
      if (disposed || !id) return () => {};
      const listeners = watchers.get(id) ?? new Set();
      listeners.add(fn);
      watchers.set(id, listeners);
      calibration.load();
      sync();
      clock ??= setInterval(() => {
        if ([...attachments.values()].some(entry => entry.store.isRunning())) notify();
      }, 500);
      return () => {
        listeners.delete(fn);
        if (!listeners.size) { watchers.delete(id); unavailable.delete(id); }
        // React can transfer a visible pill to its popover in one commit. Let the new
        // observer attach before closing a live timeline and losing its current turn.
        queueMicrotask(() => {
          if (disposed) return;
          sync();
          if (!watchers.size) {
            clearInterval(clock); clock = undefined;
            clearTimeout(redraw); redraw = undefined;
          }
        });
      };
    },
    version: () => revision,
    read(id: string, windowSeconds: number): LiveTurnSpeed | null {
      const entry = attachments.get(id);
      if (!entry) return null;
      const { store } = entry;
      const now = Date.now();
      const summary = store.summary(now);
      const team = summarizeTeam(members(id), windowSeconds, now, DEFAULT_MAX_TOK_PER_SEC);
      team.running = Math.max(team.running, entry.stream?.openDelegates() ?? 0);
      if (team.running && !team.members.length) team.approx = true;
      const finished = recent.get(id);
      if (finished && finished.start === store.state.startedAt) {
        const activeIds = new Set(team.members.map(member => member.id));
        team.members = [...team.members, ...[...finished.members.values()].filter(member => !activeIds.has(member.id))];
      }
      return {
        phase: store.state.phase, turnId: store.state.turnId, state: store.state, model: store.model, provider: store.provider,
        charsPerToken: calibration.effective(store.model), summary,
        liveTokPerSec: store.liveTokPerSec(windowSeconds, DEFAULT_MAX_TOK_PER_SEC),
        team: team.members.length || team.running ? team : null,
      };
    },
    dispose() {
      disposed = true;
      clearInterval(clock);
      clearTimeout(redraw);
      for (const timer of retryTimers) clearTimeout(timer);
      for (const id of attachments.keys()) detach(id);
      watchers.clear(); book.clear(); parents.clear(); toolParents.clear(); retryTimers.clear(); unavailable.clear(); recent.clear();
      calibration.dispose();
    },
  };
}
export type TurnSpeedRuntime = ReturnType<typeof createTurnSpeedRuntime>;
