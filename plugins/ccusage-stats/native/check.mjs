import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

const plugin = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(path.join(plugin, "package.json"), "utf8"));
const version = manifest.dependencies.ccusage;
const binary = process.platform === "win32" ? "ccusage.exe" : "ccusage";
const upstream = path.join(plugin, "node_modules", "@ccusage", `ccusage-${process.platform}-${process.arch}`, "bin", binary);
const scanner = path.join(plugin, "node_modules", ".paseo-ccusage", version, binary);
const fixture = await mkdtemp(path.join(tmpdir(), "paseo-ccusage-check-"));

try {
  const claude = path.join(fixture, "claude");
  const project = path.join(claude, "projects", "paseo-fixture");
  await mkdir(project, { recursive: true });
  const log = [
    ["2026-11-18T16:15:00.000Z", 12],
    ["2026-11-19T16:15:00.000Z", 24],
  ].map(([timestamp, tokens]) => JSON.stringify({
    type: "assistant", version: "2.1.268", sessionId: "paseo-scanner-fixture",
    timestamp, requestId: `req_${tokens}`,
    message: {
      id: `msg_${tokens}`, role: "assistant", model: "claude-fable-5-1",
      usage: { input_tokens: tokens, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  })).join("\n");
  await writeFile(path.join(project, "paseo-scanner-fixture.jsonl"), log + "\n");
  const config = path.join(fixture, "ccusage.json");
  await writeFile(config, "{}");
  const env = {
    ...process.env, CLAUDE_CONFIG_DIR: claude, XDG_CONFIG_HOME: path.join(fixture, "config"),
    XDG_CACHE_HOME: path.join(fixture, "cache"), XDG_DATA_HOME: path.join(fixture, "data"),
    ANTIGRAVITY_DATA_DIR: "", NO_COLOR: "1", LOG_LEVEL: "0",
  };
  function report(file, kind, bounds) {
    const flags = [kind, "--json", "--offline", "--by-agent", "--timezone", "Asia/Hong_Kong", "--no-color", "--config", config, ...bounds];
    return JSON.parse(execFileSync(file, flags, { cwd: fixture, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  }
  const windows = [
    { bounds: ["--since", "2026-11-20"], inputTokens: 24 },
    { bounds: ["--since", "2026-11-19", "--until", "2026-11-19"], inputTokens: 12 },
    { bounds: ["--until", "2026-11-20"], inputTokens: 36 },
  ];
  for (const kind of ["daily", "session"]) {
    for (const { bounds, inputTokens } of windows) {
      const reference = report(upstream, kind, bounds);
      const actual = report(scanner, kind, bounds);
      assert.ok(isDeepStrictEqual(actual, reference), `The offline scanner diverged from upstream for ${kind} ${bounds.join(" ")}`);
      const rows = kind === "session"
        ? actual.session.filter((row) => row.agent === "claude" && row.period === "paseo-scanner-fixture")
        : actual.daily.flatMap((row) => row.agents?.filter((agent) => agent.agent === "claude") ?? []);
      assert.equal(rows.reduce((sum, row) => sum + row.inputTokens, 0), inputTokens);
      assert.ok(rows.every((row) => row.totalCost > 0), "Expected the pinned offline pricing snapshot");
    }
  }
  console.log(`Daily and session reports match ccusage ${version} in all three date windows`);
} finally {
  await rm(fixture, { recursive: true, force: true });
}
