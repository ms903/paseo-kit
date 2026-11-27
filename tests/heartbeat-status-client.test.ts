import assert from "node:assert/strict";
import { test } from "node:test";
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
