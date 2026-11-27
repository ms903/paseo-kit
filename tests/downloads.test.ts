import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import vm from "node:vm";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTransferStore } from "../plugins/file-download/server/transfers";
import { CHUNK_BYTES } from "../plugins/file-download/shared/download";

interface Preview {
  path: string;
  host?: string;
  focused?: boolean;
  visible?: boolean;
  inSheet?: boolean;
}

function renderedFile({ path, host = "host", focused = true, visible = true, inSheet = false }: Preview) {
  // RetainedPanel's mounted View has WorkspacePaneContent as its direct React child.
  const props = {
    isWorkspaceFocused: true,
    isPaneFocused: focused,
    content: { paneContextValue: { serverId: host, workspaceId: "work", target: { kind: "file", path } } },
  };
  return {
    parentElement: { __reactProps$test: { children: { props } }, parentElement: null },
    getClientRects: () => ({ length: visible ? 1 : 0 }),
    closest: () => inSheet ? {} : null,
  };
}

async function client(picker: boolean, previews: Preview[] = [], localStorage?: { getItem(key: string): string }, sheetOpen = false) {
  const events: string[] = [],
    written: Uint8Array[] = [];
  let aborted = false;
  let suggestedName: string | undefined;
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
        showSaveFilePicker: (options: { suggestedName: string }) => {
          suggestedName = options.suggestedName;
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
    localStorage,
    document: {
      querySelectorAll: (selector: string) => {
        if (selector === '[data-testid="workspace-file-pane"]') return previews.map(renderedFile);
        if (selector === '[data-testid="sheet-tab-body"]' && sheetOpen) return [{ getClientRects: () => ({ length: 1 }) }];
        return [];
      },
    },
  };
  context.exports = context.module.exports;
  vm.runInNewContext(bundle.outputFiles[0].text, context);
  return {
    api: context.module.exports as any,
    events,
    written,
    isAborted: () => aborted,
    suggestedName: () => suggestedName,
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

test("two windows showing the same workspace download their own focused previews despite a stale shared layout", async () => {
  const leftFile = String.raw`C:\reports\figure.csv`;
  const rightFile = "/exports/figure.csv";
  const raw = JSON.stringify({
    state: { layoutByWorkspace: { "host:work": {
      focusedPaneId: "p", root: { kind: "pane", pane: { id: "p", focusedTabId: "stale",
        tabs: [{ tabId: "stale", target: { kind: "file", path: rightFile } }],
      } },
    } } },
  });
  const sharedStorage = { getItem: () => raw };
  const left = await client(true, [{ path: leftFile }, { path: rightFile, focused: false }], sharedStorage);
  const right = await client(true, [{ path: leftFile, visible: false }, { path: rightFile }], sharedStorage);
  const paths: string[] = [];
  const rpc = async (contract: { name: string }, input: { path: string }) => {
    if (contract.name !== "download.open") return {};
    paths.push(input.path);
    return { transferId: "t", name: "figure.csv", size: 0 };
  };
  assert.equal(left.api.downloadFocusedFile(rpc, () => true), true);
  assert.equal(right.api.downloadFocusedFile(rpc, () => true), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(paths, [leftFile, rightFile]);
  assert.equal(left.suggestedName(), "figure.csv");
  assert.equal(right.suggestedName(), "figure.csv");
});

test("ignores ambiguous, wrong-host and background previews, and uses a focused sheet", async () => {
  const failRpc = () => { throw Error("unexpected RPC"); };
  const other = await client(true, [{ path: "wrong", host: "other" }]);
  const ambiguous = await client(true, [{ path: "a" }, { path: "b" }]);
  const sheetOverFile = await client(true, [{ path: "under.md" }], undefined, true);
  for (const page of [other, ambiguous, sheetOverFile]) {
    assert.equal(page.api.downloadFocusedFile(failRpc, () => true), false);
  }
  const fileSheet = await client(true, [{ path: "under.md" }, { path: "sheet.md", inSheet: true }], undefined, true);
  assert.equal(fileSheet.api.downloadFocusedFile(async () => ({ transferId: "t", size: 0 }), () => true), true);
  assert.equal(fileSheet.suggestedName(), "sheet.md");
});

test("waits for the shortcut host identity and retries an initially failed lookup", async () => {
  const c = await client(true);
  let attempts = 0;
  const owns = c.api.createHostCheck(async () => {
    if (++attempts === 1) throw new Error("reconnecting");
    return { serverId: "host" };
  });
  assert.equal(owns("other"), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(owns("host"), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(owns("other"), false);
  assert.equal(owns("host"), true);
});

test("an atomic save between chunks aborts the old transfer and a new download reads the updated file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "paseo-download-"));
  const target = path.join(dir, "report.bin");
  const pending = path.join(dir, "report.tmp");
  const store = createTransferStore();
  try {
    const data = Buffer.alloc(CHUNK_BYTES + 1, 65);
    await writeFile(target, data);
    const transfer = await store.open(target);
    const first = await store.read(transfer.transferId, 0);
    assert.equal(first.nextOffset, CHUNK_BYTES);
    assert.equal(first.done, false);
    data.fill(66);
    await writeFile(pending, data);
    await rename(pending, target);
    await assert.rejects(store.read(transfer.transferId, first.nextOffset), /file changed/i);
    const fresh = await store.open(target);
    assert.equal((await store.read(fresh.transferId, CHUNK_BYTES)).base64, "Qg==");
  } finally {
    store.dispose();
    await rm(dir, { recursive: true, force: true });
  }
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
