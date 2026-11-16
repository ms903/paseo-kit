import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { keyedQueue } from "./queue";
import type { ReviewNote } from "../shared/rpc";

// Review notes sent from the player, kept per file on the daemon host so every client sees the
// same history and the same timeline markers. Notes are keyed by the file's path; each remembers
// the file version it was written about, so the player can mark notes on an earlier render.

const NOTES_DIR = path.join(
  process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
  "paseo-media-studio",
  "notes",
);
const MAX_NOTES = 500;
let storedBytes: number | null = null;
let measuredAt = 0;
async function noteBytes(): Promise<number> {
  if (storedBytes !== null && Date.now() - measuredAt < 60_000)
    return storedBytes;
  let total = 0;
  const dir = await fs.opendir(NOTES_DIR).catch(() => null);
  if (dir)
    for await (const entry of dir) {
      if (entry.isFile())
        total +=
          (await fs.stat(path.join(NOTES_DIR, entry.name)).catch(() => null))
            ?.size ?? 0;
    }
  measuredAt = Date.now();
  storedBytes = total;
  return total;
}

function notesFile(ref: string): string {
  return path.join(
    NOTES_DIR,
    `${createHash("sha1").update(ref).digest("hex")}.json`,
  );
}

export async function listNotes(ref: string): Promise<ReviewNote[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(notesFile(ref), "utf8")) as {
      notes?: ReviewNote[];
    };
    return parsed.notes ?? [];
  } catch {
    return [];
  }
}

const enqueue = keyedQueue();

/** Appends a note; writes for one file run one at a time so none is lost. */
export function addNote(
  ref: string,
  note: Omit<ReviewNote, "id" | "createdAt">,
): Promise<ReviewNote> {
  const run = async () => {
    const notes = await listNotes(ref);
    const created: ReviewNote = {
      ...note,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    notes.push(created);
    await fs.mkdir(NOTES_DIR, { recursive: true });
    const file = notesFile(ref);
    const temp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
    const data = JSON.stringify({ path: ref, notes: notes.slice(-MAX_NOTES) });
    const previous = (await fs.stat(file).catch(() => null))?.size ?? 0;
    const bytes = (await noteBytes()) - previous + Buffer.byteLength(data);
    if (bytes > 64 * 1024 * 1024)
      throw new Error("Review notes storage quota reached");
    try {
      await fs.writeFile(temp, data);
      await fs.rename(temp, file);
      storedBytes = bytes;
    } finally {
      await fs.unlink(temp).catch(() => undefined);
    }
    return created;
  };
  return enqueue("notes", run);
}

export async function removeNote(ref: string, id: string): Promise<void> {
  const run = async () => {
    const notes = (await listNotes(ref)).filter((note) => note.id !== id);
    await fs.mkdir(NOTES_DIR, { recursive: true });
    const file = notesFile(ref);
    const temp = `${file}.${randomUUID()}.tmp`;
    const data = JSON.stringify({ path: ref, notes });
    const previous = (await fs.stat(file).catch(() => null))?.size ?? 0;
    const bytes = (await noteBytes()) - previous + Buffer.byteLength(data);
    try {
      await fs.writeFile(temp, data);
      await fs.rename(temp, file);
      storedBytes = bytes;
    } finally {
      await fs.unlink(temp).catch(() => undefined);
    }
  };
  await enqueue("notes", run);
}
