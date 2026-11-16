import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  truncate,
  readdir,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("enforces cache, notes and frame quotas without deleting saved frames or notes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-storage-"));
  process.env.XDG_CACHE_HOME = path.join(root, "cache");
  try {
    const cacheRoot = path.join(root, "cache", "paseo-media-studio");
    const old = path.join(cacheRoot, "v1", "aa", "old.jpg");
    await mkdir(path.dirname(old), { recursive: true });
    await writeFile(old, "");
    await truncate(old, 1024 ** 3);
    const { writeCache, readCache, clearCache } =
      await import("../plugins/media-studio/server/cache");
    await writeCache("b".repeat(40), "jpg", Buffer.from("preview"));
    await assert.rejects(stat(old));
    assert.equal(
      (await readCache("b".repeat(40), "jpg"))?.toString(),
      "preview",
    );
    await clearCache();
    const notesRoot = path.join(cacheRoot, "notes");
    await mkdir(notesRoot, { recursive: true });
    const retained = path.join(notesRoot, "retained.json");
    await writeFile(retained, "");
    await truncate(retained, 64 * 1024 ** 2);
    const { addNote } = await import("../plugins/media-studio/server/notes");
    await assert.rejects(
      addNote("/file.mp4", { text: "note", time: 0 } as any),
      /quota/,
    );
    assert.equal((await stat(retained)).size, 64 * 1024 ** 2);
    const { localHost } = await import("../plugins/media-studio/server/hosts");
    const { saveFrame, frameStorageBytes } =
      await import("../plugins/media-studio/server/frames");
    const framesDir = path.join(root, "frames");
    await mkdir(framesDir);
    const dir = { host: localHost, path: framesDir, ref: framesDir };
    const saved = await saveFrame(dir, "frame.png", Buffer.from("png"));
    assert.equal(await frameStorageBytes(), 3);
    assert.equal(await readFile(saved, "utf8"), "png");
    await truncate(saved, 512 * 1024 ** 2);
    await assert.rejects(
      saveFrame(dir, "new.png", Buffer.from("png")),
      /quota/,
    );
    assert.equal((await stat(saved)).size, 512 * 1024 ** 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
