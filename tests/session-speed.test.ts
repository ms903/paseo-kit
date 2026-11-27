import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createSessionSpeed } from "../plugins/ccusage-stats/server/session-speed";
import { readSpeedHistory, recordedTurnSpeeds } from "../plugins/ccusage-stats/server/speed-history";
import { createUsageStore } from "../plugins/ccusage-stats/server/usage-store";

type Paseo = Parameters<ReturnType<typeof createSessionSpeed>["read"]>[1];
type Row = Parameters<typeof recordedTurnSpeeds>[0];
type Timeline = Awaited<ReturnType<Parameters<typeof readSpeedHistory>[0]["timeline"]["refetch"]>>;
const AT = "2026-11-28T15:00:00.000Z";
const THREAD_ID = "019ac4b3-1a02-7a8d-a372-5164da955be4";

function row(turnId: string, provider: string, seqEnd: number, metrics: Record<string, string>): Row {
  return {
    turnId, provider, seqEnd, seqStart: seqEnd, timestamp: AT,
    item: { type: "assistant_message", text: "example" },
    sourceSeqRanges: [], collapsed: [],
    turnMetrics: Object.entries(metrics).map(([label, value]) => ({ label, value })),
  } as Row;
}

function providerApi(rows: Row[], provider = "codex", sessionId = THREAD_ID) {
  let deleted = false;
  return {
    paseo: {
      agents: {
        async list() { return { entries: deleted ? [] : [{ agent: agent() }], pageInfo: { nextCursor: null } }; },
        ref(id: string) {
          return {
            id,
            async refresh() { return !deleted && id === "agent-1" ? { agent: agent() } : null; },
            timeline: { async refetch() { return { agent: agent(), entries: rows, epoch: "epoch", hasOlder: false }; } },
          };
        },
      },
    } as unknown as Paseo,
    deleteAgent() { deleted = true; },
    switchSession(next: string, nextRows: Row[]) { sessionId = next; rows = nextRows; },
  };

  function agent() {
    return { id: "agent-1", provider, status: "closed", persistence: { provider, sessionId } };
  }
}

function sample(turnId: string, overrides?: Partial<Parameters<ReturnType<typeof createSessionSpeed>["record"]>[0]["samples"][number]>) {
  return {
    turnId, basis: "decode" as const, measuredAt: AT, tokensPerSecond: 40,
    durationMs: 2_000, outputTokens: 80, approximate: true, ...overrides,
  };
}

test("keeps native response and model windows distinct across providers", () => {
  const openCode = recordedTurnSpeeds(row("one", "opencode", 1, { Response: "~58 tok/s", "Whole turn": "~30 tok/s", TTFT: "1.2s" }), "epoch");
  assert.deepEqual(openCode.map(({ basis, tokensPerSecond, ttftMs, source }) => [basis, tokensPerSecond, ttftMs, source]), [
    ["response", 58, 1200, "provider"], ["whole-turn", 30, 1200, "provider"],
  ]);
  assert.equal(recordedTurnSpeeds(row("two", "pi", 2, { Speed: "~55 tok/s" }), "epoch")[0]?.basis, "model-time");

  const claude = recordedTurnSpeeds(row("three", "claude", 3, { Tokens: "5.1K ↑ · 160 ↓", "Model time": "2.0s" }), "epoch")[0];
  assert.equal(claude?.tokensPerSecond, 80);
  assert.equal(claude?.outputTokens, 160);
  assert.equal(claude?.approximate, true);
  assert.deepEqual(recordedTurnSpeeds(row("four", "codex", 4, { Tokens: "5K ↑ · 4.2K ↓", Elapsed: "2.0s" }), "epoch"), []);
  assert.deepEqual(recordedTurnSpeeds(row("five", "claude", 5, { Tokens: "5K ↑ · 41 ↓", "Model time": "<0.1s" }), "epoch"), []);
});

test("reads older pages in order and drops mixed epochs", async () => {
  const calls: (string | undefined)[] = [];
  let replaced = false;
  let movedSessions = false;
  const expected = { provider: "pi", sessionId: "pi-session" };
  const handle = { timeline: {
    async refetch(options: { direction?: string } = {}) {
      calls.push(options.direction);
      const agent = {
        provider: "pi", persistence: { provider: "pi", sessionId: movedSessions && options.direction === "before" ? "other" : expected.sessionId },
      };
      return (options.direction === "before" ? {
        agent,
        entries: [row("earlier", "pi", 1, { Speed: "~8 tok/s" }), row("latest", "pi", 2, { Speed: "~9 tok/s" })],
        epoch: replaced ? "new" : "epoch", hasOlder: false,
      } : {
        agent,
        entries: [row("latest", "pi", 2, { Speed: "~9 tok/s" })],
        epoch: "epoch", hasOlder: true, startCursor: { seq: 2, epoch: "epoch" },
      }) as Timeline;
    },
  } } as Parameters<typeof readSpeedHistory>[0];
  assert.deepEqual((await readSpeedHistory(handle, expected)).turns.map((turn) => turn.turnId), ["latest", "earlier"]);
  assert.deepEqual(calls, ["tail", "before"]);
  replaced = true;
  assert.deepEqual(await readSpeedHistory(handle, expected), { turns: [], hasOlder: true });
  replaced = false;
  movedSessions = true;
  assert.deepEqual(await readSpeedHistory(handle, expected), { turns: [], hasOlder: false });
});

test("records verified completed Codex turns once across windows and restores by indexed session ID", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-speed-history-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const rows = [row("turn-1", "codex", 1, {})];
  const { paseo, deleteAgent } = providerApi(rows);
  let now = Date.parse(AT);
  const create = () => createSessionSpeed({ now: () => now, store: createUsageStore("UTC", directory) });
  const speed = create();
  const send = (item = sample("turn-1")) => speed.record({ agentId: "agent-1", samples: [item] });
  assert.equal(await send(), false);
  await speed.complete(paseo, "agent-1", "turn-1");
  assert.equal(await speed.record({ agentId: "other", samples: [sample("turn-1")] }), false);
  assert.equal(await speed.record({ agentId: "agent-1", samples: [sample("turn-1"), sample("wrong-turn")] }), false);
  assert.deepEqual(await Promise.all([send(), send()]), [true, true]);
  assert.equal(await send(sample("turn-1", { approximate: false })), true);

  now += 4_000;
  rows.push(row("turn-2", "codex", 2, {}));
  await speed.complete(paseo, "agent-1", "turn-2");
  assert.equal(await send(sample("turn-2", { basis: "whole-turn", tokensPerSecond: 70, outputTokens: 140 })), true);
  assert.equal((await speed.read({ agentId: "agent-1" }, paseo)).turns.length, 2);
  await speed.stop();

  deleteAgent();
  const restarted = create();
  const inventory = Promise.withResolvers<Awaited<ReturnType<Paseo["agents"]["list"]>>>();
  const slowHost = { agents: { ...paseo.agents, list: () => inventory.promise } } as unknown as Paseo;
  const result = await restarted.read({ sessionId: `2026/11/28/rollout-2026-11-28T15-00-00-${THREAD_ID}`, provider: "codex" }, slowHost);
  inventory.reject(new Error("Host directory unavailable"));
  assert.equal(result.status, "ready");
  assert.deepEqual(result.turns.map(({ turnId, source, approximate }) => [turnId, source, approximate]), [
    ["turn-2", "observed", true], ["turn-1", "observed", false],
  ]);
  assert.equal((await restarted.read({ sessionId: THREAD_ID, provider: "claude" }, paseo)).status, "unavailable");
  assert.equal((await restarted.read({ sessionId: `unrelated-${THREAD_ID}`, provider: "codex" }, paseo)).status, "unavailable");
});

test("keeps cached and recorded metrics apart when one agent changes provider session", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-speed-session-switch-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const { paseo, switchSession } = providerApi([row("old", "opencode", 1, { Response: "~11 tok/s" })], "opencode", "foo");
  const speed = createSessionSpeed({ store: createUsageStore("UTC", directory) });
  assert.equal((await speed.read({ sessionId: "project-foo", provider: "opencode" }, paseo)).status, "unavailable");
  assert.deepEqual((await speed.read({ sessionId: "foo", provider: "opencode" }, paseo)).turns.map(({ turnId }) => turnId), ["old"]);
  await speed.complete(paseo, "agent-1", "old");

  switchSession("project-foo", [row("new", "opencode", 2, { Response: "~35 tok/s" })]);
  assert.deepEqual((await speed.read({ agentId: "agent-1" }, paseo)).turns.map(({ turnId }) => turnId), ["new"]);
  assert.deepEqual((await speed.read({ sessionId: "foo", provider: "opencode" }, paseo)).turns.map(({ turnId }) => turnId), ["old"]);
  await speed.stop();
});

test("turning speed off during a history read discards the result before it can be saved", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-speed-interrupted-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const api = providerApi([row("one", "pi", 1, { Speed: "~58 tok/s" })], "pi", "session-1");
  const agent = api.paseo.agents.ref("agent-1");
  const original = agent.timeline.refetch;
  const started = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  agent.timeline.refetch = async (options) => {
    started.resolve();
    await resume.promise;
    return original(options);
  };
  const paseo = { agents: { ...api.paseo.agents, ref: () => agent } } as Paseo;
  const makeSpeed = () => createSessionSpeed({ store: createUsageStore("UTC", directory) });
  const speed = makeSpeed();
  const pending = speed.read({ agentId: "agent-1" }, paseo);
  await started.promise;
  speed.clear();
  resume.resolve();
  assert.equal((await pending).status, "unavailable");
  await speed.stop();

  api.deleteAgent();
  assert.equal((await makeSpeed().read({ provider: "pi", sessionId: "session-1" }, api.paseo)).status, "unavailable");
});

test("persists native metrics only for the completed hook's turn", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-native-speed-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const { paseo, deleteAgent } = providerApi([row("newer", "opencode", 1, { "Whole turn": "~60 tok/s" })], "opencode", "session-1");
  const speed = createSessionSpeed({ store: createUsageStore("UTC", directory) });
  await speed.complete(paseo, "agent-1", "older");
  await speed.complete(paseo, "agent-1", "newer");
  assert.equal(await speed.record({ agentId: "agent-1", samples: [sample("newer", { basis: "whole-turn" })] }), true);
  deleteAgent();
  const result = await speed.read({ sessionId: "session-1", provider: "opencode" }, paseo);
  assert.deepEqual(result.turns.map(({ turnId, tokensPerSecond, source }) => [turnId, tokensPerSecond, source]), [["newer", 60, "provider"]]);
});
