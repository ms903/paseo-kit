import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  listClosedAgents,
  restoreClosedAgent,
} from "../plugins/tab-recovery/server/agents";

test("reloads on the originating daemon, deduplicates within a workspace, and checks every other workspace", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const agent = { id: "same-agent-id", workspaceId: "work", archivedAt: "2026-01-01T00:00:00Z" };
  function daemon() {
    let reloads = 0;
    const handle = {
      refresh: async () => ({ agent }),
      reload: async () => { reloads++; await gate; return { agent: { ...agent, archivedAt: null } }; },
    };
    return { api: { agents: { ref: () => handle } } as any, reloads: () => reloads };
  }
  const first = daemon();
  const second = daemon();
  const pending = restoreClosedAgent(first.api, "work", agent.id);
  assert.equal(restoreClosedAgent(first.api, "work", agent.id), pending);
  const otherHost = restoreClosedAgent(second.api, "work", agent.id);
  const wrongWorkspace = restoreClosedAgent(first.api, "different", agent.id);
  release();
  await Promise.all([pending, otherHost, assert.rejects(wrongWorkspace, /no longer closed/)]);
  assert.equal(first.reloads(), 1);
  assert.equal(second.reloads(), 1);
});

test("a provider resume failure refreshes the list if the daemon already cleared the archive flag", async () => {
  let archivedAt: string | null = "2026-01-01T00:00:00Z";
  let reloads = 0;
  const agent = () => ({ id: "agent", workspaceId: "work", archivedAt, labels: {} });
  const api = {
    agents: {
      list: async () => ({
        entries: [
          { agent: agent() },
          { agent: { ...agent(), id: "background", background: true } },
          { agent: { ...agent(), id: "child", labels: { "paseo.parent-agent-id": "root" } } },
        ], pageInfo: { hasMore: false },
      }),
      ref: (id: string) => ({
        refresh: async () => ({ agent: { ...agent(), id, background: id === "background" } }),
        reload: async () => { reloads++; archivedAt = null; throw new Error("provider unavailable"); },
      }),
    },
  } as any;
  assert.deepEqual((await listClosedAgents(api, "work")).map(agent => agent.id), ["agent"]);
  await assert.rejects(restoreClosedAgent(api, "work", "background"), /no longer closed/);
  await assert.rejects(restoreClosedAgent(api, "work", "agent"), /provider unavailable/);
  assert.deepEqual(await listClosedAgents(api, "work"), []);
  await assert.rejects(restoreClosedAgent(api, "work", "agent"), /no longer closed/);
  assert.equal(reloads, 1);
});

test("a restore rejected after another client reopened the agent refreshes the cached list", async () => {
  const agent = { id: "agent", workspaceId: "work", archivedAt: "2026-01-01T00:00:00Z" as string | null };
  const api = { agents: {
    list: async () => ({ entries: [{ agent }], pageInfo: { hasMore: false } }),
    ref: () => ({ refresh: async () => ({ agent }), reload: () => assert.fail("Already reopened") }),
  } } as any;
  assert.equal((await listClosedAgents(api, "work")).length, 1);
  agent.archivedAt = null;
  await assert.rejects(restoreClosedAgent(api, "work", agent.id), /no longer closed/);
  assert.deepEqual(await listClosedAgents(api, "work"), []);
});

test("an unconfirmed reload can be retried after checking current state again", async () => {
  const agent = { id: "lost", workspaceId: "work", archivedAt: "2026-01-01T00:00:00Z" };
  let attempts = 0;
  let reads = 0;
  const api = { agents: { ref: () => ({
    refresh: async () => { reads++; return { agent }; },
    reload: async () => (++attempts === 1 ? null : { agent: { ...agent, archivedAt: null } }),
  }) } } as any;
  await assert.rejects(restoreClosedAgent(api, "work", "lost"), /could not confirm/);
  await restoreClosedAgent(api, "work", "lost");
  assert.equal(reads, 2);
});

test("shares paginated enumeration between workspaces and serializes duplicate restores", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-tabs-"));
  const calls = path.join(root, "calls");
  const previousPath = process.env.PATH;
  process.env.PATH = root + path.delimiter + previousPath;
  await writeFile(
    path.join(root, "paseo"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\n`,
    { mode: 0o755 },
  );
  let lists = 0,
    refreshes = 0;
  const agent = (i: number, workspaceId = "one") => ({
    id: String(i),
    title: String(i),
    workspaceId,
    archivedAt: new Date(1700000000000 + i * 1000).toISOString(),
    createdAt: new Date(0).toISOString(),
    provider: "codex",
    model: "test",
    labels: {},
  });
  const paseo = {
    agents: {
      list: async (input: any) => {
        lists += 1;
        return {
          entries: Array.from({ length: 100 }, (_, i) => ({
            agent: agent(
              (input.page.cursor ? 100 : 0) + i,
              i % 2 ? "one" : "two",
            ),
          })),
          pageInfo: input.page.cursor
            ? { hasMore: false }
            : { hasMore: true, nextCursor: "page-two" },
        };
      },
      ref: () => ({
        refresh: async () => {
          refreshes += 1;
          return { agent: agent(199) };
        },
      }),
    },
  } as any;
  try {
    const [one, two] = await Promise.all([
      listClosedAgents(paseo, "one"),
      listClosedAgents(paseo, "two"),
    ]);
    assert.equal(lists, 2);
    assert.equal(one.length, 50);
    assert.equal(two.length, 50);
    assert.equal(one[0].id, "199");
    await listClosedAgents(paseo, "one");
    assert.equal(lists, 2);
    await Promise.all([
      restoreClosedAgent(paseo, "one", "199"),
      restoreClosedAgent(paseo, "one", "199"),
    ]);
    assert.equal(refreshes, 1);
    assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 1);
    await assert.rejects(
      restoreClosedAgent(paseo, "other", "199"),
      /no longer closed/,
    );
    await listClosedAgents(paseo, "one");
    assert.equal(lists, 4);
  } finally {
    process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});
