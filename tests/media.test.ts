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
