// Adapted from Drenalol/paseo-turn-speed v1.4.2 under the accompanying MIT license.
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { reconcileSnapshot, turnStartFromEvent, type AgentTurnSnapshot } from "./lifecycle";
import type { AgentSpeedStore } from "./store";

type Handle = ReturnType<PluginClientContext["paseo"]["agents"]["ref"]>;
type Event = Parameters<Parameters<Handle["timeline"]["subscribe"]>[0]>[0];
type Usage = NonNullable<Handle["lastUsage"]>;

export interface AgentInfo extends AgentTurnSnapshot {
  id: string;
  title?: string | null;
  model?: string | null;
  provider?: string | null;
  labels?: Readonly<Record<string, string>> | null;
  parentAgentId?: string | null;
  runtimeInfo?: { sessionId?: string | null } | null;
  persistence?: { sessionId?: string | null } | null;
  archivedAt?: string | null;
  lastUsage?: Usage | null;
}

function mapUsage(usage: Usage) {
  return {
    input: usage.inputTokens, output: usage.outputTokens, cached: usage.cachedInputTokens,
    ctxMax: usage.contextWindowMaxTokens, ctxUsed: usage.contextWindowUsedTokens,
  };
}

export function observeAgent(handle: Handle, store: AgentSpeedStore, initial: AgentInfo | undefined, deps: {
  hasRunningChildren(): boolean;
  linkSession(childSessionId: string): void;
  completed(): void;
  maxRate(): number;
}) {
  let closed = false;
  let ready = false;
  let epoch = 0;
  let freshIdentity = 0;
  let usageSignature: string | undefined;
  const approvals = new Set<string>();
  const tools = new Set<string>();
  const delegates = new Set<string>();
  function clearWaits() { approvals.clear(); tools.clear(); delegates.clear(); }
  function syncWaits() {
    if (!store.isRunning()) return;
    const at = Date.now();
    const delegated = delegates.size > 0 || deps.hasRunningChildren();
    if (delegated !== (store.state.delegatedAt !== null))
      store.dispatch({ t: delegated ? "delegated_started" : "delegated_ended", at });
    if ((tools.size > 0) !== (store.state.toolAt !== null))
      store.dispatch({ t: tools.size ? "tool_started" : "tool_ended", at });
  }
  function usage(value: Usage | null | undefined) {
    if (!value) return;
    const mapped = mapUsage(value);
    const sig = [mapped.output, mapped.input, mapped.cached, mapped.ctxMax, mapped.ctxUsed].join("|");
    if (sig === usageSignature) return;
    usageSignature = sig;
    store.dispatch({ t: "usage", at: Date.now(), usage: mapped, maxTokPerSec: deps.maxRate() });
  }
  function snapshot(agent: AgentInfo) {
    if (closed) return;
    freshIdentity++;
    store.setIdentity(agent.provider, agent.model);
    usage(agent.lastUsage);
    const decision = reconcileSnapshot(store.state, agent, Date.now(), { seed: ready });
    if (decision.pendingWaits) {
      approvals.clear();
      for (const id of decision.pendingWaits) approvals.add(id);
    }
    for (const action of decision.actions) {
      store.dispatch(action);
      if (action.t === "turn_ended") clearWaits();
    }
    syncWaits();
  }
  function reseed() {
    const ticket = ++epoch;
    const identity = freshIdentity;
    void handle.refresh().then(result => {
      if (!closed && ticket === epoch && result?.agent && identity === freshIdentity) snapshot(result.agent);
    }).catch(() => {});
  }
  if (initial) snapshot(initial);
  function update(message: Event) {
    if (closed) return;
    const event = message.event;
    const at = Date.now();
    const current = store.state.turnId;
    if (event.type !== "turn_started" && "turnId" in event && event.turnId && current && event.turnId !== current) return;
    switch (event.type) {
      case "turn_started": {
        freshIdentity++;
        clearWaits();
        const boundary = turnStartFromEvent("timestamp" in message ? message.timestamp : null, at);
        store.dispatch({ t: "turn_started", at: boundary.at, turnId: event.turnId || null });
        syncWaits();
        break;
      }
      case "turn_completed":
      case "turn_failed":
      case "turn_canceled": {
        freshIdentity++;
        clearWaits();
        if (event.type === "turn_completed") {
          store.dispatch({ t: "turn_ended", at, kind: "completed", turnId: event.turnId || null,
            usage: event.usage ? mapUsage(event.usage) : undefined, maxTokPerSec: deps.maxRate() });
          deps.completed();
        } else {
          store.dispatch({ t: "turn_ended", at, kind: event.type === "turn_failed" ? "failed" : "canceled",
            turnId: event.turnId || null, note: event.type === "turn_failed" ? event.error : event.reason });
        }
        break;
      }
      case "permission_requested":
        if (event.request?.id) {
          approvals.add(event.request.id);
          store.dispatch({ t: "user_wait_started", at });
        }
        break;
      case "permission_resolved":
        if (approvals.delete(event.requestId) && !approvals.size) store.dispatch({ t: "user_wait_ended", at });
        break;
      case "timeline": {
        const item = event.item;
        if (item.type === "assistant_message" || item.type === "reasoning") {
          const reasoning = item.type === "reasoning";
          store.dispatch({ t: "text", at, key: reasoning ? "reasoning:" + (event.turnId ?? "current") : item.messageId ?? "assistant",
            text: item.text, kind: reasoning ? "reasoning" : "text" });
        } else if (item.type === "compaction") {
          store.dispatch({ t: "compaction", at });
        } else if (item.type === "tool_call") {
          const child = item.detail.type === "sub_agent" || /^sub[-_. ]?agent$/i.test(item.name);
          if (item.detail.type === "sub_agent" && item.detail.childSessionId) deps.linkSession(item.detail.childSessionId);
          const set = child ? delegates : tools;
          if (item.callId) {
            if (item.status === "running") set.add(item.callId);
            else set.delete(item.callId);
            syncWaits();
          }
        }
        break;
      }
      case "replacement":
      case "subscription_restored":
        clearWaits();
        usageSignature = undefined;
        store.dispatch({ t: "reset" });
        reseed();
        break;
    }
  }
  const subscription = handle.timeline.subscribe(update);
  void subscription.ready.then(() => {
    if (!closed) { ready = true; reseed(); }
  }).catch(() => {});
  return {
    snapshot, syncWaits, openDelegates: () => delegates.size,
    stop() { closed = true; void subscription.release().catch(() => {}); },
  };
}
