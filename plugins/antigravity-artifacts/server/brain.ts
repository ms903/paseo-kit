import { constants as fs } from "node:fs";
import { lstat, open, opendir, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { artifactPath, isArtifactSegment, MAX_DEPTH, uuid, type Artifact } from "../shared/artifacts";

const DIR = fs.O_RDONLY | fs.O_DIRECTORY | fs.O_NOFOLLOW;
const FILE = fs.O_RDONLY | fs.O_NOFOLLOW | fs.O_NONBLOCK;
const MAX_TEXT_BYTES = 128 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const imageMimes: ReadonlyMap<string, string> = new Map([
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".webp", "image/webp"], [".gif", "image/gif"],
]);
const textExtensions = new Set([
  ".md", ".markdown", ".txt", ".csv", ".tsv", ".log", ".json", ".jsonl", ".yaml", ".yml", ".toml",
  ".py", ".js", ".ts", ".jsx", ".tsx", ".sql", ".sh", ".html", ".css", ".patch", ".diff",
]);
const fileExtensions = new Set([".pdf", ".docx", ".xlsx", ".zip", ".mp4", ".webm", ".mp3", ".wav"]);

function kindFor(name: string): Artifact["kind"] | undefined {
  const lower = name.toLowerCase();
  if (lower.endsWith(".metadata.json")) return;
  const ext = path.extname(lower);
  if (imageMimes.has(ext)) return "image";
  if (textExtensions.has(ext)) return "text";
  if (fileExtensions.has(ext)) return "file";
}

/** On Linux a live directory descriptor keeps pathname lookup anchored during renames. */
function childPath(parent: FileHandle, name: string): string {
  return `/proc/self/fd/${parent.fd}/${name}`;
}

async function inDirectory<T>(target: string, segments: readonly string[], use: (dir: FileHandle) => Promise<T>): Promise<T> {
  const dir = await open(target, DIR);
  try {
    const [child, ...remaining] = segments;
    return child ? await inDirectory(childPath(dir, child), remaining, use) : await use(dir);
  } finally {
    await dir.close();
  }
}

function unavailable(error: unknown): boolean {
  return ["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "");
}

export function scanBudget() {
  return { entries: 500, directories: 32, limited: false };
}

export async function scanConversation(
  brain: string, owner: Pick<Artifact, "ownerAgentId" | "ownerTitle" | "conversationId">, budget: ReturnType<typeof scanBudget>,
): Promise<Artifact[]> {
  const items: Artifact[] = [];
  async function scan(dir: FileHandle, prefix: string, depth: number) {
    if (budget.directories === 0) {
      budget.limited = true;
      return;
    }
    budget.directories--;
    const entries = await opendir(`/proc/self/fd/${dir.fd}`);
    try {
      while (budget.entries > 0) {
        const entry = await entries.read();
        if (!entry) return;
        budget.entries--;
        if (!isArtifactSegment(entry.name)) continue;
        const relative = prefix + entry.name;
        const target = childPath(dir, entry.name);
        try {
          if (entry.isDirectory() && depth < MAX_DEPTH && budget.directories > 0) {
            await inDirectory(target, [], (child) => scan(child, `${relative}/`, depth + 1));
          } else if (entry.isDirectory()) {
            budget.limited = true;
          } else if (entry.isFile()) {
            const kind = kindFor(entry.name);
            if (!kind) continue;
            const info = await lstat(target);
            if (!info.isFile() || info.nlink !== 1) continue;
            items.push({ ...owner, path: relative, kind, bytes: info.size, modifiedAt: info.mtimeMs });
          }
        } catch (error) {
          if (!unavailable(error)) throw error;
        }
      }
      budget.limited = true;
    } finally {
      await entries.close();
    }
  }

  try {
    await inDirectory("/", [...path.resolve(brain).split("/").filter(Boolean), uuid.parse(owner.conversationId)], (dir) => scan(dir, "", 1));
  } catch (error) {
    if (!unavailable(error)) throw error;
  }
  return items;
}

export async function previewArtifact(brain: string, conversationId: string, relativePath: string) {
  const parts = artifactPath.parse(relativePath).split("/");
  const name = parts.pop()!;
  const kind = kindFor(name);
  if (!kind) throw new Error("Unsupported artifact.");

  const absolutePath = path.join(brain, conversationId, relativePath);
  const ancestors = [...path.resolve(brain).split("/").filter(Boolean), uuid.parse(conversationId), ...parts];
  return inDirectory("/", ancestors, async (dir) => {
    const file = await open(childPath(dir, name), FILE);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1) throw new Error("Artifact is unavailable.");
      if (kind === "file") return { kind, absolutePath } as const;
      const limit = kind === "image" ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES;
      if (kind === "image" && info.size > limit) return { kind: "tooLarge", absolutePath } as const;
      const buffer = Buffer.alloc(Math.min(info.size, limit + 1));
      let count = 0;
      while (count < buffer.length) {
        const { bytesRead } = await file.read(buffer, count, buffer.length - count, count);
        if (!bytesRead) break;
        count += bytesRead;
      }
      const content = buffer.subarray(0, Math.min(count, limit));
      if (kind === "image") {
        const mime = imageMimes.get(path.extname(name).toLowerCase());
        return { kind, absolutePath, dataUri: `data:${mime};base64,${content.toString("base64")}` } as const;
      }
      const truncated = count > limit;
      const text = new TextDecoder().decode(content, { stream: truncated });
      return { kind, absolutePath, truncated, text } as const;
    } finally {
      await file.close();
    }
  });
}
