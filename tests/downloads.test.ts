import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import vm from "node:vm";

async function client(picker: boolean) {
  const events: string[] = [],
    written: Uint8Array[] = [];
  let aborted = false;
  const writable = {
    write: async (bytes: Uint8Array) => written.push(bytes),
    close: async () => {
      events.push("saved");
    },
    abort: async () => {
      aborted = true;
    },
  };
  const testWindow = picker
    ? {
        showSaveFilePicker: () => {
          events.push("picker");
          return Promise.resolve({ createWritable: async () => writable });
        },
      }
    : {};
  const bundle = await build({
    entryPoints: ["plugins/file-download/client/downloads.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    plugins: [
      {
        name: "host-api",
        setup(build) {
          build.onResolve(
            { filter: /^(react-native|react|@getpaseo\/plugin)$/ },
            (args) => ({ path: args.path, namespace: "stub" }),
          );
          build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
            contents:
              args.path === "react-native"
                ? 'export const Platform={OS:"web"}'
                : args.path === "react"
                  ? "export function useSyncExternalStore(subscribe,get){return get()}"
                  : "export function defineRpc(value){return value}",
            loader: "js",
          }));
        },
      },
    ],
  });
  const context = {
    module: { exports: {} },
    exports: {},
    window: testWindow,
    navigator: { platform: "Linux" },
    console,
    setTimeout,
    clearTimeout,
    Uint8Array,
    atob,
    Blob,
    URL,
    location: { pathname: "/h/host/workspace/work" },
    localStorage: {
      getItem: () =>
        JSON.stringify({
          state: {
            layoutByWorkspace: {
              "host:work": {
                root: {
                  kind: "pane",
                  pane: {
                    id: "p",
                    focusedTabId: "agent",
                    tabs: [{ tabId: "agent", target: { kind: "agent" } }],
                  },
                },
                focusedPaneId: "p",
              },
            },
          },
        }),
    },
  };
  context.exports = context.module.exports;
  vm.runInNewContext(bundle.outputFiles[0].text, context);
  return {
    api: context.module.exports as any,
    events,
    written,
    isAborted: () => aborted,
  };
}

test("streams chunks to disk, invokes picker during the gesture and releases server transfer", async () => {
  const c = await client(true);
  const calls: string[] = [];
  const rpc = async (rpc: any) => {
    calls.push(rpc.name);
    c.events.push(rpc.name);
    if (rpc.name === "download.open")
      return { transferId: "t", name: "x", size: 3 };
    if (rpc.name === "download.read")
      return { base64: "YWJj", nextOffset: 3, done: true };
    return {};
  };
  await c.api.downloadFile(rpc, "w", "/x");
  assert.equal(c.events[0], "picker");
  assert.equal(Buffer.from(c.written[0]).toString(), "abc");
  assert.equal(c.api.useDownloadRecords()[0].status, "done");
  assert.equal(calls.at(-1), "download.close");
});

test("rejects large memory fallback before reading file data and leaves agent-tab save shortcuts alone", async () => {
  const c = await client(false);
  let reads = 0;
  await c.api.downloadFile(
    async (rpc: any) => {
      if (rpc.name === "download.open")
        return { transferId: "t", name: "huge", size: 65 * 1024 ** 2 };
      if (rpc.name === "download.read") reads++;
      return {};
    },
    "w",
    "/huge",
  );
  assert.equal(reads, 0);
  assert.equal(c.api.useDownloadRecords()[0].status, "failed");
  assert.equal(
    c.api.downloadFocusedFile(
      () => {
        throw Error("unexpected RPC");
      },
      () => true,
    ),
    false,
  );
});

test("canceling an in-flight download aborts the file sink and closes the server handle", async () => {
  const c = await client(true);
  let release: (value: unknown) => void = () => {};
  let reading = false,
    closed = false;
  const pending = c.api.downloadFile(
    async (rpc: any) => {
      if (rpc.name === "download.open")
        return { transferId: "t", name: "x", size: 3 };
      if (rpc.name === "download.read") {
        reading = true;
        return new Promise((resolve) => {
          release = resolve;
        });
      }
      if (rpc.name === "download.close") closed = true;
      return {};
    },
    "w",
    "/x",
  );
  while (!reading) await new Promise((resolve) => setImmediate(resolve));
  c.api.cancelDownload(c.api.useDownloadRecords()[0].id);
  release({ base64: "YWJj", nextOffset: 3, done: true });
  await pending;
  assert.equal(c.api.useDownloadRecords()[0].status, "canceled");
  assert.equal(c.written.length, 0);
  assert.equal(c.isAborted(), true);
  assert.equal(closed, true);
});
