import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { registerArtifacts } from "../plugins/antigravity-artifacts/index.server";

test("artifact RPCs list only the current Antigravity session and verified child files on Linux", { skip: process.platform !== "linux" }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-artifacts-test-"));
  t.after(async () => rm(root, { force: true, recursive: true }));
  const brain = path.join(root, "brain");
  const ids = [0, 1, 2, 3].map((n) => `cc68c2da-8dda-47b2-8c6b-07d543415ba${n}`);
  const [current, child, neighbor, otherWorkspace] = ids;
  await Promise.all(ids.map((id) => mkdir(path.join(brain, id, "reports"), { recursive: true })));
  await Promise.all(ids.map((id) => writeFile(path.join(brain, id, "reports", "result.md"), `Report for ${id}`)));
  await writeFile(path.join(brain, current, "notes.txt"), "x".repeat(128 * 1024 - 1) + "汉字");
  await writeFile(path.join(brain, current, "plot.png"), Buffer.alloc(2 * 1024 * 1024 + 1));
  await writeFile(path.join(brain, current, "report.metadata.json"), "{}");
  await symlink(path.join(brain, neighbor, "reports", "result.md"), path.join(brain, current, "linked.md"));
  await symlink(path.join(brain, neighbor, "reports"), path.join(brain, current, "linked-reports"));
  await link(path.join(brain, otherWorkspace, "reports", "result.md"), path.join(brain, current, "hardlinked.md"));
  const agent = (id: string, conversationId: string, workspaceId: string, parent?: string) => ({
    id, provider: "antigravity", workspaceId, title: id,
    persistence: { provider: "antigravity", metadata: { pluginProviderPersistence: { version: 1, data: {
      sessionId: "not-a-conversation", conversationId,
    } } } },
    labels: parent ? { "paseo.parent-agent-id": parent } : {},
  });
  const agents = {
    main: agent("main", current, "workspace"),
    child: agent("child", child, "workspace", "main"),
    neighbor: agent("neighbor", neighbor, "workspace"),
    other: agent("other", otherWorkspace, "elsewhere", "main"),
  };
  const paseo = {
    agents: {
      ref: (id: keyof typeof agents) => ({ refresh: async () => ({ agent: agents[id] }) }),
      list: async () => ({ entries: Object.values(agents).map((agent) => ({ agent })), pageInfo: { hasMore: false } }),
    },
  } as unknown as PluginHandlerContext["paseo"];

  const handlers = new Map<string, (input: unknown, context: PluginHandlerContext) => Promise<unknown>>();
  const server = {
    handle: (contract: { name: string }, callback: (input: unknown, context: PluginHandlerContext) => Promise<unknown>) => handlers.set(contract.name, callback),
  } as unknown as PluginServerContext;
  registerArtifacts(server, brain);
  const scope = { agentId: "main", workspaceId: "workspace" };
  const list = (scope: { agentId: string; workspaceId: string }) => handlers.get("artifacts.list")!(scope, { paseo });
  const read = (ownerAgentId: string, conversationId: string, relative: string) => handlers.get("artifacts.read")!({
    ...scope, rootConversationId: current, artifact: { ownerAgentId, conversationId, path: relative },
  }, { paseo });
  const listing = await list(scope) as { status: string; items: { ownerAgentId: string; path: string }[] };
  assert.equal(listing.status, "ready");
  assert.deepEqual(listing.items.map(({ ownerAgentId, path }) => `${ownerAgentId}/${path}`).sort(), [
    "child/reports/result.md", "main/notes.txt", "main/plot.png", "main/reports/result.md",
  ]);
  assert.deepEqual(await list({ ...scope, workspaceId: "elsewhere" }), { status: "unavailable" });
  const preview = await read("child", child, "reports/result.md");
  assert.deepEqual(preview, { kind: "text", truncated: false, absolutePath: path.join(brain, child, "reports", "result.md"), text: `Report for ${child}` });
  assert.deepEqual(await read("main", current, "plot.png"), { kind: "tooLarge", absolutePath: path.join(brain, current, "plot.png") });
  const text = await read("main", current, "notes.txt") as { text: string; truncated: boolean };
  assert.equal(text.truncated, true);
  assert.equal(text.text, "x".repeat(128 * 1024 - 1));
  for (const relative of ["linked.md", "hardlinked.md", "linked-reports/result.md", "../result.md", "report.metadata.json"]) {
    await assert.rejects(read("main", current, relative), /Artifact is unavailable/);
  }
  await assert.rejects(read("neighbor", neighbor, "reports/result.md"), /outside/);
  await assert.rejects(read("other", otherWorkspace, "reports/result.md"), /outside/);
  assert.ok(agents.child.labels);
  agents.child.labels["paseo.parent-agent-id"] = "neighbor";
  await assert.rejects(read("child", child, "reports/result.md"), /outside/);
});
