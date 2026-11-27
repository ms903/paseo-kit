import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CHUNK_BYTES, UPLOAD_ALIGN_BYTES, type ByteRange, type PendingUpload } from "../shared/rpc";
import { safeFileName, publishUnique } from "./files";
import { locate, refOf, type Located, type MediaHost } from "./hosts";
import { keyedQueue } from "./queue";
import { statLocated } from "./probe";

// Uploads and downloads move in pieces over plugin RPC, so they work through the daemon's direct
// connection, a reverse proxy or a tunnel without any extra port.
//
// An upload writes each piece at its offset in a hidden part file next to the target (pieces may
// arrive out of order) and publishes it under an exclusive name once every byte is there, so an interrupted
// upload never leaves a half file under the real name. Each new selection has a random upload ID;
// resuming uses that explicit ID rather than inferring identity from file metadata. The ranges
// already written are kept in a small record on the daemon host. After a dropped connection, a page
// reload, a plugin reload or a daemon restart, `begin` with the task ID returns its ranges and sends
// the rest. Records and part files nobody resumes are removed after a few days.
//
// On an SSH host each piece is one `dd` over the shared connection; the record stays on the daemon.

const STATE_DIR = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "paseo-media-studio", "uploads");
/** Unfinished uploads are kept this long after their last piece, then discarded. */
const KEEP_MS = 3 * 24 * 60 * 60 * 1000;
/** An upload nobody touched for this long leaves memory; its record and part file stay. */
const IDLE_MS = 15 * 60 * 1000;
const FLUSH_MS = 500;
const SWEEP_MS = 60 * 60 * 1000;

interface UploadRecord {
  version: 1;
  uploadId: string;
  /** Target folder as the app names it: a daemon path or alias:/path. */
  dir: string;
  name: string;
  size: number;
  lastModified: number | null;
  fingerprint?: string;
  /** Part file path on the folder's host. */
  partPath: string;
  received: ByteRange[];
  completedPath?: string;
  publishingPath?: string;
  createdAt: number;
  updatedAt: number;
}

interface ActiveUpload {
  record: UploadRecord;
  host: MediaHost;
  dirPath: string;
  lastUsed: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

interface Download {
  location: Located;
  size: number;
  lastUsed: number;
}

/** Adds `[start, end)` to sorted, merged ranges. */
export function addRange(ranges: readonly ByteRange[], start: number, end: number): ByteRange[] {
  const result: ByteRange[] = [];
  let next: ByteRange = [start, end];
  let placed = false;
  for (const range of ranges) {
    if (range[1] < next[0]) result.push(range);
    else if (range[0] > next[1]) {
      if (!placed) {
        result.push(next);
        placed = true;
      }
      result.push(range);
    } else next = [Math.min(range[0], next[0]), Math.max(range[1], next[1])];
  }
  if (!placed) result.push(next);
  return result;
}

export function coveredBytes(ranges: readonly ByteRange[]): number {
  return ranges.reduce((sum, [start, end]) => sum + (end - start), 0);
}

function isComplete(ranges: readonly ByteRange[], size: number): boolean {
  return size === 0 || (ranges.length === 1 && ranges[0]![0] === 0 && ranges[0]![1] >= size);
}

/** Keeps only the ranges that lie within the first `size` bytes of the part file. */
function clampRanges(ranges: readonly ByteRange[], size: number): ByteRange[] {
  return ranges.filter(([start]) => start < size).map(([start, end]) => [start, Math.min(end, size)] as ByteRange);
}

function partName(name: string, uploadId: string): string {
  // Keep the hidden part file name within the 255-byte limit of most file systems.
  let stem = name;
  while (Buffer.byteLength(stem) > 200) stem = stem.slice(0, -1);
  return `.${stem}.${uploadId}.part`;
}

function recordFile(uploadId: string): string {
  if (!/^(?:[a-f0-9]{24}|[a-f0-9-]{36})$/.test(uploadId)) throw new Error("Invalid upload ID");
  return path.join(STATE_DIR, `${uploadId}.json`);
}

async function readRecord(uploadId: string): Promise<UploadRecord | null> {
  try {
    const record = JSON.parse(await fs.readFile(recordFile(uploadId), "utf8")) as UploadRecord;
    return record.version === 1 && record.uploadId === uploadId ? record : null;
  } catch {
    return null;
  }
}

async function writeRecord(record: UploadRecord): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true });
  const file = recordFile(record.uploadId);
  const temp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(record));
    await fs.rename(temp, file);
  } finally { await fs.unlink(temp).catch(() => undefined); }
}

async function deleteRecord(uploadId: string): Promise<void> {
  await fs.unlink(recordFile(uploadId)).catch(() => undefined);
}

async function allRecords(): Promise<UploadRecord[]> {
  const names = await fs.readdir(STATE_DIR).catch(() => [] as string[]);
  const records = await Promise.all(
    names.filter((name) => name.endsWith(".json")).map((name) => readRecord(name.slice(0, -".json".length))),
  );
  return records.filter((record): record is UploadRecord => record !== null);
}

export function createTransfers() {
  const uploads = new Map<string, ActiveUpload>();
  const mutate = keyedQueue();
  const persist = keyedQueue();
  const capacity = keyedQueue();
  let stopped = false;
  const finished = new Map<string, string>();
  const MAX_UPLOAD_BYTES = 16 * 1024 ** 3;
  const MAX_UPLOADS = 64;
  const downloads = new Map<string, Download>();
  /** One load at a time per upload, so parallel pieces after a restart share it. */
  const loading = new Map<string, Promise<ActiveUpload>>();

  function scheduleFlush(upload: ActiveUpload): void {
    if (upload.flushTimer) return;
    upload.flushTimer = setTimeout(() => {
      upload.flushTimer = null;
      void persist(upload.record.uploadId, () => writeRecord(upload.record)).catch((error) => console.error("media-studio: could not save upload progress", error));
    }, FLUSH_MS);
  }

  async function flushNow(upload: ActiveUpload): Promise<void> {
    if (upload.flushTimer) clearTimeout(upload.flushTimer);
    upload.flushTimer = null;
    await persist(upload.record.uploadId, () => writeRecord(upload.record));
  }

  /** The upload in memory, or loaded from its record after a plugin or daemon restart. */
  function activate(uploadId: string): Promise<ActiveUpload> {
    const active = uploads.get(uploadId);
    if (active) return Promise.resolve(active);
    let pending = loading.get(uploadId);
    if (!pending) {
      pending = (async () => {
        const record = await readRecord(uploadId);
        if (!record) throw new Error("This upload expired. Start it again.");
        const dir = await locate(record.dir);
        const upload: ActiveUpload = { record, host: dir.host, dirPath: dir.path, lastUsed: Date.now(), flushTimer: null };
        uploads.set(uploadId, upload);
        return upload;
      })().finally(() => loading.delete(uploadId));
      loading.set(uploadId, pending);
    }
    return pending;
  }

  async function begin(
    dir: Located,
    input: { name: string; size: number; lastModified?: number | null; uploadId?: string | null; fingerprint: string },
  ): Promise<{ uploadId: string; received: ByteRange[]; receivedBytes: number; resumed: boolean }> {
    const name = safeFileName(input.name);
    const lastModified = input.lastModified ?? null;
    if (input.uploadId && !/^(?:[a-f0-9]{24}|[a-f0-9-]{36})$/.test(input.uploadId)) throw new Error("Invalid upload ID");
    const uploadId = input.uploadId || randomUUID();
    let upload = uploads.get(uploadId) ?? null;
    if (upload && (upload.record.dir !== dir.ref || upload.record.name !== name || upload.record.size !== input.size || upload.record.lastModified !== lastModified || upload.record.fingerprint !== input.fingerprint)) throw new Error("Upload file does not match");
    let resumed = false;
    if (upload) {
      resumed = coveredBytes(upload.record.received) > 0;
    } else {
      const record = await readRecord(uploadId);
      if (input.uploadId && !record) throw new Error("This upload expired. Start it again.");
      if (record && (record.dir !== dir.ref || record.name !== name || record.size !== input.size || record.lastModified !== lastModified || record.fingerprint !== input.fingerprint)) throw new Error("Upload file does not match");
      if (record?.completedPath) return { uploadId, received: record.received, receivedBytes: record.size, resumed: true };
      if (record) {
        // The part file must still be there; only ranges inside it count.
        const part = await dir.host.stat(record.partPath).catch(() => null);
        if (part?.isFile) {
          record.received = clampRanges(record.received, part.size);
          upload = { record, host: dir.host, dirPath: dir.path, lastUsed: Date.now(), flushTimer: null };
          resumed = coveredBytes(record.received) > 0;
        }
      }
      if (!upload) {
        const records = (await allRecords()).filter((entry) => !entry.completedPath);
        if (records.length >= MAX_UPLOADS || records.reduce((sum, entry) => sum + entry.size, 0) + input.size > MAX_UPLOAD_BYTES) throw new Error("Unfinished upload quota reached");
        await dir.host.mkdirp(dir.path);
        const partPath = (dir.host.remote ? path.posix : path).join(dir.path, partName(name, uploadId));
        const now = Date.now();
        upload = {
          record: { version: 1, uploadId, dir: dir.ref, name, size: input.size, lastModified, fingerprint: input.fingerprint, partPath, received: [], createdAt: now, updatedAt: now },
          host: dir.host,
          dirPath: dir.path,
          lastUsed: now,
          flushTimer: null,
        };
        await flushNow(upload);
        await dir.host.createEmpty(partPath);
      }
      uploads.set(uploadId, upload);
      await flushNow(upload);
    }
    upload.lastUsed = Date.now();
    const received = upload.record.received;
    return { uploadId, received, receivedBytes: coveredBytes(received), resumed };
  }

  async function write(input: { uploadId: string; offset: number; base64: string }): Promise<{ received: number }> {
    const upload = await activate(input.uploadId);
    upload.lastUsed = Date.now();
    const data = Buffer.from(input.base64, "base64");
    if (data.length > CHUNK_BYTES) throw new Error("Upload piece is too large");
    if (input.offset % UPLOAD_ALIGN_BYTES !== 0) throw new Error("Upload pieces must start at multiples of 256 KB");
    if (input.offset + data.length > upload.record.size) throw new Error("Upload piece goes past the end of the file");
    await upload.host.writeAt(upload.record.partPath, input.offset, data);
    // Recorded only after the bytes are written, so a crash can lose progress but never claim it.
    upload.record.received = addRange(upload.record.received, input.offset, input.offset + data.length);
    upload.record.updatedAt = Date.now();
    scheduleFlush(upload);
    return { received: coveredBytes(upload.record.received) };
  }

  async function finish(input: { uploadId: string }): Promise<{ path: string }> {
    const saved = await readRecord(input.uploadId);
    if (saved?.completedPath) return { path: saved.completedPath };
    const upload = await activate(input.uploadId);
    const { record } = upload;
    if (!isComplete(record.received, record.size)) {
      throw new Error(`Upload is incomplete: ${coveredBytes(record.received)} of ${record.size} bytes arrived`);
    }
    const written = await upload.host.stat(record.partPath);
    if (!written || written.size !== record.size) throw new Error("The uploaded file has the wrong size");
    if (upload.flushTimer) clearTimeout(upload.flushTimer);
    upload.flushTimer = null;
    await flushNow(upload);
    const commit = async (target: string) => {
      record.completedPath = refOf(upload.host, target);
      await persist(input.uploadId, () => writeRecord(record));
    };
    let target: string;
    if (record.publishingPath && await upload.host.sameFile(record.partPath, record.publishingPath)) {
      target = record.publishingPath;
      await commit(target);
      await upload.host.remove(record.partPath);
    } else {
      target = await publishUnique(upload.host, record.partPath, upload.dirPath, record.name, {
        before: async (candidate) => { record.publishingPath = candidate; await persist(input.uploadId, () => writeRecord(record)); },
        commit,
      });
    }
    finished.set(input.uploadId, refOf(upload.host, target));
    if (finished.size > 128) finished.delete(finished.keys().next().value!);
    record.completedPath = refOf(upload.host, target);
    await persist(input.uploadId, () => writeRecord(record));
    uploads.delete(input.uploadId);
    const completed = (await allRecords()).filter((entry) => entry.completedPath).sort((a,b) => b.updatedAt - a.updatedAt);
    for (const old of completed.slice(128)) await deleteRecord(old.uploadId);
    return { path: refOf(upload.host, target) };
  }

  async function abort(uploadId: string): Promise<void> {
    const upload = uploads.get(uploadId) ?? (await activate(uploadId).catch(() => null));
    if (upload?.flushTimer) clearTimeout(upload.flushTimer);
    uploads.delete(uploadId);
    if (upload) {
      await persist(uploadId, () => upload.host.remove(upload.record.partPath));
      await persist(uploadId, () => deleteRecord(uploadId));
    }
  }

  function isUnder(dir: string, root: string): boolean {
    const base = root.replace(/\/+$/, "");
    return dir === base || dir.startsWith(`${base}/`);
  }

  async function pending(root: string | null): Promise<PendingUpload[]> {
    const records = new Map<string, UploadRecord>();
    for (const record of await allRecords()) records.set(record.uploadId, record);
    // Uploads in memory are newer than their records between flushes.
    for (const upload of uploads.values()) records.set(upload.record.uploadId, upload.record);
    return [...records.values()]
      .filter((record) => !record.completedPath)
      .filter((record) => !root || isUnder(record.dir, root))
      .filter((record) => Date.now() - record.updatedAt < KEEP_MS)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((record) => ({
        uploadId: record.uploadId,
        dir: record.dir,
        name: record.name,
        size: record.size,
        lastModified: record.lastModified,
        receivedBytes: coveredBytes(record.received),
        updatedAt: new Date(record.updatedAt).toISOString(),
      }));
  }

  /** Removes uploads nobody resumed within KEEP_MS, part files included. */
  async function sweepStale(): Promise<void> {
    const now = Date.now();
    for (const saved of await allRecords()) {
      await mutate(saved.uploadId, async () => {
        const record = await readRecord(saved.uploadId);
        if (!record || uploads.has(record.uploadId) || now - record.updatedAt < KEEP_MS) return;
        try {
          const dir = await locate(record.dir);
          await dir.host.remove(record.partPath);
          await deleteRecord(record.uploadId);
        } catch {
          // Retain the record until its remote part file has actually been removed.
        }
      });
    }
  }

  const memorySweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, upload] of uploads) {
      if (now - upload.lastUsed <= IDLE_MS) continue;
      void mutate(id, async () => {
        const current = uploads.get(id);
        if (!current || Date.now() - current.lastUsed <= IDLE_MS) return;
        await flushNow(current);
        uploads.delete(id);
      }).catch(() => undefined);
    }
    for (const [id, download] of downloads) if (now - download.lastUsed > IDLE_MS) downloads.delete(id);
  }, 60_000);
  memorySweeper.unref();
  const firstSweep = setTimeout(() => void sweepStale().catch(() => undefined), 20_000);
  firstSweep.unref();
  const staleSweeper = setInterval(() => void sweepStale().catch(() => undefined), SWEEP_MS);
  staleSweeper.unref();

  async function openDownload(location: Located): Promise<{ transferId: string; path: string; name: string; size: number }> {
    const stats = await statLocated(location);
    if (downloads.size >= 32) throw new Error("Too many downloads are open");
    const transferId = randomUUID();
    downloads.set(transferId, { location, size: stats.size, lastUsed: Date.now() });
    return { transferId, path: location.ref, name: path.basename(location.path), size: stats.size };
  }

  async function readDownload(input: { transferId: string; offset: number }): Promise<{ base64: string }> {
    const download = downloads.get(input.transferId);
    if (!download) throw new Error("This download expired. Start it again.");
    download.lastUsed = Date.now();
    const length = Math.max(0, Math.min(CHUNK_BYTES, download.size - input.offset));
    const data = await download.location.host.readRange(download.location.path, input.offset, length);
    if (data.length < length) throw new Error("The file changed while it was being downloaded.");
    return { base64: data.toString("base64") };
  }

  async function dispose(): Promise<void> {
    stopped = true;
    clearInterval(memorySweeper);
    clearInterval(staleSweeper);
    clearTimeout(firstSweep);
    await mutate.drain();
    // Unfinished uploads stay resumable: save their progress, keep their part files.
    await Promise.all([...uploads.values()].map((upload) => flushNow(upload).catch(() => undefined)));
    uploads.clear();
    downloads.clear();
  }

  function change<T>(id: string, task: () => Promise<T>): Promise<T> {
    if (stopped) return Promise.reject(new Error("Transfers are closed"));
    return mutate(id, task);
  }
  return {
    begin: (dir: Located, input: Parameters<typeof begin>[1]) => change(input.uploadId ?? "new", () => capacity("capacity", () => begin(dir, input))),
    write: (input: Parameters<typeof write>[0]) => change(input.uploadId, () => write(input)),
    finish: (input: Parameters<typeof finish>[0]) => change(input.uploadId, () => {
      const path = finished.get(input.uploadId);
      return path ? Promise.resolve({ path }) : finish(input);
    }),
    abort: (id: string) => change(id, () => abort(id)),
    pending,
    sweepStale,
    openDownload,
    readDownload,
    closeDownload: (transferId: string) => void downloads.delete(transferId),
    dispose,
  };
}
