import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { watchSaveShortcut } from "../plugins/file-download/client/shortcut-settings";
import { downloadSettings } from "../plugins/file-download/shared/settings";
import { historySettings } from "../plugins/tab-recovery/shared/settings";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("registers the shortcut only for an enabled host preference, rejects stale reads and cleans up", async () => {
  const requests: Array<(result: unknown) => void> = [];
  let listener!: { snapshot(): void; update(value: unknown): void };
  let starts = 0, stops = 0, releases = 0;
  const stop = watchSaveShortcut({
    rpc: () => new Promise(resolve => requests.push(resolve as (value: unknown) => void)),
    paseo: { observeEvents: () => ({
      subscribe(observer: typeof listener) { listener = observer; return () => {}; },
      release: async () => { releases++; },
    }) },
  } as any, () => { starts++; return () => { stops++; }; });
  const ready = (i: number, saveShortcut: boolean) => requests[i]({ status: "ready", values: { saveShortcut } });
  const changed = () => listener.update({ type: "status", payload: { status: "plugin_settings_changed", settingsId: "downloads" } });
  assert.deepEqual(downloadSettings.schema.parse({}), { saveShortcut: true });
  changed(); ready(1, false); ready(0, true); await flush();
  assert.equal(starts, 0);
  changed(); ready(2, true); await flush();
  listener.snapshot(); ready(3, true); await flush();
  assert.equal(starts, 1);
  changed(); ready(4, false); await flush();
  assert.equal(stops, 1);
  changed(); stop(); ready(5, true); await flush();
  assert.equal(starts, 1);
  assert.equal(releases, 1);
});

test("partial legacy clients pick up shortcut changes using RPC and stop polling on unload", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let saveShortcut = true, reads = 0, active = 0;
  const stop = watchSaveShortcut({
    rpc: async () => { reads++; return { status: "ready", values: { saveShortcut } }; },
  } as any, () => { active++; return () => { active--; }; });
  await flush();
  assert.equal(active, 1);
  saveShortcut = false; t.mock.timers.tick(5_000); await flush();
  assert.equal(active, 0);
  stop(); t.mock.timers.tick(5_000); await flush();
  assert.equal(reads, 2);
});

test("the closed panel immediately shows its selected number of newest entries", async () => {
  let limit = "50";
  assert.equal(historySettings.schema.parse({}).limit, limit);
  const rows = Array.from({ length: 50 }, (_, id) => ({ id: String(id) }));
  const bundle = await build({
    entryPoints: ["plugins/tab-recovery/client/closed-panel.tsx"], bundle: true, write: false,
    platform: "node", format: "cjs", external: ["@getpaseo/plugin", "@getpaseo/plugin/*", "@tanstack/react-query", "react", "react/*", "react-native"],
  });
  const jsx = (type: unknown, props: any) => ({ type, props });
  const modules: Record<string, unknown> = {
    "@getpaseo/plugin": { defineRpc: (c: unknown) => c, defineSettings: (s: unknown) => s },
    "@getpaseo/plugin/client": { useSettings: () => ({ status: "ready", values: { limit } }), useRpc: () => () => {} },
    "@getpaseo/plugin/client/react-native": { useToast: () => ({}), FlatList: "FlatList" },
    "@tanstack/react-query": { useQuery: () => ({ data: { agents: rows } }) },
    react: { useState: () => [null, () => {}] }, "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { View: "View", Text: "Text" },
  };
  const context = { module: { exports: {} as any }, require: (name: string) => modules[name] };
  runInNewContext(bundle.outputFiles[0].text, context);
  for (limit of ["50", "10", "25", "50"]) {
    const outer = context.module.exports.ClosedAgentsPanel({ theme: { colors: {} }, host: { id: "h" }, layout: {}, workspaceId: "work" });
    const content = outer.type(outer.props);
    const list = content.props.children.find((entry: any) => entry?.type === "FlatList");
    assert.deepEqual(list.props.data, rows.slice(0, Number(limit)));
  }
});
