import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { scanMedia, publishUnique } from "../plugins/media-studio/server/files";
import { localHost } from "../plugins/media-studio/server/hosts";
import { REMOTE_SCAN } from "../plugins/media-studio/server/remote-scan";
import { createLimiter } from "../plugins/media-studio/server/ffmpeg";
const run = promisify(execFile);
const temp = () => mkdtemp(path.join(os.tmpdir(), "paseo-media-"));

test("exclusive publication preserves existing files with concurrent writers and a symlink target", async () => {
  const root = await temp();
  try {
    const original = path.join(root, "render.png");
    await writeFile(original, "original");
    const target = path.join(root, "render (2).png");
    await symlink(original, target);
    const results = await Promise.all(
      Array.from({ length: 12 }, async (_, i) => {
        const part = path.join(root, `.part-${i}`);
        await localHost.createEmpty(part);
        await localHost.writeAt(part, 0, Buffer.from(String(i)));
        const file = await publishUnique(localHost, part, root, "render.png");
        assert.equal(await readFile(file, "utf8"), String(i));
        return file;
      }),
    );
    assert.equal(new Set(results).size, 12);
    assert.equal(await readFile(original, "utf8"), "original");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local and remote scanners enforce entry budgets and avoid source code and linked directory loops", async () => {
  const root = await temp();
  try {
    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        writeFile(path.join(root, `${i}.png`), "image"),
      ),
    );
    await writeFile(path.join(root, "source.ts"), "const x = 1;");
    await symlink(root, path.join(root, "loop"));
    const result = await scanMedia(root, { maxEntries: 7, budgetMs: 1000 });
    assert.ok(result.files.length <= 7);
    assert.equal(result.truncated, true);
    assert.equal((await scanMedia(root, { budgetMs: 0 })).files.length, 0);
    const remote = JSON.parse(
      (
        await run("python3", [
          "-c",
          REMOTE_SCAN,
          root,
          JSON.stringify(["png", "ts"]),
          "scan",
        ])
      ).stdout,
    );
    assert.equal(remote.files.length, 100);
    assert.equal(remote.truncated, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("limiter reserves handed-off slots during bursts", async () => {
  const limited = createLimiter(2);
  let active = 0,
    max = 0;
  await Promise.all(
    Array.from({ length: 100 }, () =>
      limited(async () => {
        active += 1;
        max = Math.max(max, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
      }),
    ),
  );
  assert.equal(max, 2);
});

test("uploads separate identical metadata, survive restart, verify fingerprint and finish idempotently", async () => {
  const root = await temp();
  process.env.XDG_CACHE_HOME = path.join(root, "cache");
  const { createTransfers } =
    await import("../plugins/media-studio/server/transfer");
  let transfers = createTransfers();
  try {
    const dir = { host: localHost, path: root, ref: root };
    const data = {
      name: "render.png",
      size: 3,
      lastModified: 42,
      fingerprint: "sha256-tree-v1:" + "a".repeat(64),
    };
    const [a, b] = await Promise.all([
      transfers.begin(dir, data),
      transfers.begin(dir, data),
    ]);
    assert.notEqual(a.uploadId, b.uploadId);
    await Promise.all([
      transfers.write({
        uploadId: a.uploadId,
        offset: 0,
        base64: Buffer.from("aaa").toString("base64"),
      }),
      transfers.write({
        uploadId: b.uploadId,
        offset: 0,
        base64: Buffer.from("bbb").toString("base64"),
      }),
    ]);
    await assert.rejects(
      transfers.begin(dir, {
        ...data,
        uploadId: a.uploadId,
        fingerprint: "different",
      }),
      /does not match/,
    );
    await transfers.dispose();
    transfers = createTransfers();
    const resumed = await transfers.begin(dir, {
      ...data,
      uploadId: a.uploadId,
    });
    assert.equal(resumed.receivedBytes, 3);
    const [first, second] = await Promise.all([
      transfers.finish({ uploadId: a.uploadId }),
      transfers.finish({ uploadId: b.uploadId }),
    ]);
    assert.notEqual(first.path, second.path);
    assert.equal(await readFile(first.path, "utf8"), "aaa");
    assert.equal(await readFile(second.path, "utf8"), "bbb");
    await transfers.dispose();
    transfers = createTransfers();
    assert.deepEqual(await transfers.finish({ uploadId: a.uploadId }), first);
    await assert.rejects(
      transfers.begin(dir, { ...data, name: "huge.mp4", size: 17 * 1024 ** 3 }),
      /quota/,
    );
    let lost = true;
    const lossyHost = {
      ...localHost,
      publishExclusive: async (from: string, to: string) => {
        const linked = await localHost.publishExclusive(from, to);
        if (linked && lost) {
          lost = false;
          throw new Error("connection dropped after publication");
        }
        return linked;
      },
    };
    const interrupted = await transfers.begin(
      { ...dir, host: lossyHost },
      { ...data, name: "ack.png" },
    );
    await transfers.write({
      uploadId: interrupted.uploadId,
      offset: 0,
      base64: Buffer.from("ack").toString("base64"),
    });
    await assert.rejects(
      transfers.finish({ uploadId: interrupted.uploadId }),
      /connection dropped/,
    );
    await transfers.dispose();
    transfers = createTransfers();
    const recovered = await transfers.finish({
      uploadId: interrupted.uploadId,
    });
    assert.equal(await readFile(recovered.path, "utf8"), "ack");
    assert.equal(
      (await readdir(root)).filter((name) => name.startsWith("ack")).length,
      1,
    );
    // A failed remote cleanup must retain its only cleanup record, even after six days.
    const pending = await transfers.begin(dir, data);
    await transfers.dispose();
    transfers = createTransfers();
    const state = path.join(
      root,
      "cache",
      "paseo-media-studio",
      "uploads",
      pending.uploadId + ".json",
    );
    const record = JSON.parse(await readFile(state, "utf8"));
    record.dir = "not-allowed:/unreachable";
    record.updatedAt = Date.now() - 10 * 86400000;
    await writeFile(state, JSON.stringify(record));
    await transfers.sweepStale();
    assert.ok(await readFile(state, "utf8"));
  } finally {
    await transfers.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("playback admission counts pending spawns and keeps existing sessions alive", async () => {
  const { createStreamer } =
    await import("../plugins/media-studio/server/stream");
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const children: any[] = [];
  const releases: (() => void)[] = [];
  const host = {
    ...localHost,
    id: "fake",
    stat: async () => ({
      size: 100,
      mtimeMs: 42,
      isFile: true,
      isDirectory: false,
    }),
    tools: async () => ({
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
      encoders: [],
      version: "test",
    }),
    run: async () => ({
      code: 0,
      stderr: "",
      stdout: Buffer.from(
        JSON.stringify({
          format: { duration: "60" },
          streams: [{ codec_type: "audio", codec_name: "aac" }],
        }),
      ),
    }),
    spawn: async () => {
      const child = new EventEmitter() as any;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.killed = false;
      child.kill = () => {
        child.killed = true;
        child.emit("close", 0, "SIGKILL");
        return true;
      };
      children.push(child);
      await new Promise<void>((resolve) => releases.push(resolve));
      return child;
    },
  };
  const streamer = createStreamer();
  try {
    const request = {
      location: { host, path: "/test.wav", ref: "fake:/test.wav" },
      start: 0,
      quality: "auto" as const,
      h264: false,
      hardware: false,
    };
    const pending = Array.from({ length: 6 }, () => streamer.open(request));
    while (children.length < 6)
      await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(streamer.open(request), /slots/);
    assert.equal(children.length, 6);
    assert.ok(children.every((child) => !child.killed));
    for (const release of releases) release();
    await Promise.all(pending);
    await assert.rejects(streamer.open(request), /slots/);
  } finally {
    streamer.dispose();
  }
  assert.ok(children.every((child) => child.killed));
});

test("stalled stream polls release callbacks on timeout and on data arrival", async () => {
  const { waitForStreamData } =
    await import("../plugins/media-studio/server/stream");
  const waiters: (() => void)[] = [];
  for (let i = 0; i < 20; i++) {
    await waitForStreamData(waiters, 1);
    assert.equal(waiters.length, 0);
  }
  const pending = waitForStreamData(waiters, 1000);
  assert.equal(waiters.length, 1);
  waiters[0]();
  await pending;
  assert.equal(waiters.length, 0);
});

test("portable content hashing matches SHA-256 across padding and chunk boundaries", async () => {
  const { createHash, randomBytes } = await import("node:crypto");
  const { sha256 } = await import("../plugins/media-studio/shared/sha256");
  for (const size of [0, 1, 55, 56, 63, 64, 65, 1000, 4 * 1024 * 1024]) {
    const data = randomBytes(size);
    assert.equal(
      Buffer.from(sha256(data)).toString("hex"),
      createHash("sha256").update(data).digest("hex"),
    );
  }
});

test("composer pills skip disabled scans and batch every active project when enabled", async (t) => {
  const { contributeMediaPills } = await import("../plugins/media-studio/client/pill");
  let observer: any;
  let onSettings!: (event: unknown) => void;
  let settingsSignal!: AbortSignal;
  let setting: boolean | null = false;
  const calls: { dirs: string[]; fresh: boolean }[] = [];
  const visibility = new Map<string, boolean>();
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const client = {
    paseo: {
      agents: { list: async () => ({ subscription: { subscribe: (value: unknown) => { observer = value; } } }) },
      observeEvents(events: string[], { signal }: { signal: AbortSignal }) {
        assert.deepEqual(events, ["status.plugin_settings_changed"]);
        settingsSignal = signal;
        return { subscribe: ({ update }: { update: (event: unknown) => void }) => { onSettings = update; } };
      },
    },
    addComposerPill: ({ agentId }: { agentId: string }) => ({
      update: ({ visible }: { visible: boolean }) => visibility.set(agentId, visible),
      remove: () => visibility.delete(agentId),
    }),
    rpc: async ({ name }: { name: string }, input: { dirs: string[]; fresh: boolean }) => {
      if (name === "settings.media-studio.read") {
        if (setting === null) throw new Error("disconnected");
        return { status: "ready", values: { composerPill: setting } };
      }
      assert.equal(name, "media.project.summary");
      calls.push(input);
      return { projects: input.dirs.map(dir => ({ dir, isMedia: true, image: 25, video: 0, audio: 0 })) };
    },
  };
  const stop = contributeMediaPills(client as any);
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  const entries = Array.from({ length: 205 }, (_, n) => ({
    agent: { id: String(n), cwd: "/dir/" + n, workspaceId: "ws", status: "running" },
  }));
  try {
    await flush();
    observer.snapshot({ entries });
    await flush();
    assert.equal(calls.length, 0);
    setting = null;
    t.mock.timers.tick(90_000);
    await flush();
    assert.equal(calls.length, 0);
    setting = true;
    const emitSettings = (settingsId: string) => onSettings({ type: "status", payload: { status: "plugin_settings_changed", settingsId } });
    emitSettings("another-plugin");
    await flush();
    assert.equal(calls.length, 0);
    emitSettings("media-studio");
    await flush();
    assert.deepEqual(calls.map(call => [call.dirs.length, call.fresh]), [[200, false], [5, false]]);
    assert.equal([...visibility.values()].filter(Boolean).length, entries.length);

    calls.length = 0;
    for (const { agent } of entries) {
      observer.update({ type: "agent_update", payload: { kind: "upsert", agent: { ...agent, status: "idle" } } });
    }
    t.mock.timers.tick(3_000);
    await flush();
    assert.deepEqual(calls.map(call => [call.dirs.length, call.fresh]), [[200, true], [5, true]]);
    setting = false;
    calls.length = 0;
    emitSettings("media-studio");
    await flush();
    assert.equal(calls.length, 0);
    assert.ok([...visibility.values()].every(value => !value));
  } finally {
    stop();
    assert.equal(settingsSignal.aborted, true);
  }
});

test("a plugin reload continues active and queued uploads only on the original daemon", async () => {
  const { build } = await import("esbuild");
  const vm = await import("node:vm");
  const directory = path.resolve("plugins/media-studio/client");
  const bundle = await build({
    stdin: {
      contents: 'export * from "./transfers"; export {setPluginClient} from "./state";',
      resolveDir: directory,
    },
    external: ["react-native"],
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "media",
    write: false,
  });
  const page = vm.createContext({
    require: () => ({ Platform: { OS: "web" } }),
    navigator: {}, Blob, console, setTimeout, clearTimeout, btoa,
  });
  const load = (list: () => Promise<unknown>, rpc = async (_method: any, _input: any): Promise<any> => {}) => {
    vm.runInContext(bundle.outputFiles[0].text, page);
    const api = page.media;
    api.setPluginClient({ paseo: { hosts: { list } }, rpc });
    return api;
  };
  const identify = (serverId: string) => async () => ({ self: { serverId } });
  const files = ["a", "b", "c", "d"].map(name => new File(["x"], name + ".png"));
  const original = new AbortController();
  const writes: (() => void)[] = [];
  const began: string[] = [];
  const old = load(identify("daemon-a"), async (method, input) => {
    if (method.name === "upload.begin") {
      began.push(input.name);
      return { uploadId: input.name, received: [], receivedBytes: 0 };
    }
    if (method.name === "upload.write") {
      await new Promise<void>(resolve => writes.push(resolve));
      return { received: 1 };
    }
    throw new Error("old instance called " + method.name);
  });
  await old.adoptUploads(original.signal);
  const pending = old.uploadFiles(files, "/renders");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.length, 2);
  original.abort();
  old.handOverUploads();
  for (const release of writes) release();
  await pending;
  assert.deepEqual(began, files.slice(0, 2).map(file => file.name));

  const foreign = load(identify("daemon-b"), async () => { throw Error("wrong daemon"); });
  await foreign.adoptUploads(new AbortController().signal);
  foreign.handOverUploads();
  let resolveId!: (value: unknown) => void;
  const stale = load(() => new Promise(resolve => { resolveId = resolve; }));
  const disposed = new AbortController();
  const lookup = stale.adoptUploads(disposed.signal);
  disposed.abort();
  stale.handOverUploads();
  resolveId({ self: { serverId: "daemon-a" } });
  await lookup;
  assert.equal(stale.currentServerId(), null);

  const resumed: (string | null)[] = [];
  const finished: string[] = [];
  const next = load(identify("daemon-a"), async (method, input) => {
    if (method.name === "upload.begin") {
      resumed.push(input.uploadId);
      return { uploadId: input.name, received: [], receivedBytes: 0 };
    }
    if (method.name === "upload.write") return { received: 1 };
    assert.equal(method.name, "upload.finish");
    finished.push(input.uploadId);
    return { path: "/renders/" + input.uploadId };
  });
  await next.adoptUploads(new AbortController().signal);
  assert.deepEqual(resumed, ["a.png", "b.png", null, null]);
  assert.deepEqual(finished.sort(), files.map(file => file.name));
});

test("Windows tool discovery and media labels handle drive and UNC paths", async () => {
  const { baseName, extensionOf, joinPath, relativeTo, dirName } = await import("../plugins/media-studio/shared/media");
  const { findLocalBinary } = await import("../plugins/media-studio/server/hosts");
  const drive = String.raw`C:\Cuts\Episode 1`;
  const share = String.raw`\\studio\renders\episode`;
  assert.equal(baseName(drive + "\\cut.mp4"), "cut.mp4");
  assert.equal(extensionOf(drive + "\\file"), "");
  assert.equal(dirName("C:\\cut.mp4"), "C:\\");
  assert.equal(joinPath(share, "frames/one.png"), share + "\\frames\\one.png");
  assert.equal(relativeTo(drive, "c:/cuts/Episode 1/frames/cut.png"), "frames/cut.png");
  assert.equal(relativeTo(share, share + "\\v2\\cut.mp4"), "v2/cut.mp4");
  assert.equal(relativeTo("/cut", String.raw`/cut/a\b.png`), String.raw`a\b.png`);
  assert.equal(baseName(String.raw`gpu:/cut/a\b.png`), String.raw`a\b.png`);

  const root = await temp();
  try {
    const tool = path.join(root, "media-tool-fixture");
    await writeFile(tool + ".exe", "", { mode: 0o755 });
    assert.equal(await findLocalBinary("", "media-tool-fixture", [tool], "win32"), tool + ".exe");
    assert.equal(await findLocalBinary("", "media-tool-fixture", [tool], "linux"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
