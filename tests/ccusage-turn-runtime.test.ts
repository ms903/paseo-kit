import test from "node:test";
import assert from "node:assert/strict";
import { createTurnSpeedRuntime } from "../plugins/ccusage-stats/client/turn-speed/runtime";
import type { AgentInfo } from "../plugins/ccusage-stats/client/turn-speed/observe";

test("only the watched team opens live streams, shares overlapping views and records a completed observed turn", async t => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: new Date("2026-11-01T00:00:00Z") });
  const snapshots = new Map<string, AgentInfo>();
  const streams = new Map<string, (message: any) => void>();
  const counts: string[] = [];
  const recorded: any[] = [];
  const runtime = createTurnSpeedRuntime({
    paseo: { agents: { ref: (id: string) => ({
      refresh: async () => ({agent:snapshots.get(id)}),
      timeline: { subscribe: (listener: (value: unknown) => void) => {
        counts.push(id); streams.set(id, listener);
        return {ready:Promise.resolve(), release:async () => { streams.delete(id); }};
      } },
    }) } },
    rpc: async (method: {name: string}, input: any) => {
      if (method.name.endsWith(".read")) return {status:"ready",revision:"1",values:{calibration:{}}};
      if (method.name.endsWith(".record")) { recorded.push(input); return {recorded:true}; }
      return { status:"saved" };
    },
  } as any);
  const put = (id: string, more: Partial<AgentInfo> = {}) => {
    const item = { id, provider:"codex", model:"fixture", status:"idle", ...snapshots.get(id), ...more };
    snapshots.set(id,item); runtime.upsert(item);
  };
  const event = (id: string, data: any) => streams.get(id)!({ event:data, timestamp:new Date().toISOString() });
  try {
    put("parent"); put("worker",{labels:{"paseo.parent-agent-id":"parent"}}); put("otherChild",{labels:{"paseo.parent-agent-id":"parent"}}); put("unrelated");
    assert.equal(counts.length,0);
    const cleanParent = runtime.watch("parent",() => {});
    assert.deepEqual(counts,["parent"]);
    put("worker",{status:"running",activeTurn:{turnId:"subturn",startedAt:new Date().toISOString()}});
    const cleanWorker = runtime.watch("worker",() => {});
    assert.deepEqual(counts,["parent","worker"]);
    await new Promise(resolve=>setImmediate(resolve));
    event("worker",{type:"turn_completed",turnId:"subturn"});
    put("worker",{status:"idle",activeTurn:null});
    event("parent",{type:"turn_started",turnId:"turn"});
    put("parent",{status:"running",activeTurn:{turnId:"turn",startedAt:new Date().toISOString()}});
    t.mock.timers.tick(150);
    for (let n=1; n<=12; n++) {
      event("parent",{type:"timeline",turnId:"turn",item:{type:"assistant_message",messageId:"m",text:"x".repeat(n*6)}});
      t.mock.timers.tick(50);
    }
    assert.ok(runtime.read("parent",3)!.liveTokPerSec! > 0);
    event("parent",{type:"permission_requested",request:{id:"permission"}});
    assert.equal(runtime.read("parent",3)!.summary.waiting,true);
    assert.equal(runtime.read("parent",3)!.liveTokPerSec,null);
    t.mock.timers.tick(1000);
    event("parent",{type:"permission_resolved",requestId:"permission"});
    assert.equal(runtime.read("parent",3)!.summary.userWaitMs,1000);
    event("parent",{type:"timeline",turnId:"turn",item:{type:"tool_call",detail:{type:"unknown"},name:"shell",callId:"call",status:"running"}});
    assert.equal(runtime.read("parent",3)!.summary.tooling,true);
    t.mock.timers.tick(600);
    event("parent",{type:"timeline",turnId:"turn",item:{type:"tool_call",detail:{type:"unknown"},name:"shell",callId:"call",status:"completed"}});
    event("worker",{type:"turn_started",turnId:"next-subturn"});
    assert.equal(runtime.read("parent",3)!.team?.running,1);
    assert.equal(runtime.read("parent",3)!.summary.delegated,true);
    t.mock.timers.tick(650);
    event("worker",{type:"turn_completed",turnId:"next-subturn"});
    assert.ok(runtime.read("parent",3)!.summary.delegatedMs >= 650);
    // A linked worker with no open panel watches only its active turn, including reordered
    // idle/terminal messages, and then leaves a scalar summary in the parent's team.
    put("otherChild",{status:"running",activeTurn:{turnId:"other",startedAt:new Date().toISOString()}});
    await new Promise(resolve=>setImmediate(resolve));
    assert.ok(streams.has("otherChild"));
    put("otherChild",{status:"idle",activeTurn:null});
    assert.ok(streams.has("otherChild"));
    event("otherChild",{type:"turn_completed",turnId:"other"});
    assert.equal(streams.has("otherChild"),false);
    assert.ok(runtime.read("parent",3)!.team?.members.some(member=>member.id==="otherChild" && !member.running));
    t.mock.timers.tick(500);
    event("parent",{type:"turn_completed",turnId:"turn",usage:{outputTokens:20,inputTokens:8}});
    assert.equal(runtime.read("parent",3)!.phase,"completed");
    assert.equal(recorded.length,1);
    assert.equal(recorded[0].agentId,"parent");
    assert.ok(recorded[0].samples.every((s:any) => s.turnId === "turn" && s.tokensPerSecond > 0));
    cleanParent();
    const keepWorker = runtime.watch("worker", () => {});
    await Promise.resolve();
    assert.deepEqual([...streams.keys()],["worker"]);
    cleanWorker();
    keepWorker();
    await Promise.resolve();
    assert.equal(streams.size,0);

    // Reopening after the start gets the real turn boundary but never backfills unseen output.
    put("parent",{status:"running",activeTurn:{turnId:"later",startedAt:new Date(Date.now()-10_000).toISOString()}});
    const end = runtime.watch("parent",()=>{});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(runtime.read("parent",5)!.summary.partial,true);
    event("parent",{type:"turn_completed",turnId:"later",usage:{outputTokens:32}});
    assert.equal(recorded.length,1);
    runtime.remove("parent");
    assert.equal(streams.has("parent"),false);
    end();
  } finally { runtime.dispose(); }
});

test("a retained tab stops observing when host focus changes without React cleanup", async t => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: new Date("2026-11-01T00:00:00Z") });
  const composers = new Map([["first", {}], ["second", {}]]);
  const snapshots = new Map<string, AgentInfo>();
  const streams = new Map<string, (message: unknown) => void>();
  const recorded: unknown[] = [];
  let focusedId = "first";
  const runtime = createTurnSpeedRuntime({
    composers: (selector: { agentId: string } | { focused: true }) => [composers.get("agentId" in selector ? selector.agentId : focusedId)],
    paseo: { agents: { ref: (id: string) => ({
      refresh: async () => ({ agent: snapshots.get(id) }),
      timeline: { subscribe(listener: (message: unknown) => void) {
        streams.set(id, listener);
        return { ready: Promise.resolve(), release: async () => { streams.delete(id); } };
      } },
    }) } },
    rpc: async (method: { name: string }, input: unknown) => {
      if (method.name.endsWith(".record")) recorded.push(input);
      return { recorded: true, status: "ready", revision: "1", values: { calibration: {} } };
    },
  } as any);
  const event = (id: string, data: object) => streams.get(id)!({ event: data, timestamp: new Date().toISOString() });
  try {
    for (const id of composers.keys()) {
      const snapshot = { id, status: "idle" };
      snapshots.set(id, snapshot);
      runtime.upsert(snapshot);
      runtime.watch(id, () => {});
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual([...streams.keys()], ["first"]);
    event("first", { type: "turn_started", turnId: "leaving" });
    for (let chunk = 1; chunk <= 5; chunk++) {
      t.mock.timers.tick(60);
      event("first", { type: "timeline", turnId: "leaving", item: { type: "assistant_message", messageId: "m", text: "x".repeat(chunk * 40) } });
    }
    assert.ok(runtime.read("first", 5)!.summary.tokPerSecDecode! > 0);

    focusedId = "second";
    // The old effects and even its stream still exist until the next runtime poll.
    event("first", { type: "turn_completed", turnId: "leaving", usage: { outputTokens: 50 } });
    assert.deepEqual(recorded, []);
    t.mock.timers.tick(500);
    assert.deepEqual([...streams.keys()], ["second"]);
    assert.equal(runtime.read("first", 5), null);

    const running = { id: "first", status: "running", activeTurn: { turnId: "while-hidden", startedAt: new Date().toISOString() } };
    snapshots.set(running.id, running);
    runtime.upsert(running);
    focusedId = "first";
    t.mock.timers.tick(500);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual([...streams.keys()], ["first"]);
    assert.equal(runtime.read("first", 5)!.summary.partial, true);
  } finally { runtime.dispose(); }
});
