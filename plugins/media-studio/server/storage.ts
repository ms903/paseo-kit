import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { frameStorageBytes } from "./frames";

const root = path.join(
  process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
  "paseo-media-studio",
);
async function directoryBytes(dir: string): Promise<number> {
  const handle = await fs.opendir(dir).catch(() => null);
  if (!handle) return 0;
  let total = 0;
  for await (const entry of handle) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(file);
    else if (entry.isFile())
      total += (await fs.stat(file).catch(() => null))?.size ?? 0;
  }
  return total;
}

export async function storageUsage() {
  let uploadReservedBytes = 0;
  let unfinishedUploads = 0;
  for (const name of await fs
    .readdir(path.join(root, "uploads"))
    .catch(() => [])) {
    if (!name.endsWith(".json")) continue;
    const record = JSON.parse(
      await fs
        .readFile(path.join(root, "uploads", name), "utf8")
        .catch(() => "null"),
    );
    if (record && !record.completedPath) {
      unfinishedUploads += 1;
      uploadReservedBytes += record.size;
    }
  }
  const [cacheBytes, noteBytes, frameBytes] = await Promise.all([
    directoryBytes(path.join(root, "v1")),
    directoryBytes(path.join(root, "notes")),
    frameStorageBytes(),
  ]);
  return {
    cacheBytes,
    noteBytes,
    frameBytes,
    uploadReservedBytes,
    unfinishedUploads,
  };
}
