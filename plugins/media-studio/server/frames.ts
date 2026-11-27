import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { publishUnique } from "./files";
import { locate, refOf, type Located } from "./hosts";
import { keyedQueue } from "./queue";

const registry = path.join(
  process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
  "paseo-media-studio",
  "frames.json",
);
const mutate = keyedQueue();
const MAX_FRAME_BYTES = 1024 * 1024 * 1024;
const MAX_FOLDER_BYTES = 512 * 1024 * 1024;
const KEEP_PART_MS = 3 * 86400000;
interface SavedFrame {
  ref: string;
  size: number;
  pending?: boolean;
  target?: string;
  createdAt?: number;
}

async function writeRegistry(records: SavedFrame[]): Promise<void> {
  await fs.mkdir(path.dirname(registry), { recursive: true });
  const temp = `${registry}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(records));
    await fs.rename(temp, registry);
  } finally {
    await fs.unlink(temp).catch(() => undefined);
  }
}

async function frames(checkRemote = false): Promise<SavedFrame[]> {
  const raw = await fs
    .readFile(registry, "utf8")
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "[]";
      throw error;
    });
  const records = JSON.parse(raw) as SavedFrame[];
  const live: SavedFrame[] = [];
  for (const entry of records) {
    if (!checkRemote && /^[A-Za-z0-9][A-Za-z0-9._-]*:/.test(entry.ref)) {
      live.push(entry);
      continue;
    }
    const location = await locate(entry.ref).catch(() => null);
    if (!location) {
      live.push(entry);
      continue;
    }
    try {
      if (entry.pending) {
        if (
          entry.target &&
          (await location.host.sameFile(location.path, entry.target))
        ) {
          await location.host.remove(location.path);
          live.push({
            ref: refOf(location.host, entry.target),
            size: entry.size,
          });
        } else if (Date.now() - (entry.createdAt ?? 0) > KEEP_PART_MS) {
          await location.host.remove(location.path);
        } else live.push(entry);
        continue;
      }
      const stat = await location.host.stat(location.path);
      if (stat?.isFile) live.push({ ref: entry.ref, size: stat.size });
    } catch {
      live.push(entry);
    }
  }
  return live;
}

export function saveFrame(
  dir: Located,
  name: string,
  png: Buffer,
): Promise<string> {
  return mutate("frames", async () => {
    const records = await frames();
    const folder = await dir.host.listDir(dir.path);
    if (folder.truncated) throw new Error("Frame folder entry limit reached");
    const folderBytes = folder.entries.reduce(
      (sum, entry) => sum + (entry.isDirectory ? 0 : entry.size),
      0,
    );
    if (
      records.length >= 5000 ||
      records.reduce((sum, entry) => sum + entry.size, 0) + png.length >
        MAX_FRAME_BYTES ||
      folderBytes + png.length > MAX_FOLDER_BYTES
    )
      throw new Error("Saved frame storage quota reached");
    const part = (dir.host.remote ? path.posix : path).join(dir.path, `.${randomUUID()}.part`);
    const reservation: SavedFrame = {
      ref: refOf(dir.host, part),
      size: png.length,
      pending: true,
      createdAt: Date.now(),
    };
    records.push(reservation);
    await writeRegistry(records);
    await dir.host.createEmpty(part);
    await dir.host.writeAt(part, 0, png);
    const target = await publishUnique(dir.host, part, dir.path, name, {
      before: async (candidate) => {
        reservation.target = candidate;
        await writeRegistry(records);
      },
      commit: async (candidate) => {
        reservation.ref = refOf(dir.host, candidate);
        delete reservation.pending;
        delete reservation.target;
        await writeRegistry(records);
      },
    });
    return refOf(dir.host, target);
  });
}

export function frameStorageBytes(): Promise<number> {
  return mutate("frames", async () =>
    (await frames()).reduce((sum, entry) => sum + entry.size, 0),
  );
}

export function cleanupFrames(): Promise<void> {
  return mutate("frames", async () => {
    await writeRegistry(await frames(true));
  });
}
