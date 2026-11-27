import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { labelKey, REFRESH_MS, watchHeartbeats } from "../plugins/heartbeat-status/client/monitor";
import type { HeartbeatSummary } from "../plugins/heartbeat-status/shared/heartbeat";

const child: HeartbeatSummary = {
  agentId: "child", workspaceId: "work", title: "Tests", status: "idle", direct: 1, descendants: 0,
};
const parent: HeartbeatSummary = {
  ...child, agentId: "parent", title: "Release", status: "running", direct: 0, descendants: 1,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("one poll per host shows enabled schedules independently of status and clears them on disconnect", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const first = deferred<{ agents: HeartbeatSummary[] }>();
  const results: (readonly HeartbeatSummary[])[] = [];
  let reads = 0;
  const stop = watchHeartbeats(async () => {
    reads++;
    if (reads === 1) return first.promise;
    if (reads === 2) return { agents: [child, parent] };
    throw new Error("Disconnected");
  }, (rows) => results.push(rows));
  try {
    t.mock.timers.tick(REFRESH_MS);
    assert.equal(reads, 1);
    first.resolve({ agents: [parent, child, { ...child, agentId: "unscheduled", direct: 0 }] });
    await first.promise;
    await new Promise<void>((done) => setImmediate(done));
    assert.deepEqual(results, [[child, parent]]);
    assert.equal(labelKey(parent), "children");
    assert.equal(labelKey(child), "direct");
    assert.equal(labelKey({ ...parent, direct: 2 }), "both");

    t.mock.timers.tick(REFRESH_MS);
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(results.length, 1, "equivalent successful snapshots do not redraw the client");
    t.mock.timers.tick(REFRESH_MS);
    await new Promise<void>((done) => setImmediate(done));
    assert.deepEqual(results, [[child, parent], []]);
  } finally {
    stop();
  }
  t.mock.timers.tick(REFRESH_MS);
  assert.equal(reads, 3);
});

test("a poll that settles after plugin removal never republishes its indicators", async () => {
  const response = deferred<{ agents: HeartbeatSummary[] }>();
  const stop = watchHeartbeats(() => response.promise, () => assert.fail("Published after cleanup"));
  stop();
  response.resolve({ agents: [parent, child] });
  await new Promise<void>((done) => setImmediate(done));
});

test("native fallback scopes composer pills to their agent and workspace and removes an expired heartbeat", async () => {
  const bundle = await build({
    entryPoints: ["plugins/heartbeat-status/index.client.tsx"],
    bundle: true, format: "cjs", platform: "node", write: false,
    external: ["@getpaseo/plugin", "@getpaseo/plugin/*", "react", "react/*", "react-native"],
  });
  const modules: Record<string, unknown> = {
    "@getpaseo/plugin": { defineRpc: (contract: unknown) => contract },
    "@getpaseo/plugin/client": {
      defineTranslations: () => ({ message: (key: string) => key }),
      useTranslation: () => ({ t: (key: string) => key }),
    },
    "@getpaseo/plugin/client/react-native": { WorkspaceRowBadge: "WorkspaceRowBadge" },
    "react": {
      useSyncExternalStore: (_subscribe: unknown, snapshot: () => number) => snapshot(),
      useEffect: (setup: () => void) => setup(),
    },
    "react/jsx-runtime": { jsx: (type: string, props: unknown) => ({ type, props }) },
    "react-native": { Platform: { OS: "ios" } },
  };
  let tick!: () => void;
  const exports = { exports: {} as { default?: (client: unknown) => () => void } };
  runInNewContext(bundle.outputFiles[0].text, {
    module: exports, exports: exports.exports, require: (name: string) => modules[name],
    setInterval: (refresh: () => void) => { tick = refresh; }, clearInterval() {},
  });
  let agents = [child, parent];
  const pills = new Map<string, { label: string }>();
  let badge!: (props: unknown) => { props: { label: string } } | null;
  let badgeRemoved = false;
  const stop = exports.exports.default!({
    rpc: async () => ({ agents }),
    paseo: { agents: { ref: () => ({ address: { serverId: "host" } }) } },
    addWorkspaceRowBadgeItem(item: { Component: typeof badge }) {
      badge = item.Component;
      return () => { badgeRemoved = true; };
    },
    addComposerPill(item: { workspaceId: string; agentId: string; button: { label: string } }) {
      const key = item.workspaceId + "/" + item.agentId;
      assert.equal(pills.has(key), false);
      pills.set(key, item.button);
      return {
        remove: () => pills.delete(key),
        update(patch: { label: string }) { Object.assign(pills.get(key)!, patch); },
      };
    },
  });
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(pills.get("work/child")?.label, "direct");
  assert.equal(pills.get("work/parent")?.label, "children");
  const renderBadge = (workspaceId: string) => badge({ workspaceId, host: { id: "host" } });
  assert.equal(renderBadge("work")?.props.label, "Tests, Release");
  assert.equal(renderBadge("other-workspace"), null);

  agents = [{ ...parent, direct: 1, workspaceId: "moved" }];
  tick();
  await new Promise<void>((done) => setImmediate(done));
  assert.deepEqual([...pills.keys()], ["moved/parent"]);
  assert.equal(pills.get("moved/parent")?.label, "both");
  assert.equal(renderBadge("work"), null);
  assert.equal(renderBadge("moved")?.props.label, "Release");
  stop();
  assert.equal(pills.size, 0);
  assert.equal(badgeRemoved, true);
});
