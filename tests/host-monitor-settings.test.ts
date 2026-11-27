import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { build } from "esbuild";
import contributeServer from "../plugins/host-monitor/index.server";
import { defaults, settingsDefinition } from "../plugins/host-monitor/shared/settings";

test("host monitor settings register on both sides and control footer polling, layout and save revisions", async () => {
  let registered: unknown;
  const stop = contributeServer({ registerSettings: (definition: unknown) => { registered = definition; }, handle() {} } as any);
  try {
    assert.equal(registered, settingsDefinition);
    assert.deepEqual(defaults, { cpu: true, memory: true, gpu: true, disk: true, network: true, refreshSeconds: "2" });
    assert.deepEqual(settingsDefinition.schema.parse({ gpu: false }), { ...defaults, gpu: false });
  } finally { stop(); }

  const result = await build({
    entryPoints: ["plugins/host-monitor/index.client.tsx"], bundle: true, write: false, platform: "browser", format: "iife", globalName: "plugin",
    external: ["react", "react-native", "@getpaseo/plugin/client", "@tanstack/react-query"],
  });
  const components: Record<string, any> = {};
  const values = { ...defaults };
  const saved: Array<[typeof values, string]> = [];
  const queries: any[] = [];
  const settings = {
    status: "ready", values, revision: "existing", saving: false, saveError: null,
    save: async (next: typeof values, revision: string) => { saved.push([{ ...next }, revision]); return true; },
  };
  const create = (type: any, props: any) => ({ type, props });
  const modules: Record<string, object> = {
    "react": { useState: (initial: unknown) => [initial, () => {}], useCallback: (fn: unknown) => fn },
    "react/jsx-runtime": { jsx: create, jsxs: create },
    "react-native": { Text: "Text", View: "View", Pressable: "Pressable" },
    "@getpaseo/plugin/client": { useSettings: () => settings, useRpc: () => () => {} },
    "@getpaseo/plugin/client/ui": { SettingsCard: "Card", SettingsSection: "Section", SettingsSwitch: "Switch", SettingsSelect: "Select" },
    "@getpaseo/plugin/client/react-native": { Icon: "Icon" },
    "@tanstack/react-query": { useQuery: (options: any) => {
      queries.push(options);
      const stats = { current: { cpuPercent: 42 }, memory: { usedBytes: 10, totalBytes: 20 }, disks: [], network: null };
      return { data: options.queryKey[0] === "host-gpus" ? [] : stats };
    } },
  };
  const page = vm.createContext({ require: (id: string) => { assert.ok(modules[id], id); return modules[id]; } });
  vm.runInContext(result.outputFiles[0].text, page);
  const register = ({ id, Component }: any) => { components[id] = Component; };
  page.plugin.default({ addSettingsScreen: register, addSidebarFooterItem: register, addScreen: register });
  const surface = { theme: { colors: {} }, host: { id: "host-a", label: "A" } };
  function descendants(node: any): any[] {
    if (Array.isArray(node)) return node.flatMap(descendants);
    return node?.props ? [node, ...descendants(node.props.children)] : [];
  }
  const controls = descendants(components.settings(surface));
  const gpu = controls.find(node => node.props.label === "GPU");
  gpu.props.onValueChange(false);
  controls.find(node => node.type === "Select").props.onValueChange("10");
  assert.deepEqual(saved, [[{ ...defaults, gpu: false }, "existing"], [{ ...defaults, refreshSeconds: "10" }, "existing"]]);
  Object.assign(values, { gpu: false, disk: false, network: false, cpu: false, refreshSeconds: "10" });
  const footer = components["host-status"](surface);
  assert.match(footer.props.accessibilityLabel, /memory 50%/);
  assert.doesNotMatch(footer.props.accessibilityLabel, /CPU/);
  const layout = descendants(footer).find(node => node.props.layout).props.layout;
  assert.equal(layout.shown.map((metric: any) => metric.key).join(","), "memory");
  assert.equal(queries[0].refetchInterval, 10_000);
  assert.equal(queries[1].enabled, false);
  values.memory = false;
  queries.length = 0;
  assert.equal(components["host-status"](surface), null);
  assert.ok(queries.every(query => query.enabled === false));
});
