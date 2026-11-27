import assert from "node:assert/strict";
import { test } from "node:test";
import { createHeartbeatSummaryReader } from "../plugins/heartbeat-status/server/summary";

type Paseo = Parameters<ReturnType<typeof createHeartbeatSummaryReader>>[0];

function agent(id: string, options: { parent?: string; host?: string; work?: number; activeWork?: boolean; archived?: boolean } = {}) {
  return {
    id,
    workspaceId: "workspace",
    title: id,
    status: "closed",
    archivedAt: options.archived ? "2026-11-28" : null,
    backgroundWork: options.work ? { count: options.work, ...(options.activeWork ? {} : { runningCount: 0 }) } : undefined,
    labels: {
      ...(options.parent ? { "paseo.parent-agent-id": options.parent } : {}),
      ...(options.host ? { "paseo.parent-server-id": options.host } : {}),
    },
  };
}

function heartbeat(id: string) {
  return { id: `heartbeat:${id}`, kind: "heartbeat" };
}

function fixture(pages: ReturnType<typeof agent>[][]) {
  const items = new Map<string, { id: string; kind: string }[] | Error>();
  const listed: string[] = [];
  const fetched: Array<string | undefined> = [];
  let listError: Error | undefined;
  const paseo = {
    agents: {
      async list(options: { includeBackground: boolean; page: { cursor?: string; limit: number } }) {
        assert.equal(options.includeBackground, true);
        assert.equal(options.page.limit, 200);
        const cursor = options.page.cursor;
        fetched.push(cursor);
        if (listError) throw listError;
        const index = Number(cursor ?? 0);
        return {
          entries: pages[index]!.map((row) => ({ agent: row })),
          pageInfo: { nextCursor: index + 1 < pages.length ? String(index + 1) : null },
        };
      },
      ref(id: string) {
        return {
          address: { agentId: id, serverId: "local" },
          backgroundWork: {
            async list() {
              listed.push(id);
              const result = items.get(id);
              if (result instanceof Error) throw result;
              return result ?? [];
            },
          },
        };
      },
    },
  } as unknown as Paseo;
  return { paseo, items, listed, fetched, failListing(error: Error) { listError = error; } };
}

function counts(rows: Awaited<ReturnType<ReturnType<typeof createHeartbeatSummaryReader>>>) {
  return rows.map(({ agentId, direct, descendants }) => [agentId, direct, descendants]);
}

test("reads unloaded descendants across pages and counts only native heartbeat entries", async () => {
  const root = agent("root", { work: 2 });
  const child = agent("child", { parent: "root", host: "local" });
  const grandchild = agent("grandchild", { parent: "child", work: 4 });
  const foreign = agent("foreign", { parent: "root", host: "remote", work: 1 });
  const archived = agent("archived", { parent: "root", work: 1, archived: true });
  const shell = agent("shell", { parent: "root", work: 1, activeWork: true });
  const host = fixture([[root, child], [grandchild, archived, foreign, child, shell]]);
  host.items.set("root", [heartbeat("one"), heartbeat("one")]);
  host.items.set("grandchild", [
    heartbeat("two"), heartbeat("three"),
    { id: "provider:heartbeat:other", kind: "heartbeat" },
    { id: "heartbeat:not-a-heartbeat", kind: "monitor" },
  ]);
  host.items.set("foreign", [heartbeat("four")]);
  host.items.set("archived", [heartbeat("five")]);

  const read = createHeartbeatSummaryReader();
  assert.deepEqual(counts(await read(host.paseo, [])), [
    ["root", 1, 2], ["child", 0, 2], ["grandchild", 2, 0], ["foreign", 1, 0],
  ]);
  assert.deepEqual(counts(await read(host.paseo, ["missing", "root", "root", "archived"])), [
    ["missing", 0, 0], ["root", 1, 2], ["archived", 0, 0],
  ]);
  assert.deepEqual(host.fetched, [undefined, "1"]);
  assert.deepEqual(host.listed, ["root", "grandchild", "foreign"]);
});

test("discards duplicate ownership and stops propagation through parent cycles", async () => {
  const host = fixture([[
    agent("first", { parent: "second", work: 2 }),
    agent("second", { parent: "first", work: 2 }),
    agent("leaf", { parent: "first", work: 1 }),
    agent("self", { parent: "self", work: 1 }),
  ]]);
  host.items.set("first", [heartbeat("first"), heartbeat("ambiguous")]);
  host.items.set("second", [heartbeat("second"), heartbeat("ambiguous")]);
  host.items.set("leaf", [heartbeat("leaf")]);
  host.items.set("self", [heartbeat("self")]);
  const read = createHeartbeatSummaryReader();
  assert.deepEqual(counts(await read(host.paseo, [])), [
    ["first", 1, 1], ["second", 1, 0], ["leaf", 1, 0], ["self", 1, 0],
  ]);
});

test("coalesces requests and clears heartbeat counts after a failed inventory read", async () => {
  const host = fixture([[agent("root", { work: 1 })]]);
  host.items.set("root", [heartbeat("one")]);
  let now = 0;
  const read = createHeartbeatSummaryReader(() => now);
  const [one, all] = await Promise.all([read(host.paseo, ["root"]), read(host.paseo, [])]);
  assert.deepEqual(one, all);
  assert.deepEqual(counts(one), [["root", 1, 0]]);
  assert.equal(host.fetched.length, 1);

  now = 2_001;
  host.items.set("root", new Error("Background work inventory is unavailable"));
  assert.deepEqual(await read(host.paseo, []), []);
  assert.equal(host.fetched.length, 2);

  now = 4_002;
  host.failListing(new Error("Could not list agents"));
  await assert.rejects(() => read(host.paseo, []), /Could not list agents/);
});
