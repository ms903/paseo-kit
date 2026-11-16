import { promises as fs } from "node:fs";
import path from "node:path";
import { MIN_TRANSPORT_STREAM_BYTES, TRANSPORT_STREAM_HEAD_BYTES, isAmbiguousMedia, looksLikeTransportStream, mediaKindOf, type MediaKind } from "../shared/media";
import type { MediaEntry } from "../shared/rpc";
import { refOf, type MediaHost } from "./hosts";

/** Folder names never worth scanning for media. Hidden folders are skipped as well. */
const SKIPPED_DIRS = new Set(["node_modules", "__pycache__", "venv", "site-packages", "target", "Pods"]);

export interface ScannedFile {
  path: string;
  kind: MediaKind;
  size: number;
  mtimeMs: number;
}

/**
 * Drops `.ts` and `.mts` files that are source code rather than transport streams: small ones
 * outright, the rest by their first bytes. Other files pass untouched.
 */
export async function dropSourceCode<T>(
  items: T[],
  fileOf: (item: T) => { path: string; size: number } | null,
  readHead: (file: string, length: number) => Promise<Uint8Array>,
): Promise<T[]> {
  const verdicts = items.map(() => true);
  const pending: number[] = [];
  items.forEach((item, index) => {
    const file = fileOf(item);
    if (!file || !isAmbiguousMedia(file.path)) return;
    if (file.size < MIN_TRANSPORT_STREAM_BYTES) verdicts[index] = false;
    else pending.push(index);
  });
  // A few reads at a time: on an SSH host each one is a command over the shared connection.
  const worker = async () => {
    for (let index = pending.shift(); index !== undefined; index = pending.shift()) {
      const head = await readHead(fileOf(items[index]!)!.path, TRANSPORT_STREAM_HEAD_BYTES).catch(() => new Uint8Array(0));
      verdicts[index] = looksLikeTransportStream(head);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return items.filter((_, index) => verdicts[index]);
}

async function readLocalHead(file: string, length: number): Promise<Uint8Array> {
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

interface ScanOptions {
  maxEntries?: number;
  maxDepth?: number;
  budgetMs?: number;
}

/**
 * Media files under `root` on the daemon host, breadth first, within a budget so a huge repository
 * costs a bounded amount of time. `truncated` says the budget ran out before every folder was read.
 */
// Keep scans from multiple agents from multiplying disk load.
let scanning = 0;
const scanWaiters: (() => void)[] = [];
const scans = new Map<string, Promise<{ files: ScannedFile[]; truncated: boolean }>>();

export function scanMedia(root: string, options: ScanOptions = {}): Promise<{ files: ScannedFile[]; truncated: boolean }> {
  const key = JSON.stringify([root, options]);
  const existing = scans.get(key);
  if (existing) return existing;
  const requestedAt = Date.now();
  const pending = (async () => {
    if (scanning >= 2) await new Promise<void>((resolve) => scanWaiters.push(resolve));
    else scanning += 1;
    try {
      return await scanBounded(root, { ...options, budgetMs: Math.max(0, (options.budgetMs ?? 2000) - (Date.now() - requestedAt)) });
    } finally {
      const next = scanWaiters.shift();
      if (next) next();
      else scanning -= 1;
    }
  })().finally(() => scans.delete(key));
  scans.set(key, pending);
  return pending;
}

async function scanBounded(root: string, options: ScanOptions): Promise<{ files: ScannedFile[]; truncated: boolean }> {
  const { maxEntries = 20_000, maxDepth = 8, budgetMs = 2000 } = options;
  const deadline = Date.now() + budgetMs;
  const files: ScannedFile[] = [];
  const queue = [{ dir: root, depth: 0 }];
  const visited = new Set<string>();
  let seen = 0;
  let truncated = false;
  outer: for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const { dir, depth } = queue[cursor]!;
    if (seen >= maxEntries || Date.now() >= deadline) { truncated = true; break; }
    const real = await fs.realpath(dir).catch(() => dir);
    if (visited.has(real)) continue;
    visited.add(real);
    const handle = await fs.opendir(dir).catch(() => null);
    if (!handle) continue;
    try {
      for (;;) {
        if (seen >= maxEntries || Date.now() >= deadline) { truncated = true; break outer; }
        const entry = await handle.read();
        if (!entry) break;
        seen += 1;
        if (entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (depth < maxDepth && !SKIPPED_DIRS.has(entry.name)) queue.push({ dir: full, depth: depth + 1 });
          continue;
        }
        // Do not walk linked folders outside the workspace; linked media files still work.
        const kind = mediaKindOf(entry.name);
        if (!kind || (!entry.isFile() && !entry.isSymbolicLink())) continue;
        const stat = await fs.stat(full).catch(() => null);
        if (!stat?.isFile()) continue;
        if (isAmbiguousMedia(full)) {
          if (stat.size < MIN_TRANSPORT_STREAM_BYTES || Date.now() >= deadline) continue;
          const head = await readLocalHead(full, TRANSPORT_STREAM_HEAD_BYTES).catch(() => new Uint8Array());
          if (!looksLikeTransportStream(head)) continue;
        }
        files.push({ path: full, kind, size: stat.size, mtimeMs: stat.mtimeMs });
      }
    } finally {
      await handle.close();
    }
  }
  return { files, truncated };
}

export async function listRecent(host: MediaHost, root: string, limit: number): Promise<{ entries: MediaEntry[]; truncated: boolean }> {
  const { files, truncated } = await host.scan(root);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return {
    truncated: truncated || files.length > limit,
    entries: files.slice(0, limit).map((file) => ({
      path: refOf(host, file.path),
      name: path.basename(file.path),
      kind: file.kind,
      size: file.size,
      modifiedAt: new Date(file.mtimeMs).toISOString(),
    })),
  };
}

export async function listFolder(host: MediaHost, dir: string, limit: number): Promise<{ entries: MediaEntry[]; truncated: boolean }> {
  const result: MediaEntry[] = [];
  const listing = await host.listDir(dir);
  const entries = await dropSourceCode(
    listing.entries,
    (entry) => (entry.isDirectory ? null : { path: path.posix.join(dir, entry.name), size: entry.size }),
    (file, length) => host.readRange(file, 0, length),
  );
  for (const entry of entries) {
    const kind = entry.isDirectory ? "directory" : mediaKindOf(entry.name);
    if (!kind) continue;
    result.push({
      path: refOf(host, path.posix.join(dir, entry.name)),
      name: entry.name,
      kind,
      size: entry.isDirectory ? 0 : entry.size,
      modifiedAt: new Date(entry.mtimeMs).toISOString(),
    });
  }
  result.sort((a, b) => {
    if ((a.kind === "directory") !== (b.kind === "directory")) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
  return { entries: result.slice(0, limit), truncated: listing.truncated || result.length > limit };
}

/** A file name the user can type: no folders, no control characters, not `.` or `..`. */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[\u0000-\u001f/\\]/g, "_").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") throw new Error(`Invalid file name: ${name}`);
  return cleaned;
}

/** Publish a completed part file with an atomic, exclusive destination claim. */
export async function publishUnique(host: MediaHost, from: string, dir: string, name: string, journal?: { before(target: string): Promise<void>; commit(target: string): Promise<void> }): Promise<string> {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let index = 1; index < 1000; index += 1) {
    const candidate = path.posix.join(dir, index === 1 ? name : `${stem} (${index})${ext}`);
    await journal?.before(candidate);
    if (await host.publishExclusive(from, candidate)) {
      await journal?.commit(candidate);
      await host.remove(from);
      return candidate;
    }
  }
  throw new Error(`Too many files named ${name}`);
}
