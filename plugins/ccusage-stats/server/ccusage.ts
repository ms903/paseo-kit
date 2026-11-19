import { execFile, type ExecFileException } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

// ccusage 20 ships a native binary per platform; the `ccusage` npm package is only a launcher.
// The daemon evaluates the server bundle without a module path, so `require.resolve` cannot find
// our node_modules. Instead, find our own directory among the plugins the daemon has registered,
// then fall back to a `ccusage` on PATH.
const NATIVE_PACKAGE = `@ccusage/ccusage-${process.platform}-${process.arch}`;
const BINARY_NAME = process.platform === "win32" ? "ccusage.exe" : "ccusage";
const RUN_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export function paseoHome(): string {
  return process.env.PASEO_HOME || path.join(os.homedir(), ".paseo");
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Plugin directories from the daemon config: `plugins.<id>.path`. */
function registeredPluginDirectories(): string[] {
  try {
    const config = JSON.parse(readFileSync(path.join(paseoHome(), "config.json"), "utf8")) as {
      plugins?: Record<string, { path?: unknown }>;
    };
    return Object.values(config.plugins ?? {})
      .map((entry) => entry?.path)
      .filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}

function scannerPackage(directory: string): { dependencies?: Record<string, unknown> } | undefined {
  try {
    const manifest = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")) as {
      name?: unknown;
      dependencies?: Record<string, unknown>;
    };
    if (manifest.name === "ccusage-stats") return manifest;
  } catch {
    return undefined;
  }
}

export interface CcusageBinary {
  file: string;
  source: "local" | "bundled" | "path";
}

export function locateCcusage(): CcusageBinary {
  // Only our own install: never run a binary out of another plugin's directory.
  for (const directory of registeredPluginDirectories()) {
    const manifest = scannerPackage(directory);
    if (!manifest) continue;
    const modules = path.join(directory, "node_modules");
    const version = manifest.dependencies?.ccusage;
    if (typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version)) {
      const local = path.join(modules, ".paseo-ccusage", version, BINARY_NAME);
      if (isExecutable(local)) return { file: local, source: "local" };
    }
    const file = path.join(modules, NATIVE_PACKAGE, "bin", BINARY_NAME);
    if (isExecutable(file)) return { file, source: "bundled" };
  }
  return { file: "ccusage", source: "path" };
}

const rawUsage = {
  inputTokens: z.number().default(0),
  outputTokens: z.number().default(0),
  cacheCreationTokens: z.number().default(0),
  cacheReadTokens: z.number().default(0),
};

const rawModel = z.object({
  modelName: z.string(),
  cost: z.number().default(0),
  missingPricing: z.boolean().optional(),
  costPending: z.literal(true).optional(),
  ...rawUsage,
});

const rawAgentRow = z.object({
  agent: z.string(),
  totalTokens: z.number().default(0),
  totalCost: z.number().default(0),
  modelBreakdowns: z.array(rawModel).default([]),
  ...rawUsage,
});

const rawRow = rawAgentRow.extend({
  period: z.string(),
  agents: z.array(rawAgentRow).optional(),
  metadata: z.object({ lastActivity: z.string().optional(), projectPath: z.string().nullish() }).optional(),
});

export const reportRows = z.array(rawRow);

export type RawModel = z.infer<typeof rawModel>;
export type RawAgentRow = z.infer<typeof rawAgentRow>;
export type RawRow = z.infer<typeof rawRow>;
export type RawReport = Record<"daily" | "weekly" | "monthly" | "session", RawRow[]>;
export type ScanKind = "daily" | "session";

export function describeCcusageFailure(
  { code, killed, signal }: Pick<ExecFileException, "code" | "killed" | "signal">,
  stderr: string,
  kind: ScanKind,
): string {
  if (code === "ENOENT") return "ccusage executable was not found";
  if (code === "EACCES" || code === "EPERM") return "Permission denied when starting ccusage";
  if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "ccusage output exceeded the size limit";
  if (code === "ABORT_ERR") return "ccusage was cancelled";
  if (killed && signal === "SIGTERM") return `ccusage ${kind} scan timed out after ${RUN_TIMEOUT_MS / 1000} seconds`;
  if (signal) return `ccusage was terminated (${signal})`;

  const status = code == null ? "ccusage exited" : `ccusage exited (${code})`;
  const detail = stderr.trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 280);
  return detail ? `${status}. ${detail}` : status;
}

export function runCcusage(kind: ScanKind, timezone: string, signal: AbortSignal, since?: string, until?: string): Promise<RawRow[]> {
  const binary = locateCcusage();
  const args = [
    kind,
    "--json",
    "--offline",
    "--by-agent",
    "--timezone",
    timezone,
    "--no-color",
  ];
  if (since) args.push("--since", since);
  if (until) args.push("--until", until);
  return new Promise((resolve, reject) => {
    const child = execFile(
      binary.file,
      args,
      {
        timeout: RUN_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        signal,
        // The plugin's SQLite reader supplies Antigravity.
        env: { ...process.env, NO_COLOR: "1", ANTIGRAVITY_DATA_DIR: "" },
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(describeCcusageFailure(error, stderr, kind)));
          return;
        }
        try {
          resolve(reportRows.parse(JSON.parse(stdout)[kind]));
        } catch (parseError) {
          reject(new Error(`Unexpected ccusage output: ${(parseError as Error).message}`));
        }
      },
    );
    if (child.pid) {
      try {
        const priority = os.constants.priority.PRIORITY_BELOW_NORMAL;
        if (os.getPriority(child.pid) < priority) os.setPriority(child.pid, priority);
      } catch {
        // Some hosts restrict changing the scheduling priority.
      }
    }
  });
}
