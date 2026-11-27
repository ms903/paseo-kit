import { spawnSync } from "node:child_process";
import { discoverPlugins } from "./plugin-projects.mjs";

const commands = {
  install: ["ci"],
  typecheck: ["run", "typecheck"],
  test: ["run", "--if-present", "test"],
  "check:build": ["run", "--if-present", "check:build"],
};
const command = process.argv[2];
if (!Object.hasOwn(commands, command)) throw new Error(`Unknown plugin command: ${command}`);
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run this command through the repository's npm scripts.");

for (const { id, project } of await discoverPlugins()) {
  console.log(`\n== ${id} ==`);
  // npm supplies the JS entrypoint, so a Windows .cmd shim is unnecessary.
  const args = [npm, ...commands[command], ...process.argv.slice(3)];
  const result = spawnSync(process.execPath, args, { cwd: project, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
