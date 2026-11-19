import { spawnSync } from "node:child_process";
import { appendFile, chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const upstream = "https://github.com/ccusage/ccusage.git";
const plugin = path.resolve(import.meta.dirname, "..");
const packageInfo = JSON.parse(await readFile(path.join(plugin, "package.json"), "utf8"));
const version = packageInfo.dependencies.ccusage;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error("Pin ccusage to an exact release before building the scanner");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`);
  return result.stdout;
}

const scratch = await mkdtemp(path.join(tmpdir(), "paseo-ccusage-"));
try {
  const checkout = path.join(scratch, "ccusage");
  run("git", ["-c", "advice.detachedHead=false", "clone", "--quiet", "--depth", "1", "--branch", `v${version}`, upstream, checkout]);
  const upstreamPackage = JSON.parse(await readFile(path.join(checkout, "package.json"), "utf8"));
  if (upstreamPackage.version !== version) throw new Error("The upstream tag does not match the npm pin");

  const workspace = path.join(checkout, "rust");
  const crate = path.join(workspace, "crates", "ccusage");
  await copyFile(path.join(import.meta.dirname, "paseo-ccusage.rs"), path.join(crate, "src", "paseo-ccusage.rs"));
  await appendFile(path.join(crate, "Cargo.toml"), '\n[[bin]]\nname = "paseo-ccusage"\npath = "src/paseo-ccusage.rs"\n');

  const flake = JSON.parse(await readFile(path.join(checkout, "flake.lock"), "utf8"));
  const pricingUrl = new URL(flake.nodes.litellm.locked.url);
  if (pricingUrl.protocol !== "https:") throw new Error("Expected an HTTPS upstream pricing snapshot");
  const pricingFile = path.join(scratch, "pricing.json");
  run("curl", ["--fail", "--silent", "--show-error", "--location", "--max-time", "60", "--output", pricingFile, pricingUrl.href]);

  const toolchainSpec = await readFile(path.join(checkout, "rust-toolchain.toml"), "utf8");
  const channel = /^channel\s*=\s*"([^"]+)"/m.exec(toolchainSpec)?.[1];
  if (!channel) throw new Error("The upstream Rust toolchain is unspecified");
  run("rustup", ["toolchain", "install", channel, "--profile", "minimal"]);
  const target = path.join(scratch, "target");
  run("rustup", ["run", channel, "cargo", "build", "--release", "--locked", "--bin", "paseo-ccusage",
    "--manifest-path", path.join(workspace, "Cargo.toml"), "--target-dir", target],
  { env: { ...process.env, CCUSAGE_PRICING_JSON_PATH: pricingFile } });

  const extension = process.platform === "win32" ? ".exe" : "";
  const binary = path.join(target, "release", `paseo-ccusage${extension}`);
  const output = run(binary, ["--version"], { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
  if (output?.trim() !== `ccusage ${version}`) throw new Error("The built scanner has the wrong version");
  const directory = path.join(plugin, "node_modules", ".paseo-ccusage", version);
  await mkdir(directory, { recursive: true });
  const destination = path.join(directory, `ccusage${extension}`);
  const staging = await mkdtemp(path.join(directory, ".install-"));
  try {
    const staged = path.join(staging, `ccusage${extension}`);
    await copyFile(binary, staged);
    await chmod(staged, 0o755);
    await rename(staged, destination);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  console.log(`Built the offline scanner at ${destination}`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
