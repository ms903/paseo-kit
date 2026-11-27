import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { discoverPlugins } from "./plugin-projects.mjs";

const run = promisify(execFile);
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run this command with npm run smoke:host.");
const modules = fileURLToPath(new URL("./host-smoke/node_modules/", import.meta.url));
const cli = join(modules, "@getpaseo", "cli", "bin", "paseo");
try {
  await access(cli);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  throw new Error("Install the pinned smoke-test CLI with npm ci --prefix scripts/host-smoke.");
}

const plugins = await discoverPlugins();
const temp = await mkdtemp(join(tmpdir(), "paseo-kit-smoke-"));
const daemonHome = join(temp, "daemon");
const pluginCopies = join(temp, "plugins");
const env = {
  // Run all lifecycle operations against the new daemon even on a host with Paseo configured.
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:PASEO_|PORT$)/i.test(key))),
  PATH: `${join(modules, ".bin")}${delimiter}${process.env.PATH ?? ""}`,
  XDG_CACHE_HOME: join(temp, "cache"),
  XDG_CONFIG_HOME: join(temp, "config"),
  XDG_STATE_HOME: join(temp, "state"),
};

async function paseo(args) {
  try {
    const { stdout } = await run(process.execPath, [cli, ...args, "--home", daemonHome, "--json"], {
      cwd: temp, env, timeout: 60_000,
    });
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`paseo ${args.join(" ")} failed\n${error.stdout ?? ""}${error.stderr ?? ""}`, { cause: error });
  }
}

async function stagePlugin(project) {
  const copy = join(pluginCopies, basename(project));
  await cp(project, copy, {
    recursive: true,
    filter: (source) => !["node_modules", ".git"].includes(basename(source)),
  });
  try {
    await run(process.execPath, [npm, "ci", "--omit=dev", "--no-audit", "--no-fund"], {
      cwd: copy, env, timeout: 60_000,
    });
  } catch (error) {
    throw new Error(`Could not install locked runtime dependencies for ${basename(project)}\n${error.stdout ?? ""}${error.stderr ?? ""}`, { cause: error });
  }
  return copy;
}

function launchDaemon() {
  // A foreground child reaps the supervisor even on runners whose PID 1
  // does not reap detached processes.
  const child = spawn(process.execPath, [cli, "daemon", "run", "--home", daemonHome], {
    cwd: temp, env, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const closed = new Promise((resolve) => child.once("close", (code) => resolve({ code })));
  const ready = new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const diagnostics = (message) => new Error(`${message}\n${stdout}\n${stderr}`);
    const timer = setTimeout(() => finish(diagnostics("Paseo daemon startup timed out")), 45_000);
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk).slice(-16_384);
      if (/Listening on 127\.0\.0\.1:[1-9]\d*/.test(stdout)) finish();
    });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-16_384); });
    child.once("error", finish);
    void closed.then(({ code }) => finish(diagnostics(`Paseo daemon exited before becoming ready (${code})`)));
  });
  return { child, closed, ready };
}

let daemon;
try {
  await mkdir(pluginCopies);
  const staged = [];
  for (const { id, project } of plugins) staged.push({ id, project: await stagePlugin(project) });
  await mkdir(daemonHome);
  await writeFile(join(daemonHome, "config.json"), JSON.stringify({
    version: 1,
    pluginsEnabled: true,
    daemon: {
      listen: "127.0.0.1:0",
      relay: { enabled: false },
      mcp: { enabled: false, injectIntoAgents: false },
      usage: { enabled: false },
      browserTools: { enabled: false },
    },
    features: {
      webUi: { enabled: false },
      dictation: { enabled: false },
      voiceMode: { enabled: false },
    },
  }), { mode: 0o600 });
  daemon = launchDaemon();
  await daemon.ready;
  for (const { id, project } of staged) {
    const installed = await paseo(["plugin", "install", project]);
    assert.equal(installed.id, id);
    assert.equal(installed.status, "running", `${id}: ${installed.error ?? installed.status}`);
    console.log(`Installed and activated ${id}`);
  }
  const running = new Map((await paseo(["plugin", "ls"])).map((entry) => [entry.id, entry.status]));
  for (const { id } of plugins) assert.equal(running.get(id), "running", `${id} did not stay running`);
} finally {
  // Leave diagnostics available if the owned daemon cannot be stopped.
  try {
    if (daemon && daemon.child.exitCode === null && daemon.child.signalCode === null) {
      await paseo(["daemon", "stop", "--timeout", "5", "--force"]);
      const stopped = await Promise.race([daemon.closed, delay(10_000, null, { ref: false })]);
      if (!stopped) throw new Error("The foreground daemon did not exit after stopping");
    }
  } catch (error) {
    daemon?.child.kill();
    console.error(`Could not stop the smoke-test daemon. Its files are in ${daemonHome}.`, error);
    process.exitCode = 1;
  }
  if (!process.exitCode) await rm(temp, { recursive: true, force: true });
}
