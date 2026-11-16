import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  listClosedAgents,
  restoreClosedAgent,
} from "../plugins/tab-recovery/server/agents";

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
