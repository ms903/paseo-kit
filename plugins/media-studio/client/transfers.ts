import { baseName } from "../shared/media";
import {
  CHUNK_BYTES,
  downloadCloseRpc,
  downloadOpenRpc,
  downloadReadRpc,
  uploadAbortRpc,
  uploadBeginRpc,
  uploadFinishRpc,
  uploadWriteRpc,
  type ByteRange,
  type PendingUpload,
} from "../shared/rpc";
import { addTransfer, getPluginClient, notifyUploaded, updateTransfer } from "./state";
import { SaveCanceledError, fileFingerprint, base64ToBytes, bytesToBase64, openSaveSink, type WebFile } from "./web";

/** Pieces in flight per upload; enough to fill a link with a 100 ms round trip. */
const UPLOAD_PARALLEL = 4;
/**
 * Upload pieces share the Paseo connection with everything else, so they are kept small: a 1 MB
 * piece is a 1.4 MB message that agent updates can interleave with. Through a Cloudflare tunnel
 * the connection's upstream is the limit, not the piece size or count.
 */
const UPLOAD_PIECE_BYTES = 1024 * 1024;
/** Files uploaded at once. */
const FILES_PARALLEL = 2;
/**
 * Consecutive failed attempts without progress before a transfer gives up. With the backoff below
 * that is about five minutes, enough to ride out a reconnect, a plugin reload or a daemon restart.
 */
const MAX_ATTEMPTS = 12;
const MAX_BACKOFF_MS = 30_000;

/** Errors that another attempt cannot fix. */
const FATAL = /Upload file does not match|quota reached|Invalid file name|Not an absolute|past the end|must start at multiples|too large|No space left|ENOSPC|Permission denied|EACCES|EROFS|not an allowed SSH host/i;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function backoff(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.max(0, attempt - 1));
}

class Stopped extends Error {}

interface UploadJob {
  transferId: string;
  file: WebFile;
  dir: string;
  uploadId: string | null;
  fingerprint?: string;
  /** What the host already had on the first attempt, so the row can say the upload resumed. */
  resumedFrom: number | null;
  /**
   * Set by pause or cancel; the running pass stops after its pieces in flight. `handover`: this
   * copy of the plugin is unloading and a reloaded copy takes the upload over.
   */
  stop: "pause" | "cancel" | "handover" | null;
  /** Whether the user paused it, so a reloaded copy keeps it paused. */
  paused: boolean;
  running: Promise<string | null> | null;
  wake: (() => void) | null;
}

/** Waits `ms`, or less when the user pauses or cancels. */
function wait(job: UploadJob, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      job.wake = null;
      resolve();
    }, ms);
    job.wake = () => {
      clearTimeout(timer);
      job.wake = null;
      resolve();
    };
  });
}

function covers(ranges: readonly ByteRange[], start: number, end: number): boolean {
  return ranges.some(([from, to]) => from <= start && to >= end);
}

/**
 * One attempt: ask the daemon what it already has, send the missing pieces, finish. Throws on the
 * first failed piece; the caller decides whether to try again.
 */
async function uploadPass(job: UploadJob, onProgress: () => void): Promise<string> {
  const { rpc } = getPluginClient();
  const { file } = job;
  job.fingerprint ??= await fileFingerprint(file, () => job.stop !== null);
  if (job.stop) throw new Stopped(job.stop);
  const begun = await rpc(uploadBeginRpc, { dir: job.dir, name: file.name, size: file.size, lastModified: file.lastModified ?? null, uploadId: job.uploadId, fingerprint: job.fingerprint });
  job.uploadId = begun.uploadId;
  if (job.resumedFrom === null) job.resumedFrom = begun.receivedBytes;
  updateTransfer(job.transferId, { uploadId: begun.uploadId, done: begun.receivedBytes, resumedFrom: job.resumedFrom });
  const missing: number[] = [];
  for (let offset = 0; offset < file.size; offset += UPLOAD_PIECE_BYTES) {
    if (!covers(begun.received, offset, Math.min(file.size, offset + UPLOAD_PIECE_BYTES))) missing.push(offset);
  }
  let failure: unknown = null;
  const worker = async () => {
    for (;;) {
      if (failure !== null || job.stop) return;
      const offset = missing.shift();
      if (offset === undefined) return;
      try {
        const end = Math.min(file.size, offset + UPLOAD_PIECE_BYTES);
        const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
        const result = await rpc(uploadWriteRpc, { uploadId: begun.uploadId, offset, base64: bytesToBase64(bytes) });
        updateTransfer(job.transferId, { done: result.received });
        onProgress();
      } catch (error) {
        failure ??= error;
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: UPLOAD_PARALLEL }, worker));
  if (job.stop) throw new Stopped(job.stop);
  if (failure !== null) throw failure;
  const { path } = await rpc(uploadFinishRpc, { uploadId: begun.uploadId });
  return path;
}

/** Runs passes until the upload lands, retrying with backoff while the connection comes back. */
async function runUpload(job: UploadJob): Promise<string | null> {
  job.stop = null;
  job.paused = false;
  updateTransfer(job.transferId, { status: "running", error: null, retryAt: null, ...controls(job, "running") });
  let attempt = 0;
  for (;;) {
    let progressed = false;
    try {
      const path = await uploadPass(job, () => {
        progressed = true;
      });
      jobs.delete(job);
      updateTransfer(job.transferId, { status: "done", done: job.file.size, resultPath: path, retryAt: null, ...controls(job, "done") });
      notifyUploaded(path);
      return path;
    } catch (error) {
      if (job.stop === "cancel" || job.stop === "handover") return null;
      if (job.stop === "pause") {
        job.paused = true;
        updateTransfer(job.transferId, { status: "paused", retryAt: null, ...controls(job, "paused") });
        return null;
      }
      if (progressed) attempt = 0;
      attempt += 1;
      if (FATAL.test(message(error)) || attempt > MAX_ATTEMPTS) {
        // The bytes stay on the host: Resume here, or later from the unfinished uploads list.
        updateTransfer(job.transferId, { status: "failed", error: message(error), retryAt: null, ...controls(job, "failed") });
        return null;
      }
      const delay = backoff(attempt);
      updateTransfer(job.transferId, { status: "retrying", error: message(error), retryAt: Date.now() + delay });
      await wait(job, delay);
      if (job.stop === "cancel" || job.stop === "handover") return null;
      if (job.stop === "pause") {
        job.paused = true;
        updateTransfer(job.transferId, { status: "paused", retryAt: null, ...controls(job, "paused") });
        return null;
      }
      updateTransfer(job.transferId, { status: "running", retryAt: null });
    }
  }
}

function start(job: UploadJob): Promise<string | null> {
  const running = runUpload(job).finally(() => {
    if (job.running === running) job.running = null;
  });
  job.running = running;
  return running;
}

/** The buttons a transfer row shows in each state. */
function controls(job: UploadJob, state: "running" | "paused" | "failed" | "done") {
  const pause = () => {
    job.stop = "pause";
    job.wake?.();
  };
  const resume = () => {
    if (!job.running) void start(job);
  };
  const cancel = () => {
    job.stop = "cancel";
    job.wake?.();
    jobs.delete(job);
    updateTransfer(job.transferId, { status: "canceled", retryAt: null, cancel: null, pause: null, resume: null });
    const { rpc } = getPluginClient();
    const discard = (uploadId: string) => void rpc(uploadAbortRpc, { uploadId }).catch(() => undefined);
    // Wait for pieces in flight, so none lands after the part file is gone.
    void (job.running ?? Promise.resolve(null)).then(() => {
      if (job.uploadId) discard(job.uploadId);
      return undefined;
    });
  };
  if (state === "running") return { pause, resume: null, cancel };
  if (state === "paused" || state === "failed") return { pause: null, resume, cancel };
  return { pause: null, resume: null, cancel: null };
}

/** Uploads of this copy of the plugin that have not landed or been canceled. */
const jobs = new Set<UploadJob>();

function createJob(file: WebFile, dir: string, resumedFrom: number | null = null): UploadJob {
  const job: UploadJob = { transferId: "", file, dir, uploadId: null, resumedFrom, stop: null, paused: false, running: null, wake: null };
  job.transferId = addTransfer({ kind: "upload", name: file.name, target: dir, total: file.size });
  jobs.add(job);
  return job;
}

// When Paseo reloads the plugin (an update, a reload, a host reconnect), this module is evaluated
// again and the old copy's state is gone, but the page and the picked files are not. The unloading
// copy leaves its unfinished uploads on the page's global object, keyed by the daemon's server ID,
// and the new copy for the same daemon picks them up and continues; the daemon already has the
// bytes, so they resume. Files picked in this page stay readable for as long as the page lives.
interface HandedOver {
  file: WebFile;
  dir: string;
  paused: boolean;
  uploadId: string | null;
  resumedFrom: number | null;
}
// A selection can contain more files than the workers can run. Keep the waiting files available
// to the next plugin instance as well as those that already have an upload ID.
const waiting = new Set<HandedOver>();
type Handover = Record<string, HandedOver[]>;
const HANDOVER_KEY = "__paseoMediaStudioUploads";
let serverId: string | null = null;

/** The daemon's server ID once known: scopes what this client remembers per host. */
export function currentServerId(): string | null {
  return serverId;
}

function handoverStore(): Handover {
  const holder = globalThis as unknown as Record<string, Handover | undefined>;
  holder[HANDOVER_KEY] ??= {};
  return holder[HANDOVER_KEY]!;
}

/** Called when this copy of the plugin unloads. */
export function handOverUploads(): void {
  if (serverId && (jobs.size || waiting.size)) {
    const store = handoverStore();
    store[serverId] = [
      ...(store[serverId] ?? []),
      ...[...jobs].map((job) => ({ file: job.file, dir: job.dir, paused: job.paused || job.stop === "pause", uploadId: job.uploadId, resumedFrom: job.resumedFrom })),
      ...waiting,
    ];
  }
  waiting.clear();
  serverId = null;
  for (const job of jobs) {
    job.stop = "handover";
    job.wake?.();
  }
  jobs.clear();
}

/** Called when this copy of the plugin loads: learns the daemon's ID and continues handed-over uploads. */
export async function adoptUploads(signal: AbortSignal): Promise<void> {
  const { paseo } = getPluginClient();
  for (let attempt = 1; attempt <= 10 && !signal.aborted; attempt += 1) {
    try {
      // The SDK reports the identity of this installation's daemon, independently of its media tools.
      const { self } = await paseo.hosts.list();
      if (signal.aborted || !self.serverId) return;
      serverId = self.serverId;
      break;
    } catch {
      if (signal.aborted || attempt === 10) return;
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, 1000 * attempt);
        signal.addEventListener("abort", finish, { once: true });
      });
    }
  }
  if (!serverId || signal.aborted) return;
  const store = handoverStore();
  const entries = store[serverId] ?? [];
  delete store[serverId];
  await uploadQueue(entries);
}

async function uploadQueue(entries: HandedOver[]): Promise<string[]> {
  for (const entry of entries) waiting.add(entry);
  const done: string[] = [];
  let index = 0;
  const worker = async () => {
    while (index < entries.length) {
      const entry = entries[index++];
      if (!waiting.delete(entry)) return; // already handed to the next plugin instance
      const job = createJob(entry.file, entry.dir, entry.resumedFrom);
      job.uploadId = entry.uploadId;
      if (entry.paused) {
        job.paused = true;
        updateTransfer(job.transferId, { status: "paused", resumedFrom: entry.resumedFrom ?? 0, ...controls(job, "paused") });
      } else {
        const path = await start(job);
        if (path) done.push(path);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(FILES_PARALLEL, entries.length) }, worker));
  return done;
}

/** Uploads files into `dir` (a daemon folder or alias:/path). Resolves with the paths that landed. */
export function uploadFiles(files: readonly WebFile[], dir: string): Promise<string[]> {
  return uploadQueue(files.map((file) => ({ file, dir, paused: false, uploadId: null, resumedFrom: null })));
}

/** Whether `file` is the file an unfinished upload started from: same name, size and modification time. */
export function matchesPending(file: WebFile, pending: PendingUpload): boolean {
  if (file.name !== pending.name || file.size !== pending.size) return false;
  return pending.lastModified === null || file.lastModified === undefined || file.lastModified === pending.lastModified;
}

/** Continues an unfinished upload with the file the user picked again; sends only what is missing. */
export function resumePending(pending: PendingUpload, file: WebFile): Promise<string[]> {
  if (!matchesPending(file, pending)) throw new Error(`Pick the same file: ${pending.name}`);
  const job = createJob(file, pending.dir);
  job.uploadId = pending.uploadId;
  return start(job).then((path) => path ? [path] : []);
}

/** Discards an unfinished upload and the bytes already on the host. */
export async function discardPending(pending: PendingUpload): Promise<void> {
  await getPluginClient().rpc(uploadAbortRpc, { uploadId: pending.uploadId });
}

/**
 * Downloads a daemon file to this device. Call it straight from a press handler with the size you
 * know, so a large file can open the browser's save dialog during the gesture. A piece that fails
 * is fetched again after a pause, reopening the download if the daemon forgot it.
 */
export async function downloadFile(path: string, size: number, cwd?: string | null): Promise<void> {
  const name = baseName(path.replace(/^[^/:]+:(?=\/)/, ""));
  let sink;
  try {
    sink = await openSaveSink(name, size);
  } catch (error) {
    if (error instanceof SaveCanceledError) return;
    throw error;
  }
  const { rpc } = getPluginClient();
  let canceled = false;
  let wake: (() => void) | null = null;
  let transferId: string | null = null;
  const id = addTransfer({
    kind: "download",
    name,
    target: path,
    total: size,
    cancel: () => {
      canceled = true;
      wake?.();
      updateTransfer(id, { status: "canceled", cancel: null, retryAt: null });
    },
  });
  const open = async () => {
    const transfer = await rpc(downloadOpenRpc, { path, cwd });
    transferId = transfer.transferId;
    return transfer;
  };
  /** One piece, retried with backoff; the stream stays in order because pieces are awaited in order. */
  const readPiece = async (offset: number) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        if (!transferId) await open();
        const piece = await rpc(downloadReadRpc, { transferId: transferId!, offset });
        updateTransfer(id, { status: "running", retryAt: null });
        return piece;
      } catch (error) {
        if (canceled) throw new Stopped("cancel");
        const text = message(error);
        if (/changed while|not found|Not a file/i.test(text) || attempt >= MAX_ATTEMPTS) throw error;
        if (/expired/i.test(text)) transferId = null;
        const delay = backoff(attempt);
        updateTransfer(id, { status: "retrying", error: text, retryAt: Date.now() + delay });
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = null;
      }
    }
  };
  try {
    const transfer = await open();
    updateTransfer(id, { total: transfer.size });
    // Two reads in flight hide the round trip; pieces are written in order.
    let next = 0;
    let pending = transfer.size > 0 ? readPiece(0) : null;
    while (pending) {
      const offset = next;
      next += CHUNK_BYTES;
      const following = next < transfer.size ? readPiece(next) : null;
      const piece = await pending;
      if (canceled) {
        void following?.catch(() => undefined);
        await sink.abort();
        return;
      }
      const bytes = base64ToBytes(piece.base64);
      await sink.write(bytes);
      updateTransfer(id, { done: Math.min(transfer.size, offset + bytes.length) });
      pending = following;
    }
    await sink.close();
    updateTransfer(id, { status: "done", done: transfer.size, cancel: null, retryAt: null });
  } catch (error) {
    await sink.abort().catch(() => undefined);
    if (!canceled) updateTransfer(id, { status: "failed", error: message(error), cancel: null, retryAt: null });
  } finally {
    if (transferId) void rpc(downloadCloseRpc, { transferId }).catch(() => undefined);
  }
}
