import { randomUUID } from "node:crypto";
import { constants, promises as fs, type BigIntStats } from "node:fs";
import path from "node:path";
import { CHUNK_BYTES, MAX_FILE_BYTES } from "../shared/download";

// A transfer nobody reads from for this long is dropped.
const IDLE_MS = 10 * 60 * 1000;
const SWEEP_MS = 60 * 1000;

interface Transfer {
  filePath: string;
  size: number;
  snapshot: BigIntStats;
  lastUsed: number;
}

function checkFile(current: BigIntStats, snapshot: BigIntStats) {
  if (!current.isFile() || current.dev !== snapshot.dev || current.ino !== snapshot.ino ||
      current.size !== snapshot.size || current.mtimeNs !== snapshot.mtimeNs || current.ctimeNs !== snapshot.ctimeNs) {
    throw new Error("The file changed while it was being downloaded.");
  }
}

export interface TransferStore {
  open(filePath: string): Promise<{ transferId: string; name: string; size: number }>;
  read(transferId: string, offset: number): Promise<{ base64: string; nextOffset: number; done: boolean }>;
  close(transferId: string): void;
  dispose(): void;
}

export function createTransferStore(): TransferStore {
  const transfers = new Map<string, Transfer>();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, transfer] of transfers) {
      if (now - transfer.lastUsed > IDLE_MS) transfers.delete(id);
    }
  }, SWEEP_MS);
  sweep.unref();

  return {
    async open(filePath) {
      if (!path.isAbsolute(filePath)) throw new Error(`Not an absolute path: ${filePath}`);
      const stats = await fs.stat(filePath, { bigint: true }).catch(() => null);
      if (!stats) throw new Error(`File not found: ${filePath}`);
      if (!stats.isFile()) throw new Error(`Not a regular file: ${filePath}`);
      if (stats.size > BigInt(MAX_FILE_BYTES)) throw new Error("The file is larger than 1 GB.");
      const size = Number(stats.size);
      const transferId = randomUUID();
      transfers.set(transferId, { filePath, size, snapshot: stats, lastUsed: Date.now() });
      return { transferId, name: path.basename(filePath), size };
    },

    async read(transferId, offset) {
      const transfer = transfers.get(transferId);
      if (!transfer) throw new Error("This download expired. Start it again.");
      transfer.lastUsed = Date.now();
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > transfer.size) throw new Error("Invalid download offset.");
      const length = Math.min(CHUNK_BYTES, transfer.size - offset);
      const handle = await fs.open(transfer.filePath, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        checkFile(await handle.stat({ bigint: true }), transfer.snapshot);
        const buffer = Buffer.alloc(length);
        let bytesRead = 0;
        while (bytesRead < length) {
          const result = await handle.read(buffer, bytesRead, length - bytesRead, offset + bytesRead);
          if (result.bytesRead === 0) throw new Error("The file changed while it was being downloaded.");
          bytesRead += result.bytesRead;
        }
        checkFile(await handle.stat({ bigint: true }), transfer.snapshot);
        const nextOffset = offset + length;
        return { base64: buffer.toString("base64"), nextOffset, done: nextOffset === transfer.size };
      } finally {
        await handle.close();
      }
    },

    close(transferId) {
      transfers.delete(transferId);
    },

    dispose() {
      clearInterval(sweep);
      transfers.clear();
    },
  };
}
